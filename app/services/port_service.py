import threading
from typing import Dict, Optional

import psutil

from app.config import settings
from app.services.tunnel_service import CloudflareTunnelService


class PortManager:
    """Lists local TCP listeners and controls one Cloudflare quick tunnel per port."""

    def __init__(self):
        self._tunnels: Dict[int, CloudflareTunnelService] = {}
        self._lock = threading.RLock()

    @staticmethod
    def _listening_ports():
        try:
            connections = psutil.net_connections(kind="inet")
        except Exception as exc:
            raise RuntimeError(f"Could not inspect listening ports: {exc}") from exc

        ports = {}
        for connection in connections:
            if connection.type != psutil.SOCK_STREAM or connection.status != psutil.CONN_LISTEN:
                continue
            if not connection.laddr:
                continue

            address = connection.laddr.ip
            # cloudflared targets 127.0.0.1, so only include listeners reachable there.
            if address not in ("127.0.0.1", "0.0.0.0", "::ffff:127.0.0.1"):
                continue

            port = int(connection.laddr.port)
            item = ports.setdefault(port, {"port": port, "addresses": set(), "processes": set()})
            item["addresses"].add(address)
            if connection.pid:
                try:
                    name = psutil.Process(connection.pid).name()
                except (psutil.Error, OSError):
                    name = ""
                if name:
                    item["processes"].add(name)

        return [
            {
                "port": item["port"],
                "address": ", ".join(sorted(item["addresses"])),
                "process": ", ".join(sorted(item["processes"])) or "Unknown",
            }
            for item in sorted(ports.values(), key=lambda value: value["port"])
        ]

    def _active_tunnel(self, port: int) -> Optional[CloudflareTunnelService]:
        tunnel = self._tunnels.get(port)
        if tunnel and tunnel.process and tunnel.process.poll() is None:
            return tunnel
        if port == settings.PORT:
            # The application may already have its startup tunnel managed by run.py.
            from app.services.tunnel_service import tunnel_service
            if tunnel_service.process and tunnel_service.process.poll() is None:
                return tunnel_service
        return None

    @staticmethod
    def _tunnel_state(tunnel: Optional[CloudflareTunnelService]):
        active = bool(tunnel and tunnel.process and tunnel.process.poll() is None)
        return {"active": active, "url": tunnel.public_url if active else None}

    def list_ports(self):
        with self._lock:
            items = {item["port"]: item for item in self._listening_ports()}
            candidate_ports = set(self._tunnels)
            candidate_ports.add(settings.PORT)
            for port in candidate_ports:
                tunnel = self._active_tunnel(port)
                if not tunnel:
                    continue
                item = items.setdefault(port, {
                    "port": port,
                    "address": "",
                    "process": "Unknown",
                })
                item["tunnel"] = self._tunnel_state(tunnel)
            for port, item in items.items():
                item.setdefault("tunnel", self._tunnel_state(self._active_tunnel(port)))
            return [items[port] for port in sorted(items)]

    def stop_all(self):
        '''Stop all quick tunnels created by this manager during app shutdown.'''
        with self._lock:
            tunnels = list(self._tunnels.values())
            self._tunnels.clear()
            for tunnel in tunnels:
                tunnel.stop_tunnel()

    def start_tunnel(self, port: int):
        if port < 1 or port > 65535:
            raise ValueError("Port must be between 1 and 65535.")

        with self._lock:
            available = {item["port"] for item in self._listening_ports()}
            if port not in available:
                raise ValueError(f"No local TCP service is listening on port {port}.")

            existing = self._active_tunnel(port)
            if existing:
                return {"port": port, **self._tunnel_state(existing)}

            stale = self._tunnels.pop(port, None)
            if stale:
                stale.stop_tunnel()

            tunnel = CloudflareTunnelService()
            try:
                url = tunnel.start_tunnel(port, quick=True)
                if not tunnel.process or tunnel.process.poll() is not None:
                    raise RuntimeError("Cloudflare Tunnel stopped before it became available.")
                self._tunnels[port] = tunnel
                return {"port": port, "active": True, "url": url}
            except Exception as exc:
                tunnel.stop_tunnel()
                if isinstance(exc, RuntimeError):
                    raise
                raise RuntimeError(f"Could not start Cloudflare Tunnel: {exc}") from exc

    def stop_tunnel(self, port: int):
        if port < 1 or port > 65535:
            raise ValueError("Port must be between 1 and 65535.")

        with self._lock:
            tunnel = self._tunnels.pop(port, None)
            if not tunnel and port == settings.PORT:
                from app.services.tunnel_service import tunnel_service
                if tunnel_service.process and tunnel_service.process.poll() is None:
                    tunnel = tunnel_service
            if tunnel:
                tunnel.stop_tunnel()
            return {"port": port, "active": False, "url": None}


port_manager = PortManager()
