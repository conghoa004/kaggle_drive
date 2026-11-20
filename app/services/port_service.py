import socket
import threading
from pathlib import Path
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
    def _proc_listening_ports():
        ports = {}
        readable = False
        for proc_path in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
            try:
                lines = proc_path.read_text(encoding="ascii").splitlines()
                readable = True
            except OSError:
                continue

            is_ipv6 = proc_path.name.endswith("tcp6")
            for line in lines[1:]:
                fields = line.split()
                if len(fields) < 4 or fields[3] != "0A":
                    continue
                try:
                    raw_ip, raw_port = fields[1].split(":")
                    port = int(raw_port, 16)
                    address_bytes = bytes.fromhex(raw_ip)
                    if is_ipv6:
                        address_bytes = b"".join(
                            address_bytes[index:index + 4][::-1]
                            for index in range(0, 16, 4)
                        )
                        address = socket.inet_ntop(socket.AF_INET6, address_bytes)
                    else:
                        address = socket.inet_ntop(socket.AF_INET, address_bytes[::-1])
                except (ValueError, OSError):
                    continue

                # cloudflared targets 127.0.0.1, so omit listeners unreachable there.
                if address not in ("127.0.0.1", "0.0.0.0", "::ffff:127.0.0.1"):
                    continue
                item = ports.setdefault(port, {"port": port, "addresses": set()})
                item["addresses"].add(address)

        if not readable:
            return None
        return [
            {
                "port": item["port"],
                "address": ", ".join(sorted(item["addresses"])),
                "process": "Unknown",
            }
            for item in sorted(ports.values(), key=lambda value: value["port"])
        ]

    @staticmethod
    def _listening_ports():
        try:
            connections = psutil.net_connections(kind="inet")
            ports = {}
            for connection in connections:
                if connection.type != psutil.SOCK_STREAM or connection.status != psutil.CONN_LISTEN:
                    continue
                local_address = connection.laddr
                if not local_address:
                    continue
                if hasattr(local_address, "ip"):
                    address, port = local_address.ip, local_address.port
                else:
                    address, port = local_address[0], local_address[1]

                # cloudflared targets 127.0.0.1, so omit listeners unreachable there.
                if address not in ("127.0.0.1", "0.0.0.0", "::ffff:127.0.0.1"):
                    continue

                port = int(port)
                item = ports.setdefault(port, {"port": port, "addresses": set(), "processes": set()})
                item["addresses"].add(address)
                pid = getattr(connection, "pid", None)
                if pid:
                    try:
                        name = psutil.Process(pid).name()
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
        except Exception as exc:
            fallback = PortManager._proc_listening_ports()
            if fallback is not None:
                return fallback
            raise RuntimeError(f"Could not inspect listening ports: {exc}") from exc

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
                item["is_application"] = port == settings.PORT
                item.setdefault("tunnel", self._tunnel_state(self._active_tunnel(port)))
            return [items[port] for port in sorted(items)]

    def stop_all(self):
        """Stop all quick tunnels created by this manager during app shutdown."""
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
                url = tunnel.start_tunnel(port, quick=True, verify_public_health=False)
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
