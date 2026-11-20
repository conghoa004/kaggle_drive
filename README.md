# Kaggle Cloud Drive

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115%2B-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare_Tunnel-supported-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)
[![Languages](https://img.shields.io/badge/languages-Vietnamese%20%7C%20English%20%7C%20Chinese-blue?style=flat-square)](#features)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

Kaggle Cloud Drive is a browser-based file manager for Kaggle Notebooks and local development. It includes file upload and preview tools, an in-browser code editor, an optional VS Code Web IDE, Linux PTY terminal sessions, system resource monitoring, and Cloudflare Tunnel controls.

## Features

### File management

- Browse the configured root directory in grid or list view, including optional display of hidden files.
- Upload files or select a folder. Folder uploads preserve relative paths and subfolder structure.
- Uploads larger than 80 MiB are sent in 8 MiB chunks. The default maximum upload batch is 5 GiB.
- Download files, create ZIP downloads, download selected items as a ZIP, or download files directly from a URL.
- Create, rename, duplicate, and delete files or folders; create and edit text files; extract supported archives.
- Copy a cURL command for downloading a file from the running server.
- Preview images, audio, video, PDF, Markdown, code/text, Jupyter notebooks, and tabular files. CSV, TSV, XLS, and XLSX files use the spreadsheet viewer/editor.

Folder selection uses the browser's directory upload input. Some browsers display an additional confirmation before allowing a site to upload the selected folder.

### Ports Manager and Cloudflare Tunnel

- Scan local TCP ports that are listening on an address reachable through `127.0.0.1`.
- Start or stop an on-demand Cloudflare Quick Tunnel for a listed port and show its public URL.
- Port 8000 is the Kaggle Cloud Drive web server by default. Closing its tunnel disconnects the current public URL; the UI asks for confirmation first.
- Use Quick Tunnels for web/HTTP applications. A tunnel URL is public, so protect the target application with its own authentication when needed.
- The application can also start a primary tunnel automatically. It uses a Quick Tunnel by default, or a named tunnel when `CLOUDFLARE_TUNNEL_TOKEN` is configured.

### Terminal

- Open up to four terminal tabs. Each tab has its own Linux shell, working directory, output history, and WebSocket connection.
- PTY terminal sessions require Linux, such as a Kaggle runtime; they are not supported on Windows.
- WebSocket heartbeats help keep idle sessions active. Unexpected disconnects trigger reconnect attempts with increasing delays, up to 30 seconds.
- Reconnecting creates a new shell. A shell process or command from the disconnected session cannot be resumed.
- Minimize the terminal to keep its tabs open. Closing the terminal window or logging out closes all tabs.

### VS Code Web IDE

- The optional IDE is powered by code-server and served through the authenticated `/ide/` route.
- On Linux, the app can download code-server on first start when no executable is configured. Internet access is required for that download.
- The code-server process listens on loopback and is proxied through the app's authenticated HTTP and WebSocket routes.
- If code-server cannot start, the file manager can continue without the IDE. Set `ENABLE_CODE_SERVER=false` to disable it.
- Automatic code-server installation is Linux-only. On Windows, use WSL or provide a compatible executable with `CODE_SERVER_BIN`.

### System monitor and interface

- View CPU, memory, GPU, and the disk usage of the filesystem containing the configured root directory.
- Switch the interface between Vietnamese, English, and Simplified Chinese.
- Use the responsive interface on desktop and mobile screens.

## Requirements

- Python 3.10 or newer.
- Internet access is needed to download Cloudflared or code-server when they are not already installed, and for Cloudflare Tunnel connections.
- Linux is required for the interactive PTY terminal and automatic code-server installation.
- The application can run without a public tunnel by using `--no-tunnel`.

## Getting started

### Kaggle Notebook

Turn on Internet in the Kaggle Notebook settings to use Cloudflare Tunnel and allow the runtime to download Cloudflared when needed. In a notebook cell:

```python
import os

%cd /kaggle/working

PROJECT_DIR = "/kaggle/working/kaggle_drive"

# 1. Clone or update repository from GitHub
if not os.path.isdir(PROJECT_DIR):
    print("[*] Cloning repository from GitHub...")
    !git clone -b coder https://github.com/conghoa004/kaggle_drive.git
else:
    print("[*] Repository exists -> Pulling latest changes...")
    %cd /kaggle/working/kaggle_drive
    !git pull

%cd /kaggle/working/kaggle_drive

# 2. Install dependencies
print("[*] Installing dependencies...")
!pip install -q -r requirements.txt

# 3. Start the server in the background
print("[*] Starting Kaggle Cloud Drive...")

# Run with default settings (--lang en --username admin --password auto)
# !python start_server.py

# Optional: --lang vi|en|zh, --username <user>, --password <pass>
# !python start_server.py --lang en --username admin --password your_password

# Keep the notebook cell attached to the server and stream logs in real time:
!python start_server.py --foreground
```

The background launcher writes output to `server.log`. Stop it from another cell:

```python
!python /kaggle/working/kaggle_drive/stop_server.py
```

### Local development

Use a dedicated workspace directory rather than the default root:

```bash
git clone --branch main https://github.com/conghoa004/kaggle_drive.git
cd kaggle_drive
pip install -r requirements.txt
python run.py --root ./workspace --port 8000 --lang en --no-tunnel
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The terminal requires Linux; the rest of the file manager can run on Windows and macOS.

## Command-line options

Both `run.py` and `start_server.py` accept:

| Option | Default | Description |
|---|---:|---|
| `--host` | `127.0.0.1` | Address for the web server to bind to. |
| `--port` | `8000` | Web server TCP port. |
| `--root` | Configured root | Directory managed by the app. |
| `--username` | `admin` | Login username. |
| `--password` | Generated if unset | Login password. |
| `--lang` | Configured language (`en` by default) | Initial language: `vi`, `en`, or `zh`. |
| `--no-tunnel` | Off | Disable the primary Cloudflare Tunnel. |
| `--token` | Unset | Use a Cloudflare Named Tunnel token for the primary tunnel. |

`start_server.py` also accepts:

| Option | Default | Description |
|---|---:|---|
| `--foreground` | Off | Run attached to the current terminal and stream logs. Without it, launch in the background. |
| `--wait` | `300` seconds | Maximum time the background launcher waits for startup status. |

The two launchers support the same long options. `start_server.py` additionally provides short aliases for language, username, and password.

## Configuration

Copy `.env.example` to `.env` and edit the values before starting the app. CLI arguments override the corresponding environment values.

| Variable | Default | Description |
|---|---|---|
| `KAGGLE_DRIVE_ROOT` | `/` | Managed root directory. Choose a dedicated directory for local use. |
| `KAGGLE_DRIVE_HOST` | `127.0.0.1` | Web server bind address. |
| `KAGGLE_DRIVE_PORT` | `8000` | Web server port. |
| `KAGGLE_DRIVE_USERNAME` | `admin` | Login username. |
| `KAGGLE_DRIVE_PASSWORD` | Generated | Password generated at startup if unset. |
| `KAGGLE_DRIVE_LANG` | `en` | Initial language: `vi`, `en`, or `zh`. |
| `KAGGLE_DRIVE_SECRET_KEY` | Generated | Signing key for session cookies. |
| `SESSION_MAX_AGE` | `86400` | Session lifetime in seconds. |
| `ENABLE_CLOUDFLARE_TUNNEL` | `true` | Start the primary tunnel at application startup. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Empty | Optional named tunnel token for the primary tunnel. |
| `CLOUDFLARE_TUNNEL_URL` | Empty | Optional HTTPS URL to display when using a named tunnel. |
| `ENABLE_CODE_SERVER` | `true` | Enable the VS Code Web IDE when supported. |
| `CODE_SERVER_PORT` | `8081` | Private loopback port used by code-server. Must differ from the web server port. |
| `CODE_SERVER_VERSION` | `4.143.1` | Version downloaded by the Linux auto-installer. |
| `CODE_SERVER_BIN` | Auto-detected | Optional path to an existing code-server executable. |
| `KAGGLE_DRIVE_MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | Maximum size of an upload batch. |
| `KAGGLE_DRIVE_MAX_BINARY_SAVE_BYTES` | `104857600` (100 MiB) | Maximum size for binary editor saves. |
| `KAGGLE_DRIVE_MAX_TEXT_PREVIEW_BYTES` | `10485760` (10 MiB) | Maximum size for text previews. |
| `KAGGLE_DRIVE_MAX_REMOTE_DOWNLOAD_BYTES` | `5368709120` (5 GiB) | Maximum size for a URL download. |
| `KAGGLE_DRIVE_MAX_ARCHIVE_MEMBERS` | `100000` | Maximum entries extracted from an archive. |
| `KAGGLE_DRIVE_MAX_ARCHIVE_UNPACKED_BYTES` | `10737418240` (10 GiB) | Maximum total expanded size during extraction/compression. |

## Security notes

- All file operations are restricted to the configured root directory.
- Login attempts are rate-limited. Session cookies are signed and have a configurable lifetime; signing does not encrypt cookie contents.
- The app binds to loopback by default. Cloudflare Tunnel exposes the app through a public HTTPS URL when enabled.
- A Quick Tunnel URL is publicly reachable. Use a strong login password and keep credentials private.
- Ports Manager exposes the selected local service through a public tunnel. It does not add authentication to that service.

## Project layout

```text
app/
  main.py                         FastAPI setup, middleware, and shutdown lifecycle
  config.py                       Environment and runtime settings
  security.py                     Authentication and safe-path helpers
  routes/
    auth_routes.py                Login and session endpoints
    file_routes.py                File, upload, archive, and URL-download endpoints
    ide_routes.py                 Authenticated HTTP/WebSocket IDE proxy
    system_routes.py              System stats, ports, tunnels, and terminal endpoints
    view_routes.py                Web UI and public configuration
  services/
    file_service.py               Filesystem operations
    code_server_service.py        code-server lifecycle and Linux installer
    port_service.py               TCP listener scan and per-port tunnel control
    pty_terminal_service.py       Linux PTY terminal sessions
    system_service.py             CPU, memory, disk, and GPU metrics
    tunnel_service.py              Cloudflare Tunnel lifecycle
  static/
    css/main.css                  Interface styles
    js/                            Browser application modules
  templates/index.html             Single-page application
start_server.py                    Background/foreground launcher
stop_server.py                     Background server stop command
run.py                             Application and tunnel process launcher
requirements.txt                   Python dependencies
.env.example                       Configuration template
tests/test_file_server.py          File-server unit tests
```

## API documentation

When the server is running, FastAPI's interactive API docs are available at `/api/docs`. The health endpoint is `/health`.

## Tests

Run the repository's unit tests with:

```bash
python -m unittest discover -s tests
```

## License

MIT. See [LICENSE](LICENSE).
