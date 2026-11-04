# apps/api

FastAPI service for domain logic, AI and document parsing. The only route is `GET /health`.

- App factory: `src/lunarhunt_api/main.py`. `app` is the ASGI object.
- Tests: `pnpm test` (runs pytest from the repo root so the root dev group is installed).
- Set `operation_id` on every route. `uv run export-openapi` (repo root) rewrites `packages/contracts/openapi.json` and the hey-api client.
- `migrations/` is an empty placeholder. No migration tool is configured.
