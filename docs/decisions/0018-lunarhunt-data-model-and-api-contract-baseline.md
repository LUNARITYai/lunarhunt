---
status: proposed
date: 2026-11-13
decision-makers: Krzysztof Oszczapiński
consulted: spec-writer (AI)
---

# ADR-0018: LunarHunt data model and API contract baseline

## Context and Problem Statement

ADR-0016 D8 (proposed) requires an agreed data model and API contract before parallel feature work on `apps/**`. `apps/api` has only `GET /health`, no database layer and no migration tool. If each feature defined its own tables and routes, parallel tasks would produce conflicting migrations, duplicate offer entities and contract diffs that `oasdiff` flags late.

LunarHunt also holds two kinds of risky data: the user's CV and other personal data (C-19), and job-offer content from outside sources that may carry prompt injection (C-20). The model must make both visible per field, and the user must be able to delete personal data.

The full model, API resource list and open questions are in the spec [`docs/specs/2026-11-13-lunarhunt-data-model.md`](../specs/2026-11-13-lunarhunt-data-model.md) (issue #105). This ADR records the decisions that later specs must not reopen.

## Decision Drivers

- One offer entity for every channel; features refer to it instead of redefining it
- Raw external content kept as received, for provenance and re-processing
- Every derived value traceable to the model call and inputs that produced it
- Personal and untrusted fields marked so that code and checks can find them
- Personal data deletable by the user
- A generated contract that is complete before features fill it in
- Feature areas that parallel tasks can own without overlapping
- A seam for auth and multi-user without redesigning keys
- Every rule has an enforcer in code, or says it has none yet (C-01)

## Considered Options

Model:

1. Canonical `offers` plus immutable `source_records` plus insert-only derived rows with `ai_runs` provenance
2. One `offers` table per channel, unified by a view
3. One `offers` table whose fields are overwritten by each capture
4. Event sourcing (an event log, offers as projections)

Persistence:

A. SQLAlchemy 2.x + Alembic
B. SQLModel + Alembic
C. Plain SQL migrations (for example dbmate) with a query builder

## Decision Outcome

Chosen options: **1** and **A**. Option 1 keeps one entity and full provenance with plain tables. Option A is the standard typed ORM and migration pair for FastAPI and works with Pyright strict.

### Decisions

Enforcement status per C-01: **enforced** (a check exists today), **planned** (named enforcer, built in the task given), **not yet enforced** (no enforcer).

**D1. One canonical offer, many source records.** Every channel (`manual`, `paste`, `ats`, `notion`) stores what it received as a `source_record` linked to one `offer`. Features never add a second offer entity.
- Enforcement: **planned** (spec Task 2): foreign keys and `NOT NULL` on `source_records.offer_id`; schema test. Feature specs referring to this model: **not yet enforced** (Reviewer).

**D2. Raw content is immutable; derived data is insert-only with provenance.** Content columns of `source_records` and all of `cv_versions` never change; immutability forbids `UPDATE`, not `DELETE` (D9). `manual`, `ats` and `notion` fill offer fields by deterministic mapping with no model call; only `paste` uses an LLM `extract` run, recorded in `offers.derived_by_ai_run_id`. Classifications, match scores, parsed and tailored CVs are written only by a succeeded `ai_run` (or by the user: `method = user`, `origin = user_edit`), which records `model`, `prompt_version` and `input_sha256`, but no prompt or content.
- Enforcement: **planned** (Task 2): `BEFORE UPDATE` triggers in `0001_baseline.py` with a test that updates are rejected and deletes allowed; `ai_runs` `CHECK` and `BEFORE INSERT` trigger for references per purpose; derived-row consistency and CV lineage triggers. Deterministic mapping per channel: **not yet enforced** (feature specs add tests that the capture path calls no model).

**D3. Deterministic deduplication from trusted input.** Same record, same posting and same normalized canonical URL resolve to one offer. Only a user-supplied or ATS-supplied URL can link records automatically; a model-extracted URL and the fingerprint of company, title and location are suggestions for the user. A URL match never re-derives fields and never links an `ats` record to an offer that has an `ats` record from another source.
- Enforcement: **planned** (Task 2): unique indexes on `source_records` and `offers`, advisory lock for same-posting captures; tests per rule. Trusted-URL and cross-source rules: **planned** (Feature 1 and 2 tests).

**D4. Data classes in the contract.** Fields holding personal data or CV content are class `PD` (C-19); fields holding untrusted external content are class `UX` (C-20). Both are marked in the generated OpenAPI with `x-lunarhunt-data`, and never logged, put in errors, traces, recorded exceptions, metrics or The Ledger. `PD` leaves the system only to the LLM provider, for `extract`, `classify`, `score`, `parse_cv` and `tailor` (spec Q15). Validation errors carry only a location and a code.
- Enforcement:
  - marks: **planned** (Task 3): a contract test compares marked fields with the spec's list;
  - logs and errors: **planned** (Task 3 for `apps/api`, Task 4 for `apps/worker` and span exception recording): a test that seeds synthetic CV and offer markers and asserts they are absent from captured logs, spans and error bodies. The Charter keys `log_access.redact` and `ledger.capture_content: false` state the policy, but their tools are not built, so they enforce nothing yet;
  - egress only to the LLM provider: **not yet enforced**; the LLM client spec adds it;
  - encrypted volume and backups (spec Q8): **not yet enforced**;
  - Sentinel review is a human control on top, not a code enforcer.

**D5. Offer content never steers actions.** A model call that receives offer content has no tools; its output is schema-validated and only written as that run's derived row. A model's output never links, merges or deletes a record. No component fetches a URL found in offer content; ATS adapters call only fixed provider hosts with a validated `board_token`. URLs are accepted and returned only with `http` or `https`.
- Enforcement: `board_token` pattern and URL schemes: **planned** (Task 3, request and response models). No-tools model calls: **planned** (Task 4, LLM client test). No content URL fetching and the fixed host list: **not yet enforced**; the ATS feature spec must add tests (adapter rejects hosts outside its list and cross-host redirects). Sentinel reviews every such PR.

**D6. API conventions.** Resources under `/v1`; errors as RFC 9457 `application/problem+json` with a stable `code`; cursor pagination `{items, next_cursor}`; camelCase `operation_id` on every route; UUIDv7 ids; UTC ISO 8601 times; `owner_id` never in the API; every request string, array and JSON object bounded. The full resource list is in the contract early, with `501` stubs until features implement it. Routes start as `x-stability-level: alpha` and become frozen when their feature sets them to `stable`.
- Enforcement:
  - contract generated, never hand-written: **enforced** (`pnpm check` contract drift, CI `contract`, `generated-files-guard` in The Charter `paths.generated`);
  - no breaking change to a `stable` route inside `v1`: **enforced** (CI `contract` `oasdiff`, `fail-on: ERR`); the `alpha` exclusion is **planned** to be verified in Task 3;
  - conventions and bounds: **planned** (Task 3): a test over `openapi.json` that every path starts with `/v1` or is `/health`, every operation has a camelCase `operationId`, every error response uses `Problem`, every list returns `Page`, and every request string has `maxLength` and every array `maxItems`.

**D7. Persistence baseline.** Postgres 18, product tables in schema `lunarhunt` (The Ledger stays outside it); SQLAlchemy 2.x with Alembic and psycopg 3; `apps/api` owns the models and is the only package with migrations, in `apps/api/migrations/versions/`, sequential revision ids `NNNN_<slug>.py`; `apps/worker` imports the models as a workspace dependency. Enum values are `text` with `CHECK`. A migration role owns the schema; the app and worker connect as a runtime role with DML only.
- Enforcement:
  - migrations are `ask` and `risk:high`: **enforced** (`protected-paths`, Charter `paths.protected.ask`; `risk-classifier` planned);
  - single head, upgrade and downgrade round trip, no model drift (`alembic check`), runtime role limits: **planned** (Task 2 tests in `pnpm check`). In CI they run only after Krzysztof adds Postgres to the `check` job (spec Prerequisite 1); until then they run locally against the Dev Container database;
  - worker has no migrations: **not yet enforced**.

**D8. Owner seam.** Every table except `owners` has `owner_id`; foreign keys between owned tables include it; uniqueness is per owner. `current_owner` is the only place that resolves the owner of a request; in the baseline it returns the single seeded owner. Auth and identity are a separate ADR, which decides login, sessions, CSRF, the admin role and exposure beyond localhost.
- Enforcement: owner columns and composite foreign keys: **planned** (Task 2 schema introspection test). Queries scoped through `current_owner`: **not yet enforced** (Reviewer; row-level security when multi-user arrives). Localhost-only exposure until auth: Host allowlist and CORS **planned** (Task 3); network exposure **not yet enforced** (`deploy/**` is `ask`, so no agent can expose it alone).

**D9. User-initiated hard delete.** The user can delete offers, source records, CV uploads and CV versions. Every foreign key states its `ON DELETE` action in the spec: the CV chain cascades (versions, tailored versions, scores); deleting an offer cascades to its records, derived rows and tailored CVs; `ai_runs` references become null so the run row survives without content. Notion import stores only pages mapped to an offer, and the uploaded export is deleted when its run ends. Retention periods and soft delete are not used (spec Q10).
- Enforcement: **planned** (Task 2): a test per `ON DELETE` action, a test that a run row survives its inputs' deletion, and a test that a terminal `ingest_run` has no `ingest_uploads` row. Unmapped Notion pages not stored: **planned** (Notion feature spec test).

**D10. The data model spec is a living baseline.** The spec stays in `docs/specs/` with `status: ready` and is changed in place; it never moves to `docs/specs/implemented/`, as an exception to ADR-0011's folder rule for this spec only. A feature that needs a new field, resource or bound changes the spec in its own `docs/specs/**` PR before its `apps/**` PR; Krzysztof's merge of that PR is the re-approval (C-10).
- Enforcement: **not yet enforced** (Reviewer; `spec-check` is not built). The contract drift check makes an unapproved model change visible as a diff.

**D11. Feature areas own disjoint paths.** Each feature area (offers, sources, Notion, CV, classification, scoring, tailoring, Nightwatch) owns one package in `apps/api` and one in `apps/worker`, created as stubs by the baseline tasks. Shared code (`db/`, `api/`, `ai/`, `runner/`), migrations and the contract are serialized (ADR-0016 D3).
- Enforcement: allowed paths per task: **enforced** when the worktree has `.panopticon/task.json` (`scope-guard`); serialization of shared paths: **not yet enforced** (ADR-0016 D3, OVERSEER by hand).

### Consequences

- Good, because every feature spec works against one model, and contract changes are visible as diffs to this baseline.
- Good, because raw content and model provenance make re-processing and audits possible without re-fetching.
- Good, because sensitive and untrusted fields are machine-findable in the contract.
- Good, because the user can delete personal data, and the cascade is defined before any data exists.
- Good, because feature areas can be built in parallel without overlapping paths.
- Good, because adding auth or more users does not change keys or uniqueness.
- Bad, because insert-only derived rows and kept raw content grow the database and hold more `PD` until the user deletes it.
- Bad, because hard delete leaves no undo and no content audit, and an ATS offer still posted comes back on the next scan.
- Bad, because composite foreign keys add columns and index width for a single user.
- Bad, because D5's main controls and the database tests in CI have no enforcer until Task 4, the ATS feature and Prerequisite 1 land.
- Neutral, because `501` stubs make the contract complete before the behaviour exists; clients must handle `501`.

### Confirmation

- Prerequisite (Krzysztof, before Task 2): Postgres 18 and `DATABASE_URL` in the CI `check` job, and the migration and runtime roles. Until then the Task 2 tests run in local `pnpm check` only.
- Task 2 tests (in `pnpm check`; in CI `check` once the prerequisite lands): migration round trip on Postgres 18, single Alembic head, `alembic check`, owner column and composite foreign keys on every owned table, `ON DELETE` actions, immutability triggers, `ai_runs` and lineage triggers, unique indexes for deduplication, runtime role limits.
- Task 3 tests: OpenAPI conventions and bounds (D6), `x-lunarhunt-data` marks against the spec's list (D4), API log and error-body redaction with synthetic markers (D4), the `alpha` stability exclusion in `oasdiff`.
- Task 4 tests: no-tools LLM client (D5), worker log and span redaction (D4), `input_deleted` handling (D9).
- Existing: contract drift in `pnpm check`, CI `contract` with `oasdiff`, `generated-files-guard`, `protected-paths` for migrations, `scope-guard` with task files.
- Human: Sentinel reviews this ADR and the spec before Krzysztof sets the spec `ready` (ADR-0016 D8).

## Pros and Cons of the Options

### 1. Canonical offer + immutable source records (chosen)

- Good, because one entity serves every channel and raw input is never lost by overwriting.
- Bad, because there are more tables and a deduplication step at capture.

### 2. One table per channel

- Good, because each channel's fields fit exactly.
- Bad, because scoring, tailoring and the summary must join four tables, and the same job from two channels is two offers.

### 3. Overwrite one table

- Good, because it is the simplest.
- Bad, because a capture overwrites earlier content and user edits, and nothing shows where a value came from.

### 4. Event sourcing

- Good, because the history is complete.
- Bad, because projections and replay are heavy for a single-user app, slow every feature, and make deleting personal data from the log hard.

### A. SQLAlchemy 2.x + Alembic (chosen)

- Good, because it is mature, typed (`Mapped[...]`) and has autogenerate and `alembic check`.
- Bad, because Pydantic API models and ORM models are separate classes.

### B. SQLModel + Alembic

- Good, because one class can serve as ORM and API model.
- Bad, because sharing one class makes it easy to expose `owner_id` or `PD` columns by accident, and it lags SQLAlchemy releases.

### C. Plain SQL migrations

- Good, because the SQL is explicit.
- Bad, because there is no model drift check and no typed models for Pyright.

## Proposed normative changes (Krzysztof applies after acceptance)

Agents do not edit these files (C-24).

- `.github/workflows/check.yml`: a Postgres 18 service (or compose) for the `check` job, with `DATABASE_URL` and `DATABASE_URL_MIGRATE` passed into the `docker run` (spec Prerequisite 1).
- `.env.example` and `.devcontainer/**`: `DATABASE_URL_MIGRATE` for the migration role beside the runtime `DATABASE_URL` (spec Prerequisite 2).
- The Charter, `concurrency.serialize_on` (ADR-0016, once its section exists): add `"apps/api/migrations/**"`, so two tasks never add the same revision number in parallel.
- `apps/api/AGENTS.md`, after Task 2: replace "No migration tool is configured" with the Alembic commands, the `--rev-id` naming rule and the area package layout. `apps/api/migrations/README.md` likewise.
- `docs/specs/AGENTS.md`: note the D10 exception for the data model spec.
- `docs/decision-log.md`: a row for this ADR after #101 merges.

## More Information

- Spec: [`docs/specs/2026-11-13-lunarhunt-data-model.md`](../specs/2026-11-13-lunarhunt-data-model.md); issue #105.
- RFC 9457 Problem Details: <https://www.rfc-editor.org/rfc/rfc9457>; Alembic: <https://alembic.sqlalchemy.org/>. The `oasdiff` `x-stability-level` behaviour is taken from its documentation and verified in Task 3.
- Related: ADR-0007 (contract generation, `oasdiff`), ADR-0010 (The Ledger, log redaction), ADR-0011 (spec process), ADR-0016 D3 and D8 (proposed; serialization and contracts first).
- Revisit when the auth ADR is accepted or when LunarHunt becomes multi-user.
