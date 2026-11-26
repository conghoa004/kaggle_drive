import hashlib
import ipaddress
import json
import os
import re
import time
import base64
import errno
import shutil
import socket
import stat as stat_module
import threading
import tempfile
import tarfile
import zipfile
import urllib.request
import http.client
from urllib.parse import urlsplit, urljoin, unquote
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
from fastapi import HTTPException, UploadFile, status

from app.config import settings
from app.security import get_root_dir, get_safe_path, get_safe_path_entry
from app.services.file_operation_context import OperationCancelledError, check_cancelled

# Extended MIME types and category classification
EXTENSION_CATEGORIES = {
    # Images
    "jpg": "image", "jpeg": "image", "png": "image", "gif": "image",
    "webp": "image", "svg": "image", "bmp": "image", "ico": "image",
    "avif": "image", "tiff": "image", "tif": "image",
    # Video
    "mp4": "video", "webm": "video", "mkv": "video", "avi": "video",
    "mov": "video", "flv": "video", "wmv": "video", "m4v": "video",
    # Audio
    "mp3": "audio", "wav": "audio", "ogg": "audio", "flac": "audio",
    "m4a": "audio", "aac": "audio", "wma": "audio", "opus": "audio",
    # Code & Notebooks
    "py": "code", "ipynb": "notebook", "js": "code", "ts": "code",
    "html": "code", "css": "code", "json": "code", "yaml": "code",
    "yml": "code", "sh": "code", "bash": "code", "sql": "code",
    "c": "code", "cpp": "code", "h": "code", "java": "code",
    "rs": "code", "go": "code", "r": "code",
    # Text & Documents
    "txt": "text", "md": "markdown", "log": "text", "ini": "text",
    "conf": "text", "env": "text", "pdf": "pdf",
    # Spreadsheets & Data
    "csv": "spreadsheet", "tsv": "spreadsheet", "xlsx": "spreadsheet", "xls": "spreadsheet",
    "parquet": "data", "pkl": "data", "h5": "data", "pt": "data", "pth": "data", "bin": "data",
    "safetensors": "data", "onnx": "data",
    # Archives
    "zip": "archive", "tar": "archive", "gz": "archive", "tgz": "archive",
    "bz2": "archive", "rar": "archive"
}

MEDIA_MIMETYPES = {
    # Images
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
    "webp": "image/webp", "svg": "image/svg+xml", "bmp": "image/bmp", "ico": "image/x-icon",
    "tiff": "image/tiff", "tif": "image/tiff", "avif": "image/avif",
    # Audio
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "flac": "audio/flac",
    "m4a": "audio/mp4", "aac": "audio/aac", "wma": "audio/x-ms-wma", "opus": "audio/opus",
    # Video
    "mp4": "video/mp4", "webm": "video/webm", "mkv": "video/webm",
    "avi": "video/x-msvideo", "mov": "video/quicktime", "flv": "video/x-flv", "m4v": "video/mp4",
    # Documents & Spreadsheets
    "pdf": "application/pdf",
    "csv": "text/csv; charset=utf-8",
    "tsv": "text/tab-separated-values; charset=utf-8",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel"
}

UPLOAD_CHUNK_TTL_SECONDS = 24 * 60 * 60
UPLOAD_CHUNK_CLEANUP_INTERVAL_SECONDS = 60 * 60
_UPLOAD_CHUNK_DIRECTORIES: Dict[Path, float] = {}
_UPLOAD_CHUNK_DIRECTORIES_LOCK = threading.Lock()
_UPLOAD_CHUNK_DIRECTORY_REGISTRY_LOADED = False
_CANCELLED_UPLOAD_CHUNK_IDS: Dict[str, float] = {}
_CANCELLED_UPLOAD_CHUNK_IDS_LOCK = threading.Lock()


def _is_upload_chunk_cancelled(upload_id: str) -> bool:
    now = time.time()
    with _CANCELLED_UPLOAD_CHUNK_IDS_LOCK:
        for cancelled_id, expires_at in list(_CANCELLED_UPLOAD_CHUNK_IDS.items()):
            if expires_at <= now:
                _CANCELLED_UPLOAD_CHUNK_IDS.pop(cancelled_id, None)
        return upload_id in _CANCELLED_UPLOAD_CHUNK_IDS


def _mark_upload_chunk_cancelled(upload_id: str) -> None:
    now = time.time()
    with _CANCELLED_UPLOAD_CHUNK_IDS_LOCK:
        for cancelled_id, expires_at in list(_CANCELLED_UPLOAD_CHUNK_IDS.items()):
            if expires_at <= now:
                _CANCELLED_UPLOAD_CHUNK_IDS.pop(cancelled_id, None)
        if (
            upload_id not in _CANCELLED_UPLOAD_CHUNK_IDS
            and len(_CANCELLED_UPLOAD_CHUNK_IDS) >= 4096
        ):
            oldest_id = min(
                _CANCELLED_UPLOAD_CHUNK_IDS,
                key=_CANCELLED_UPLOAD_CHUNK_IDS.get,
            )
            _CANCELLED_UPLOAD_CHUNK_IDS.pop(oldest_id, None)
        _CANCELLED_UPLOAD_CHUNK_IDS[upload_id] = now + UPLOAD_CHUNK_TTL_SECONDS


def _upload_chunk_directory_registry_path() -> Path:
    root = get_root_dir().resolve()
    root_hash = hashlib.sha256(os.fsencode(str(root))).hexdigest()
    return Path(tempfile.gettempdir()) / f"kaggle-drive-upload-chunks-{root_hash}.json"


def _load_upload_chunk_directories_locked() -> None:
    """Load persisted upload directories once, accepting paths inside ROOT_DIR only."""
    global _UPLOAD_CHUNK_DIRECTORY_REGISTRY_LOADED
    if _UPLOAD_CHUNK_DIRECTORY_REGISTRY_LOADED:
        return
    _UPLOAD_CHUNK_DIRECTORY_REGISTRY_LOADED = True

    try:
        with _upload_chunk_directory_registry_path().open("r", encoding="utf-8") as registry_file:
            directories = json.load(registry_file)
    except (OSError, ValueError):
        return
    if not isinstance(directories, list):
        return

    root = get_root_dir().resolve()
    now = time.monotonic()
    for value in directories:
        if not isinstance(value, str):
            continue
        try:
            directory = Path(value).resolve()
            directory.relative_to(root)
        except (OSError, ValueError):
            continue
        _UPLOAD_CHUNK_DIRECTORIES[directory] = now


def _persist_upload_chunk_directories_locked() -> None:
    """Atomically persist the current directory set without blocking uploads on errors."""
    registry_path = _upload_chunk_directory_registry_path()
    temporary_path = None
    try:
        payload = sorted(str(directory) for directory in _UPLOAD_CHUNK_DIRECTORIES)
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{registry_path.name}.", suffix=".tmp", dir=registry_path.parent
        )
        temporary_path = Path(temporary_name)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as registry_file:
            json.dump(payload, registry_file)
            registry_file.flush()
            os.fsync(registry_file.fileno())
        os.replace(temporary_path, registry_path)
    except OSError:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def _validate_file_operation_tree(root: Path, cancel_event=None) -> None:
    """Reject special entries before mutating a tree."""
    check_cancelled(cancel_event)
    if root.is_symlink():
        return

    try:
        root_mode = root.stat(follow_symlinks=False).st_mode
    except OSError as exc:
        raise HTTPException(status_code=403, detail=f"Could not inspect the selected path: {exc}")

    if stat_module.S_ISREG(root_mode):
        return
    if not stat_module.S_ISDIR(root_mode):
        raise HTTPException(status_code=400, detail="Special files cannot be copied, moved, or deleted.")

    pending = [root]
    while pending:
        check_cancelled(cancel_event)
        directory = pending.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    check_cancelled(cancel_event)
                    child = Path(entry.path)
                    try:
                        mode = entry.stat(follow_symlinks=False).st_mode
                    except OSError as exc:
                        raise HTTPException(
                            status_code=403,
                            detail=f"Could not inspect '{child.name}': {exc}",
                        )
                    if stat_module.S_ISLNK(mode):
                        continue
                    if stat_module.S_ISDIR(mode):
                        pending.append(child)
                    elif not stat_module.S_ISREG(mode):
                        raise HTTPException(
                            status_code=400,
                            detail="Directories containing special files cannot be modified.",
                        )
        except HTTPException:
            raise
        except OSError as exc:
            raise HTTPException(status_code=403, detail=f"Could not inspect directory: {exc}")
    check_cancelled(cancel_event)


def _path_identity(path: Path):
    metadata = path.lstat()
    return metadata.st_dev, metadata.st_ino


def _remove_owned_path(path: Path, identity) -> None:
    """Remove a partial destination only while it is still the entry we created."""
    if identity is None:
        return
    try:
        metadata = path.lstat()
        if (metadata.st_dev, metadata.st_ino) != identity:
            return
        if stat_module.S_ISDIR(metadata.st_mode):
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _remove_owned_empty_directory(path: Path, identity) -> None:
    """Remove only our still-empty directory reservation."""
    if identity is None:
        return
    try:
        metadata = path.lstat()
        if (
            (metadata.st_dev, metadata.st_ino) == identity
            and stat_module.S_ISDIR(metadata.st_mode)
        ):
            path.rmdir()
    except OSError:
        pass


def _publish_without_overwrite(source: Path, destination: Path) -> None:
    """Move a staged regular file into destination without overwriting."""
    if os.name == "nt":
        source.rename(destination)
        return
    try:
        os.link(source, destination, follow_symlinks=False)
    except FileExistsError:
        raise
    except OSError as exc:
        if exc.errno not in {
            errno.EXDEV,
            errno.EPERM,
            errno.EACCES,
            getattr(errno, "EOPNOTSUPP", errno.EPERM),
            getattr(errno, "ENOTSUP", errno.EPERM),
            errno.EINVAL,
        }:
            raise
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST), str(destination))
        source.replace(destination)
        return
    source.unlink()


