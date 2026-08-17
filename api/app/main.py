"""FastAPI application entry point."""

from __future__ import annotations

import contextlib
import logging
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import drive
from app.config import settings
from app.routers import drive as drive_router
from app.routers import lectures, projects

log = logging.getLogger("ig-study")


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    missing = settings().missing()
    if missing:
        log.warning("Missing configuration: %s", ", ".join(missing))
    yield
    await drive.close()


app = FastAPI(title="ig-study API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings().cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(drive_router.router)
app.include_router(lectures.router)
app.include_router(projects.router)


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness plus a configuration check that never leaks a secret value.

    Not `/healthz`: Google's frontend intercepts that path on Cloud Run and
    answers its own 404 before the request reaches the container, which reads
    as a broken deploy when everything else is fine.
    """
    return {"ok": True, "missingConfig": settings().missing()}
