import asyncio
import os
import signal
import struct
import subprocess
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Deque, Dict, Optional
from urllib.parse import urlsplit

from fastapi import WebSocket, WebSocketDisconnect

from app.security import get_safe_path

if os.name != "nt":
    import fcntl
    import pty
    import termios


MAX_TERMINAL_SESSIONS = 4
TERMINAL_IDLE_TTL_SECONDS = 30 * 60
TERMINAL_HISTORY_LIMIT_BYTES = 512 * 1024
TERMINAL_OUTPUT_QUEUE_CHUNKS = 64
_TERMINAL_SESSIONS: Dict[str, "_TerminalSession"] = {}


@dataclass
class _TerminalSession:
    session_id: str
    cwd: Path
    process: subprocess.Popen
    master_fd: Optional[int]
    loop: asyncio.AbstractEventLoop
    history: Deque[bytes] = field(default_factory=deque)
    history_bytes: int = 0
    history_truncated: bool = False
    websocket: Optional[WebSocket] = None
    output_queue: Optional[asyncio.Queue] = None
    reader_paused: bool = False
    exited: bool = False
    closed: bool = False
    idle_task: Optional[asyncio.Task] = None


class PtyTerminalService:
    @staticmethod
    async def serve(websocket: WebSocket) -> None:
        if websocket.scope.get("session", {}).get("authenticated") is not True:
            await websocket.close(code=1008)
            return

        origin = websocket.headers.get("origin")
        host = websocket.headers.get("host", "")
        if origin and urlsplit(origin).netloc.lower() != host.lower():
            await websocket.close(code=1008)
            return

        if os.name == "nt":
            await websocket.accept()
            await websocket.send_json({
                "type": "error",
                "message": "Interactive PTY terminal is supported on Linux/Kaggle only.",
            })
            await websocket.close(code=1011)
            return

        requested_id = websocket.query_params.get("session_id", "")
        try:
            session_id = str(uuid.UUID(requested_id)) if requested_id else str(uuid.uuid4())
        except (ValueError, TypeError, AttributeError):
            await websocket.close(code=1008)
            return

        session = _TERMINAL_SESSIONS.get(session_id)
        resumed = session is not None and not session.closed
        if session is not None and session.closed:
            _TERMINAL_SESSIONS.pop(session_id, None)
            session = None

        if session is None:
            while len(_TERMINAL_SESSIONS) >= MAX_TERMINAL_SESSIONS:
                # Keep exited sessions briefly for reconnect/history replay, but
                # evict the oldest detached one when a new shell needs a slot.
                expired_candidates = [
                    item
                    for item in _TERMINAL_SESSIONS.values()
                    if item.exited and item.websocket is None
                ]
                if not expired_candidates:
                    break
                oldest = min(expired_candidates, key=lambda item: item.created_at)
                await PtyTerminalService._terminate_session(oldest)

            if len(_TERMINAL_SESSIONS) >= MAX_TERMINAL_SESSIONS:
                await websocket.accept()
                await websocket.send_json({
                    "type": "error",
                    "message": "All terminal sessions are busy.",
                })
                await websocket.close(code=1013)
                return

            requested_cwd = websocket.query_params.get("cwd", "")
            try:
                cwd = get_safe_path(requested_cwd, must_exist=True)
                if not cwd.is_dir():
                    raise ValueError("The selected working directory is not a directory.")
                session = PtyTerminalService._create_session(session_id, cwd)
            except Exception:
                await websocket.close(code=1008)
                return

        await websocket.accept()
        try:
            await PtyTerminalService._serve_session(
                websocket,
                session,
                replay=websocket.query_params.get("replay") == "1",
                resumed=resumed,
            )
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        except Exception as exc:
            try:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Terminal connection failed: {exc}",
                })
            except Exception:
                pass
        finally:
            if session.websocket is None and not session.closed:
                PtyTerminalService._schedule_idle_expiry(session)
            try:
                await websocket.close(code=1000)
            except Exception:
                pass

    @staticmethod
    def _create_session(session_id: str, cwd: Path) -> _TerminalSession:
        master_fd = None
        slave_fd = None
        try:
            master_fd, slave_fd = pty.openpty()
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

            shell = os.environ.get("SHELL", "/bin/bash")
            if not Path(shell).is_file():
                shell = "/bin/bash" if Path("/bin/bash").is_file() else "/bin/sh"
            argv = [shell, "--noprofile", "--norc", "-i"] if Path(shell).name == "bash" else [shell, "-i"]

            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            env["COLORTERM"] = "truecolor"
            env["PS1"] = r"\[\e[1;32m\]kaggle@drive\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ "

            def set_controlling_terminal():
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

            process = subprocess.Popen(
                argv,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=str(cwd),
                env=env,
                close_fds=True,
                start_new_session=True,
                preexec_fn=set_controlling_terminal,
            )
            os.close(slave_fd)
            slave_fd = None
            loop = asyncio.get_running_loop()
            session = _TerminalSession(session_id, cwd, process, master_fd, loop)
            _TERMINAL_SESSIONS[session_id] = session
            loop.add_reader(master_fd, PtyTerminalService._read_pty, session)
            PtyTerminalService._schedule_idle_expiry(session)
            return session
        except Exception:
            for fd in (slave_fd, master_fd):
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            raise

    @staticmethod
    def _append_history(session: _TerminalSession, chunk: bytes) -> None:
        if len(chunk) >= TERMINAL_HISTORY_LIMIT_BYTES:
            session.history.clear()
            session.history.append(chunk[-TERMINAL_HISTORY_LIMIT_BYTES:])
            session.history_bytes = TERMINAL_HISTORY_LIMIT_BYTES
            session.history_truncated = True
            return

        session.history.append(chunk)
        session.history_bytes += len(chunk)
        while session.history_bytes > TERMINAL_HISTORY_LIMIT_BYTES and session.history:
            overflow = session.history_bytes - TERMINAL_HISTORY_LIMIT_BYTES
            oldest = session.history[0]
            if len(oldest) <= overflow:
                session.history.popleft()
                session.history_bytes -= len(oldest)
            else:
                session.history[0] = oldest[overflow:]
                session.history_bytes -= overflow
            session.history_truncated = True

    @staticmethod
    def _read_pty(session: _TerminalSession) -> None:
        fd = session.master_fd
        if fd is None or session.closed or session.exited:
            return

        queue = session.output_queue
        if session.websocket is not None and queue is not None and queue.full():
            try:
                session.loop.remove_reader(fd)
            except Exception:
                pass
            session.reader_paused = True
            return

        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""

        if not chunk:
            session.exited = True
            try:
                session.loop.remove_reader(fd)
            except Exception:
                pass
            session.reader_paused = False
            try:
                os.close(fd)
            except OSError:
                pass
            session.master_fd = None
            queue = session.output_queue
            if queue is not None and not queue.full():
                queue.put_nowait(None)
            session.loop.create_task(asyncio.to_thread(session.process.wait))
            return

        PtyTerminalService._append_history(session, chunk)
        queue = session.output_queue
        if session.websocket is not None and queue is not None:
            queue.put_nowait(chunk)

    @staticmethod
    def _resume_reader(session: _TerminalSession) -> None:
        if not session.reader_paused or session.master_fd is None or session.closed or session.exited:
            return
        session.reader_paused = False
        try:
            session.loop.add_reader(
                session.master_fd, PtyTerminalService._read_pty, session
            )
        except (RuntimeError, OSError):
            session.reader_paused = True

    @staticmethod
    async def _send_output(
        websocket: WebSocket,
        session: _TerminalSession,
        queue: asyncio.Queue,
    ) -> None:
        while True:
            chunk = await queue.get()
            if chunk is None:
                await websocket.send_json({"type": "exit"})
                return
            await websocket.send_bytes(chunk)
            # EOF can arrive while the bounded queue is full, leaving no room
            # for the sentinel. Once buffered output drains, send the exit event.
            if session.exited and queue.empty():
                await websocket.send_json({"type": "exit"})
                return
            if session.reader_paused and not queue.full():
                PtyTerminalService._resume_reader(session)

    @staticmethod
    async def _receive_input(
        websocket: WebSocket,
        session: _TerminalSession,
    ) -> None:
        while True:
            message = await websocket.receive_json()
            kind = message.get("type")
            if kind == "input":
                data = message.get("data", "")
                if isinstance(data, str) and data and session.master_fd is not None:
                    os.write(session.master_fd, data.encode("utf-8"))
            elif kind == "ping":
                await websocket.send_json({"type": "pong"})
            elif kind == "clear":
                session.history.clear()
                session.history_bytes = 0
                session.history_truncated = False
            elif kind == "resize" and session.master_fd is not None:
                try:
                    cols = max(20, min(int(message.get("cols", 80)), 300))
                    rows = max(2, min(int(message.get("rows", 24)), 120))
                    fcntl.ioctl(
                        session.master_fd,
                        termios.TIOCSWINSZ,
                        struct.pack("HHHH", rows, cols, 0, 0),
                    )
                except (TypeError, ValueError, OSError):
                    pass
            elif kind == "terminate":
                await PtyTerminalService._terminate_session(session)
                return

    @staticmethod
    async def _serve_session(
        websocket: WebSocket,
        session: _TerminalSession,
        replay: bool,
        resumed: bool,
    ) -> None:
        previous_socket = session.websocket
        if previous_socket is not None and previous_socket is not websocket:
            try:
                await previous_socket.close(code=1012, reason="Terminal reconnected")
            except Exception:
                pass

        if session.idle_task is not None:
            session.idle_task.cancel()
            session.idle_task = None

        session.websocket = websocket
        queue: asyncio.Queue = asyncio.Queue(maxsize=TERMINAL_OUTPUT_QUEUE_CHUNKS)
        session.output_queue = queue
        history = b"".join(session.history) if replay or not resumed else b""
        was_truncated = session.history_truncated and replay

        try:
            await websocket.send_json({
                "type": "session",
                "session_id": session.session_id,
                "resumed": resumed,
            })
            if was_truncated:
                await websocket.send_json({"type": "history_truncated"})
            if history:
                await websocket.send_bytes(history)

            if session.exited or session.closed:
                await websocket.send_json({"type": "exit"})
                return

            if session.reader_paused:
                PtyTerminalService._resume_reader(session)

            output_task = asyncio.create_task(
                PtyTerminalService._send_output(websocket, session, queue)
            )
            input_task = asyncio.create_task(
                PtyTerminalService._receive_input(websocket, session)
            )
            done, pending = await asyncio.wait(
                {output_task, input_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                try:
                    task.result()
                except Exception:
                    pass
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        finally:
            if session.websocket is websocket:
                session.websocket = None
                session.output_queue = None
                if session.reader_paused:
                    PtyTerminalService._resume_reader(session)
                if not session.closed:
                    PtyTerminalService._schedule_idle_expiry(session)

    @staticmethod
    def _schedule_idle_expiry(session: _TerminalSession) -> None:
        if session.closed or session.websocket is not None:
            return
        if session.idle_task is not None:
            session.idle_task.cancel()
        session.idle_task = session.loop.create_task(
            PtyTerminalService._expire_idle_session(session)
        )

    @staticmethod
    async def _expire_idle_session(session: _TerminalSession) -> None:
        try:
            await asyncio.sleep(TERMINAL_IDLE_TTL_SECONDS)
            if (
                _TERMINAL_SESSIONS.get(session.session_id) is session
                and session.websocket is None
            ):
                await PtyTerminalService._terminate_session(session)
        except asyncio.CancelledError:
            pass

    @staticmethod
    async def _terminate_session(session: _TerminalSession) -> None:
        if session.closed:
            return
        session.closed = True
        _TERMINAL_SESSIONS.pop(session.session_id, None)

        if session.idle_task is not None:
            current_task = asyncio.current_task()
            if session.idle_task is not current_task:
                session.idle_task.cancel()
            session.idle_task = None

        if session.master_fd is not None:
            try:
                session.loop.remove_reader(session.master_fd)
            except Exception:
                pass
            try:
                os.close(session.master_fd)
            except OSError:
                pass
            session.master_fd = None

        queue = session.output_queue
        if queue is not None:
            while queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            queue.put_nowait(None)

        if session.process.poll() is None:
            try:
                os.killpg(session.process.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(session.process.wait), timeout=2
                )
            except asyncio.TimeoutError:
                try:
                    os.killpg(session.process.pid, signal.SIGKILL)
                except OSError:
                    pass
                await asyncio.to_thread(session.process.wait)

    @staticmethod
    async def close_session(session_id: str) -> Dict[str, str]:
        try:
            normalized_id = str(uuid.UUID(session_id))
        except (ValueError, TypeError, AttributeError):
            return {"status": "closed"}
        session = _TERMINAL_SESSIONS.get(normalized_id)
        if session is not None:
            await PtyTerminalService._terminate_session(session)
        return {"status": "closed"}

    @staticmethod
    async def stop_all() -> None:
        sessions = list(_TERMINAL_SESSIONS.values())
        if sessions:
            await asyncio.gather(
                *(PtyTerminalService._terminate_session(session) for session in sessions),
                return_exceptions=True,
            )
