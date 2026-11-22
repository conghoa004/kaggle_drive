from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.security import require_auth
from app.services import service_manager


router = APIRouter(prefix="/api/services", tags=["services"])


@router.get("")
def get_services(request: Request, response: Response):
    require_auth(request)
    response.headers["Cache-Control"] = "no-store"
    return {"services": service_manager.list_services()}


@router.post("/{service_id}/{action}")
def run_service_action(request: Request, service_id: str, action: str):
    require_auth(request)
    try:
        return service_manager.start_action(service_id, action)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not start service action: {exc}") from exc


@router.get("/{service_id}/credentials")
def get_service_credentials(request: Request, response: Response, service_id: str):
    require_auth(request)
    response.headers["Cache-Control"] = "no-store"
    try:
        credentials = service_manager.get_service_credentials(service_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from exc
    if credentials is None:
        raise HTTPException(status_code=404, detail="Service information is not available.")
    return {"credentials": credentials}


@router.get("/directory")
def get_services_directory(
    request: Request,
    response: Response,
    path: str = Query(default="", max_length=4096),
):
    require_auth(request)
    response.headers["Cache-Control"] = "no-store"
    try:
        return service_manager.list_services_directory(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/tasks/{task_id}")
def get_service_task(request: Request, task_id: str):
    require_auth(request)
    task = service_manager.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Service action was not found.")
    return task
