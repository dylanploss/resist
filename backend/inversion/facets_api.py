"""HTTP endpoints for the 3D facet inversion (free dip azimuth, all four image quadrants)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from backend.inversion import facets, service
from backend.services import runs

router = APIRouter(prefix="/inversion3d")


class FacetRequest(BaseModel):
    run: str
    curves: list[str] = Field(min_length=1)
    md_min_ft: float
    md_max_ft: float
    step_ft: float = Field(4.0, ge=1.0, le=20.0)
    window_ft: float = Field(100.0, ge=40.0, le=400.0)
    layers: int = Field(2, ge=1, le=3)
    max_dip_deg: float = Field(facets.DEFAULT_MAX_DIP_DEG, ge=5.0, le=80.0)
    rotation: int = 1
    remove_lateral_offset: bool = True
    calibration: bool = True
    compare: bool = False
    quick: bool = True

    @model_validator(mode="after")
    def check(self):
        if self.md_max_ft <= self.md_min_ft:
            raise ValueError("md_max_ft must be greater than md_min_ft")
        if self.md_max_ft - self.md_min_ft > facets.MAX_INTERVAL_FT:
            raise ValueError(f"interval longer than {facets.MAX_INTERVAL_FT:.0f} ft")
        if self.rotation not in (1, -1):
            raise ValueError("rotation must be 1 or -1")
        return self


@router.get("/defaults")
def defaults(run: str) -> dict:
    return {"run": run, **facets.suggested_interval(runs.get_run(run)), "channels": facets.channel_labels(),
            "max_interval_ft": facets.MAX_INTERVAL_FT, "max_windows": facets.MAX_WINDOWS,
            "corridor_m": facets.CORRIDOR_M, "max_dip_deg": facets.DEFAULT_MAX_DIP_DEG}


@router.post("/plan")
def plan(request: FacetRequest) -> dict:
    well_run = runs.get_run(request.run)
    centres = facets.window_centres(request.md_min_ft, request.md_max_ft, request.window_ft)
    return {**service.public_plan(facets.build_plan(well_run, request.curves, request.calibration)),
            "estimated_stations": int((request.md_max_ft - request.md_min_ft) // request.step_ft) + 1,
            "windows": len(centres)}


@router.post("/jobs")
def submit(request: FacetRequest) -> dict:
    try:
        job = facets.submit(request.run, runs.get_run(request.run), request.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return job.to_dict()


@router.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = service.get(job_id)
    if job is None:
        raise HTTPException(404, f"unknown inversion job: {job_id}")
    return job.to_dict()
