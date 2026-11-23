import mimetypes
import os
from urllib.parse import quote
from typing import List, Literal, Optional
from fastapi import APIRouter, Request, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from app.config import settings

from app.security import get_root_dir, require_auth, get_safe_path
from app.services.file_service import FileService, MEDIA_MIMETYPES, MAX_EXTRACT_REVIEW_PATHS
from app.services.file_operation_manager import file_operation_manager

router = APIRouter(prefix="/api/files", tags=["files"])


def _archive_chunks(archive_file):
    while True:
        chunk = archive_file.read(settings.CHUNK_SIZE)
        if not chunk:
            break
        yield chunk


def _overwrite_required(paths: List[str]) -> HTTPException:
    unique_paths = sorted(set(paths))
    return HTTPException(
        status_code=409,
        detail={
            "code": "overwrite_required",
            "paths": unique_paths[:10],
            "count": len(unique_paths),
            "message": "One or more destination files already exist.",
        },
    )


class ContentSaveRequest(BaseModel):
    path: str = Field(..., max_length=4096)
    content: str = Field(..., max_length=settings.MAX_TEXT_PREVIEW_SIZE)


class BinarySaveRequest(BaseModel):
    path: str = Field(..., max_length=4096)
    content_b64: str = Field(..., max_length=((settings.MAX_BINARY_SAVE_BYTES + 2) // 3) * 4)


class MkdirRequest(BaseModel):
    path: str


class TouchRequest(BaseModel):
    path: str


class DeleteRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    path: str
    new_name: str


class CopyMoveRequest(BaseModel):
    source_path: str
    target_folder: str


class UploadCheckRequest(BaseModel):
    target_path: str = ""
    relative_paths: List[str] = Field(..., min_length=1, max_length=1000)


class ExtractRequest(BaseModel):
    path: str
    target_folder: Optional[str] = None
    overwrite: bool = False
    overwrite_paths: List[str] = Field(default_factory=list, max_length=MAX_EXTRACT_REVIEW_PATHS)
    skip_paths: List[str] = Field(default_factory=list, max_length=MAX_EXTRACT_REVIEW_PATHS)


class DownloadUrlRequest(BaseModel):
    url: str = Field(..., max_length=4096)
    target_folder: str = ""
    filename: Optional[str] = None
    overwrite: bool = False


class DownloadSelectedRequest(BaseModel):
    items: List[str] = Field(..., min_length=1, max_length=1000)


class CompressRequest(BaseModel):
    paths: List[str] = Field(..., min_length=1, max_length=1000)
    archive_name: Optional[str] = None
    target_folder: Optional[str] = None


class FileOperationStartRequest(BaseModel):
    operation: Literal[
        "copy", "move", "delete", "compress", "extract", "download_selected_zip",
        "download_folder_zip",
    ]
    source_path: Optional[str] = None
    target_folder: Optional[str] = None
    path: Optional[str] = None
    paths: Optional[List[str]] = Field(None, max_length=1000)
    items: Optional[List[str]] = Field(None, max_length=1000)
    archive_name: Optional[str] = None
    overwrite: bool = False
    overwrite_paths: List[str] = Field(default_factory=list, max_length=MAX_EXTRACT_REVIEW_PATHS)
    skip_paths: List[str] = Field(default_factory=list, max_length=MAX_EXTRACT_REVIEW_PATHS)


@router.get("")
def list_files(
    request: Request,
    path: str = Query("", description="Relative path from ROOT_DIR"),
    show_hidden: bool = Query(False, description="Whether to include hidden files")
):
    """List directory contents."""
    require_auth(request)
    return FileService.list_directory(path, show_hidden=show_hidden)


@router.get("/download")
def download_file(request: Request, path: str = Query(..., description="File path to download")):
    """Download a single file."""
    require_auth(request)
    target = get_safe_path(path, must_exist=True)

    if not target.is_file():
        raise HTTPException(status_code=400, detail="Mục chỉ định không phải là một tệp tin.")

    mime_type, _ = mimetypes.guess_type(target.name)
    return FileResponse(
        path=target,
        media_type=mime_type or "application/octet-stream",
        filename=target.name
    )


@router.get("/preview-raw")
def preview_raw_file(request: Request, path: str = Query(..., description="File path to preview")):
    """
    Stream/serve raw media (image, video, audio, pdf) for inline browser rendering.
    Supports HTTP range requests for smooth video/audio seeking.
    """
    require_auth(request)
    target = get_safe_path(path, must_exist=True)

    if not target.is_file():
        raise HTTPException(status_code=400, detail="Mục chỉ định không phải là một tệp tin.")

    ext = target.suffix.lower().lstrip(".")
    mime_type = MEDIA_MIMETYPES.get(ext) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(
        path=target,
        media_type=mime_type
    )


@router.get("/download-zip")
def download_zip(request: Request, path: str = Query("", description="Folder or file path to zip")):
    """Download a folder or file as a compressed ZIP file."""
    require_auth(request)
    target = get_safe_path(path, must_exist=True)
    archive_file = FileService.create_zip_archive(path)
    zip_name = (target.name if target.name else "kaggle_working") + ".zip"
    return StreamingResponse(
        _archive_chunks(archive_file),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{quote(zip_name)}"'},
        background=BackgroundTask(archive_file.close),
    )


@router.get("/content")
def get_file_content(request: Request, path: str = Query(..., description="File path to read")):
    """Read text file content for web code editor."""
    require_auth(request)
    return FileService.read_text_file(path)


@router.post("/content")
def save_file_content(request: Request, payload: ContentSaveRequest):
    """Save edited content to a text file."""
    require_auth(request)
    return FileService.write_text_file(payload.path, payload.content)


@router.post("/save-binary")
def save_binary_file(request: Request, payload: BinarySaveRequest):
    """Save base64-encoded binary content (e.g. modified Excel workbook) to file."""
    require_auth(request)
    return FileService.write_binary_file(payload.path, payload.content_b64)


@router.post("/upload/check")
def check_upload_conflicts(request: Request, payload: UploadCheckRequest):
    """Check all upload destinations before sending file data."""
    require_auth(request)
    return {
        "conflicts": FileService.get_upload_conflicts(
            payload.target_path, payload.relative_paths
        )
    }


@router.post("/upload")
def upload_files(
    request: Request,
    target_path: str = Form(""),
    files: List[UploadFile] = File(...),
    relative_paths: Optional[List[str]] = Form(None),
    overwrite: bool = Form(False),
    overwrite_paths: Optional[List[str]] = Form(None),
    skip_paths: Optional[List[str]] = Form(None),
):
    """Upload files with per-file and aggregate size limits."""
    require_auth(request)
    if len(files) > 1000:
        raise HTTPException(status_code=413, detail="Too many files in one upload request.")
    results = []
    try:
        file_sizes = []
        for upload_file in files:
            upload_file.file.seek(0, 2)
            file_sizes.append(upload_file.file.tell())
            upload_file.file.seek(0)
        if sum(file_sizes) > settings.MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Upload exceeds the configured size limit.")

        filenames = [
            relative_paths[idx]
            if relative_paths and idx < len(relative_paths) and relative_paths[idx]
            else upload_file.filename or "uploaded_file"
            for idx, upload_file in enumerate(files)
        ]
        approved_overwrites = set(overwrite_paths or [])
        approved_skips = set(skip_paths or [])
        if len(approved_overwrites) + len(approved_skips) > 1000:
            raise HTTPException(status_code=413, detail="Too many per-file upload decisions.")
        if any(
            len(path.encode("utf-8")) > 4096
            for path in approved_overwrites | approved_skips
        ):
            raise HTTPException(status_code=413, detail="An upload decision path is too long.")
        conflicts = FileService.get_upload_conflicts(target_path, filenames)
        unresolved = [
            path for path in conflicts
            if not overwrite
            and path not in approved_overwrites
            and path not in approved_skips
        ]
        if unresolved:
            raise _overwrite_required(unresolved)

        for idx, upload_file in enumerate(files):
            rel_filename = filenames[idx]
            result = FileService.save_uploaded_file(
                target_folder_rel=target_path,
                upload_file=upload_file,
                relative_filename=rel_filename,
                max_bytes=file_sizes[idx],
                overwrite=overwrite,
                overwrite_paths=list(approved_overwrites),
                skip_paths=list(approved_skips),
            )
            results.append(result)
    finally:
        for upload_file in files:
            if not upload_file.file.closed:
                upload_file.file.close()
    uploaded_files = [result for result in results if not result.get("skipped")]
    skipped_files = [result for result in results if result.get("skipped")]
    return {
        "status": "success",
        "message": f"\u0110\u00e3 t\u1ea3i l\u00ean th\u00e0nh c\u00f4ng {len(uploaded_files)} t\u1ec7p.",
        "uploaded_files": uploaded_files,
        "skipped_files": skipped_files,
    }


@router.post("/upload/chunk")
def upload_file_chunk(
    request: Request,
    target_path: str = Form(""),
    relative_path: str = Form(...),
    upload_id: str = Form(...),
    offset: int = Form(...),
    total_size: int = Form(...),
    batch_size: int = Form(...),
    chunk: UploadFile = File(...),
    overwrite: bool = Form(False),
    overwrite_paths: Optional[List[str]] = Form(None),
    skip_paths: Optional[List[str]] = Form(None),
):
    """Append one bounded upload chunk and atomically publish the completed file."""
    require_auth(request)
    from uuid import UUID

    try:
        UUID(upload_id)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid upload ID.")

    if total_size < 0 or total_size > settings.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Upload exceeds the configured size limit.")
    if batch_size < total_size or batch_size > settings.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Upload exceeds the configured size limit.")
    if offset < 0 or offset > total_size:
        raise HTTPException(status_code=400, detail="Invalid upload offset.")

    base_folder = get_safe_path(target_path, must_exist=True)
    if not base_folder.is_dir():
        raise HTTPException(status_code=400, detail="Upload destination must be a directory.")

    raw_name = relative_path.replace("\\", "/")
    parts = [part for part in raw_name.split("/") if part not in ("", ".")]
    if raw_name.startswith("/") or not parts or any(part == ".." or ":" in part for part in parts):
        raise HTTPException(status_code=400, detail="Invalid upload filename.")

    dest_path = base_folder.joinpath(*parts).resolve()
    try:
        dest_path.relative_to(base_folder.resolve())
        dest_path.relative_to(get_root_dir().resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Upload destination escapes the configured root.")

    chunk_path = dest_path.with_name(f".upload-{upload_id}.part")
    try:
        if dest_path.is_dir():
            raise HTTPException(
                status_code=409,
                detail={"code": "path_conflict", "message": "An upload destination is an existing directory."},
            )
        relative_dest = str(dest_path.relative_to(get_root_dir().resolve())).replace("\\", "/")
        approved_skips = set(skip_paths or [])
        approved_overwrites = set(overwrite_paths or [])
        if len(approved_skips) + len(approved_overwrites) > 1000:
            raise HTTPException(status_code=413, detail="Too many per-file upload decisions.")
        if any(
            len(path.encode("utf-8")) > 4096
            for path in approved_skips | approved_overwrites
        ):
            raise HTTPException(status_code=413, detail="An upload decision path is too long.")
        if relative_dest in approved_skips:
            chunk_path.unlink(missing_ok=True)
            return {"status": "skipped", "path": relative_dest}
        overwrite_this = overwrite or relative_dest in approved_overwrites
        if dest_path.exists() and not overwrite_this:
            chunk_path.unlink(missing_ok=True)
            relative_dest = str(dest_path.relative_to(get_root_dir().resolve())).replace("\\", "/")
            raise _overwrite_required([relative_dest])

        dest_path.parent.mkdir(parents=True, exist_ok=True)
        FileService.register_upload_chunk_directory(dest_path.parent)
        data = chunk.file.read(settings.UPLOAD_CHUNK_BYTES + 1)
        if len(data) > settings.UPLOAD_CHUNK_BYTES or offset + len(data) > total_size:
            raise HTTPException(status_code=413, detail="Upload chunk exceeds the configured limit.")

        if offset == 0:
            if chunk_path.is_dir():
                raise HTTPException(status_code=400, detail="Invalid upload staging path.")
            mode = "wb"
        else:
            if not chunk_path.is_file() or chunk_path.stat().st_size != offset:
                raise HTTPException(status_code=409, detail="Upload chunk is out of sequence.")
            mode = "ab"

        with chunk_path.open(mode) as output:
            output.write(data)
        FileService.register_upload_chunk_directory(dest_path.parent)

        received = offset + len(data)
        if received == total_size:
            if overwrite_this:
                chunk_path.replace(dest_path)
            else:
                try:
                    os.link(chunk_path, dest_path)
                except FileExistsError:
                    chunk_path.unlink(missing_ok=True)
                    relative_dest = str(dest_path.relative_to(get_root_dir().resolve())).replace("\\", "/")
                    raise _overwrite_required([relative_dest])
                chunk_path.unlink()
            return {
                "status": "success",
                "filename": dest_path.name,
                "path": str(dest_path.relative_to(get_root_dir().resolve())).replace("\\", "/"),
                "size": received,
            }
        return {"status": "partial", "received": received}
    finally:
        chunk.file.close()



@router.post("/mkdir")
def create_directory(request: Request, payload: MkdirRequest):
    """Create a new folder."""
    require_auth(request)
    return FileService.create_directory(payload.path)


@router.post("/touch")
def create_file(request: Request, payload: TouchRequest):
    """Create a new empty file."""
    require_auth(request)
    return FileService.create_empty_file(payload.path)


@router.delete("/delete")
def delete_item(request: Request, payload: DeleteRequest):
    """Delete a file or folder recursively."""
    require_auth(request)
    return FileService.delete_item(payload.path)


@router.post("/operations", status_code=202)
def start_file_operation(request: Request, payload: FileOperationStartRequest):
    """Start a cancellable file operation in a background worker."""
    require_auth(request)
    operation = payload.operation
    if operation in {"copy", "move"}:
        if payload.source_path is None or payload.target_folder is None:
            raise HTTPException(status_code=422, detail="A source and destination are required.")
    elif operation == "delete" and payload.path is None:
        raise HTTPException(status_code=422, detail="A path is required.")
    elif operation == "compress" and not payload.paths:
        raise HTTPException(status_code=422, detail="At least one path is required.")
    elif operation == "download_selected_zip" and not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required.")
    elif operation == "extract" and payload.path is None:
        raise HTTPException(status_code=422, detail="An archive path is required.")

    return file_operation_manager.start(
        operation,
        payload.dict(exclude={"operation"}, exclude_none=True),
    )


@router.get("/operations/{operation_id}")
def get_file_operation(request: Request, operation_id: str):
    """Read the state of one background file operation."""
    require_auth(request)
    operation = file_operation_manager.get(operation_id)
    if operation is None:
        raise HTTPException(status_code=404, detail="File operation not found.")
    return operation


@router.delete("/operations/{operation_id}")
def cancel_file_operation(request: Request, operation_id: str):
    """Request cooperative cancellation of one background file operation."""
    require_auth(request)
    operation = file_operation_manager.cancel(operation_id)
    if operation is None:
        raise HTTPException(status_code=404, detail="File operation not found.")
    return operation


@router.get("/operations/{operation_id}/download")
def download_file_operation_archive(request: Request, operation_id: str):
    """Stream a ZIP produced by a selected-items background operation."""
    require_auth(request)
    archive_file = file_operation_manager.take_archive(operation_id)
    if archive_file is None:
        raise HTTPException(status_code=409, detail="The archive is not available for download.")
    return StreamingResponse(
        _archive_chunks(archive_file),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="selected_items.zip"'},
        background=BackgroundTask(archive_file.close),
    )


@router.post("/rename")
def rename_item(request: Request, payload: RenameRequest):
    """Rename a file or folder."""
    require_auth(request)
    return FileService.rename_item(payload.path, payload.new_name)


@router.post("/copy")
def copy_item(request: Request, payload: CopyMoveRequest):
    """Copy an item to a target directory."""
    require_auth(request)
    return FileService.copy_item(payload.source_path, payload.target_folder)


@router.post("/move")
def move_item(request: Request, payload: CopyMoveRequest):
    """Move an item to a target directory."""
    require_auth(request)
    return FileService.move_item(payload.source_path, payload.target_folder)


@router.post("/extract")
def extract_archive(request: Request, payload: ExtractRequest):
    """Extract an archive (.zip, .tar, .tar.gz, .rar)."""
    require_auth(request)
    return FileService.extract_archive(
        payload.path,
        payload.target_folder,
        payload.overwrite,
        payload.overwrite_paths,
        payload.skip_paths,
    )


@router.post("/download-from-url")
def download_from_url(request: Request, payload: DownloadUrlRequest):
    """Download a file directly from external URL to the target directory."""
    require_auth(request)
    return FileService.download_url_to_folder(
        url=payload.url,
        target_folder_rel=payload.target_folder,
        custom_filename=payload.filename,
        overwrite=payload.overwrite,
    )


@router.post("/download-selected-zip")
def download_selected_zip(request: Request, payload: DownloadSelectedRequest):
    """Download multiple selected files/folders as a streamed ZIP archive."""
    require_auth(request)
    if not payload.items:
        raise HTTPException(status_code=400, detail="No items were selected for archiving.")
    archive_file = FileService.create_zip_from_items(payload.items)
    return StreamingResponse(
        _archive_chunks(archive_file),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="selected_items.zip"'},
        background=BackgroundTask(archive_file.close),
    )


@router.post("/compress")
def compress_files(request: Request, payload: CompressRequest):
    """Compress one or multiple files/folders into a .zip archive stored on disk."""
    require_auth(request)
    return FileService.compress_items(
        item_paths=payload.paths,
        archive_name=payload.archive_name,
        target_folder_rel=payload.target_folder
    )

