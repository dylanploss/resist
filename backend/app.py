import os
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import numpy as np
from pydantic import BaseModel
from starlette.exceptions import HTTPException

from backend.data.loader import measurement_metadata
from backend.qc.selection import DEFAULT_SELECT, SELECT_RANGE, _json_safe, select_curves
from backend.services import runs

from backend.qc.api import router as qc_router
from backend.inversion.api import router as inversion_router
from backend.inversion.facets_api import router as facets_router

app = FastAPI(title="Resist backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.include_router(qc_router)
app.include_router(inversion_router)
app.include_router(facets_router)


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
    return error(exc.status_code, str(exc.detail))


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
    return error(422, f"{where}: {first.get('msg', 'invalid request')}".strip(": "))


@app.exception_handler(runs.DataDirError)
async def data_dir_error(_: Request, exc: runs.DataDirError) -> JSONResponse:
    return error(503, str(exc))


@app.exception_handler(runs.UnknownRunError)
async def unknown_run(_: Request, exc: runs.UnknownRunError) -> JSONResponse:
    return error(404, str(exc.args[0]))


@app.exception_handler(Exception)
async def server_error(_: Request, exc: Exception) -> JSONResponse:
    return error(500, f"{type(exc).__name__}: {exc}")


class QcSelectRequest(BaseModel):
    run: str
    n_select: int = DEFAULT_SELECT


def _nullable(values: np.ndarray) -> list:
    out = values.astype(object)
    out[~np.isfinite(values)] = None
    return out.tolist()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/runs")
def list_runs() -> dict:
    return {"runs": runs.list_runs()}


@app.get("/curves")
def curves(run: str | None = None) -> dict:
    if not run:
        raise HTTPException(400, "query parameter 'run' is required; see GET /runs")
    well_run = runs.get_run(run)
    rows = [{**row, **measurement_metadata(row["curve"])}
            for row in well_run.metadata.to_dict("records")]
    return _json_safe({"run": run, "well": well_run.well, "curves": rows})


@app.get("/curves/{run}/data")
def curve_data(run: str, curves: str = Query("")) -> dict:
    names = [n.strip() for n in curves.split(",") if n.strip()]
    if not names:
        raise HTTPException(400, "query parameter 'curves' is required, e.g. ?curves=ARM16PC,GR")
    well_run = runs.get_run(run)
    missing = [n for n in names if n not in well_run.curves]
    if missing:
        raise HTTPException(400, f"unknown curves for run {run}: {', '.join(missing)}")
    units = dict(zip(well_run.metadata["curve"], well_run.metadata["unit"]))
    return {
        "run": run,
        "well": well_run.well,
        "depth_m": well_run.depth_m.tolist(),
        "curves": {
            n: {"unit": units.get(n), "bins": 1 if well_run.curves[n].ndim == 1
                else int(well_run.curves[n].shape[1]),
                "values": _nullable(well_run.curves[n])}
            for n in names
        },
    }


@app.post("/qc/select")
def qc_select(request: QcSelectRequest) -> dict:
    low, high = SELECT_RANGE
    if not low <= request.n_select <= high:
        raise HTTPException(400, f"n_select must be between {low} and {high}")
    return _json_safe(select_curves(runs.get_run(request.run), request.n_select))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, port=int(os.environ.get("RESIST_BACKEND_PORT", "5000")))