def _rename_without_overwrite(source: Path, destination: Path) -> None:
    """Rename an entry without replacing a path created concurrently."""
    if source.is_symlink() and os.name != "nt":
        os.symlink(
            os.readlink(source),
            destination,
            target_is_directory=source.is_dir(),
        )
        source.unlink()
        return

    if source.is_dir() and not source.is_symlink():
        reservation_identity = None
        try:
            destination.mkdir()
            reservation_identity = _path_identity(destination)
            if os.name == "nt":
                destination.rmdir()
                reservation_identity = None
            source.rename(destination)
        except Exception:
            _remove_owned_empty_directory(destination, reservation_identity)
            raise
        return

    _publish_without_overwrite(source, destination)


def _is_regular_archive_file(path: Path) -> bool:
    if path.is_symlink():
        return False
    try:
        return (
            stat_module.S_ISREG(path.stat(follow_symlinks=False).st_mode)
            and os.access(path, os.R_OK)
        )
    except OSError:
        return False


def _iter_archive_entries(root: Path, cancel_event=None):
    """Yield visible regular files and leaf directories that would otherwise be lost."""
    check_cancelled(cancel_event)

    def ignore_walk_error(_error):
        return None

    empty_directories = []
    for directory, subdirectories, filenames in os.walk(
        root, topdown=True, onerror=ignore_walk_error, followlinks=False
    ):
        check_cancelled(cancel_event)
        directory_path = Path(directory)
        visible_subdirectories = []
        for name in subdirectories:
            check_cancelled(cancel_event)
            child = directory_path / name
            if not name.startswith(".") and not child.is_symlink():
                visible_subdirectories.append(name)
        subdirectories[:] = visible_subdirectories
        has_regular_file = False
        for filename in filenames:
            check_cancelled(cancel_event)
            path = directory_path / filename
            relative = path.relative_to(root)
            if any(part.startswith(".") for part in relative.parts):
                continue
            if _is_regular_archive_file(path):
                has_regular_file = True
                yield path, False
        if directory_path != root and not visible_subdirectories and not has_regular_file:
            empty_directories.append(directory_path)

    for directory in empty_directories:
        check_cancelled(cancel_event)
        yield directory, True


def _cleanup_stale_upload_chunk_files(directory: Path, now: Optional[float] = None) -> bool:
    """Remove expired partial uploads; return whether recent partials remain."""
    cutoff = (time.time() if now is None else now) - UPLOAD_CHUNK_TTL_SECONDS
    has_recent_chunks = False
    try:
        candidates = directory.glob(".upload-*.part")
        for candidate in candidates:
            try:
                if candidate.is_symlink():
                    continue
                metadata = candidate.stat(follow_symlinks=False)
                if not stat_module.S_ISREG(metadata.st_mode):
                    continue
                if metadata.st_mtime <= cutoff:
                    candidate.unlink()
                else:
                    has_recent_chunks = True
            except OSError:
                has_recent_chunks = True
    except OSError:
        return False
    return has_recent_chunks


def _register_upload_chunk_directory(directory: Path) -> None:
    directory = directory.resolve()
    now = time.monotonic()
    with _UPLOAD_CHUNK_DIRECTORIES_LOCK:
        _load_upload_chunk_directories_locked()
        last_registered = _UPLOAD_CHUNK_DIRECTORIES.get(directory)
        _UPLOAD_CHUNK_DIRECTORIES[directory] = now
        if last_registered is None or now - last_registered >= 60:
            _persist_upload_chunk_directories_locked()
    if last_registered is None or now - last_registered >= 60:
        _cleanup_stale_upload_chunk_files(directory)


def format_size(bytes_num: int) -> str:
    """Format file size into human-readable string."""
    if bytes_num < 1024:
        return f"{bytes_num} B"
    elif bytes_num < 1024 * 1024:
        return f"{bytes_num / 1024:.1f} KB"
    elif bytes_num < 1024 * 1024 * 1024:
        return f"{bytes_num / (1024 * 1024):.1f} MB"
    else:
        return f"{bytes_num / (1024 * 1024 * 1024):.2f} GB"


def _path_to_api(path: Path) -> str:
    """Serialize native paths using slash separators without altering POSIX names."""
    return path.as_posix()


def _unique_archive_root_names(targets: List[Path]) -> List[str]:
    """Give each selected archive root a distinct, extraction-safe name."""
    used_names = set()
    unique_names = []

    for target in targets:
        original_name = target.name
        stem, suffix = os.path.splitext(original_name)
        candidate = original_name
        counter = 1
        while os.path.normcase(os.path.normpath(candidate)) in used_names:
            candidate = f"{stem}_copy{counter}{suffix}"
            counter += 1
        used_names.add(os.path.normcase(os.path.normpath(candidate)))
        unique_names.append(candidate)

    return unique_names


def get_file_category(extension: str) -> str:
    """Determine UI category for icon and previewer."""
    return EXTENSION_CATEGORIES.get(extension.lower(), "generic")


def _is_invalid_rar_error(exc: Exception) -> bool:
    """Identify an invalid RAR header without making rarfile mandatory."""
    try:
        import rarfile
    except ImportError:
        return False
    return isinstance(exc, rarfile.NotRarFile)


MAX_EXTRACT_REVIEW_PATHS = 1000
MAX_ARCHIVE_METADATA_HEADER_BYTES = 1024 * 1024


def _overwrite_required(paths: List[str], max_paths: int = 10) -> HTTPException:
    unique_paths = sorted(set(paths))
    return HTTPException(
        status_code=409,
        detail={
            "code": "overwrite_required",
            "paths": unique_paths[:max_paths],
            "count": len(unique_paths),
            "message": "One or more destination files already exist.",
        },
    )


def _resolve_upload_destination(base_folder: Path, relative_filename: str) -> Path:
    raw_name = relative_filename or ""
    if os.name == "nt":
        raw_name = raw_name.replace("\\", "/")
    parts = [part for part in raw_name.split("/") if part not in ("", ".")]
    if raw_name.startswith("/") or not parts or any(
        part == ".." or ":" in part for part in parts
    ):
        raise HTTPException(status_code=400, detail="Invalid upload filename.")

    dest_path = base_folder.joinpath(*parts).resolve()
    try:
        dest_path.relative_to(base_folder.resolve())
        dest_path.relative_to(get_root_dir().resolve())
    except ValueError:
        raise HTTPException(
            status_code=403, detail="Upload destination escapes the configured root."
        )
    return dest_path


