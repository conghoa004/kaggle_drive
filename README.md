# Kaggle Cloud Drive

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115%2B-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare_Tunnel-supported-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)
[![Languages](https://img.shields.io/badge/languages-Vietnamese%20%7C%20English%20%7C%20Chinese-blue?style=flat-square)](#-system-monitor-and-language-support)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

A browser-based file manager and development toolkit built with **FastAPI**, designed for **Kaggle Notebooks** and local development environments. Kaggle Cloud Drive turns any managed directory into a fully featured web workspace — with file management, code editing, spreadsheet editing, an interactive Linux terminal, system monitoring, and Cloudflare Tunnel integration for instant public HTTPS access.

> This README describes the `main` branch. The `coder` branch additionally contains an optional code-server-powered VS Code Web IDE.

---

## Table of Contents

- [Features](#features)
  - [File Manager](#-file-manager)
  - [File Preview & Spreadsheet Editor](#-file-preview-and-spreadsheet-editor)
  - [Browser Code Editor](#-browser-code-editor)
  - [Ports Manager & Cloudflare Tunnel](#-ports-manager-and-cloudflare-tunnel)
  - [Interactive Terminal](#-interactive-terminal)
  - [System Monitor & Language Support](#-system-monitor-and-language-support)
- [Requirements](#requirements)
- [Getting Started](#getting-started)
  - [Kaggle Notebook](#kaggle-notebook)
  - [Local Development](#local-development)
- [Command-Line Options](#command-line-options)
- [Configuration](#configuration)
- [Security Notes](#security-notes)
- [Architecture](#architecture)
- [API Documentation](#api-documentation)
- [Project Layout](#project-layout)
- [Tests](#tests)
- [License](#license)

---

## Features

### 📁 File Manager

- Browse directories in **grid** or **list** view, search by filename, navigate breadcrumbs, and optionally show hidden files.
- **Upload** files or entire folders. Folder uploads preserve the relative directory structure. Batches larger than 80 MiB use sequential 8 MiB chunks; the default maximum batch size is **5 GiB**.
- **Download** individual files, download folders or selected items as ZIP archives, and create ZIP archives in the managed directory.
- **Download from URL** — save a file from any public HTTP(S) URL directly to the managed directory. Private and local network destinations are rejected.
- **Create** files and folders, **rename**, **duplicate** (copy/move), **delete**, and **extract** supported archives (ZIP, TAR, TAR.GZ, and RAR).
- Copy a **cURL command** for downloading a file from the server.
- Background file operations (copy, move, delete, compress, extract) run in a worker pool with **progress tracking** and **cooperative cancellation**.

The default managed root is `/` on Kaggle and `./workspace` elsewhere. Override it with `--root` or the `KAGGLE_DRIVE_ROOT` environment variable.

### 📄 File Preview and Spreadsheet Editor

- Preview **images**, **audio**, **video**, **PDF**, **Markdown**, **source code**, **plain text**, and **Jupyter notebooks** inline in the browser.
- Preview and edit **CSV**, **TSV**, **XLS**, and **XLSX** spreadsheet files. Multi-sheet workbooks support sheet switching.
- Search spreadsheet rows, edit cells and column names, insert or delete rows and columns, copy table data, and save changes with **Ctrl+S** / **Cmd+S**.
- Spreadsheet tables display 100 rows per page. The copy action copies up to 1,000 rows from the active sheet.

### ✏️ Browser Code Editor

- Edit text and source files in a modal editor powered by **Ace** (with a textarea fallback when the Ace browser asset is unavailable).
- Save with **Ctrl+S** / **Cmd+S**, adjust font size, toggle line wrapping, and use fullscreen mode.
- Displays line count, file size, and cursor position; warns before discarding unsaved changes.

### 🌐 Ports Manager and Cloudflare Tunnel

- **Scan** local TCP listening ports reachable via `127.0.0.1`; display port, address, process name, and tunnel state.
- **Start/stop** an on-demand **Cloudflare Quick Tunnel** for any listed port to get an instant public HTTPS URL.
- **Stop** a local listener process from the port list (its active Cloudflare Tunnel is closed automatically). The app confirms before stopping a process.
- Port `8000` is the web app's default port. Closing it stops Kaggle Cloud Drive.
- Quick Tunnels are intended for HTTP applications. Tunnel URLs are public — enable authentication in the target application when it handles private data.
- At startup, the app can create a **primary tunnel** automatically. It uses a Quick Tunnel unless a named tunnel token is configured via `--token` or `CLOUDFLARE_TUNNEL_TOKEN`.

### 🖥️ Interactive Terminal

- Open up to **10** terminal tabs. Each tab has its own shell, working directory, output, and connection.
- Full interactive **PTY** terminal (requires **Linux**, e.g. a Kaggle runtime; not supported on Windows).
- **WebSocket heartbeats** keep idle connections alive. After unexpected disconnects, the client retries with increasing delays up to 30 seconds.
- Sessions are indexed by authenticated username. The same shell can be open in multiple browsers simultaneously — all receive its output, and input from any browser goes to the shared shell. Disconnecting all browsers leaves the shell running until manually closed or the app stops.
- **Minimize** the terminal to keep tabs open. Closing the terminal window or signing out closes all sessions.

### 📊 System Monitor and Language Support

- View **CPU**, **RAM**, **GPU** status (NVIDIA GPUs with VRAM details when available), and **disk** usage for the filesystem containing the managed root.
- The interface supports **Vietnamese** 🇻🇳, **English** 🇺🇸, and **Simplified Chinese** 🇨🇳. Switch languages without reloading; the selection is saved in the browser.

---

## Requirements

- **Python 3.10** or newer (compatible with 3.10, 3.11, 3.12, and 3.13+).
- **Internet access** is needed for Cloudflare Tunnel and for first-time download of the Cloudflared binary. The browser loads interface libraries, fonts, and icons from public CDNs.
- **Linux** is required for the interactive PTY terminal. All other features (file manager, editor, preview, system monitor) run on **Windows**, **macOS**, and **Linux**.
- Use `--no-tunnel` to disable the public tunnel for local-only development.

---

## Getting Started

### Kaggle Notebook

Turn on **Internet** in the Kaggle Notebook settings to enable Cloudflare Tunnel and allow the runtime to download Cloudflared. In a notebook cell:

```python
import os

%cd /kaggle/working

PROJECT_DIR = "/kaggle/working/kaggle_drive"

# 1. Clone or update repository from GitHub
if not os.path.isdir(PROJECT_DIR):
    print("[*] Cloning repository from GitHub...")
    !git clone -b main https://github.com/conghoa004/kaggle_drive.git
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

### Local Development

Use a dedicated workspace directory rather than the default root:

```bash
git clone --branch main https://github.com/conghoa004/kaggle_drive.git
cd kaggle_drive
pip install -r requirements.txt
python run.py --root ./workspace --port 8000 --lang en --no-tunnel
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The terminal requires Linux; the rest of the file manager runs on Windows and macOS.

> **Tip:** If the dependencies are not installed, `run.py` will auto-install them on first launch.

---

## Command-Line Options

Both `run.py` and `start_server.py` accept these long options:

| Option | Default | Description |
|---|---|---|
| `--host` | `127.0.0.1` | Address for the web server to bind to. |
| `--port` | `8000` | Web server TCP port. |
| `--root` | `/` on Kaggle, `./workspace` elsewhere | Directory managed by the app. |
| `--username` | `admin` | Login username. |
| `--password` | Auto-generated if unset | Login password. |
| `--lang` | `en` | Initial UI language: `vi`, `en`, or `zh`. |
| `--no-tunnel` | Off | Disable the primary Cloudflare Tunnel. |
| `--token` | Unset | Cloudflare Named Tunnel token for the primary tunnel. |

`start_server.py` additionally accepts:

| Option | Default | Description |
|---|---|---|
| `--foreground` | Off | Attach to the server and stream output instead of starting in the background. |
| `--wait` | `300` seconds | Maximum time to wait for background startup status. |

**Short aliases:** `start_server.py` supports `-l`, `-u`, and `-p` for language, username, and password. `run.py` supports `-l` for language.

---

## Configuration

Copy `.env.example` to `.env` and edit it before starting the app. CLI options override the corresponding settings.

### Server & Authentication

| Variable | Default | Description |
|---|---|---|
| `KAGGLE_DRIVE_ROOT` | `/` on Kaggle, `./workspace` elsewhere | Managed root directory. |
| `KAGGLE_DRIVE_HOST` | `127.0.0.1` | Web server bind address. |
| `KAGGLE_DRIVE_PORT` | `8000` | Web server port. |
| `KAGGLE_DRIVE_USERNAME` | `admin` | Login username. |
| `KAGGLE_DRIVE_PASSWORD` | Auto-generated | Random password generated at startup if unset. |
| `KAGGLE_DRIVE_LANG` | `en` | Initial language: `vi`, `en`, or `zh`. |
| `KAGGLE_DRIVE_SECRET_KEY` | Auto-generated | Key used to sign session cookies. Set it explicitly to preserve sessions across restarts. |
| `SESSION_MAX_AGE` | `86400` (24 hours) | Session lifetime in seconds. |

### Cloudflare Tunnel

| Variable | Default | Description |
|---|---|---|
| `ENABLE_CLOUDFLARE_TUNNEL` | `true` | Start a primary tunnel with the app. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Empty | Optional named tunnel token for the primary tunnel. |
| `CLOUDFLARE_TUNNEL_URL` | Empty | Optional HTTPS URL displayed for a named tunnel. |

### Upload & File Limits

| Variable | Default | Description |
|---|---|---|
| `KAGGLE_DRIVE_MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | Maximum upload batch size. |
| `KAGGLE_DRIVE_MAX_BINARY_SAVE_BYTES` | `104857600` (100 MiB) | Maximum size for binary editor saves. |
| `KAGGLE_DRIVE_MAX_TEXT_PREVIEW_BYTES` | `10485760` (10 MiB) | Maximum text content size for editor/preview. |
| `KAGGLE_DRIVE_MAX_REMOTE_DOWNLOAD_BYTES` | `5368709120` (5 GiB) | Maximum size for a URL download. |
| `KAGGLE_DRIVE_MAX_ARCHIVE_MEMBERS` | `100000` | Maximum archive entries to process. |
| `KAGGLE_DRIVE_MAX_ARCHIVE_UNPACKED_BYTES` | `10737418240` (10 GiB) | Maximum uncompressed archive size. |
| `KAGGLE_DRIVE_MAX_ARCHIVE_METADATA_BYTES` | `67108864` (64 MiB) | Maximum ZIP central-directory and TAR metadata size. |

---

## Security Notes

- **Path traversal protection** — file routes resolve paths under the configured root and reject any path that escapes it.
- **Login rate limiting** — five failed attempts in a 15-minute window trigger a 15-minute lockout per client IP.
- **Constant-time credential verification** — prevents timing-based password guessing attacks.
- **Cross-origin request blocking** — API requests with an `Origin` header that doesn't match the `Host` header are rejected.
- **Request body size limits** — every endpoint enforces a per-route body size limit to prevent resource exhaustion.
- **Session cookies** are signed (not encrypted). The secret key is auto-generated on startup if unset; existing sessions will no longer validate after a restart with a new key.
- The web server binds to **loopback** by default. Enabling Cloudflare Tunnel provides a public HTTPS URL; keep the generated credentials private.
- **Ports Manager** exposes a selected local service through a public tunnel. It does not add authentication to that service.
- **URL downloads** allow public HTTP(S) destinations and reject localhost, private network, and link-local addresses.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (SPA)                       │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌─────┐ │
│  │ File │ │Editor│ │Sheet │ │Ports │ │Term  │ │Stats│ │
│  │Mgr   │ │      │ │Editor│ │Mgr   │ │(PTY) │ │Mon  │ │
│  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬──┘ │
└─────┼────────┼────────┼────────┼────────┼────────┼─────┘
      │ REST   │ REST   │ REST   │ REST   │  WS    │ REST
┌─────┴────────┴────────┴────────┴────────┴────────┴─────┐
│              FastAPI Application (Uvicorn)              │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Middleware: Session → AuthGate → BodyLimit     │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌────────────┐ ┌────────────┐ ┌───────────────────┐   │
│  │ auth_routes│ │ file_routes│ │  system_routes     │   │
│  │ view_routes│ │            │ │  (ports, terminal, │   │
│  │            │ │            │ │   stats)           │   │
│  └────────────┘ └─────┬──────┘ └────────┬──────────┘   │
│                       │                 │              │
│  ┌────────────────────┴──┐  ┌───────────┴──────────┐   │
│  │ file_service          │  │ port_service          │   │
│  │ file_operation_manager│  │ tunnel_service        │   │
│  │                       │  │ persistent_pty_service│   │
│  │                       │  │ system_service        │   │
│  └───────────────────────┘  └──────────────────────┘   │
└──────────────────────┬─────────────────────────────────┘
                       │
           ┌───────────┴───────────┐
           │  Cloudflare Tunnel    │
           │  (cloudflared binary) │
           └───────────────────────┘
```

---

## API Documentation

FastAPI's interactive **Swagger UI** documentation is available at `/api/docs`. The health endpoint at `/health` returns `{"status": "online", "service": "Kaggle Cloud Drive"}`.

### Key API Endpoints

| Group | Endpoint | Description |
|---|---|---|
| **Auth** | `POST /api/auth/login` | Authenticate with username and password |
| | `POST /api/auth/logout` | Invalidate the current session |
| | `GET /api/auth/me` | Check authentication status |
| **Files** | `GET /api/files` | List directory contents |
| | `POST /api/files/upload` | Upload files (single-request) |
| | `POST /api/files/upload/chunk` | Upload large files in chunks |
| | `GET /api/files/download` | Download a file |
| | `GET /api/files/download-zip` | Download a folder as ZIP |
| | `GET /api/files/content` | Read text file content |
| | `POST /api/files/content` | Save text file content |
| | `POST /api/files/save-binary` | Save binary file (base64) |
| | `POST /api/files/extract` | Extract an archive |
| | `POST /api/files/download-from-url` | Download from external URL |
| | `POST /api/files/operations` | Start a background file operation |
| **System** | `GET /api/system/stats` | CPU, RAM, disk, and GPU statistics |
| | `GET /api/system/ports` | List local TCP listeners |
| | `POST /api/system/ports/{port}/tunnel` | Start a tunnel for a port |
| | `WS /api/system/terminal/ws` | Interactive terminal WebSocket |
| **Config** | `GET /api/config` | Public app configuration |
| | `GET /health` | Health check |

Most file, system, and port endpoints require an **authenticated session**.

---

## Project Layout

```
kaggle_drive/
├── app/
│   ├── __init__.py
│   ├── main.py                          # FastAPI app factory, middleware, lifespan
│   ├── config.py                        # Environment and runtime settings (Settings class)
│   ├── security.py                      # Authentication, rate limiting, path validation
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── auth_routes.py               # Login, logout, session endpoints
│   │   ├── file_routes.py               # File, upload, archive, URL-download endpoints
│   │   ├── system_routes.py             # Stats, ports, tunnels, terminal endpoints
│   │   └── view_routes.py               # Web UI, config, health endpoints
│   ├── services/
│   │   ├── __init__.py
│   │   ├── file_service.py              # Filesystem operations (list, read, write, archive)
│   │   ├── file_operation_manager.py    # Background file operation worker pool
│   │   ├── file_operation_context.py    # Cooperative cancellation primitives
│   │   ├── port_service.py              # TCP listener scan and per-port tunnel control
│   │   ├── persistent_pty_service.py    # Linux PTY terminal sessions (WebSocket)
│   │   ├── system_service.py            # CPU, memory, disk, and GPU metrics
│   │   └── tunnel_service.py            # Cloudflare Tunnel lifecycle management
│   ├── static/
│   │   ├── css/main.css                 # Interface styles
│   │   └── js/                          # Browser application modules
│   │       ├── api.js                   # API client
│   │       ├── app.js                   # Application initialization
│   │       ├── editor.js                # Code editor integration
│   │       ├── i18n.js                  # Internationalization (vi/en/zh)
│   │       ├── preview.js               # File preview handlers
│   │       ├── ui.js                    # UI components and interactions
│   │       └── upload.js               # Upload with chunking logic
│   └── templates/
│       └── index.html                   # Single-page application template
├── tests/
│   └── test_file_server.py              # File-server unit tests
├── run.py                               # Application and primary tunnel launcher
├── start_server.py                      # Background/foreground server launcher
├── stop_server.py                       # Background server stop command
├── requirements.txt                     # Python dependencies
├── .env.example                         # Configuration template
└── LICENSE                              # MIT License
```

---

## Tests

Run the unit test suite:

```bash
python -m unittest discover -s tests
```

---

## License

MIT — see [LICENSE](LICENSE).
