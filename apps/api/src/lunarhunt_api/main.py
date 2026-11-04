"""FastAPI application. Placeholder: health check only."""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel


class Health(BaseModel):
    status: Literal["ok"]


def create_app() -> FastAPI:
    app = FastAPI(title="LunarHunt API", version="0.0.0")

    @app.get("/health", operation_id="health")
    def health() -> Health:
        return Health(status="ok")

    return app


app = create_app()
