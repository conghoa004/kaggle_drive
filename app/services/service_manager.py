import os
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path


_SERVICES_ROOT = Path(__file__).resolve().parents[2] / "services"
_ACTIONS = {
    "install": "install.sh",
    "start": "start.sh",
    "stop": "stop.sh",
    "uninstall": "uninstall.sh",
}

_TASKS = {}
_SERVICE_TASKS = {}
_TASK_LOCK = threading.Lock()
_IS_LINUX = sys.platform.startswith("linux")


def get_services_root() -> Path:
    return _SERVICES_ROOT.resolve()


def _service_directory(service_id: str) -> Path | None:
    if (
        not service_id
        or Path(service_id).name != service_id
        or "/" in service_id
        or "\\" in service_id
    ):
        return None

    candidate = _SERVICES_ROOT / service_id
    if candidate.is_symlink() or not candidate.is_dir():
        return None
    try:
        if candidate.resolve().parent != _SERVICES_ROOT.resolve():
            return None
    except OSError:
        return None
    return candidate


def _service_directories() -> list[Path]:
    try:
        directories = [
            entry for entry in _SERVICES_ROOT.iterdir()
            if entry.is_dir() and not entry.is_symlink()
        ]
    except OSError:
        return []
    return sorted(directories, key=lambda entry: entry.name.casefold())


def _display_name(service_id: str) -> str:
    return service_id.replace("_", " ").replace("-", " ").replace(".", " ").title()


def _read_service_info(service_dir: Path | None) -> dict | None:
    if service_dir is None:
        return None
    info_path = service_dir / "tmp" / "info.txt"
    if info_path.is_symlink() or not info_path.is_file():
        return None

    fields = {}
    try:
        lines = info_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return None

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower().replace(" ", "_")
        if key:
            fields[key] = value.strip()
    return fields or None


def _task_payload(task: dict | None) -> dict | None:
    if not task:
        return None
    process = task["process"]
    return_code = process.poll()
    if return_code is None:
        status = "running"
    else:
        status = "completed" if return_code == 0 else "failed"
        task["status"] = status
        task["return_code"] = return_code
    return {
        "id": task["id"],
        "service_id": task["service_id"],
        "action": task["action"],
        "status": status,
        "return_code": task.get("return_code"),
        "log_file": task.get("log_file"),
    }


def list_services() -> list[dict]:
    supported = _IS_LINUX and bool(shutil.which("bash"))
    services = []
    for service_dir in _service_directories():
        service_id = service_dir.name
        info = _read_service_info(service_dir) or {}
        actions = {
            action: (service_dir / script_name).is_file()
            and not (service_dir / script_name).is_symlink()
            for action, script_name in _ACTIONS.items()
        }
        with _TASK_LOCK:
            task = _TASKS.get(_SERVICE_TASKS.get(service_id))
            task_info = _task_payload(task)

        services.append({
            "id": service_id,
            "name": info.get("name") or _display_name(service_id),
            "description": info.get("description", ""),
            "info_available": bool(info),
            "credentials_available": bool(info),
            "actions": actions,
            "supported": supported,
            "task": task_info,
        })
    return services


def get_service_info(service_id: str) -> dict | None:
    return _read_service_info(_service_directory(service_id))


def get_service_credentials(service_id: str) -> dict | None:
    # Keep the existing endpoint name for clients that still request credentials.
    return get_service_info(service_id)


def start_action(service_id: str, action: str) -> dict:
    if action not in _ACTIONS:
        raise ValueError("Unknown service action.")
    if not _IS_LINUX or not shutil.which("bash"):
        raise RuntimeError("Service actions require a Linux shell with bash.")

    service_dir = _service_directory(service_id)
    if service_dir is None:
        raise FileNotFoundError("Service directory is not available.")

    script = service_dir / _ACTIONS[action]
    if script.is_symlink() or not script.is_file():
        raise FileNotFoundError(f"Service script not found: {_ACTIONS[action]}")

    with _TASK_LOCK:
        previous_id = _SERVICE_TASKS.get(service_id)
        previous = _TASKS.get(previous_id)
        if previous and previous["process"].poll() is None:
            raise RuntimeError("Another action is already running for this service.")
        if previous_id:
            _TASKS.pop(previous_id, None)

        log_dir = service_dir / "tmp"
        log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(log_dir, 0o700)
        log_path = log_dir / f"services_store_{action}.log"
        log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(log_path, 0o600)
        with os.fdopen(log_fd, "wb") as output:
            process = subprocess.Popen(
                [shutil.which("bash") or "bash", str(script)],
                cwd=str(service_dir),
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        task_id = uuid.uuid4().hex
        task = {
            "id": task_id,
            "service_id": service_id,
            "action": action,
            "process": process,
            "status": "running",
            "log_file": str(log_path),
        }
        _TASKS[task_id] = task
        _SERVICE_TASKS[service_id] = task_id
        return _task_payload(task)


def get_task(task_id: str) -> dict | None:
    with _TASK_LOCK:
        return _task_payload(_TASKS.get(task_id))
