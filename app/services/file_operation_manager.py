import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from fastapi import HTTPException

from app.services.file_operation_context import OperationCancelledError


MAX_ACTIVE_FILE_OPERATIONS = 8
FILE_OPERATION_RETENTION_SECONDS = 15 * 60


@dataclass
class _FileOperation:
    operation_id: str
    operation: str
    payload: Dict[str, Any]
    cancel_event: threading.Event = field(default_factory=threading.Event)
    status: str = "queued"
    result: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None
    archive_file: Any = None
    created_at: float = field(default_factory=time.monotonic)
    updated_at: float = field(default_factory=time.monotonic)


class FileOperationManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._operations: Dict[str, _FileOperation] = {}
        self._executor = ThreadPoolExecutor(
            max_workers=3, thread_name_prefix="file-operation"
        )
        self._executor_shutdown = False

    def start(self, operation: str, payload: Dict[str, Any]) -> Dict[str, str]:
        with self._lock:
            self._prune_locked()
            if self._executor_shutdown:
                self._executor = ThreadPoolExecutor(
                    max_workers=3, thread_name_prefix="file-operation"
                )
                self._executor_shutdown = False
            active_count = sum(
                item.status in {"queued", "running", "cancelling"}
                for item in self._operations.values()
            )
            if active_count >= MAX_ACTIVE_FILE_OPERATIONS:
                raise HTTPException(
                    status_code=429,
                    detail="Too many file operations are already running.",
                )

            operation_id = str(uuid.uuid4())
            item = _FileOperation(operation_id, operation, dict(payload))
            self._operations[operation_id] = item
            self._executor.submit(self._run, operation_id)
            return {"operation_id": operation_id, "status": item.status}

    def get(self, operation_id: str) -> Optional[Dict[str, Any]]:
        normalized_id = self._normalize_id(operation_id)
        with self._lock:
            self._prune_locked()
            item = self._operations.get(normalized_id)
            return self._snapshot(item) if item else None

    def cancel(self, operation_id: str) -> Optional[Dict[str, Any]]:
        normalized_id = self._normalize_id(operation_id)
        with self._lock:
            item = self._operations.get(normalized_id)
            if item is None:
                return None
            if item.status in {"queued", "running", "cancelling"}:
                item.cancel_event.set()
                item.status = "cancelling"
                item.updated_at = time.monotonic()
            elif item.status == "completed" and item.archive_file is not None:
                item.archive_file.close()
                item.archive_file = None
                item.status = "cancelled"
                item.updated_at = time.monotonic()
            return self._snapshot(item)

    def take_archive(self, operation_id: str):
        normalized_id = self._normalize_id(operation_id)
        with self._lock:
            item = self._operations.get(normalized_id)
            if item is None or item.status != "completed" or item.archive_file is None:
                return None
            archive_file = item.archive_file
            item.archive_file = None
            return archive_file

    def shutdown(self) -> None:
        with self._lock:
            for item in self._operations.values():
                if item.status in {"queued", "running", "cancelling"}:
                    item.cancel_event.set()
                if item.archive_file is not None:
                    item.archive_file.close()
                    item.archive_file = None
            executor = self._executor
            self._executor_shutdown = True
        executor.shutdown(wait=True, cancel_futures=False)

    def _run(self, operation_id: str) -> None:
        with self._lock:
            item = self._operations.get(operation_id)
            if item is None:
                return
            if item.cancel_event.is_set():
                item.status = "cancelled"
                item.updated_at = time.monotonic()
                return
            item.status = "running"
            item.updated_at = time.monotonic()

        try:
            result = self._execute(item)
        except OperationCancelledError:
            with self._lock:
                item.status = "cancelled"
                item.updated_at = time.monotonic()
        except HTTPException as exc:
            with self._lock:
                item.error = {"status_code": exc.status_code, "detail": exc.detail}
                item.status = "failed"
                item.updated_at = time.monotonic()
        except Exception as exc:
            with self._lock:
                item.error = {
                    "status_code": 500,
                    "detail": f"File operation failed: {exc}",
                }
                item.status = "failed"
                item.updated_at = time.monotonic()
        else:
            with self._lock:
                if item.operation in {"download_selected_zip", "download_folder_zip"}:
                    if item.cancel_event.is_set():
                        try:
                            result.close()
                        except Exception:
                            pass
                        item.status = "cancelled"
                    else:
                        item.archive_file = result
                        item.result = {"status": "ready"}
                        item.status = "completed"
                else:
                    item.result = result
                    item.status = "completed"
                item.updated_at = time.monotonic()

    @staticmethod
    def _execute(item: _FileOperation) -> Any:
        from app.services.file_service import FileService

        payload = item.payload
        cancel_event = item.cancel_event
        if item.operation == "copy":
            return FileService.copy_item(
                payload["source_path"], payload["target_folder"], cancel_event
            )
        if item.operation == "move":
            return FileService.move_item(
                payload["source_path"], payload["target_folder"], cancel_event
            )
        if item.operation == "delete":
            return FileService.delete_item(payload["path"], cancel_event)
        if item.operation == "compress":
            return FileService.compress_items(
                payload["paths"],
                payload.get("archive_name"),
                payload.get("target_folder"),
                cancel_event,
            )
        if item.operation == "extract":
            return FileService.extract_archive(
                payload["path"],
                payload.get("target_folder"),
                payload.get("overwrite", False),
                payload.get("overwrite_paths"),
                payload.get("skip_paths"),
                cancel_event,
            )
        if item.operation == "download_selected_zip":
            return FileService.create_zip_from_items(
                payload["items"], cancel_event
            )
        if item.operation == "download_folder_zip":
            return FileService.create_zip_archive(
                payload.get("path", ""), cancel_event
            )
        raise HTTPException(status_code=400, detail="Unsupported file operation.")

    def _prune_locked(self) -> None:
        now = time.monotonic()
        for operation_id, item in list(self._operations.items()):
            if (
                item.status in {"cancelled", "completed", "failed"}
                and now - item.updated_at > FILE_OPERATION_RETENTION_SECONDS
            ):
                if item.archive_file is not None:
                    item.archive_file.close()
                self._operations.pop(operation_id, None)

    @staticmethod
    def _normalize_id(operation_id: str) -> str:
        try:
            return str(uuid.UUID(operation_id))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(status_code=404, detail="File operation not found.")

    @staticmethod
    def _snapshot(item: _FileOperation) -> Dict[str, Any]:
        return {
            "operation_id": item.operation_id,
            "operation": item.operation,
            "status": item.status,
            "result": item.result,
            "error": item.error,
        }


file_operation_manager = FileOperationManager()
