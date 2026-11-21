# Kaggle Cloud Drive

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115%2B-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare_Tunnel-supported-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)
[![Languages](https://img.shields.io/badge/languages-Vietnamese%20%7C%20English%20%7C%20Chinese-blue?style=flat-square)](#features)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

Kaggle Cloud Drive is a browser-based file manager for Kaggle Notebooks and local development. It includes file upload and preview tools, a browser code and spreadsheet editor, an optional VS Code Web IDE, Linux PTY terminal sessions, system resource monitoring, and Cloudflare Tunnel controls.

The `coder` branch includes all `main` features and adds an optional code-server-powered VS Code Web IDE.

## Features

### File manager

- Browse directories in grid or list view, search names, navigate breadcrumbs, and optionally show hidden files.
- Upload files or select a folder. Folder uploads preserve relative paths and subdirectory structure. Some browsers ask for confirmation before uploading a selected folder.
- View upload progress. Batches larger than 80 MiB use sequential 8 MiB chunks; the default maximum batch size is 5 GiB.
- Download files, download a folder or selected items as ZIP, and create ZIP archives in the managed directory.
- Download a file from a public HTTP(S) URL directly to the managed directory. Private and local network destinations are rejected.
- Create files and folders, rename, duplicate, delete, and extract supported archives (ZIP, TAR, and RAR).
- Copy a cURL command for downloading a file from the server.

The default managed root is `/`. Use `--root` or `KAGGLE_DRIVE_ROOT` to limit the app to a narrower directory, especially during local development.

### File preview and spreadsheet editor

- Preview images, audio, video, PDF, Markdown, source code, plain text, and Jupyter notebooks.
- Preview and edit CSV, TSV, XLS, and XLSX files. Workbooks with multiple sheets can be switched in the viewer.
- Search spreadsheet rows, edit cells and column names, insert or delete rows and columns, copy table data, and save changes with the Save button or `Ctrl+S` / `Cmd+S`.
- Spreadsheet tables show 100 rows per page. The copy action copies up to 1,000 rows from the active sheet.

### Browser code editor

- Edit text and source files in a modal editor powered by Ace when its browser asset is available; a textarea editor is used as a fallback.
- Save with `Ctrl+S` or `Cmd+S`, change the font size, toggle line wrapping, and use fullscreen mode.
- The editor displays line count, file size, and cursor position, and warns before discarding unsaved changes.

### Ports Manager and Cloudflare Tunnel

- Scan local TCP listening ports that can be reached through `127.0.0.1`; display the port, address, process name when available, and tunnel state.
- Start or stop an on-demand Cloudflare Quick Tunnel for a listed port.
- Stop a local listener process from the port list; its active Cloudflare tunnel is stopped at the same time. The app confirms before stopping a process.
- Port 8000 is the web app's default port. Closing it stops Kaggle Cloud Drive and disconnects this session and its public URL.
- Quick Tunnels are intended for web/HTTP applications. Tunnel URLs are public; enable authentication in the target application when it handles private data.
- At startup, the app can create a primary tunnel automatically. It uses a Quick Tunnel unless a named tunnel token is configured.

### Terminal

- Open up to four terminal tabs. Each tab has its own shell, working directory, output, and connection.
- The interactive PTY terminal requires Linux, such as a Kaggle runtime. It is not supported on Windows.
- WebSocket heartbeats help keep idle connections alive. After unexpected disconnects, the client retries with increasing delays up to 30 seconds.
- Reconnection starts a new shell; the previous shell process and running commands do not resume.
- Minimize the terminal to keep tabs open. Closing the terminal window or signing out closes all sessions.

### VS Code Web IDE

- The optional IDE is powered by code-server and served through the authenticated `/ide/` route.
- On Linux, the app can download code-server on first start when no executable is configured. Internet access is required for that download.
- The code-server process listens on loopback and is proxied through the app's authenticated HTTP and WebSocket routes.
- If code-server cannot start, the file manager can continue without the IDE. Set `ENABLE_CODE_SERVER=false` to disable it.
- Automatic code-server installation is Linux-only. On Windows, use WSL or provide a compatible executable with `CODE_SERVER_BIN`.

### MySQL and phpMyAdmin

- The optional installer at `services/mysql/install_mysql_phpmyadmin.sh` installs MySQL and phpMyAdmin, configures Apache on port 8081, and redirects the Apache root to `/phpmyadmin/`.

### System monitor and language support

- View CPU and memory use, GPU status and VRAM when an NVIDIA GPU is available, and disk usage for the filesystem containing the managed root.
- The interface supports Vietnamese, English, and Simplified Chinese. Users can switch languages without reloading; the selected language is saved in the browser.

## Requirements

- Python 3.10 or newer.
- Internet access in the runtime is needed for Cloudflare Tunnel and for first-time downloads of Cloudflared. The browser also loads interface libraries, fonts, and icons from public CDNs.
- Linux is required for the interactive PTY terminal. Other file manager features run on Windows, macOS, and Linux.
- Run with `--no-tunnel` to disable the public tunnel.

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
git clone --branch coder https://github.com/conghoa004/kaggle_drive.git
cd kaggle_drive
pip install -r requirements.txt
python run.py --root ./workspace --port 8000 --lang en --no-tunnel
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The terminal requires Linux; the rest of the file manager can run on Windows and macOS.

## Command-line options

Both `run.py` and `start_server.py` accept these long options:

| Option | Default | Description |
|---|---|---|
| `--host` | `127.0.0.1` | Address for the web server to bind to. |
| `--port` | `8000` | Web server TCP port. |
| `--root` | Configured root (`/` by default) | Directory managed by the app. |
| `--username` | `admin` | Login username. |
| `--password` | Generated if unset | Login password. |
| `--lang` | `en` | Initial language: `vi`, `en`, or `zh`. |
| `--no-tunnel` | Off | Disable the primary Cloudflare Tunnel. |
| `--token` | Unset | Cloudflare Named Tunnel token for the primary tunnel. |

`start_server.py` additionally accepts:

| Option | Default | Description |
|---|---:|---|
| `--foreground` | Off | Attach to the server and stream output instead of starting in the background. |
| `--wait` | `300` seconds | Maximum time to wait for background startup status. |

`start_server.py` also provides the short aliases `-l`, `-u`, and `-p` for language, username, and password. `run.py` supports `-l` for language.

## Configuration

Copy `.env.example` to `.env` and edit it before starting the app. CLI options override the corresponding settings.

| Variable | Default | Description |
|---|---|---|
| `KAGGLE_DRIVE_ROOT` | `/` | Managed root directory. Set a narrower directory for local use. |
| `KAGGLE_DRIVE_HOST` | `127.0.0.1` | Web server bind address. |
| `KAGGLE_DRIVE_PORT` | `8000` | Web server port. |
| `KAGGLE_DRIVE_USERNAME` | `admin` | Login username. |
| `KAGGLE_DRIVE_PASSWORD` | Generated | Random password generated at startup if unset. |
| `KAGGLE_DRIVE_LANG` | `en` | Initial language: `vi`, `en`, or `zh`. |
| `KAGGLE_DRIVE_SECRET_KEY` | Generated | Key used to sign session cookies. Set it explicitly to preserve sessions across restarts. |
| `SESSION_MAX_AGE` | `86400` | Session lifetime in seconds (24 hours). |
| `ENABLE_CLOUDFLARE_TUNNEL` | `true` | Start a primary tunnel with the app. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Empty | Optional named tunnel token for the primary tunnel. |
| `CLOUDFLARE_TUNNEL_URL` | Empty | Optional HTTPS URL displayed for a named tunnel. |
| `KAGGLE_DRIVE_MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | Maximum upload batch size. |
| `KAGGLE_DRIVE_MAX_BINARY_SAVE_BYTES` | `104857600` (100 MiB) | Maximum size for binary editor saves. |
| `KAGGLE_DRIVE_MAX_TEXT_PREVIEW_BYTES` | `10485760` (10 MiB) | Maximum text content size. |
| `KAGGLE_DRIVE_MAX_REMOTE_DOWNLOAD_BYTES` | `5368709120` (5 GiB) | Maximum size for a URL download. |
| `KAGGLE_DRIVE_MAX_ARCHIVE_MEMBERS` | `100000` | Maximum archive entries to process. |
| `KAGGLE_DRIVE_MAX_ARCHIVE_UNPACKED_BYTES` | `10737418240` (10 GiB) | Maximum uncompressed archive size. |

## Security notes

- File routes resolve paths under the configured root and reject paths that escape it.
- Login attempts are rate-limited: five failed attempts in a 15-minute window trigger a 15-minute lockout.
- Session cookies are signed, not encrypted. The secret key is generated on startup if unset; existing sessions will no longer validate after a restart with a new key.
- The web server binds to loopback by default. Enabling Cloudflare Tunnel provides a public HTTPS URL; keep the generated credentials private.
- Ports Manager exposes a selected local service through a public tunnel. It does not add authentication to that service.
- URL downloads allow public HTTP(S) destinations and reject localhost or private network addresses.

## API and project layout

FastAPI's interactive API documentation is available at `/api/docs`, and the health endpoint is `/health`. Most file, system, and port endpoints require an authenticated session.

```text
app/
  main.py                         FastAPI application and shutdown lifecycle
  config.py                       Environment and runtime settings
  security.py                     Login checks and safe-path validation
  routes/
    auth_routes.py                Login and session endpoints
    file_routes.py                File, upload, archive, and URL-download endpoints
    system_routes.py              Stats, ports, tunnels, and terminal endpoints
    view_routes.py                Web UI, config, and health endpoints
  services/
    file_service.py               Filesystem operations
    port_service.py               TCP listener scan and per-port tunnel control
    pty_terminal_service.py        Linux PTY terminal sessions
    system_service.py              CPU, memory, disk, and GPU metrics
    tunnel_service.py              Cloudflare Tunnel lifecycle
  static/
    css/main.css                  Interface styles
    js/                            Browser application modules
  templates/index.html             Single-page application
run.py                             Application and primary tunnel launcher
start_server.py                    Background/foreground server launcher
stop_server.py                     Background server stop command
requirements.txt                   Python dependencies
.env.example                       Configuration template
tests/test_file_server.py          File-server unit tests
```

## Tests

The repository contains one unit test module:

```bash
python -m unittest discover -s tests
```

## License

MIT. See [LICENSE](LICENSE).
