import os
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path


_SERVICES_ROOT = Path(__file__).resolve().parents[2] / "services"
_SERVICE_DEFINITIONS = {
    "mysql": {
        "folders": ("mysql",),
        "scripts": {
            "install": "install_mysql_phpmyadmin.sh",
            "start": "start_mysql_phpmyadmin.sh",
            "stop": "stop_mysql_phpmyadmin.sh",
            "uninstall": "uninstall_mysql_phpmyadmin.sh",
        },
    },
    "code-server": {
        "folders": ("coder", "vs_code"),
        "scripts": {
            "install": "install_coder_server.sh",
            "start": "start_coder_server.sh",
            "stop": "stop_coder_server.sh",
            "uninstall": "uninstall_coder_server.sh",
        },
    },
}

_TASKS = {}
_SERVICE_TASKS = {}
_TASK_LOCK = threading.Lock()
_IS_LINUX = sys.platform.startswith("linux")


def _service_directory(service_id: str) -> Path | None:
    definition = _SERVICE_DEFINITIONS[service_id]
    for folder in definition["folders"]:
        candidate = _SERVICES_ROOT / folder
        if candidate.is_dir():
            return candidate
    return None


def _run_check(command: list[str], timeout: float = 2.0) -> bool:
    try:
        return subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        ).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _mysql_state() -> tuple[bool, bool, bool, dict[str, bool]]:
    mysql_installed = bool(shutil.which("mysqladmin"))
    apache_installed = bool(shutil.which("apache2ctl"))
    phpmyadmin_installed = Path("/usr/share/phpmyadmin").is_dir()
    mysql_running = _run_check([shutil.which("mysqladmin") or "mysqladmin", "ping", "--silent"])
    apache_running = _run_check([shutil.which("pgrep") or "pgrep", "-x", "apache2"])
    components = {
        "mysql": mysql_installed,
        "apache": apache_installed,
        "phpmyadmin": phpmyadmin_installed,
    }
    installed = mysql_installed or apache_installed or phpmyadmin_installed
    complete = mysql_installed and apache_installed and phpmyadmin_installed
    active = mysql_running or apache_running
    running = mysql_running and apache_running
    return installed, complete, running, {**components, "active": active}


def _code_server_state() -> tuple[bool, bool, bool, dict[str, bool]]:
    home = Path.home()
    executable = home / ".local" / "bin" / "code-server"
    installed = executable.is_file() or bool(shutil.which("code-server"))
    state_dir = Path(os.environ.get("CODE_SERVER_STATE_DIR", home / ".local" / "state" / "kaggle-code-server"))
    pid_file = state_dir / "code-server.pid"
    running = False
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
        command_line = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        running = "--config" in command_line and str(state_dir / "config.yaml") in command_line
    except (OSError, ValueError):
        pass
    return installed, installed, running, {"code-server": installed, "active": running}


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
    if _IS_LINUX:
        mysql_installed, mysql_complete, mysql_running, mysql_components = _mysql_state()
        code_installed, code_complete, code_running, code_components = _code_server_state()
    else:
        mysql_installed = mysql_complete = mysql_running = False
        code_installed = code_complete = code_running = False
        mysql_components = {"mysql": False, "apache": False, "phpmyadmin": False, "active": False}
        code_components = {"code-server": False, "active": False}

    states = {
        "mysql": (mysql_installed, mysql_complete, mysql_running, mysql_components),
        "code-server": (code_installed, code_complete, code_running, code_components),
    }
    supported = _IS_LINUX and bool(shutil.which("bash"))
    services = []
    for service_id, definition in _SERVICE_DEFINITIONS.items():
        service_dir = _service_directory(service_id)
        installed, complete, running, components = states[service_id]
        with _TASK_LOCK:
            task = _TASKS.get(_SERVICE_TASKS.get(service_id))
            task_info = _task_payload(task)
        scripts_available = bool(service_dir) and all(
            (service_dir / script_name).is_file()
            for script_name in definition["scripts"].values()
        )
        services.append({
            "id": service_id,
            "installed": installed,
            "complete": complete,
            "running": running,
            "active": bool(components.get("active")),
            "components": components,
            "supported": supported and scripts_available,
            "task": task_info,
        })
    return services


def start_action(service_id: str, action: str) -> dict:
    if service_id not in _SERVICE_DEFINITIONS:
        raise KeyError("Unknown service.")
    if action not in ("install", "start", "stop", "uninstall"):
        raise ValueError("Unknown service action.")
    if not _IS_LINUX or not shutil.which("bash"):
        raise RuntimeError("Service actions require a Linux shell with bash.")

    service_dir = _service_directory(service_id)
    if service_dir is None:
        raise FileNotFoundError("Service directory is not available.")
    script_name = _SERVICE_DEFINITIONS[service_id]["scripts"][action]
    script = service_dir / script_name
    if not script.is_file():
        raise FileNotFoundError(f"Service script not found: {script_name}")

    installed, complete, running, components = (
        _mysql_state() if service_id == "mysql" else _code_server_state()
    )
    active = bool(components.get("active"))
    if action == "install" and complete:
        raise RuntimeError("Service is already installed.")
    if action == "start" and not complete:
        raise RuntimeError("Install this service before starting it.")
    if action == "stop" and not active:
        raise RuntimeError("Service is already stopped.")
    if action == "uninstall" and not installed and not active:
        raise RuntimeError("Service is not installed.")

    with _TASK_LOCK:
        previous_id = _SERVICE_TASKS.get(service_id)
        previous = _TASKS.get(previous_id)
        if previous and previous["process"].poll() is None:
            raise RuntimeError("Another action is already running for this service.")
        if previous_id:
            _TASKS.pop(previous_id, None)

        args = [shutil.which("bash") or "bash", str(script)]
        if action == "install":
            args.append("--install-only")
        log_dir = service_dir / "tmp"
        log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(log_dir, 0o700)
        log_path = log_dir / f"services_store_{action}.log"
        log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(log_path, 0o600)
        with os.fdopen(log_fd, "wb") as output:
            process = subprocess.Popen(
                args,
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
