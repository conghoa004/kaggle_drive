class OperationCancelledError(Exception):
    """Raised when a file operation receives a cooperative cancellation request."""


def check_cancelled(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise OperationCancelledError("File operation cancelled.")
