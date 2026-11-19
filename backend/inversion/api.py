"""HTTP endpoints for 1.5D inversion of a QC-selected curve set."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from backend.inversion import layers, service
from backend.services import runs

router = APIRouter(prefix="/inversion")


class InversionRequest(BaseModel):
    run: str
    curves: list[str] = Field(min_length=1)
    md_min_ft: float
    md_max_ft: float
    step_ft: float = Field(4.0, ge=0.5, le=20.0)
    layers: int = Field(3, ge=1, le=4)
    calibration: bool = True
    quick: bool = False

    @model_validator(mode="after")
    def check_interval(self):
        if self.md_max_ft <= self.md_min_ft:
            raise ValueError("md_max_ft must be greater than md_min_ft")
        if self.md_max_ft - self.md_min_ft > service.MAX_INTERVAL_FT:
            raise ValueError(f"interval longer than {service.MAX_INTERVAL_FT:.0f} ft")
        return self


@router.get("/defaults")
def defaults(run: str) -> dict:
    well_run = runs.get_run(run)
    return {"run": run, **service.suggested_interval(well_run), "channels": service.channel_labels(),
            "max_stations": service.MAX_STATIONS, "max_interval_ft": service.MAX_INTERVAL_FT}


@router.post("/plan")
def plan(request: InversionRequest) -> dict:
    well_run = runs.get_run(request.run)
    span = request.md_max_ft - request.md_min_ft
    return {**service.public_plan(service.build_plan(well_run, request.curves, request.calibration)),
            "estimated_stations": int(span // request.step_ft) + 1}


@router.post("/jobs")
def submit(request: InversionRequest) -> dict:
    well_run = runs.get_run(request.run)
    try:
        job = service.submit(request.run, well_run, request.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return job.to_dict()


@router.get("/jobs")
def finished_jobs(run: str) -> dict:
    """Finished jobs of a run, newest first (no result payload); the 3D well tab picks one."""
    return {"run": run, "jobs": [layers.job_summary(j) for j in service.finished_jobs(run)]}


@router.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = service.get(job_id)
    if job is None:
        raise HTTPException(404, f"unknown inversion job: {job_id}")
    return job.to_dict()


@router.get("/jobs/{job_id}/layers")
def job_layers(job_id: str) -> dict:
    """Boundary geometry of a finished job for the 3D well tab; see layers.boundary_geometry."""
    job = service.get(job_id)
    if job is None:
        raise HTTPException(404, f"unknown inversion job: {job_id}")
    if job.status != "done" or job.result is None:
        raise HTTPException(409, f"inversion job {job_id} is {job.status}, not done")
    return {"id": job.id, "run": job.run, **layers.boundary_geometry(job.result)}
