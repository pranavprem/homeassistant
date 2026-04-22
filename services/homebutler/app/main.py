from __future__ import annotations

from fastapi import FastAPI

from app.api.routes.migration import router as migration_router
from app.api.routes.ops import router as ops_router
from app.api.routes.shopping import router as shopping_router
from app.api.routes.system import router as system_router
from app.config import APP_VERSION, get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.service_name,
        version=APP_VERSION,
        description=(
            "HomeButler is the action/orchestration layer. "
            "Grocy remains the source of household state."
        ),
    )
    app.include_router(system_router)
    app.include_router(shopping_router)
    app.include_router(ops_router)
    app.include_router(migration_router)
    return app


app = create_app()
