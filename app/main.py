import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.routes.auth_routes import router as auth_router
from app.routes.file_routes import router as file_router
from app.routes.system_routes import router as system_router
from app.routes.view_routes import router as view_router
from app.services.port_service import port_manager
from app.services.file_service import FileService, UPLOAD_CHUNK_CLEANUP_INTERVAL_SECONDS
from app.services.persistent_pty_service import PtyTerminalService


async def _upload_chunk_cleanup_loop():
    while True:
        await asyncio.sleep(UPLOAD_CHUNK_CLEANUP_INTERVAL_SECONDS)
        await asyncio.to_thread(FileService.cleanup_stale_upload_chunks)


@asynccontextmanager
async def app_lifespan(_app: FastAPI):
    await asyncio.to_thread(FileService.cleanup_stale_upload_chunks)
    cleanup_task = asyncio.create_task(_upload_chunk_cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        await asyncio.gather(cleanup_task, return_exceptions=True)
        await PtyTerminalService.stop_all()
        port_manager.stop_all()


class RequestBodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def _reject(self, send, status_code, detail):
        body = json.dumps({"detail": detail}).encode("utf-8")
        await send({"type": "http.response.start", "status": status_code, "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("ascii")),
        ]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limits = {
            "/api/auth/login": 16 * 1024,
            "/api/files/upload": settings.MAX_UPLOAD_BYTES + 16 * 1024 * 1024,
            "/api/files/upload/check": 16 * 1024 * 1024,
            "/api/files/upload/chunk": settings.UPLOAD_CHUNK_BYTES + 5 * 1024 * 1024,
            "/api/files/extract": 8 * 1024 * 1024,
            "/api/files/content": settings.MAX_TEXT_PREVIEW_SIZE * 6 + 1024 * 1024,
            "/api/files/save-binary": ((settings.MAX_BINARY_SAVE_BYTES + 2) // 3) * 4 + 1024 * 1024,
            "/api/files/download-selected-zip": 8 * 1024 * 1024,
            "/api/files/compress": 8 * 1024 * 1024,
        }
        # Endpoints with larger expected payloads are listed above.
        # Keep all other HTTP request bodies small by default.
        limit = limits.get(scope.get("path", ""), 1024 * 1024)

        raw_length = next((value for name, value in scope.get("headers", []) if name.lower() == b"content-length"), None)
        if raw_length is not None:
            try:
                content_length = int(raw_length)
                if content_length < 0:
                    raise ValueError
            except ValueError:
                await self._reject(send, 400, "Invalid Content-Length header.")
                return
            if content_length > limit:
                await self._reject(send, 413, "Request body exceeds the configured limit.")
                return

        received = 0
        too_large = False
        response_started = False

        async def limited_receive():
            nonlocal received, too_large
            if too_large:
                return {"type": "http.disconnect"}
            message = await receive()
            if message.get("type") == "http.request":
                body = message.get("body", b"")
                remaining = limit - received
                if len(body) > remaining:
                    too_large = True
                    return {"type": "http.request", "body": body[:max(0, remaining)], "more_body": False}
                received += len(body)
            return message

        async def capture_send(message):
            nonlocal response_started
            if too_large:
                return
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, capture_send)
        except Exception:
            if not too_large:
                raise

        if too_large:
            if not response_started:
                await self._reject(send, 413, "Request body exceeds the configured limit.")
            return


class RequestAuthGateMiddleware:
    """Reject cross-origin and unauthenticated API calls before body parsing."""

    def __init__(self, app):
        self.app = app

    async def _reject(self, send, status_code: int, detail: str):
        body = json.dumps({"detail": detail}).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        protected = any(
            path == prefix or path.startswith(prefix + "/")
            for prefix in ("/api/files", "/api/system")
        )
        is_api = path == "/api" or path.startswith("/api/")

        if scope.get("type") == "http" and is_api:
            headers = {
                name.lower(): value
                for name, value in scope.get("headers", [])
            }
            raw_origin = headers.get(b"origin")
            if raw_origin:
                try:
                    origin = urlsplit(raw_origin.decode("latin-1"))
                except ValueError:
                    await self._reject(
                        send, 403, "Cross-origin API requests are not allowed."
                    )
                    return
                host = headers.get(b"host", b"").decode("latin-1").lower()
                if (
                    origin.scheme.lower() not in ("http", "https")
                    or not origin.netloc
                    or origin.netloc.lower() != host
                ):
                    await self._reject(
                        send, 403, "Cross-origin API requests are not allowed."
                    )
                    return

        if scope.get("type") == "http" and protected:
            if scope.get("session", {}).get("authenticated") is not True:
                await self._reject(send, 401, "Not authenticated.")
                return
        await self.app(scope, receive, send)


def create_app() -> FastAPI:
    """FastAPI Application Factory."""
    app = FastAPI(
        title="Kaggle Cloud Drive",
        description="Modern File Server & Manager for Kaggle Working Directory",
        version="2.0.0",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=app_lifespan
    )

    # Middleware is registered inside-out: the auth gate runs after SessionMiddleware
    # but before FastAPI reads request bodies.
    app.add_middleware(RequestBodyLimitMiddleware)
    app.add_middleware(RequestAuthGateMiddleware)
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.SECRET_KEY,
        max_age=settings.SESSION_MAX_AGE,
        same_site="lax",
        https_only=False
    )

    static_dir = Path(__file__).resolve().parent / "static"
    if static_dir.exists():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    app.include_router(view_router)
    app.include_router(auth_router)
    app.include_router(file_router)
    app.include_router(system_router)
    return app


app = create_app()
