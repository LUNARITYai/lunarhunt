# apps/api

FastAPI service for domain logic, AI and document parsing. The only route is `GET /health`.

- App factory: `src/lunarhunt_api/main.py`. `app` is the ASGI object.
- Tests: `uv run pytest tests` from this directory (TestClient against `/health`).
- Set `operation_id` on every route. `uv run export-openapi` (repo root) rewrites `packages/contracts/openapi.json` and the hey-api client.
- `migrations/` is an empty placeholder. No migration tool is configured.
