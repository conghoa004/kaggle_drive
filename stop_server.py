#!/usr/bin/env python3
"""
Kaggle Cloud Drive - Background Server Stopper
Stops the running background server gracefully or forcefully.
"""

import os
import subprocess
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent if "__file__" in globals() else (
    Path("/kaggle/working/kaggle_drive") if Path("/kaggle/working/kaggle_drive").exists() else Path.cwd()
)
PID_PATH = PROJECT_DIR / "server.pid"

stopped = False
stop_unverified = False
stop_failed = False


def is_project_server(pid: int) -> bool:
    try:
        import psutil
        process = psutil.Process(pid)
        working_dir = Path(process.cwd()).resolve()
        expected_script = (PROJECT_DIR / "run.py").resolve()
        owns_project_script = False
        for argument in process.cmdline():
            if Path(argument).name.lower() != "run.py":
                continue
            script_path = Path(argument)
            if not script_path.is_absolute():
                script_path = working_dir / script_path
            if script_path.resolve() == expected_script:
                owns_project_script = True
                break

        return (
            process.is_running()
            and process.status() != psutil.STATUS_ZOMBIE
            and working_dir == PROJECT_DIR.resolve()
            and owns_project_script
        )
    except Exception:
        return False

# 1. Check if server process is in globals (interactive notebook session)
if "server" in globals() and globals()["server"] is not None:
    srv = globals()["server"]
    if srv.poll() is None:
        srv.terminate()
        try:
            srv.wait(timeout=5)
            print("[✓] Server stopped successfully.")
            stopped = True
        except subprocess.TimeoutExpired:
            srv.kill()
            srv.wait()
            print("[✓] Server was forcefully stopped.")
            stopped = True

# 2. Check PID file only after verifying it belongs to this project.
if not stopped and PID_PATH.exists():
    try:
        pid = int(PID_PATH.read_text().strip())
        if not is_project_server(pid):
            print(f"[!] PID {pid} does not identify this project's run.py; it was not terminated.")
            stop_unverified = True
            PID_PATH.unlink(missing_ok=True)
        elif os.name == "nt":
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            stopped = result.returncode == 0
            stop_failed = not stopped
        else:
            import psutil
            process = psutil.Process(pid)
            process.terminate()
            try:
                process.wait(timeout=8)
            except psutil.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            stopped = True
        if stopped:
            PID_PATH.unlink(missing_ok=True)
            print(f"[OK] Stopped Kaggle Cloud Drive (PID: {pid}).")
    except ProcessLookupError:
        PID_PATH.unlink(missing_ok=True)
        print("[*] Server process was already stopped.")
    except Exception as exc:
        stop_failed = True
        print(f"[!] Could not safely stop the PID file process: {exc}")

if stopped:
    print("Server status: STOPPED")
elif stop_unverified or stop_failed:
    print("Server status: UNKNOWN (no unverified process was terminated)")
else:
    print("[*] No running Kaggle Cloud Drive server found.")
    print("Server status: STOPPED")
