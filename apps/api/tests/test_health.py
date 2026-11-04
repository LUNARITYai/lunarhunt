"""Health route."""

from typing import Protocol, cast

import httpx
from fastapi.testclient import TestClient

from lunarhunt_api.main import app


class _HttpGet(Protocol):
    def get(self, url: str) -> httpx.Response: ...


def test_health() -> None:
    with TestClient(app) as raw:
        # Starlette types this client against httpx2, which we do not depend on.
        client = cast("_HttpGet", raw)
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
