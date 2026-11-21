import logging
from fastapi import APIRouter, HTTPException, Request, WebSocket
from app.security import require_auth
from app.services.system_service import SystemService
from app.services.pty_terminal_service import PtyTerminalService
from app.services.port_service import port_manager

router = APIRouter(prefix="/api/system", tags=["system"])

logger = logging.getLogger(__name__)


@router.get("/stats")
def get_system_stats(request: Request):
    """Return disk space, RAM, CPU, and GPU statistics."""
    require_auth(request)
    return SystemService.get_full_stats()


@router.get("/ports")
def get_listening_ports(request: Request):
    """Return local TCP listeners and their Cloudflare tunnel state."""
    require_auth(request)
    try:
        return {"ports": port_manager.list_ports()}
    except Exception as exc:
        logger.exception("Could not read local listening ports")
        raise HTTPException(
            status_code=503,
            detail=f"Could not inspect local ports ({type(exc).__name__}): {exc}",
        ) from exc


@router.post("/ports/{port}/tunnel")
def open_port_tunnel(request: Request, port: int):
    """Expose a local TCP listener using a Cloudflare quick tunnel."""
    require_auth(request)
    try:
        return port_manager.start_tunnel(port)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.delete("/ports/{port}")
def close_local_port(request: Request, port: int):
    """Stop a local port listener and close its associated tunnel."""
    require_auth(request)
    try:
        return port_manager.close_local_port(port)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("Could not close local port %s", port)
        raise HTTPException(
            status_code=500,
            detail=f"Could not close local port ({type(exc).__name__}): {exc}",
        ) from exc


@router.delete("/ports/{port}/tunnel")
def close_port_tunnel(request: Request, port: int):
    """Stop the Cloudflare tunnel associated with one local port."""
    require_auth(request)
    try:
        return port_manager.stop_tunnel(port)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.websocket("/terminal/ws")
async def run_terminal_pty(websocket: WebSocket):
    """Open an authenticated interactive PTY session for the browser terminal."""
    await PtyTerminalService.serve(websocket)

