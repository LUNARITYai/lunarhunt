---
status: proposed
date: 2026-11-13
decision-makers: Krzysztof Oszczapiński
consulted: spec-writer (AI)
---

# ADR-0018: LunarHunt data model and API contract baseline

## Context and Problem Statement

ADR-0016 D8 (proposed) requires an agreed data model and API contract before parallel feature work on `apps/**`. `apps/api` has only `GET /health`, no database layer and no migration tool. If each feature defined its own tables and routes, parallel tasks would produce conflicting migrations, duplicate offer entities and contract diffs that `oasdiff` flags late.

LunarHunt also holds two kinds of risky data: the user's CV and other personal data (C-19), and job-offer content from outside sources that may carry prompt injection (C-20). The model must make both visible per field.

The full model, API resource list and open questions are in the spec [`docs/specs/2026-11-13-lunarhunt-data-model.md`](../specs/2026-11-13-lunarhunt-data-model.md) (issue #105). This ADR records the decisions that later specs must not reopen.

## Decision Drivers

- One offer entity for every channel; features refer to it instead of redefining it
- Raw external content kept as received, for provenance and re-processing
- Every derived value traceable to the model call and inputs that produced it
- Personal and untrusted fields marked so that code and checks can find them
- A generated contract that is complete before features fill it in
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

**D2. Raw content is immutable; derived data is insert-only with provenance.** Content columns of `source_records` and all of `cv_versions` never change. Classifications, match scores, extracted fields, parsed and tailored CVs are written only by a succeeded `ai_run` (or `method = user`), which records `model`, `prompt_version` and `input_sha256`, but no prompt or content.
- Enforcement: **planned** (Task 2): `BEFORE UPDATE` triggers in `0001_baseline.py` and a test that updates are rejected; `CHECK` constraints on `ai_runs` references per purpose.

**D3. Deterministic deduplication.** Same record, same posting and same normalized canonical URL resolve to one offer; a fingerprint of company, title and location only suggests duplicates.
- Enforcement: **planned** (Task 2): unique indexes on `source_records` and `offers`; tests per rule.

**D4. Data classes in the contract.** Fields holding personal data or CV content are class `PD` (C-19); fields holding untrusted external content are class `UX` (C-20). Both are marked in the generated OpenAPI with `x-lunarhunt-data`, never logged, never put in errors, traces, metrics or The Ledger.
- Enforcement:
  - marks: **planned** (Task 3): a contract test compares marked fields with the spec's list;
  - logs and errors: **planned** (Task 3): a test that seeds synthetic CV and offer markers and asserts they are absent from captured logs and error bodies. The Charter keys `log_access.redact` and `ledger.capture_content: false` state the policy, but their tools are not built, so they enforce nothing yet;
  - Sentinel review is a human control on top, not a code enforcer.

**D5. Offer content never steers actions.** A model call that receives offer content has no tools; its output is schema-validated and only written as that run's derived row. No component fetches a URL found in offer content; ATS adapters call only fixed provider hosts with a validated `board_token`.
- Enforcement: `board_token` pattern: **planned** (Task 3, request model). No-tools model calls and no content URL fetching: **not yet enforced**; the LLM client and ATS adapter feature specs must add tests (model client built without tools; adapter rejects hosts outside its list). Sentinel reviews every such PR.

**D6. API conventions.** Resources under `/v1`; errors as RFC 9457 `application/problem+json` with a stable `code`; cursor pagination `{items, next_cursor}`; camelCase `operation_id` on every route; UUIDv7 ids; UTC ISO 8601 times; `owner_id` never in the API. The full resource list is in the contract early, with `501` stubs until features implement it.
- Enforcement:
  - contract generated, never hand-written: **enforced** (`pnpm check` contract drift, CI `contract`, `generated-files-guard` in The Charter `paths.generated`);
  - no breaking change inside `v1`: **enforced** (CI `contract` `oasdiff`, `fail-on: ERR`);
  - conventions: **planned** (Task 3): a test over `openapi.json` that every path starts with `/v1` or is `/health`, every operation has a camelCase `operationId`, every error response uses `Problem`, every list returns `Page`.

**D7. Persistence baseline.** Postgres 18, product tables in schema `lunarhunt` (The Ledger stays outside it); SQLAlchemy 2.x with Alembic and psycopg 3; `apps/api` owns the models and is the only package with migrations, in `apps/api/migrations/versions/`, sequential revision ids `NNNN_<slug>.py`; `apps/worker` imports the models as a workspace dependency. Enum values are `text` with `CHECK`.
- Enforcement:
  - migrations are `ask` and `risk:high`: **enforced** (`protected-paths`, Charter `paths.protected.ask`; `risk-classifier` planned);
  - single head, upgrade and downgrade round trip, no model drift (`alembic check`): **planned** (Task 2 tests in `pnpm check`);
  - worker has no migrations: **not yet enforced**.

**D8. Owner seam.** Every table except `owners` has `owner_id`; foreign keys between owned tables include it; uniqueness is per owner. `current_owner` is the only place that resolves the owner of a request; in the baseline it returns the single seeded owner. Auth and identity are a separate ADR, which decides login, sessions, CSRF, the admin role and exposure beyond localhost.
- Enforcement: owner columns and composite foreign keys: **planned** (Task 2 schema introspection test). Queries scoped through `current_owner`: **not yet enforced** (Reviewer; row-level security when multi-user arrives). Localhost-only exposure until auth: **not yet enforced** (`deploy/**` is `ask`, so no agent can expose it alone).

### Consequences

- Good, because every feature spec works against one model, and contract changes are visible as diffs to this baseline.
- Good, because raw content and model provenance make re-processing and audits possible without re-fetching.
- Good, because sensitive and untrusted fields are machine-findable in the contract.
- Good, because adding auth or more users does not change keys or uniqueness.
- Bad, because insert-only derived rows and kept raw content grow the database and hold more `PD`; retention is an open question (spec Q10).
- Bad, because composite foreign keys add columns and index width for a single user.
- Bad, because D5's main controls have no code enforcer until the LLM client and ATS adapter exist.
- Neutral, because `501` stubs make the contract complete before the behaviour exists; clients must handle `501`.

### Confirmation

- Task 2 tests (in `pnpm check`, CI `check`): migration round trip on Postgres 18, single Alembic head, `alembic check`, owner column and composite foreign keys on every owned table, immutability triggers, unique indexes for deduplication.
- Task 3 tests: OpenAPI conventions (D6), `x-lunarhunt-data` marks against the spec's list (D4), log and error-body redaction with synthetic markers (D4).
- Existing: contract drift in `pnpm check`, CI `contract` with `oasdiff`, `generated-files-guard`, `protected-paths` for migrations.
- Human: Sentinel reviews this ADR and the spec before Krzysztof sets the spec `ready` (ADR-0016 D8).

## Pros and Cons of the Options

### 1. Canonical offer + immutable source records (chosen)

- Good, because one entity serves every channel and raw input is never lost.
- Bad, because there are more tables and a deduplication step at capture.

### 2. One table per channel

- Good, because each channel's fields fit exactly.
- Bad, because scoring, tailoring and the summary must join four tables, and the same job from two channels is two offers.

### 3. Overwrite one table

- Good, because it is the simplest.
- Bad, because a capture overwrites earlier content and user edits, and nothing shows where a value came from.

### 4. Event sourcing

- Good, because the history is complete.
- Bad, because projections and replay are heavy for a single-user app and slow every feature.

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

- The Charter, `concurrency.serialize_on` (ADR-0016, once its section exists): add `"apps/api/migrations/**"`, so two tasks never add the same revision number in parallel.
- `apps/api/AGENTS.md`, after Task 2: replace "No migration tool is configured" with the Alembic commands and the `--rev-id` naming rule. `apps/api/migrations/README.md` likewise.
- `docs/decision-log.md`: a row for this ADR after #101 merges.

## More Information

- Spec: [`docs/specs/2026-11-13-lunarhunt-data-model.md`](../specs/2026-11-13-lunarhunt-data-model.md); issue #105.
- RFC 9457 Problem Details: <https://www.rfc-editor.org/rfc/rfc9457>; Alembic: <https://alembic.sqlalchemy.org/>.
- Related: ADR-0007 (contract generation, `oasdiff`), ADR-0010 (The Ledger, log redaction), ADR-0011 (spec process), ADR-0016 D3 and D8 (proposed; serialization and contracts first).
- Revisit when the auth ADR is accepted or when LunarHunt becomes multi-user.