class FileService:

    @staticmethod
    def cleanup_stale_upload_chunks() -> None:
        """Periodically clean expired chunks in directories used for uploads."""
        with _UPLOAD_CHUNK_DIRECTORIES_LOCK:
            _load_upload_chunk_directories_locked()
            directories = list(_UPLOAD_CHUNK_DIRECTORIES.items())
        now = time.time()
        for directory, last_registered in directories:
            if _cleanup_stale_upload_chunk_files(directory, now):
                continue
            with _UPLOAD_CHUNK_DIRECTORIES_LOCK:
                if _UPLOAD_CHUNK_DIRECTORIES.get(directory) == last_registered:
                    _UPLOAD_CHUNK_DIRECTORIES.pop(directory, None)
                    _persist_upload_chunk_directories_locked()

    @staticmethod
    def register_upload_chunk_directory(directory: Path) -> None:
        _register_upload_chunk_directory(directory)

    @staticmethod
    def is_upload_chunk_cancelled(upload_id: str) -> bool:
        return _is_upload_chunk_cancelled(upload_id)

    @staticmethod
    def mark_upload_chunk_cancelled(upload_id: str) -> None:
        _mark_upload_chunk_cancelled(upload_id)

    @staticmethod
    def cancel_upload_chunks(target_folder_rel: str, uploads: List[Dict[str, str]]) -> int:
        """Mark in-flight chunk IDs cancelled and remove their partial files."""
        base_folder = get_safe_path(target_folder_rel, must_exist=True)
        if not base_folder.is_dir():
            raise HTTPException(status_code=400, detail="Upload destination must be a directory.")

        removed = 0
        for upload in uploads:
            destination = _resolve_upload_destination(
                base_folder, upload.get("relative_path", "")
            )
            upload_id = upload.get("upload_id", "")
            _mark_upload_chunk_cancelled(upload_id)
            chunk_path = destination.with_name(f".upload-{upload_id}.part")
            existed = chunk_path.exists() or chunk_path.is_symlink()
            chunk_path.unlink(missing_ok=True)
            removed += int(existed)
        return removed

    @staticmethod
    def list_directory(rel_path: str = "", show_hidden: bool = False) -> Dict[str, Any]:
        """List files and folders in the target directory."""
        folder = get_safe_path(rel_path, must_exist=True)
        if not folder.is_dir():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Đường dẫn chỉ định không phải là một thư mục."
            )

        _cleanup_stale_upload_chunk_files(folder)
        items = []
        try:
            for item in folder.iterdir():
                if not show_hidden and item.name.startswith("."):
                    continue

                is_dir = item.is_dir()
                try:
                    stat = item.stat()
                    size = stat.st_size if not is_dir else 0
                    mtime = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                except OSError:
                    size = 0
                    mtime = "-"

                ext = item.suffix.lstrip(".") if not is_dir else ""
                category = "folder" if is_dir else get_file_category(ext)

                rel_item_path = _path_to_api(item.relative_to(get_root_dir()))

                items.append({
                    "name": item.name,
                    "path": rel_item_path,
                    "is_dir": is_dir,
                    "size": size,
                    "formatted_size": "—" if is_dir else format_size(size),
                    "mtime": mtime,
                    "extension": ext.lower(),
                    "category": category,
                })
        except PermissionError:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Không có quyền truy cập vào thư mục này."
            )

        # Sort: Folders first, then alphabetically case-insensitive
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

        # Determine parent path
        clean_rel = Path(rel_path).as_posix().strip("/") if rel_path else ""
        parent_path = Path(clean_rel).parent.as_posix() if clean_rel else None
        if parent_path == ".":
            parent_path = ""

        return {
            "current_path": clean_rel,
            "root_dir": str(get_root_dir()),
            "parent_path": parent_path,
            "folder_name": folder.name if clean_rel else "working",
            "items": items,
            "total_items": len(items)
        }

    @staticmethod
    def read_text_file(rel_path: str) -> Dict[str, Any]:
        """Read text file content for the code/text editor."""
        file_path = get_safe_path(rel_path, must_exist=True)
        if not file_path.is_file():
            raise HTTPException(status_code=400, detail="Không phải tệp tin.")

        file_size = file_path.stat().st_size
        if file_size > settings.MAX_TEXT_PREVIEW_SIZE:
            raise HTTPException(
                status_code=400,
                detail=f"Tệp quá lớn ({format_size(file_size)}) để mở trong trình chỉnh sửa web (tối đa 10MB)."
            )

        try:
            raw_content = file_path.read_bytes()
            if b"\x00" in raw_content:
                raise HTTPException(status_code=400, detail="Binary files cannot be edited as text.")
        except HTTPException:
            raise
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Could not read file: {exc}")

        crlf_count = raw_content.count(b"\r\n")
        content_without_crlf = raw_content.replace(b"\r\n", b"")
        lf_count = content_without_crlf.count(b"\n")
        cr_count = content_without_crlf.count(b"\r")
        newline = max(
            ((crlf_count, "\r\n"), (lf_count, "\n"), (cr_count, "\r")),
            key=lambda item: item[0],
        )[1]
        if crlf_count == 0 and lf_count == 0 and cr_count == 0:
            newline = "\n"

        # Attempt UTF-8 then fallback to Latin-1
        try:
            content = raw_content.decode("utf-8")
            encoding = "utf-8"
        except UnicodeDecodeError:
            try:
                content = raw_content.decode("latin-1")
                encoding = "latin-1"
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Không thể đọc mã hóa của tệp: {str(e)}")

        content = content.replace("\r\n", "\n").replace("\r", "\n")

        ext = file_path.suffix.lstrip(".").lower()
        return {
            "name": file_path.name,
            "path": rel_path,
            "content": content,
            "size": file_size,
            "extension": ext,
            "encoding": encoding,
            "newline": newline,
            "category": get_file_category(ext)
        }

    @staticmethod
    def write_text_file(
        rel_path: str,
        content: str,
        encoding: str = "utf-8",
        newline: str = "\n",
    ) -> Dict[str, Any]:
        """Save edited text atomically within the configured byte limit."""
        file_path = get_safe_path(rel_path, must_exist=False)
        if encoding not in {"utf-8", "latin-1"}:
            raise HTTPException(status_code=400, detail="Unsupported text encoding.")
        if newline not in {"\n", "\r\n", "\r"}:
            raise HTTPException(status_code=400, detail="Unsupported line ending format.")

        normalized_content = content.replace("\r\n", "\n").replace("\r", "\n")
        formatted_content = normalized_content.replace("\n", newline)
        try:
            payload = formatted_content.encode(encoding)
        except UnicodeEncodeError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Content contains characters that cannot be saved using {encoding}.",
            ) from exc
        if len(payload) > settings.MAX_TEXT_PREVIEW_SIZE:
            raise HTTPException(status_code=413, detail="Text content exceeds the configured size limit.")

        file_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=file_path.parent, prefix=".save-", delete=False
            ) as temp_file:
                temp_path = Path(temp_file.name)
                temp_file.write(payload)
            os.replace(temp_path, file_path)
        except Exception as exc:
            if temp_path:
                temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Could not save file: {exc}")

        return {
            "status": "success",
            "message": "File saved.",
            "size": file_path.stat().st_size,
        }

    @staticmethod
    def write_binary_file(rel_path: str, content_b64: str) -> Dict[str, Any]:
        """Decode and atomically save bounded base64 binary content."""
        encoded_limit = ((settings.MAX_BINARY_SAVE_BYTES + 2) // 3) * 4
        if len(content_b64) > encoded_limit:
            raise HTTPException(status_code=413, detail="Binary content exceeds the configured size limit.")
        try:
            payload = base64.b64decode(content_b64, validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid base64 data: {exc}")
        if len(payload) > settings.MAX_BINARY_SAVE_BYTES:
            raise HTTPException(status_code=413, detail="Binary content exceeds the configured size limit.")

        file_path = get_safe_path(rel_path, must_exist=False)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=file_path.parent, prefix=".save-", delete=False
            ) as temp_file:
                temp_path = Path(temp_file.name)
                temp_file.write(payload)
            os.replace(temp_path, file_path)
        except Exception as exc:
            if temp_path:
                temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Could not save binary file: {exc}")

        return {
            "status": "success",
            "message": "Binary file saved.",
            "size": file_path.stat().st_size,
        }

    @staticmethod
    def get_upload_conflicts(
        target_folder_rel: str, relative_filenames: List[str]
    ) -> List[str]:
        """Return existing files and duplicate names in an upload batch."""
        base_folder = get_safe_path(target_folder_rel, must_exist=True)
        if not base_folder.is_dir():
            raise HTTPException(status_code=400, detail="Upload destination must be a directory.")

        conflicts = []
        seen = set()
        root = get_root_dir().resolve()
        for relative_filename in relative_filenames:
            dest_path = _resolve_upload_destination(base_folder, relative_filename)
            if dest_path.is_dir():
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "path_conflict",
                        "message": "An upload destination is an existing directory.",
                    },
                )
            key = os.path.normcase(os.path.normpath(str(dest_path)))
            relative_path = _path_to_api(dest_path.relative_to(root))
            if key in seen:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "path_conflict",
                        "message": "Upload contains duplicate destination paths.",
                    },
                )
            parent = dest_path.parent
            base_root = base_folder.resolve()
            while parent != base_root:
                if parent.exists() and not parent.is_dir():
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "path_conflict",
                            "message": "Upload path conflicts with an existing file.",
                        },
                    )
                parent_key = os.path.normcase(os.path.normpath(str(parent)))
                if parent_key in seen:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "path_conflict",
                            "message": "Upload paths conflict with each other.",
                        },
                    )
                parent = parent.parent
            prefix = key + os.sep
            if any(existing.startswith(prefix) for existing in seen):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "path_conflict",
                        "message": "Upload paths conflict with each other.",
                    },
                )
            if dest_path.exists():
                conflicts.append(relative_path)
            seen.add(key)
        return sorted(set(conflicts))

    @staticmethod
    def save_uploaded_file(
        target_folder_rel: str,
        upload_file: UploadFile,
        relative_filename: Optional[str] = None,
        max_bytes: Optional[int] = None,
        overwrite: bool = False,
        overwrite_paths: Optional[List[str]] = None,
        skip_paths: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Stream a bounded upload to a temporary file and atomically publish it."""
        base_folder = get_safe_path(target_folder_rel, must_exist=True)
        if not base_folder.is_dir():
            raise HTTPException(status_code=400, detail="Upload destination must be a directory.")

        raw_name = relative_filename or upload_file.filename or "uploaded_file"
        dest_path = _resolve_upload_destination(base_folder, raw_name)
        if dest_path.is_dir():
            raise HTTPException(
                status_code=409,
                detail={"code": "path_conflict", "message": "An upload destination is an existing directory."},
            )
        relative_dest = _path_to_api(dest_path.relative_to(get_root_dir().resolve()))
        if relative_dest in set(skip_paths or []):
            upload_file.file.close()
            return {"filename": dest_path.name, "path": relative_dest, "skipped": True}
        overwrite_this = overwrite or relative_dest in set(overwrite_paths or [])
        if dest_path.exists() and not overwrite_this:
            relative_path = _path_to_api(dest_path.relative_to(get_root_dir().resolve()))
            raise _overwrite_required([relative_path])

        dest_path.parent.mkdir(parents=True, exist_ok=True)
        limit = settings.MAX_UPLOAD_BYTES if max_bytes is None else min(
            max_bytes, settings.MAX_UPLOAD_BYTES
        )
        temp_path = None
        bytes_written = 0
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=dest_path.parent, prefix=".upload-", delete=False
            ) as output:
                temp_path = Path(output.name)
                while True:
                    chunk = upload_file.file.read(settings.CHUNK_SIZE)
                    if not chunk:
                        break
                    if bytes_written + len(chunk) > limit:
                        raise HTTPException(
                            status_code=413, detail="Upload exceeds the configured size limit."
                        )
                    output.write(chunk)
                    bytes_written += len(chunk)
            if overwrite_this:
                os.replace(temp_path, dest_path)
            else:
                try:
                    _publish_without_overwrite(temp_path, dest_path)
                except FileExistsError:
                    relative_path = _path_to_api(dest_path.relative_to(get_root_dir().resolve()))
                    raise _overwrite_required([relative_path])
            temp_path = None
        except HTTPException:
            if temp_path:
                temp_path.unlink(missing_ok=True)
            raise
        except Exception as exc:
            if temp_path:
                temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Could not save uploaded file: {exc}")
        finally:
            upload_file.file.close()

        return {
            "filename": dest_path.name,
            "path": _path_to_api(dest_path.relative_to(get_root_dir().resolve())),
            "size": bytes_written,
            "formatted_size": format_size(bytes_written),
        }

    @staticmethod
    def create_directory(rel_path: str) -> Dict[str, Any]:
        """Create a new directory."""
        target = get_safe_path(rel_path, must_exist=False)
        if target.exists():
            raise HTTPException(status_code=400, detail="Thư mục hoặc tệp tin đã tồn tại.")

        target.mkdir(parents=True, exist_ok=True)
        return {"status": "success", "message": f"Đã tạo thư mục '{target.name}'"}

    @staticmethod
    def create_empty_file(rel_path: str) -> Dict[str, Any]:
        """Create an empty new file."""
        target = get_safe_path(rel_path, must_exist=False)
        if target.exists():
            raise HTTPException(status_code=400, detail="Tệp tin đã tồn tại.")

        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()
        return {"status": "success", "message": f"Đã tạo tệp '{target.name}'"}

    @staticmethod
    def delete_item(rel_path: str, cancel_event=None) -> Dict[str, Any]:
        """Delete a file or recursively delete a directory."""
        target = get_safe_path_entry(rel_path, must_exist=True)

        # Prevent deleting ROOT_DIR itself
        if not target.is_symlink() and target.resolve() == get_root_dir().resolve():
            raise HTTPException(status_code=403, detail="Không thể xóa thư mục gốc!")

        _validate_file_operation_tree(target, cancel_event)

        def remove_path(path: Path) -> None:
            check_cancelled(cancel_event)
            if path.is_symlink() or not path.is_dir():
                path.unlink()
                return
            with os.scandir(path) as entries:
                for entry in entries:
                    check_cancelled(cancel_event)
                    remove_path(Path(entry.path))
            check_cancelled(cancel_event)
            path.rmdir()

        try:
            remove_path(target)
        except OperationCancelledError:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Không thể xóa: {str(e)}")

        return {"status": "success", "message": f"Đã xóa '{target.name}'"}

    @staticmethod
    def rename_item(rel_path: str, new_name: str) -> Dict[str, Any]:
        """Rename a file or folder safely within its parent directory."""
        target = get_safe_path_entry(rel_path, must_exist=True)
        if not target.is_symlink() and target.resolve() == get_root_dir().resolve():
            raise HTTPException(status_code=403, detail="Cannot rename the configured root directory.")

        # Sanitize new_name to avoid path injection
        clean_new_name = os.path.basename(new_name)
        if not clean_new_name or clean_new_name in (".", ".."):
            raise HTTPException(status_code=400, detail="Tên mới không hợp lệ.")

        new_target = target.parent / clean_new_name
        if new_target.exists() or new_target.is_symlink():
            raise HTTPException(status_code=400, detail="Tên mới đã tồn tại.")

        try:
            _rename_without_overwrite(target, new_target)
        except Exception as e:
            if isinstance(e, FileExistsError):
                raise HTTPException(status_code=409, detail="The new name already exists.") from e
            raise HTTPException(status_code=500, detail=f"Lỗi đổi tên: {str(e)}")

        new_rel_path = _path_to_api(new_target.relative_to(get_root_dir()))
        return {
            "status": "success",
            "message": f"Đã đổi tên thành '{clean_new_name}'",
            "new_path": new_rel_path
        }

    @staticmethod
    def copy_item(
        source_rel: str, dest_folder_rel: str, cancel_event=None
    ) -> Dict[str, Any]:
        """Copy an item while rejecting recursive directory copies."""
        check_cancelled(cancel_event)
        source = get_safe_path_entry(source_rel, must_exist=True)
        if source.is_symlink():
            raise HTTPException(status_code=400, detail="Symbolic links cannot be copied.")
        _validate_file_operation_tree(source, cancel_event)
        dest_folder = get_safe_path(dest_folder_rel, must_exist=True)
        if not dest_folder.is_dir():
            raise HTTPException(status_code=400, detail="Destination must be a directory.")

        if source.is_dir():
            try:
                dest_folder.resolve().relative_to(source.resolve())
            except ValueError:
                pass
            else:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot copy a directory into itself or one of its descendants.",
                )

        dest_item = dest_folder / source.name
        if dest_item.exists() or dest_item.is_symlink():
            counter = 1
            while dest_item.exists() or dest_item.is_symlink():
                if source.is_file():
                    name = f"{source.stem}_copy{counter}{source.suffix}"
                else:
                    name = f"{source.name}_copy{counter}"
                dest_item = dest_folder / name
                counter += 1

        destination_identity = None

        def copy_file(source_path: str, destination_path: str) -> str:
            nonlocal destination_identity
            check_cancelled(cancel_event)
            source_file = Path(source_path)
            destination_file = Path(destination_path)
            with source_file.open("rb") as source_stream:
                with destination_file.open("xb") as destination_stream:
                    if destination_file == dest_item:
                        metadata = os.fstat(destination_stream.fileno())
                        destination_identity = (metadata.st_dev, metadata.st_ino)
                    while True:
                        check_cancelled(cancel_event)
                        chunk = source_stream.read(settings.CHUNK_SIZE)
                        if not chunk:
                            break
                        destination_stream.write(chunk)
            check_cancelled(cancel_event)
            shutil.copystat(source_file, destination_file)
            return str(destination_file)

        try:
            if source.is_dir():
                # Claim the destination atomically before copying so a failed
                # concurrent copy cannot mistake somebody else's directory for ours.
                dest_item.mkdir()
                destination_identity = _path_identity(dest_item)
                shutil.copytree(
                    source,
                    dest_item,
                    symlinks=True,
                    copy_function=copy_file,
                    dirs_exist_ok=True,
                )
            else:
                copy_file(str(source), str(dest_item))
            check_cancelled(cancel_event)
        except OperationCancelledError:
            _remove_owned_path(dest_item, destination_identity)
            raise
        except FileExistsError as exc:
            _remove_owned_path(dest_item, destination_identity)
            raise HTTPException(
                status_code=409,
                detail=f"'{dest_item.name}' already exists in the destination.",
            ) from exc
        except Exception as exc:
            _remove_owned_path(dest_item, destination_identity)
            raise HTTPException(status_code=500, detail=f"Could not copy item: {exc}")

        return {"status": "success", "message": f"Copied to '{dest_item.name}'"}

    @staticmethod
    def move_item(
        source_rel: str,
        dest_folder_rel: str,
        cancel_event=None,
        on_finalizing=None,
    ) -> Dict[str, Any]:
        """Move an item while rejecting moves into its own subtree."""
        check_cancelled(cancel_event)
        source = get_safe_path_entry(source_rel, must_exist=True)
        dest_folder = get_safe_path(dest_folder_rel, must_exist=True)
        if not dest_folder.is_dir():
            raise HTTPException(status_code=400, detail="Destination must be a directory.")
        _validate_file_operation_tree(source, cancel_event)

        if source.is_dir() and not source.is_symlink():
            try:
                dest_folder.resolve().relative_to(source.resolve())
            except ValueError:
                pass
            else:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot move a directory into itself or one of its descendants.",
                )

        dest_item = dest_folder / source.name
        if dest_item.exists() or dest_item.is_symlink():
            raise HTTPException(
                status_code=400,
                detail=f"'{source.name}' already exists in the destination.",
            )
        check_cancelled(cancel_event)

        destination_identity = None
        destination_committed = False

        def copy_move_file(source_path: str, destination_path: str) -> str:
            """Copy a file in cancellable chunks without overwriting the destination."""
            nonlocal destination_identity
            check_cancelled(cancel_event)
            source_file = Path(source_path)
            destination_file = Path(destination_path)
            with source_file.open("rb") as source_stream:
                with destination_file.open("xb") as destination_stream:
                    if destination_file == dest_item:
                        metadata = os.fstat(destination_stream.fileno())
                        destination_identity = (metadata.st_dev, metadata.st_ino)
                    elif destination_identity is None and dest_item.is_dir():
                        destination_identity = _path_identity(dest_item)
                    while True:
                        check_cancelled(cancel_event)
                        chunk = source_stream.read(settings.CHUNK_SIZE)
                        if not chunk:
                            break
                        destination_stream.write(chunk)
            check_cancelled(cancel_event)
            shutil.copystat(source_file, destination_file)
            return str(destination_file)

        try:
            if source.is_symlink():
                os.symlink(os.readlink(source), dest_item, target_is_directory=source.is_dir())
                destination_identity = _path_identity(dest_item)
                check_cancelled(cancel_event)
                if on_finalizing is not None:
                    on_finalizing()
                destination_committed = True
                source.unlink()
            elif source.is_dir():
                # Reserve the name first. Rename on the same filesystem; copy
                # across filesystems so cancellation remains available mid-copy.
                dest_item.mkdir()
                destination_identity = _path_identity(dest_item)
                check_cancelled(cancel_event)
                same_filesystem = source.stat().st_dev == dest_folder.stat().st_dev
                if same_filesystem and os.name != "nt":
                    try:
                        if on_finalizing is None:
                            os.rename(source, dest_item)
                        else:
                            on_finalizing(lambda: os.rename(source, dest_item))
                    except OSError as exc:
                        if exc.errno != errno.EXDEV:
                            raise
                        shutil.copytree(
                            source,
                            dest_item,
                            symlinks=True,
                            copy_function=copy_move_file,
                            dirs_exist_ok=True,
                        )
                        check_cancelled(cancel_event)
                        if on_finalizing is not None:
                            on_finalizing()
                        destination_committed = True
                        shutil.rmtree(source)
                    else:
                        destination_committed = True
                else:
                    shutil.copytree(
                        source,
                        dest_item,
                        symlinks=True,
                        copy_function=copy_move_file,
                        dirs_exist_ok=True,
                    )
                    check_cancelled(cancel_event)
                    if on_finalizing is not None:
                        on_finalizing()
                    destination_committed = True
                    shutil.rmtree(source)
            else:
                try:
                    os.link(source, dest_item, follow_symlinks=False)
                except FileExistsError:
                    raise
                except OSError as exc:
                    if exc.errno not in {
                        errno.EXDEV,
                        errno.EPERM,
                        errno.EACCES,
                        getattr(errno, "EOPNOTSUPP", errno.EPERM),
                        getattr(errno, "ENOTSUP", errno.EPERM),
                    }:
                        raise
                    copy_move_file(str(source), str(dest_item))
                else:
                    destination_identity = _path_identity(dest_item)
                check_cancelled(cancel_event)
                if on_finalizing is not None:
                    on_finalizing()
                destination_committed = True
                source.unlink()
        except OperationCancelledError:
            if not destination_committed:
                _remove_owned_path(dest_item, destination_identity)
            raise
        except FileExistsError as exc:
            if not destination_committed:
                _remove_owned_path(dest_item, destination_identity)
            raise HTTPException(
                status_code=409,
                detail=f"'{source.name}' already exists in the destination.",
            ) from exc
        except Exception as exc:
            if not destination_committed:
                _remove_owned_path(dest_item, destination_identity)
            raise HTTPException(status_code=500, detail=f"Could not move item: {exc}")

        return {"status": "success", "message": f"Moved '{source.name}'"}

    @staticmethod
    def create_zip_archive(rel_path: str = "", cancel_event=None):
        """Build a size-limited ZIP in a spooled file."""
        check_cancelled(cancel_event)
        target = get_safe_path_entry(rel_path, must_exist=True)
        if target.is_symlink():
            raise HTTPException(status_code=400, detail="Symbolic links cannot be archived.")
        archive = tempfile.SpooledTemporaryFile(
            max_size=8 * 1024 * 1024, mode="w+b", prefix=".zip-spool-"
        )
        entries = 0
        total_bytes = 0

        def add_file(zip_file, path, archive_name):
            nonlocal entries, total_bytes
            check_cancelled(cancel_event)
            entries += 1
            total_bytes += path.stat().st_size
            if entries > settings.MAX_ARCHIVE_MEMBERS:
                raise HTTPException(status_code=413, detail="ZIP contains too many files.")
            if total_bytes > settings.MAX_ARCHIVE_UNPACKED_BYTES:
                raise HTTPException(status_code=413, detail="ZIP exceeds the configured uncompressed size limit.")
            zip_info = zipfile.ZipInfo.from_file(path, archive_name)
            zip_info.compress_type = zip_file.compression
            with path.open("rb") as source, zip_file.open(
                zip_info,
                "w",
                force_zip64=zip_info.file_size > zipfile.ZIP64_LIMIT,
            ) as archived:
                while True:
                    check_cancelled(cancel_event)
                    chunk = source.read(settings.CHUNK_SIZE)
                    if not chunk:
                        break
                    archived.write(chunk)

        def add_empty_directory(zip_file, archive_name):
            nonlocal entries
            check_cancelled(cancel_event)
            entries += 1
            if entries > settings.MAX_ARCHIVE_MEMBERS:
                raise HTTPException(status_code=413, detail="ZIP contains too many entries.")
            zip_file.writestr(archive_name.rstrip("/") + "/", "")

        try:
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
                if target.is_file():
                    if not _is_regular_archive_file(target):
                        raise HTTPException(
                            status_code=400,
                            detail="Special files cannot be archived.",
                        )
                    add_file(zip_file, target, target.name)
                elif target.is_dir():
                    for path, is_directory in _iter_archive_entries(
                        target, cancel_event=cancel_event
                    ):
                        check_cancelled(cancel_event)
                        relative = path.relative_to(target)
                        archive_name = relative.as_posix()
                        if is_directory:
                            add_empty_directory(zip_file, archive_name)
                        else:
                            add_file(zip_file, path, archive_name)
                else:
                    raise HTTPException(
                        status_code=400,
                        detail="Only regular files and directories can be archived.",
                    )
            check_cancelled(cancel_event)
            archive.seek(0)
            return archive
        except Exception as exc:
            archive.close()
            if isinstance(exc, (HTTPException, OperationCancelledError)):
                raise
            raise HTTPException(status_code=500, detail=f"Could not create ZIP archive: {exc}")

    @staticmethod
    def is_rar_file(archive_path: Path) -> bool:
        """Check if file has .rar extension or RAR magic signature."""
        if archive_path.suffix.lower() == ".rar":
            return True
        try:
            with open(archive_path, "rb") as f:
                sig = f.read(7)
                return sig.startswith(b"Rar!\x1a\x07")
        except Exception:
            return False

    @staticmethod
    def extract_archive(
        archive_rel: str,
        target_folder_rel: Optional[str] = None,
        overwrite: bool = False,
        overwrite_paths: Optional[List[str]] = None,
        skip_paths: Optional[List[str]] = None,
        cancel_event=None,
    ) -> Dict[str, Any]:
        """Extract ZIP, TAR, or RAR after validating paths and expansion limits."""
        check_cancelled(cancel_event)
        archive_path = get_safe_path(archive_rel, must_exist=True)
        if not archive_path.is_file():
            raise HTTPException(status_code=400, detail="Archive path must be a file.")

        overwrite_paths = set(overwrite_paths or [])
        skip_paths = set(skip_paths or [])
        if len(overwrite_paths) + len(skip_paths) > MAX_EXTRACT_REVIEW_PATHS:
            raise HTTPException(status_code=413, detail="Too many per-file extraction decisions.")
        if overwrite_paths & skip_paths:
            raise HTTPException(
                status_code=400,
                detail="A path cannot be both approved for overwrite and marked to skip.",
            )

        if target_folder_rel:
            dest_dir = get_safe_path(target_folder_rel, must_exist=False)
        else:
            folder_name = archive_path.stem
            if folder_name.endswith(".tar"):
                folder_name = Path(folder_name).stem
            dest_dir = archive_path.parent / folder_name

        root_dir = get_root_dir().resolve()

        def validate_destination_root(path: Path) -> Path:
            resolved = path.resolve()
            try:
                resolved.relative_to(root_dir)
            except ValueError:
                raise HTTPException(
                    status_code=403,
                    detail="Extraction destination is outside the configured root.",
                )
            return resolved

        dest_root = validate_destination_root(dest_dir)
        destination_directories_created = []
        cursor = dest_dir
        while cursor != root_dir and not cursor.exists():
            destination_directories_created.append(cursor)
            cursor = cursor.parent
        if dest_dir.is_symlink() or (dest_dir.exists() and not dest_dir.is_dir()):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "path_conflict",
                    "message": "Extraction destination conflicts with an existing file.",
                },
            )

        def safe_member_path(member_name: str) -> Path:
            normalized = str(member_name)
            if os.name == "nt":
                normalized = normalized.replace("\\", "/")
            if (
                not normalized
                or normalized.startswith("/")
                or re.match(r"^[A-Za-z]:", normalized)
            ):
                raise HTTPException(status_code=400, detail="Archive contains an unsafe path.")
            parts = [
                part for part in normalized.rstrip("/").split("/") if part not in ("", ".")
            ]
            if any(part == ".." or ":" in part for part in parts):
                raise HTTPException(status_code=400, detail="Archive contains an unsafe path.")
            if not parts:
                return dest_root

            member_path = dest_root.joinpath(*parts).resolve()
            try:
                member_path.relative_to(dest_root)
            except ValueError:
                raise HTTPException(status_code=400, detail="Archive path escapes the destination.")

            cursor = dest_root
            for part in parts:
                cursor = cursor / part
                if cursor.is_symlink():
                    raise HTTPException(
                        status_code=400, detail="Archive path traverses an existing symbolic link."
                    )
            if member_path == archive_path.resolve():
                raise HTTPException(status_code=400, detail="Archive cannot overwrite itself.")
            return member_path

        def check_limits(member_count: int, unpacked_size: int) -> None:
            if member_count > settings.MAX_ARCHIVE_MEMBERS:
                raise HTTPException(status_code=413, detail="Archive contains too many entries.")
            if unpacked_size > settings.MAX_ARCHIVE_UNPACKED_BYTES:
                raise HTTPException(
                    status_code=413, detail="Archive expands beyond the configured size limit."
                )

        metadata_header_types = tuple(
            getattr(tarfile, name)
            for name in (
                "XHDTYPE",
                "XGLTYPE",
                "SOLARIS_XHDTYPE",
                "GNUTYPE_LONGNAME",
                "GNUTYPE_LONGLINK",
            )
            if hasattr(tarfile, name)
        )

        class BoundedTarInfo(tarfile.TarInfo):
            @staticmethod
            def _account_metadata(tar_file, byte_count):
                total_metadata = (
                    getattr(tar_file, "_kaggle_archive_metadata_bytes", 0)
                    + byte_count
                )
                if total_metadata > settings.MAX_ARCHIVE_METADATA_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="Archive metadata exceeds the configured limit.",
                    )
                tar_file._kaggle_archive_metadata_bytes = total_metadata

            def _proc_member(self, tar_file):
                if self.type in metadata_header_types:
                    header_size = self.size
                    if header_size < 0:
                        raise HTTPException(
                            status_code=400,
                            detail="Archive contains metadata with an invalid size.",
                        )
                    if header_size > min(
                        MAX_ARCHIVE_METADATA_HEADER_BYTES,
                        settings.MAX_ARCHIVE_METADATA_BYTES,
                    ):
                        raise HTTPException(
                            status_code=413,
                            detail="Archive metadata entry exceeds the configured limit.",
                        )
                    self._account_metadata(tar_file, header_size)
                return super()._proc_member(tar_file)

            def _proc_sparse(self, tar_file):
                structs, is_extended, original_size = self._sparse_structs
                del self._sparse_structs
                while is_extended:
                    block = tar_file.fileobj.read(tarfile.BLOCKSIZE)
                    self._account_metadata(tar_file, len(block))
                    position = 0
                    for _ in range(21):
                        try:
                            offset = tarfile.nti(block[position:position + 12])
                            size = tarfile.nti(block[position + 12:position + 24])
                        except ValueError:
                            break
                        if offset and size:
                            if len(structs) >= settings.MAX_ARCHIVE_MEMBERS:
                                raise HTTPException(
                                    status_code=413,
                                    detail="Archive contains too many sparse entries.",
                                )
                            structs.append((offset, size))
                        position += 24
                    is_extended = bool(block[504])

                self.sparse = structs
                self.offset_data = tar_file.fileobj.tell()
                tar_file.offset = self.offset_data + self._block(self.size)
                self.size = original_size
                return self

            def _proc_gnusparse_01(self, tar_info, pax_headers):
                sparse_map = pax_headers["GNU.sparse.map"]
                if sparse_map.count(",") + 1 > settings.MAX_ARCHIVE_MEMBERS * 2:
                    raise HTTPException(
                        status_code=413,
                        detail="Archive contains too many sparse entries.",
                    )
                values = sparse_map.split(",")
                sparse = [int(value) for value in values]
                tar_info.sparse = list(zip(sparse[::2], sparse[1::2]))

            def _proc_gnusparse_10(self, tar_info, pax_headers, tar_file):
                block = tar_file.fileobj.read(tarfile.BLOCKSIZE)
                self._account_metadata(tar_file, len(block))
                fields_line, remainder = block.split(b"\n", 1)
                field_count = int(fields_line)
                if field_count < 0 or field_count > settings.MAX_ARCHIVE_MEMBERS:
                    raise HTTPException(
                        status_code=413,
                        detail="Archive contains too many sparse entries.",
                    )
                sparse = []
                while len(sparse) < field_count * 2:
                    if b"\n" not in remainder:
                        block = tar_file.fileobj.read(tarfile.BLOCKSIZE)
                        self._account_metadata(tar_file, len(block))
                        remainder += block
                    number, remainder = remainder.split(b"\n", 1)
                    sparse.append(int(number))
                tar_info.offset_data = tar_file.fileobj.tell()
                tar_info.sparse = list(zip(sparse[::2], sparse[1::2]))

            def _proc_gnusparse_00(self, tar_info, raw_headers):
                offsets = []
                sizes = []
                for _length, keyword, value in raw_headers:
                    if keyword == b"GNU.sparse.offset":
                        if len(offsets) >= settings.MAX_ARCHIVE_MEMBERS:
                            raise HTTPException(
                                status_code=413,
                                detail="Archive contains too many sparse entries.",
                            )
                        try:
                            offsets.append(int(value.decode()))
                        except ValueError:
                            raise tarfile.InvalidHeaderError("invalid sparse offset")
                    elif keyword == b"GNU.sparse.numbytes":
                        if len(sizes) >= settings.MAX_ARCHIVE_MEMBERS:
                            raise HTTPException(
                                status_code=413,
                                detail="Archive contains too many sparse entries.",
                            )
                        try:
                            sizes.append(int(value.decode()))
                        except ValueError:
                            raise tarfile.InvalidHeaderError("invalid sparse size")
                tar_info.sparse = list(zip(offsets, sizes))

        def is_tar_archive_with_limits() -> bool:
            try:
                with tarfile.open(
                    archive_path, "r:*", tarinfo=BoundedTarInfo
                ):
                    return True
            except (tarfile.TarError, OSError, EOFError):
                return False

        def check_zip_member_count_before_loading() -> None:
            # ZipFile reads the entire central directory and builds its full
            # ZipInfo list during construction. Count its records incrementally
            # first so even a forged EOCD count cannot bypass the limit.
            with archive_path.open("rb") as archive_stream:
                end_record = zipfile._EndRecData(archive_stream)
                if end_record is None:
                    raise zipfile.BadZipFile("File is not a zip file")

                directory_size = end_record[zipfile._ECD_SIZE]
                if directory_size > settings.MAX_ARCHIVE_METADATA_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="Archive metadata exceeds the configured limit.",
                    )
                offset_cd = end_record[zipfile._ECD_OFFSET]
                concat = end_record[zipfile._ECD_LOCATION] - directory_size - offset_cd
                if end_record[zipfile._ECD_SIGNATURE] == zipfile.stringEndArchive64:
                    concat -= (
                        zipfile.sizeEndCentDir64 + zipfile.sizeEndCentDir64Locator
                    )
                directory_start = offset_cd + concat
                archive_stream.seek(0, os.SEEK_END)
                archive_size = archive_stream.tell()
                if (
                    directory_size < 0
                    or directory_start < 0
                    or directory_start + directory_size > archive_size
                ):
                    raise zipfile.BadZipFile("Invalid central directory bounds")

                archive_stream.seek(directory_start)
                directory_bytes_read = 0
                member_count = 0
                while directory_bytes_read < directory_size:
                    header = archive_stream.read(zipfile.sizeCentralDir)
                    if len(header) != zipfile.sizeCentralDir:
                        raise zipfile.BadZipFile("Truncated central directory")
                    record = zipfile.struct.unpack(zipfile.structCentralDir, header)
                    if record[zipfile._CD_SIGNATURE] != zipfile.stringCentralDir:
                        raise zipfile.BadZipFile("Invalid central directory entry")

                    member_count += 1
                    check_limits(member_count, 0)
                    variable_size = sum(
                        record[index]
                        for index in (
                            zipfile._CD_FILENAME_LENGTH,
                            zipfile._CD_EXTRA_FIELD_LENGTH,
                            zipfile._CD_COMMENT_LENGTH,
                        )
                    )
                    directory_bytes_read += zipfile.sizeCentralDir + variable_size
                    if directory_bytes_read > directory_size:
                        raise zipfile.BadZipFile("Central directory entry exceeds its bounds")
                    archive_stream.seek(variable_size, os.SEEK_CUR)

        def validate_extraction_targets(checked_members) -> None:
            planned = {}
            conflicts = []
            for _member, member_path, is_directory in checked_members:
                check_cancelled(cancel_event)
                relative = member_path.relative_to(dest_root)
                key = os.path.normcase(os.path.normpath(str(member_path)))

                if key in planned:
                    if planned[key] and is_directory:
                        continue
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "path_conflict",
                            "message": "Archive contains duplicate or conflicting paths.",
                        },
                    )

                parts = relative.parts
                for length in range(1, len(parts)):
                    ancestor = dest_root.joinpath(*parts[:length])
                    ancestor_key = os.path.normcase(os.path.normpath(str(ancestor)))
                    if planned.get(ancestor_key) is False:
                        raise HTTPException(
                            status_code=409,
                            detail={
                                "code": "path_conflict",
                                "message": "Archive paths conflict with each other.",
                            },
                        )
                    if ancestor.exists() and not ancestor.is_dir():
                        raise HTTPException(
                            status_code=409,
                            detail={
                                "code": "path_conflict",
                                "message": "Archive path conflicts with an existing file.",
                            },
                        )

                if not is_directory:
                    prefix = key + os.sep
                    if any(existing.startswith(prefix) for existing in planned):
                        raise HTTPException(
                            status_code=409,
                            detail={
                                "code": "path_conflict",
                                "message": "Archive paths conflict with each other.",
                            },
                        )
                    if member_path.is_dir():
                        raise HTTPException(
                            status_code=409,
                            detail={
                                "code": "path_conflict",
                                "message": "Archive file conflicts with an existing directory.",
                            },
                        )
                    if member_path.exists() and not overwrite:
                        relative_path = relative.as_posix()
                        if relative_path not in overwrite_paths and relative_path not in skip_paths:
                            conflicts.append(relative_path)
                elif member_path.exists() and not member_path.is_dir():
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "path_conflict",
                            "message": "Archive directory conflicts with an existing file.",
                        },
                    )

                planned[key] = is_directory

            if conflicts:
                raise _overwrite_required(conflicts, max_paths=MAX_EXTRACT_REVIEW_PATHS)

        transaction_dir = None
        published_files: List[Path] = []
        backed_up_files: Dict[Path, Path] = {}
        created_directories = set(destination_directories_created)

        def ensure_transaction_dir() -> None:
            nonlocal transaction_dir
            if transaction_dir is None:
                transaction_dir = Path(
                    tempfile.mkdtemp(prefix=".extract-rollback-", dir=dest_root)
                )

        def ensure_directory(directory: Path) -> None:
            missing = []
            cursor = directory
            while cursor != dest_root and not cursor.exists():
                missing.append(cursor)
                cursor = cursor.parent
            if cursor.exists() and not cursor.is_dir():
                raise HTTPException(
                    status_code=409,
                    detail={"code": "path_conflict", "message": "Extraction path conflicts with an existing file."},
                )
            directory.mkdir(parents=True, exist_ok=True)
            created_directories.update(missing)

        def copy_member(source, target: Path, expected_size: int, allow_overwrite: bool) -> None:
            ensure_directory(target.parent)
            remaining = expected_size
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="wb", dir=target.parent, prefix=".extract-", delete=False
                ) as output:
                    temp_path = Path(output.name)
                    while remaining:
                        check_cancelled(cancel_event)
                        chunk = source.read(min(settings.CHUNK_SIZE, remaining))
                        if not chunk:
                            raise HTTPException(
                                status_code=400, detail="Archive entry is shorter than declared."
                            )
                        output.write(chunk)
                        remaining -= len(chunk)
                    check_cancelled(cancel_event)
                    if source.read(1):
                        raise HTTPException(
                            status_code=400, detail="Archive entry exceeds its declared size."
                        )

                if allow_overwrite:
                    backup_path = None
                    if target.exists():
                        ensure_transaction_dir()
                        backup_path = transaction_dir / ("backup-" + str(len(backed_up_files)))
                        os.replace(target, backup_path)
                        backed_up_files[target] = backup_path
                    try:
                        os.replace(temp_path, target)
                        published_files.append(target)
                    except Exception:
                        if backup_path is not None:
                            try:
                                os.replace(backup_path, target)
                                backed_up_files.pop(target, None)
                            except OSError:
                                pass
                        raise
                else:
                    try:
                        _publish_without_overwrite(temp_path, target)
                    except FileExistsError:
                        raise _overwrite_required([target.relative_to(dest_root).as_posix()])
                    published_files.append(target)
                temp_path = None
            except Exception:
                if temp_path:
                    temp_path.unlink(missing_ok=True)
                raise

        extracted_count = 0
        skipped_count = 0
        try:
            try:
                dest_dir.mkdir(parents=True, exist_ok=True)
            except (FileExistsError, NotADirectoryError) as exc:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "path_conflict",
                        "message": "Extraction destination conflicts with an existing file.",
                    },
                ) from exc
            if zipfile.is_zipfile(archive_path):
                check_zip_member_count_before_loading()
                with zipfile.ZipFile(archive_path, "r") as zip_file:
                    members = zip_file.infolist()
                    unpacked_size = sum(
                        member.file_size for member in members if not member.is_dir()
                    )
                    check_limits(len(members), unpacked_size)

                    checked_members = []
                    for member in members:
                        check_cancelled(cancel_event)
                        mode = member.external_attr >> 16
                        file_type = stat_module.S_IFMT(mode)
                        if file_type not in (
                            0,
                            stat_module.S_IFREG,
                            stat_module.S_IFDIR,
                        ):
                            raise HTTPException(
                                status_code=400,
                                detail="Archive contains a link or special file.",
                            )
                        is_directory = member.is_dir() or file_type == stat_module.S_IFDIR
                        checked_members.append(
                            (member, safe_member_path(member.filename), is_directory)
                        )
                    validate_extraction_targets(checked_members)
                    ensure_transaction_dir()

                    for member, member_path, is_directory in checked_members:
                        check_cancelled(cancel_event)
                        if is_directory:
                            ensure_directory(member_path)
                        else:
                            relative_path = member_path.relative_to(dest_root).as_posix()
                            if not overwrite and relative_path in skip_paths and member_path.exists():
                                skipped_count += 1
                                continue
                            with zip_file.open(member, "r") as source:
                                copy_member(
                                    source, member_path, member.file_size,
                                    overwrite or relative_path in overwrite_paths,
                                )
                        extracted_count += 1

            elif is_tar_archive_with_limits():
                with tarfile.open(
                    archive_path, "r:*", tarinfo=BoundedTarInfo
                ) as tar_file:
                    members = []
                    unpacked_size = 0
                    for member in tar_file:
                        members.append(member)
                        if member.isfile():
                            unpacked_size += member.size
                        check_limits(len(members), unpacked_size)

                    checked_members = []
                    for member in members:
                        check_cancelled(cancel_event)
                        if not (member.isfile() or member.isdir()):
                            raise HTTPException(
                                status_code=400,
                                detail="Archive contains a link or special file.",
                            )
                        checked_members.append(
                            (member, safe_member_path(member.name), member.isdir())
                        )
                    validate_extraction_targets(checked_members)
                    ensure_transaction_dir()

                    for member, member_path, is_directory in checked_members:
                        check_cancelled(cancel_event)
                        if is_directory:
                            ensure_directory(member_path)
                        else:
                            relative_path = member_path.relative_to(dest_root).as_posix()
                            if not overwrite and relative_path in skip_paths and member_path.exists():
                                skipped_count += 1
                                continue
                            source = tar_file.extractfile(member)
                            if source is None:
                                raise HTTPException(
                                    status_code=400, detail="Could not read archive entry."
                                )
                            with source:
                                copy_member(
                                    source, member_path, member.size,
                                    overwrite or relative_path in overwrite_paths,
                                )
                        extracted_count += 1

            elif FileService.is_rar_file(archive_path):
                try:
                    import rarfile
                except ImportError:
                    raise HTTPException(status_code=500, detail="RAR support is unavailable.")

                rar_member_count = 0

                def check_rar_member_count(member) -> None:
                    nonlocal rar_member_count
                    is_file = getattr(member, "is_file", False)
                    is_directory = getattr(member, "is_dir", False)
                    if callable(is_file):
                        is_file = is_file()
                    if callable(is_directory):
                        is_directory = is_directory()
                    if not (is_file or is_directory):
                        return

                    split_before = getattr(rarfile, "RAR_FILE_SPLIT_BEFORE", 0)
                    if split_before and getattr(member, "flags", 0) & split_before:
                        return

                    rar_member_count += 1
                    check_limits(rar_member_count, 0)

                with rarfile.RarFile(
                    archive_path, "r", info_callback=check_rar_member_count
                ) as rar_file:
                    members = rar_file.infolist()
                    unpacked_size = sum(
                        max(0, int(getattr(member, "file_size", 0)))
                        for member in members
                        if not member.is_dir()
                    )
                    check_limits(len(members), unpacked_size)

                    checked_members = []
                    for member in members:
                        check_cancelled(cancel_event)
                        for flag_name in ("is_symlink", "is_hardlink"):
                            flag = getattr(member, flag_name, False)
                            if callable(flag):
                                flag = flag()
                            if flag:
                                raise HTTPException(
                                    status_code=400, detail="Archive contains a link."
                                )
                        checked_members.append(
                            (member, safe_member_path(member.filename), member.is_dir())
                        )
                    validate_extraction_targets(checked_members)
                    ensure_transaction_dir()

                    for member, member_path, is_directory in checked_members:
                        check_cancelled(cancel_event)
                        if is_directory:
                            ensure_directory(member_path)
                        else:
                            relative_path = member_path.relative_to(dest_root).as_posix()
                            if not overwrite and relative_path in skip_paths and member_path.exists():
                                skipped_count += 1
                                continue
                            expected_size = int(getattr(member, "file_size", 0))
                            if expected_size < 0:
                                raise HTTPException(
                                    status_code=400, detail="Archive entry has an invalid size."
                                )
                            with rar_file.open(member) as source:
                                copy_member(
                                    source, member_path, expected_size,
                                    overwrite or relative_path in overwrite_paths,
                                )
                        extracted_count += 1
            else:
                raise HTTPException(status_code=400, detail="Unsupported archive format.")

            if not extracted_count and not skipped_count:
                raise HTTPException(status_code=400, detail="Archive contains no entries.")
        except Exception as exc:
            rollback_errors = []
            for target in reversed(published_files):
                try:
                    target.unlink(missing_ok=True)
                except OSError as rollback_exc:
                    rollback_errors.append(rollback_exc)
            for target, backup_path in reversed(list(backed_up_files.items())):
                try:
                    os.replace(backup_path, target)
                except OSError as rollback_exc:
                    rollback_errors.append(rollback_exc)
            for directory in sorted(
                created_directories, key=lambda path: len(path.parts), reverse=True
            ):
                try:
                    directory.rmdir()
                except OSError:
                    pass
            if rollback_errors:
                detail = "Extraction failed and rollback was incomplete."
                if transaction_dir is not None:
                    detail += f" Recovery files remain in '{transaction_dir.name}'."
                raise HTTPException(status_code=500, detail=detail) from exc
            if transaction_dir is not None:
                shutil.rmtree(transaction_dir, ignore_errors=True)
            if isinstance(exc, OperationCancelledError):
                raise
            if isinstance(exc, HTTPException):
                raise
            if _is_invalid_rar_error(exc):
                raise HTTPException(
                    status_code=400,
                    detail="Invalid or corrupted RAR archive.",
                ) from exc
            if isinstance(exc, (zipfile.BadZipFile, tarfile.TarError)):
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid or corrupted archive: {exc}",
                ) from exc
            raise HTTPException(status_code=500, detail=f"Could not extract archive: {exc}")

        if transaction_dir is not None:
            shutil.rmtree(transaction_dir, ignore_errors=True)

        message = f"Extracted {extracted_count} entries to '{dest_dir.name}'."
        if skipped_count:
            message += f" Skipped {skipped_count} existing files."
        return {
            "status": "success",
            "message": message,
            "destination": _path_to_api(dest_dir.relative_to(get_root_dir())),
            "skipped": skipped_count,
        }

    @staticmethod
    def download_url_to_folder(
        url: str,
        target_folder_rel: str = "",
        custom_filename: Optional[str] = None,
        overwrite: bool = False,
    ) -> Dict[str, Any]:
        """Download bounded HTTP(S) data from public hosts with DNS-pinned connections."""
        base_folder = get_safe_path(target_folder_rel, must_exist=True)
        if not base_folder.is_dir():
            raise HTTPException(status_code=400, detail="Destination must be a directory.")

        def validate_url(candidate: str):
            try:
                parsed = urlsplit(candidate)
                port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid download URL.")
            if (
                parsed.scheme.lower() not in ("http", "https")
                or not parsed.hostname
                or parsed.username
                or parsed.password
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Only HTTP(S) URLs without credentials are allowed.",
                )

            hostname = parsed.hostname.rstrip(".").lower()
            if hostname == "localhost" or hostname.endswith(
                (".localhost", ".local", ".internal")
            ):
                raise HTTPException(
                    status_code=400, detail="Local network destinations are not allowed."
                )
            try:
                addresses = {ipaddress.ip_address(hostname)}
            except ValueError:
                try:
                    addresses = {
                        ipaddress.ip_address(result[4][0])
                        for result in socket.getaddrinfo(
                            hostname, port, type=socket.SOCK_STREAM
                        )
                    }
                except OSError as exc:
                    raise HTTPException(
                        status_code=400, detail=f"Could not resolve download host: {exc}"
                    )
            if not addresses or any(not address.is_global for address in addresses):
                raise HTTPException(
                    status_code=400,
                    detail="Local or non-public network destinations are not allowed.",
                )
            return parsed, addresses

        parsed, _ = validate_url(url)
        has_custom_filename = bool(custom_filename and custom_filename.strip())
        filename = custom_filename.strip() if has_custom_filename else (
            os.path.basename(unquote(parsed.path))
        )
        if not filename or (not has_custom_filename and "." not in filename):
            filename = f"download_{int(time.time())}.bin"
        if os.name == "nt":
            filename = filename.replace("\\", "/")
        filename = os.path.basename(filename)
        if filename in ("", ".", "..") or ":" in filename:
            raise HTTPException(status_code=400, detail="Invalid download filename.")

        dest_entry = base_folder / filename
        if dest_entry.is_symlink():
            raise HTTPException(
                status_code=409,
                detail={"code": "path_conflict", "message": "Cannot overwrite a symbolic link."},
            )
        dest_path = dest_entry.resolve()
        try:
            dest_path.relative_to(get_root_dir().resolve())
        except ValueError:
            raise HTTPException(
                status_code=403, detail="Download destination is outside configured root."
            )
        if dest_path.is_dir():
            raise HTTPException(
                status_code=409,
                detail={"code": "path_conflict", "message": "A directory already has this name."},
            )
        if dest_path.exists() and not overwrite:
            raise _overwrite_required([filename])

        class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, new_url):
                validate_url(urljoin(req.full_url, new_url))
                return super().redirect_request(req, fp, code, msg, headers, new_url)

        class PinnedHTTPHandler(urllib.request.HTTPHandler):
            def http_open(self, req):
                _, addresses = validate_url(req.full_url)
                address = str(min(addresses, key=lambda ip: ip.version))

                class PinnedHTTPConnection(http.client.HTTPConnection):
                    def connect(self):
                        self.sock = socket.create_connection(
                            (address, self.port), self.timeout, self.source_address
                        )

                return self.do_open(PinnedHTTPConnection, req)

        class PinnedHTTPSHandler(urllib.request.HTTPSHandler):
            def https_open(self, req):
                parsed_request, addresses = validate_url(req.full_url)
                address = str(min(addresses, key=lambda ip: ip.version))
                server_name = parsed_request.hostname

                class PinnedHTTPSConnection(http.client.HTTPSConnection):
                    def connect(self):
                        sock = socket.create_connection(
                            (address, self.port), self.timeout, self.source_address
                        )
                        self.sock = self._context.wrap_socket(
                            sock, server_hostname=server_name
                        )

                return self.do_open(
                    PinnedHTTPSConnection, req, context=self._context
                )

        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            PinnedHTTPHandler(),
            PinnedHTTPSHandler(),
            SafeRedirectHandler(),
        )
        request = urllib.request.Request(
            url, headers={"User-Agent": "KaggleCloudDrive/2.0"}
        )
        temp_path = None
        bytes_downloaded = 0
        deadline = time.monotonic() + 600
        try:
            with opener.open(request, timeout=60) as response:
                content_length = response.headers.get("Content-Length")
                if content_length:
                    try:
                        if int(content_length) > settings.MAX_REMOTE_DOWNLOAD_BYTES:
                            raise HTTPException(
                                status_code=413,
                                detail="Remote file exceeds the configured size limit.",
                            )
                    except ValueError:
                        pass

                with tempfile.NamedTemporaryFile(
                    mode="wb", dir=dest_path.parent, prefix=".download-", delete=False
                ) as output:
                    temp_path = Path(output.name)
                    while True:
                        if time.monotonic() > deadline:
                            raise HTTPException(
                                status_code=504, detail="Remote download timed out."
                            )
                        chunk = response.read(settings.CHUNK_SIZE)
                        if not chunk:
                            break
                        if bytes_downloaded + len(chunk) > settings.MAX_REMOTE_DOWNLOAD_BYTES:
                            raise HTTPException(
                                status_code=413,
                                detail="Remote file exceeds the configured size limit.",
                            )
                        output.write(chunk)
                        bytes_downloaded += len(chunk)
            if overwrite:
                os.replace(temp_path, dest_entry)
            else:
                try:
                    _publish_without_overwrite(temp_path, dest_entry)
                except FileExistsError:
                    raise _overwrite_required([filename])
            temp_path = None
        except HTTPException:
            if temp_path:
                temp_path.unlink(missing_ok=True)
            raise
        except Exception as exc:
            if temp_path:
                temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail=f"Remote download failed: {exc}")

        return {
            "status": "success",
            "message": f"Downloaded '{filename}' ({format_size(bytes_downloaded)}).",
            "filename": filename,
            "path": _path_to_api(dest_path.relative_to(get_root_dir())),
            "size": bytes_downloaded,
        }

    @staticmethod
    def create_zip_from_items(item_paths: List[str], cancel_event=None):
        """Build a size-limited selected-items ZIP that spills to disk."""
        check_cancelled(cancel_event)
        if not item_paths:
            raise HTTPException(status_code=400, detail="No items were selected.")
        targets = [get_safe_path_entry(path, must_exist=True) for path in item_paths]
        archive_root_names = _unique_archive_root_names(targets)
        archive = tempfile.SpooledTemporaryFile(
            max_size=8 * 1024 * 1024, mode="w+b", prefix=".zip-spool-"
        )
        entries = 0
        total_bytes = 0

        def add_file(zip_file, path, archive_name):
            nonlocal entries, total_bytes
            check_cancelled(cancel_event)
            entries += 1
            total_bytes += path.stat().st_size
            if entries > settings.MAX_ARCHIVE_MEMBERS:
                raise HTTPException(status_code=413, detail="ZIP contains too many files.")
            if total_bytes > settings.MAX_ARCHIVE_UNPACKED_BYTES:
                raise HTTPException(status_code=413, detail="ZIP exceeds the configured uncompressed size limit.")
            zip_info = zipfile.ZipInfo.from_file(path, archive_name)
            zip_info.compress_type = zip_file.compression
            with path.open("rb") as source, zip_file.open(
                zip_info,
                "w",
                force_zip64=zip_info.file_size > zipfile.ZIP64_LIMIT,
            ) as archived:
                while True:
                    check_cancelled(cancel_event)
                    chunk = source.read(settings.CHUNK_SIZE)
                    if not chunk:
                        break
                    archived.write(chunk)

        def add_empty_directory(zip_file, archive_name):
            nonlocal entries
            check_cancelled(cancel_event)
            entries += 1
            if entries > settings.MAX_ARCHIVE_MEMBERS:
                raise HTTPException(status_code=413, detail="ZIP contains too many entries.")
            zip_file.writestr(archive_name.rstrip("/") + "/", "")

        try:
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
                for target, archive_root_name in zip(targets, archive_root_names):
                    check_cancelled(cancel_event)
                    if target.is_symlink():
                        raise HTTPException(status_code=400, detail="Symbolic links cannot be archived.")
                    if target.is_file():
                        if not _is_regular_archive_file(target):
                            raise HTTPException(
                                status_code=400,
                                detail="Only regular files can be archived.",
                            )
                        add_file(zip_file, target, archive_root_name)
                    elif target.is_dir():
                        folder_entries = 0
                        for path, is_directory in _iter_archive_entries(target, cancel_event):
                            check_cancelled(cancel_event)
                            relative = path.relative_to(target)
                            archive_name = (Path(archive_root_name) / relative).as_posix()
                            if is_directory:
                                add_empty_directory(zip_file, archive_name)
                            else:
                                add_file(zip_file, path, archive_name)
                            folder_entries += 1
                        if not folder_entries:
                            add_empty_directory(
                                zip_file, Path(archive_root_name).as_posix() + "/"
                            )
                    else:
                        raise HTTPException(status_code=400, detail="Selected item is not a regular file or directory.")
            if not entries:
                raise HTTPException(status_code=400, detail="No files were available to archive.")
            check_cancelled(cancel_event)
            archive.seek(0)
            return archive
        except Exception as exc:
            archive.close()
            if isinstance(exc, (HTTPException, OperationCancelledError)):
                raise
            raise HTTPException(status_code=500, detail=f"Could not create ZIP archive: {exc}")

    @staticmethod
    def compress_items(
        item_paths: List[str],
        archive_name: Optional[str] = None,
        target_folder_rel: Optional[str] = None,
        cancel_event=None,
    ) -> Dict[str, Any]:
        """Create a complete ZIP atomically, within configured archive limits."""
        check_cancelled(cancel_event)
        if not item_paths:
            raise HTTPException(status_code=400, detail="No items selected for compression.")
        targets = [get_safe_path_entry(path, must_exist=True) for path in item_paths]
        archive_root_names = _unique_archive_root_names(targets)
        first = targets[0]
        dest_dir = get_safe_path(target_folder_rel, must_exist=True) if target_folder_rel else first.parent
        if not dest_dir.is_dir():
            raise HTTPException(status_code=400, detail="Destination must be a directory.")

        requested_name = archive_name.strip() if archive_name and archive_name.strip() else None
        if requested_name and os.name == "nt":
            requested_name = requested_name.replace("\\", "/")
        name = os.path.basename(requested_name) if requested_name else (
            f"{first.stem}.zip" if len(targets) == 1 else "archive.zip"
        )
        if not name or name in (".", "..") or ":" in name:
            raise HTTPException(status_code=400, detail="Invalid archive filename.")
        if not name.lower().endswith(".zip"):
            name += ".zip"

        dest = dest_dir / name
        if dest.exists() or dest.is_symlink():
            if requested_name:
                raise HTTPException(status_code=409, detail="An archive with that name already exists.")
            stem = dest.stem
            counter = 1
            while dest.exists() or dest.is_symlink():
                dest = dest_dir / f"{stem}_{counter}.zip"
                counter += 1
        try:
            dest.resolve().relative_to(get_root_dir().resolve())
        except ValueError:
            raise HTTPException(status_code=403, detail="Archive destination is outside configured root.")
        if any(target.resolve() == dest.resolve() for target in targets):
            raise HTTPException(status_code=400, detail="An archive cannot include itself.")

        temp_path = None
        file_count = 0
        entry_count = 0
        total_bytes = 0

        def add_file(zip_file, path, archive_name):
            nonlocal file_count, entry_count, total_bytes
            check_cancelled(cancel_event)
            entry_count += 1
            file_count += 1
            total_bytes += path.stat().st_size
            if entry_count > settings.MAX_ARCHIVE_MEMBERS:
                raise HTTPException(status_code=413, detail="ZIP contains too many files.")
            if total_bytes > settings.MAX_ARCHIVE_UNPACKED_BYTES:
                raise HTTPException(status_code=413, detail="ZIP exceeds the configured uncompressed size limit.")
            zip_info = zipfile.ZipInfo.from_file(path, archive_name)
            zip_info.compress_type = zip_file.compression
            with path.open("rb") as source, zip_file.open(
                zip_info,
                "w",
                force_zip64=zip_info.file_size > zipfile.ZIP64_LIMIT,
            ) as archived:
                while True:
                    check_cancelled(cancel_event)
                    chunk = source.read(settings.CHUNK_SIZE)
                    if not chunk:
                        break
                    archived.write(chunk)

        def add_empty_directory(zip_file, archive_name):
            nonlocal entry_count
            check_cancelled(cancel_event)
            entry_count += 1
            if entry_count > settings.MAX_ARCHIVE_MEMBERS:
                raise HTTPException(status_code=413, detail="ZIP contains too many entries.")
            zip_file.writestr(archive_name, "")

        try:
            with tempfile.NamedTemporaryFile(
                mode="w+b", dir=dest_dir, prefix=".archive-", suffix=".tmp", delete=False
            ) as output:
                temp_path = Path(output.name)
                with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
                    for target, archive_root_name in zip(targets, archive_root_names):
                        check_cancelled(cancel_event)
                        if target.is_symlink():
                            raise HTTPException(status_code=400, detail="Symbolic links cannot be archived.")
                        if target.is_file():
                            if not _is_regular_archive_file(target):
                                raise HTTPException(
                                    status_code=400,
                                    detail="Only regular files can be archived.",
                                )
                            add_file(zip_file, target, archive_root_name)
                        elif target.is_dir():
                            directory_entries = 0
                            for path, is_directory in _iter_archive_entries(target, cancel_event):
                                check_cancelled(cancel_event)
                                if not is_directory and path.resolve() in (dest.resolve(), temp_path.resolve()):
                                    continue
                                relative = path.relative_to(target)
                                archive_path = (Path(archive_root_name) / relative).as_posix()
                                if is_directory:
                                    add_empty_directory(zip_file, archive_path + "/")
                                else:
                                    add_file(zip_file, path, archive_path)
                                directory_entries += 1
                            if not directory_entries:
                                add_empty_directory(zip_file, Path(archive_root_name).as_posix() + "/")
                        else:
                            raise HTTPException(status_code=400, detail="Selected item is not a regular file or directory.")
                output.flush()
                check_cancelled(cancel_event)
                os.fsync(output.fileno())
            if not entry_count:
                raise HTTPException(status_code=400, detail="No files were available to archive.")
            check_cancelled(cancel_event)
            try:
                _publish_without_overwrite(temp_path, dest)
            except FileExistsError as exc:
                raise HTTPException(
                    status_code=409,
                    detail="An archive with that name already exists.",
                ) from exc
            temp_path = None
        except Exception as exc:
            if temp_path:
                temp_path.unlink(missing_ok=True)
            if isinstance(exc, (HTTPException, OperationCancelledError)):
                raise
            raise HTTPException(status_code=500, detail=f"Could not create ZIP archive: {exc}")

        size = dest.stat().st_size
        return {
            "status": "success",
            "message": f"Compressed {file_count} files into '{dest.name}'.",
            "archive_name": dest.name,
            "archive_path": _path_to_api(dest.relative_to(get_root_dir())),
            "size": size,
            "formatted_size": format_size(size),
        }
