import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Resist backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class QcSelectRequest(BaseModel):
    curves: list[str] = Field(default_factory=list)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/curves")
def curves() -> dict[str, list]:
    return {"curves": []}


@app.post("/qc/select")
def qc_select(request: QcSelectRequest) -> dict:
    return {"selected": [], "rejected": [], "scores": {}}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, port=int(os.environ.get("RESIST_BACKEND_PORT", "5000")))
