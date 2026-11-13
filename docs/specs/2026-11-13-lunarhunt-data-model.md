---
status: draft
issue: "#105"
adrs: ["0007", "0010", "0011", "0016", "0018"]
---

# LunarHunt data model and API contract baseline

## Goal and context

Issue [#105](https://github.com/LUNARITYai/lunarhunt/issues/105) implements ADR-0016 D8: parallel feature work on `apps/**` starts only after the data model is agreed in a `ready` spec and the matching `packages/contracts/openapi.json` is merged. Without that, features produce conflicting migrations and contract diffs.

This spec defines the LunarHunt data model and the API resource list for the product scope in `AGENTS.md` ("Purpose"), for a single user:

- offers collected from manual entry, pasted text, public ATS APIs and Notion import;
- classification of offers and an AI match score;
- a CV tailored to each offer;
- an admin panel;
- Nightwatch nightly ATS scans and a morning summary.

It is the source of intent for the generated contract (C-13). Feature specs refer to its entities and do not define their own. A feature that needs a new field changes this spec first (Task 1 rule, below). [ADR-0018](../decisions/0018-lunarhunt-data-model-and-api-contract-baseline.md) records the baseline decisions and their enforcers.

**Out of scope:**

- auth and identity (own ADR; the seam is defined under "Owner seam");
- LLM prompts, model choice and the LLM provider integration;
- UI and the admin panel screens;
- the job queue mechanism (Open question Q12);
- The Ledger, which is PANOPTICON's agent run log, not product data (ADR-0010).

## Acceptance criteria (EARS)

### Capture and provenance

- WHEN an offer is captured from any channel, THE SYSTEM SHALL store the received content as one `source_record` linked to exactly one `offer`.
- IF an update changes any immutable column of a `source_record` (listed under "Entities"), THEN THE SYSTEM SHALL reject it at the database level.
- IF a captured record has the same `owner_id`, `channel`, `source_id`, `external_id` and `content_sha256` as an existing record, THEN THE SYSTEM SHALL create no new record and SHALL return the existing offer with outcome `duplicate`.
- WHEN an ATS or Notion record has the same `channel`, `source_id` and `external_id` as an existing record but a different `content_sha256`, THE SYSTEM SHALL store a new `source_record` and link it to the existing offer.
- WHEN a captured offer's normalized `canonical_url` equals that of an existing non-merged offer of the same owner, THE SYSTEM SHALL link the record to the existing offer instead of creating an offer.
- WHEN extraction of a `pending` offer yields a normalized `canonical_url` equal to that of another non-merged offer, THE SYSTEM SHALL merge the `pending` offer into that offer.
- THE SYSTEM SHALL NOT merge offers automatically on `fingerprint` alone.
- WHEN the user merges offer A into offer B, THE SYSTEM SHALL relink A's records to B, set A to `merged` with `merged_into_id` = B, repoint offers merged into A to B, and keep A's derived records.
- IF a merge names the same offer or a `merged` offer, THEN THE SYSTEM SHALL reject it with `409` and code `offer_merge_invalid`.
- IF a request names an id that does not exist for the current owner, THEN THE SYSTEM SHALL answer `404` with code `not_found`, also when the id belongs to another owner.

### Derived data

- THE SYSTEM SHALL create extracted offer fields, classifications, match scores, parsed CVs and tailored CVs only through an `ai_run`, except rows with `method` = `user`.
- THE SYSTEM SHALL record `model`, `prompt_version` and `input_sha256` on every `ai_run` that calls a model.
- IF an `ai_run` fails, THEN THE SYSTEM SHALL keep the previous derived record as current and store only an `error_code`, never content.
- THE SYSTEM SHALL allow at most one `queued` or `running` `ai_run` per `purpose`, subject and `input_sha256`.
- IF an update targets a `cv_version`, THEN THE SYSTEM SHALL reject it at the database level; an edit SHALL create a new version whose `parent_id` is the edited version.

### Sensitive and untrusted data

- THE SYSTEM SHALL NOT write the value of any field marked `PD` or `UX` to logs, trace or span attributes, metrics, error responses or The Ledger.
- THE SYSTEM SHALL mark every `PD` and `UX` field of the generated OpenAPI schema with the extension `x-lunarhunt-data`.
- THE SYSTEM SHALL return `raw_content` only from `GET /v1/source-records/{id}`.
- WHEN THE SYSTEM sends offer content to a model, THE SYSTEM SHALL call the model with no tools, validate the output against the purpose's schema and write the result only as that run's derived record.
- THE SYSTEM SHALL NOT fetch any URL taken from offer content.
- WHEN an ATS adapter fetches postings, THE SYSTEM SHALL request only the fixed host list of that provider's adapter.
- IF a `board_token` does not match `^[A-Za-z0-9_-]{1,100}$`, THEN THE SYSTEM SHALL reject it with `422`.
- THE SYSTEM SHALL use only synthetic personal data and synthetic offer text in tests and fixtures.
- WHILE no auth is implemented, THE SYSTEM SHALL be reachable only from localhost or the private Dev Container network.

### API

- THE SYSTEM SHALL serve every resource of this spec under `/v1`; `GET /health` stays unversioned.
- WHEN a request fails, THE SYSTEM SHALL respond with the `Problem` shape and media type `application/problem+json`, including validation errors.
- WHEN a list endpoint is called, THE SYSTEM SHALL return a `Page` with `items` and `next_cursor` and accept `limit` from 1 to 200 (default 50).
- THE SYSTEM SHALL set a unique camelCase `operation_id` on every route.
- WHILE a resource of this spec has no feature implementation, THE SYSTEM SHALL serve its route with its final request and response models and answer `501` with code `not_implemented`.

### Persistence and owner seam

- THE SYSTEM SHALL keep every product table in the Postgres schema `lunarhunt`.
- THE SYSTEM SHALL give every table except `owners` a non-null `owner_id`, and every foreign key between owned tables SHALL include `owner_id`.
- THE SYSTEM SHALL resolve the owner of a request through one dependency, `current_owner`, and scope every query on an owned table by its result.
- THE SYSTEM SHALL have exactly one Alembic head; upgrading from empty, downgrading to base and upgrading again SHALL succeed on Postgres 18.

## Plan

### Conventions

- **Database:** Postgres 18 (Dev Container image `postgres:18.6-alpine`). Schema `lunarhunt`; table names plural snake_case.
- **Keys:** `id uuid` primary key, UUIDv7 generated by the application (`uuid.uuid7()`, Python 3.14).
- **Time:** `timestamptz`, stored and returned in UTC, ISO 8601 in the API. `created_at` on every table; `updated_at` on mutable tables.
- **Enums:** `text` with a `CHECK` constraint, not Postgres `ENUM` types, so adding a value is a plain migration.
- **Hashes:** `content_sha256 char(64)`, lowercase hex SHA-256 of the stored bytes (UTF-8 for text).
- **Deletes:** foreign keys are `ON DELETE RESTRICT` unless stated. Deletion of personal data is Q10.
- **Size limits:** pasted text ≤ 100 000 characters; `raw_content` ≤ 2 MiB; uploads ≤ 10 MiB. Larger input gets `413`.

### Data classes

Every field that holds sensitive or untrusted data carries a class in the entity tables:

| Class | Meaning | Stored | Logged | Exposed |
|---|---|---|---|---|
| `PD` | Personal data or CV content (C-19), including third-party contacts that offers may contain | Postgres schema `lunarhunt`, no column encryption in the baseline (Q8) | Never. Logs carry ids, enums, counts, lengths and hashes only | Only through the API routes below; never in errors, traces, metrics or The Ledger. Sent outside the system only to the LLM provider, for `parse_cv`, `score` and `tailor` |
| `UX` | Untrusted external content (C-20): offer text from any channel, and model output derived from it | Raw as received, immutable; derived values in their own rows | Never; length and hash only | API returns it as plain JSON strings marked `x-lunarhunt-data: ["untrusted"]`. The web app renders it as text, never as HTML |

Rules for `UX` beyond storage:

- Offer content is data, never instructions. A model call that receives it has no tools. Its output is parsed with a strict Pydantic schema. The only effect of the call is the derived row of its own `ai_run`. Offer content never chooses an action, a URL to fetch, a record to change or a model to call.
- No component fetches a URL found in offer content (SSRF). ATS adapters build request URLs from a fixed provider host and a validated `board_token` only.
- ATS HTML is stored raw in `raw_content` and converted to plain text deterministically for `description_text`. It is never rendered as HTML.
- An enum field in a derived row (for example `seniority`) is validated against its `CHECK` list; free-text derived fields stay `UX`.

### Entities

`owner_id` is `uuid not null` with a composite foreign key to `owners` on every table except `owners`; it is not repeated in the tables below. Foreign keys between owned tables are composite, `(owner_id, x_id)` → `(owner_id, id)`, so a row can never point to another owner's row.

#### `owners`

| Field | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `created_at` | timestamptz | no | |

No identity data. Identity fields (email, login) belong to the auth ADR. The first migration inserts the single owner.

#### `owner_settings`

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `owner_id` | uuid | no | PK | |
| `active_base_cv_version_id` | uuid | yes | FK `cv_versions`, must be `kind = base` | |
| `timezone` | text | no | IANA name, default `UTC`; defines Nightwatch's run date and the summary period | |
| `updated_at` | timestamptz | no | | |

#### `sources` (configured public ATS boards)

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `provider` | text | no | CHECK list grows with adapters (Q11) | |
| `board_token` | text | no | The company's board id on that provider; `^[A-Za-z0-9_-]{1,100}$` | |
| `display_name` | text | no | Set by the user | |
| `enabled` | boolean | no | Disabled sources are never scanned | |
| `nightwatch` | boolean | no | Included in the nightly scan | |
| `created_at`, `updated_at` | timestamptz | no | | |

Unique `(owner_id, provider, board_token)`. Sources are never deleted while records reference them; they are disabled.

#### `source_records` (immutable raw capture)

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `channel` | text | no | `manual`, `paste`, `ats`, `notion` | |
| `source_id` | uuid | yes | FK `sources`; CHECK not null exactly when `channel = ats` | |
| `ingest_run_id` | uuid | yes | FK `ingest_runs`; null for `manual` and `paste` | |
| `external_id` | text | yes | ATS posting id or Notion page id | `UX` |
| `external_url` | text | yes | URL as received; never fetched | `UX` |
| `content_type` | text | no | `text/plain`, `text/html`, `application/json` | |
| `raw_content` | text | no | Content as received: pasted text, ATS posting JSON, Notion page JSON, or the manual form as JSON | `PD` `UX` |
| `content_sha256` | char(64) | no | | |
| `captured_at` | timestamptz | no | | |
| `offer_id` | uuid | no | FK `offers`; mutable, changes only by merge | |
| `last_seen_at` | timestamptz | no | Mutable; set when a later scan sees the same content | |

- Immutable columns: every column except `offer_id` and `last_seen_at`. A `BEFORE UPDATE` trigger rejects changes to them.
- Unique `NULLS NOT DISTINCT (owner_id, channel, source_id, external_id, content_sha256)`.
- Index `(owner_id, channel, source_id, external_id)` for posting identity.
- `raw_content` is `PD` because offers and Notion pages can contain recruiter contacts and the user's own notes.
- A Notion export file is not kept; each page becomes one record.

#### `offers` (canonical offer)

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `status` | text | no | `pending`, `active`, `archived`, `merged` | |
| `merged_into_id` | uuid | yes | FK `offers`; CHECK not null exactly when `status = merged` | |
| `title` | text | yes | Null only while `pending` | `UX` |
| `company_name` | text | yes | Null only while `pending` | `UX` |
| `location_text` | text | yes | | `UX` |
| `description_text` | text | yes | Plain text | `PD` `UX` |
| `canonical_url` | text | yes | Normalized (below) | `UX` |
| `fingerprint` | char(64) | yes | SHA-256 of normalized `company_name`, `title`, `location_text` | |
| `posted_at` | timestamptz | yes | As stated by the source | `UX` |
| `derived_from_record_id` | uuid | yes | FK `source_records`; the record the canonical fields were last derived from; set in the creating transaction | |
| `user_edited_fields` | text[] | no | Fields the user changed; re-derivation leaves them alone (Q3) | |
| `created_at`, `updated_at` | timestamptz | no | | |

- Unique `(owner_id, canonical_url) WHERE status <> 'merged' AND canonical_url IS NOT NULL`.
- Index `(owner_id, fingerprint)`.
- Canonical URL normalization: lowercase scheme and host, drop the fragment, drop `utm_*` and other known tracking parameters, sort the remaining query parameters, drop a trailing `/`. Only `http` and `https` are kept; any other scheme gives `null`.
- Lifecycle:

| From | To | Trigger |
|---|---|---|
| (new) | `pending` | `paste` capture, before extraction |
| (new) | `active` | `manual`, `ats` or `notion` capture with title and company |
| `pending` | `active` | extraction succeeds, or the user sets title and company |
| `active` | `archived` | user |
| `archived` | `active` | user |
| `pending`, `active`, `archived` | `merged` | merge (user, or the URL rule after extraction); terminal |

#### `ingest_runs`

| Field | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `kind` | text | no | `ats_scan`, `notion_import` |
| `source_id` | uuid | yes | FK `sources`; CHECK not null exactly when `kind = ats_scan` |
| `nightwatch_run_id` | uuid | yes | FK `nightwatch_runs` |
| `trigger` | text | no | `user`, `nightwatch` |
| `status` | text | no | `queued` → `running` → `succeeded` \| `partial` \| `failed` |
| `records_seen`, `records_new`, `offers_created`, `offers_linked`, `errors` | integer | no | Counters, default 0 |
| `error_code` | text | yes | Stable code; never content |
| `created_at` | timestamptz | no | |
| `started_at`, `finished_at` | timestamptz | yes | |

`manual` and `paste` captures are synchronous and have no ingest run.

#### `nightwatch_runs`

| Field | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `run_date` | date | no | In `owner_settings.timezone`; unique `(owner_id, run_date)` |
| `status` | text | no | `queued` → `running` → `succeeded` \| `partial` \| `failed` |
| `created_at` | timestamptz | no | |
| `started_at`, `finished_at` | timestamptz | yes | |

One run starts one `ats_scan` per source with `enabled` and `nightwatch`, then produces one morning summary. `partial` means at least one scan failed.

#### `ai_runs` (provenance and job record for derived data)

| Field | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `purpose` | text | no | `extract`, `classify`, `score`, `parse_cv`, `tailor` |
| `trigger` | text | no | `user`, `ingest`, `nightwatch` |
| `status` | text | no | `queued` → `running` → `succeeded` \| `failed` |
| `offer_id` | uuid | yes | FK `offers`; required for `extract`, `classify`, `score`, `tailor` |
| `source_record_id` | uuid | yes | FK `source_records`; required for `extract` |
| `cv_version_id` | uuid | yes | FK `cv_versions`; the input CV, required for `score` and `tailor` |
| `cv_upload_id` | uuid | yes | FK `cv_uploads`; required for `parse_cv` |
| `model` | text | yes | Model id, set when a model is called |
| `prompt_version` | text | yes | Version label of the prompt, not the prompt |
| `input_sha256` | char(64) | yes | Hash of all inputs, for idempotency and audit |
| `input_tokens`, `output_tokens` | integer | yes | |
| `error_code` | text | yes | Stable code; never content |
| `created_at` | timestamptz | no | |
| `started_at`, `finished_at` | timestamptz | yes | |

- CHECK constraints enforce the required references per `purpose`.
- Unique `(owner_id, purpose, offer_id, cv_version_id, cv_upload_id, input_sha256) NULLS NOT DISTINCT WHERE status IN ('queued', 'running')`.
- No prompt, input or output text is stored here.
- A derived row is written only when its run succeeds, in the same transaction as `status = succeeded`.

#### `classifications`

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `offer_id` | uuid | no | FK `offers` | |
| `ai_run_id` | uuid | yes | FK `ai_runs`; null exactly when `method = user` | |
| `method` | text | no | `llm`, `user` | |
| `taxonomy_version` | text | no | | |
| `seniority`, `work_mode`, `employment_type` | text | yes | CHECK lists per `taxonomy_version` (Q1) | |
| `role_family` | text | yes | | `UX` |
| `tags` | text[] | no | | `UX` |
| `created_at` | timestamptz | no | | |

Insert-only. The current classification of an offer is its newest row.

#### `match_scores`

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `offer_id` | uuid | no | FK `offers` | |
| `cv_version_id` | uuid | no | FK `cv_versions`, `kind = base` | |
| `ai_run_id` | uuid | no | FK `ai_runs` | |
| `score` | smallint | no | CHECK 0–100 | |
| `rationale` | text | yes | Model output over CV and offer | `PD` `UX` |
| `created_at` | timestamptz | no | | |

Insert-only. The current score of an offer is its newest row for the active base CV version.

#### `cv_uploads`

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `filename` | text | no | As uploaded; may contain the user's name | `PD` |
| `media_type` | text | no | Allowed types set in the CV feature spec (Q7) | |
| `size_bytes` | integer | no | | |
| `content_sha256` | char(64) | no | Unique `(owner_id, content_sha256)` | |
| `content` | bytea | no | Original file (Q7) | `PD` |
| `created_at` | timestamptz | no | | |

#### `cv_versions` (immutable)

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `kind` | text | no | `base`, `tailored` | |
| `origin` | text | no | `upload_parse`, `user_edit`, `ai_tailor` | |
| `parent_id` | uuid | yes | FK `cv_versions`; the version this one was derived from | |
| `offer_id` | uuid | yes | FK `offers`; CHECK not null exactly when `kind = tailored` | |
| `cv_upload_id` | uuid | yes | FK `cv_uploads`; set when `origin = upload_parse` | |
| `ai_run_id` | uuid | yes | FK `ai_runs`; set when `origin` is `upload_parse` or `ai_tailor` | |
| `label` | text | yes | User label, for example "Backend, EN" | |
| `schema_version` | text | no | Version of the structured CV schema | |
| `content` | jsonb | no | Structured CV (Q7) | `PD`; `UX` when `ai_tailor` |
| `content_sha256` | char(64) | no | | |
| `created_at` | timestamptz | no | | |

- A `BEFORE UPDATE` trigger rejects every update. Edits create a new row.
- A tailored version's `parent_id` is a base version or an earlier tailored version for the same offer.
- Tailored `content` is `UX` too, because offer text steered the model that wrote it.

#### `morning_summaries` and `morning_summary_items`

| Field | Type | Null | Notes |
|---|---|---|---|
| `morning_summaries.id` | uuid | no | PK |
| `morning_summaries.nightwatch_run_id` | uuid | no | FK `nightwatch_runs`, unique |
| `morning_summaries.period_start`, `period_end` | timestamptz | no | Offers created in `[start, end)` |
| `morning_summaries.created_at` | timestamptz | no | |
| `morning_summary_items.summary_id` | uuid | no | FK, `ON DELETE CASCADE`; PK with `offer_id` |
| `morning_summary_items.offer_id` | uuid | no | FK `offers` |
| `morning_summary_items.rank` | integer | no | |
| `morning_summary_items.match_score` | smallint | yes | Score at summary time |

The summary is a deterministic list of references; it stores no offer text (Q9).

### Relations

```text
owners 1─1 owner_settings ─0..1→ cv_versions (active base)
owners 1─* sources 1─* ingest_runs *─0..1 nightwatch_runs 1─0..1 morning_summaries 1─* morning_summary_items *─1 offers
sources 1─* source_records *─1 offers (offer_id) ; offers *─0..1 offers (merged_into_id)
offers 1─* classifications ; offers 1─* match_scores *─1 cv_versions (base)
offers 1─* cv_versions (tailored) ; cv_versions *─0..1 cv_versions (parent_id) ; cv_uploads 1─* cv_versions
ai_runs 1─0..1 each derived row (classifications, match_scores, cv_versions, extracted offer fields)
```

### Deduplication

Applied in order at capture. The first rule that matches wins.

1. **Same record:** unique key `(owner_id, channel, source_id, external_id, content_sha256)`. No new record. An ATS scan updates `last_seen_at`. Outcome `duplicate`.
2. **Same posting, new content:** same `(channel, source_id, external_id)` for `ats`, or same `(channel, external_id)` for `notion`. New record, linked to the existing offer. Canonical fields are re-derived, except `user_edited_fields`. Outcome `linked`.
3. **Same canonical URL:** normalized `canonical_url` equals an existing non-merged offer's. New record, linked. Outcome `linked`. For `paste` this runs after extraction and merges the `pending` offer.
4. **Otherwise:** new offer. Outcome `created`.

`fingerprint` matches are only listed for the user (`GET /v1/offers?fingerprint=`); merging is a user action (Q2). Rules 1–3 are backed by unique indexes, so concurrent captures cannot create two offers for the same URL; the losing transaction retries and lands in rule 2 or 3.

### Owner seam

- Every owned row carries `owner_id`. Uniqueness is scoped by owner.
- `current_owner` is a FastAPI dependency in `apps/api`. In the baseline it returns the single seeded owner. Every repository function takes the owner id as an argument.
- The worker gets the owner id from the job record (`ai_runs`, `ingest_runs`, `nightwatch_runs`), never from content.

The auth ADR must decide:

- the login method and identity provider, and which identity fields join `owners` (they are `PD`);
- how a request resolves to an owner in `current_owner` (session cookie or token), and CSRF protection for the web app;
- whether the admin panel is a separate role or the same user;
- how the worker and Nightwatch authenticate, if they ever call the API instead of the database;
- when the API may be exposed beyond localhost (until then, the criterion above holds).

What changes for multi-user:

- Postgres row-level security on `owner_id` as a second line behind `current_owner`.
- Nightwatch runs per owner; LLM cost limits per owner.
- Per-owner data export and deletion (GDPR); Q10 becomes mandatory.
- Optional sharing of raw ATS records across owners. That would move `source_records` ownership and is a new ADR.
- No change to uniqueness keys or foreign keys, because they already include `owner_id`.

### API

Contract rules:

- **Contract:** `apps/api` routes and Pydantic models generate `packages/contracts/openapi.json` through `uv run export-openapi`. The file is never hand-written (C-13).
- **Versioning:** path prefix `/v1`. Breaking changes inside `v1` fail CI `oasdiff` (`fail-on: ERR`). A `v2` needs an ADR. `info.version` follows the `apps/api` package version.
- **Error shape `Problem`** (RFC 9457, `application/problem+json`): `type` (URI), `title`, `status`, `detail`, `code` (stable snake_case), `errors` (optional list of `{field, message}` for `422`). `detail` never contains a `PD` or `UX` value. FastAPI's default validation error is replaced with this shape.
- **Pagination `Page[T]`:** `{items: T[], next_cursor: string | null}`. Query `limit` (1–200, default 50) and `cursor` (opaque). Order `created_at desc, id desc`. No total count.
- **IDs and times:** UUID strings; ISO 8601 UTC times.
- **Data class marks:** `PD` fields carry `x-lunarhunt-data: ["personal"]`, `UX` fields `["untrusted"]`, fields with both carry both.
- **Async work:** routes that start a model call or a scan answer `202` with the `AiRun` or `IngestRun`. Clients poll the run.
- **Stubs:** until a feature task implements a route, it answers `501` with code `not_implemented`.

Resources:

| Method and path | operationId | Request | Response |
|---|---|---|---|
| `GET /v1/offers` | `listOffers` | query `status`, `channel`, `min_score`, `fingerprint`, `q` (title or company contains), `limit`, `cursor` | `200 Page[OfferSummary]` |
| `POST /v1/offers` | `createOffer` | `ManualOfferCreate` | `201 IngestResult` (`200` when `duplicate` or `linked`) |
| `POST /v1/offers/paste` | `pasteOffer` | `PasteOfferCreate` | `202 IngestResult` |
| `GET /v1/offers/{id}` | `getOffer` | | `200 OfferDetail` |
| `PATCH /v1/offers/{id}` | `updateOffer` | `OfferPatch` | `200 OfferDetail` |
| `POST /v1/offers/{id}/merge` | `mergeOffer` | `{into_offer_id}` | `200 OfferDetail` (the target) |
| `GET /v1/offers/{id}/source-records` | `listOfferSourceRecords` | `limit`, `cursor` | `200 Page[SourceRecordSummary]` |
| `GET /v1/source-records/{id}` | `getSourceRecord` | | `200 SourceRecord` |
| `POST /v1/offers/{id}/classifications` | `classifyOffer` | | `202 AiRun` |
| `GET /v1/offers/{id}/classifications` | `listOfferClassifications` | `limit`, `cursor` | `200 Page[Classification]` |
| `POST /v1/offers/{id}/match-scores` | `scoreOffer` | `{cv_version_id?}` (default: active base) | `202 AiRun` |
| `GET /v1/offers/{id}/match-scores` | `listOfferMatchScores` | `limit`, `cursor` | `200 Page[MatchScore]` |
| `POST /v1/offers/{id}/tailored-cvs` | `tailorCv` | `{base_cv_version_id?}` | `202 AiRun` |
| `GET /v1/sources` | `listSources` | `limit`, `cursor` | `200 Page[Source]` |
| `POST /v1/sources` | `createSource` | `SourceCreate` | `201 Source` |
| `GET /v1/sources/{id}` | `getSource` | | `200 Source` |
| `PATCH /v1/sources/{id}` | `updateSource` | `SourcePatch` | `200 Source` |
| `POST /v1/sources/{id}/scans` | `scanSource` | | `202 IngestRun` |
| `POST /v1/imports/notion` | `importNotion` | multipart: export file (Q6) | `202 IngestRun` |
| `GET /v1/ingest-runs` | `listIngestRuns` | `kind`, `status`, `source_id`, `limit`, `cursor` | `200 Page[IngestRun]` |
| `GET /v1/ingest-runs/{id}` | `getIngestRun` | | `200 IngestRun` |
| `GET /v1/ai-runs` | `listAiRuns` | `purpose`, `status`, `offer_id`, `limit`, `cursor` | `200 Page[AiRun]` |
| `GET /v1/ai-runs/{id}` | `getAiRun` | | `200 AiRun` |
| `POST /v1/cv-uploads` | `uploadCv` | multipart: file | `202 AiRun` (`parse_cv`) |
| `GET /v1/cv-uploads/{id}` | `getCvUpload` | | `200 CvUpload` (metadata, no file bytes) |
| `GET /v1/cv-versions` | `listCvVersions` | `kind`, `offer_id`, `limit`, `cursor` | `200 Page[CvVersionSummary]` |
| `POST /v1/cv-versions` | `createCvVersion` | `CvVersionCreate` | `201 CvVersion` |
| `GET /v1/cv-versions/{id}` | `getCvVersion` | | `200 CvVersion` |
| `GET /v1/settings` | `getSettings` | | `200 Settings` |
| `PATCH /v1/settings` | `updateSettings` | `SettingsPatch` | `200 Settings` |
| `GET /v1/nightwatch-runs` | `listNightwatchRuns` | `limit`, `cursor` | `200 Page[NightwatchRun]` |
| `GET /v1/nightwatch-runs/{id}` | `getNightwatchRun` | | `200 NightwatchRun` |
| `GET /v1/morning-summaries` | `listMorningSummaries` | `limit`, `cursor` | `200 Page[MorningSummary]` |
| `GET /v1/morning-summaries/{id}` | `getMorningSummary` | | `200 MorningSummary` (items with `OfferSummary`) |

Shapes at entity level (fields as in the entity tables unless listed):

- `OfferSummary`: `id`, `status`, `title`, `company_name`, `location_text`, `canonical_url`, `fingerprint`, `current_score` (`score` only), `current_classification` (enum fields only), `created_at`, `updated_at`.
- `OfferDetail`: `OfferSummary` plus `description_text`, `posted_at`, `merged_into_id`, `user_edited_fields`, `current_classification` (`Classification`), `current_match_score` (`MatchScore`), `latest_runs` (latest `AiRun` per purpose), `channels` (distinct channels of its records).
- `ManualOfferCreate`: `title`, `company_name`, optional `location_text`, `description_text`, `url`.
- `PasteOfferCreate`: `text`, optional `url`.
- `OfferPatch`: any of `title`, `company_name`, `location_text`, `description_text`, `canonical_url`, `posted_at`; `status` limited to `active` and `archived`. Changed fields join `user_edited_fields`.
- `IngestResult`: `outcome` (`created`, `linked`, `duplicate`), `offer_id`, `source_record_id`, `ai_run_id` (for `paste`).
- `SourceRecordSummary`: every column except `raw_content`, plus `content_length`. `SourceRecord` adds `raw_content`.
- `SourceCreate`: `provider`, `board_token`, `display_name`, optional `enabled`, `nightwatch`. `SourcePatch`: `display_name`, `enabled`, `nightwatch` (provider and token are fixed; a new board is a new source).
- `CvVersionCreate`: `parent_id`, `content`, optional `label`; `kind` and `offer_id` come from the parent; `origin` is `user_edit`.
- `CvVersionSummary`: every column except `content`. `CvVersion` adds `content`.
- `CvUpload`: every column except `content`.
- `Settings` and `SettingsPatch`: `active_base_cv_version_id`, `timezone`.
- `AiRun`, `IngestRun`, `NightwatchRun`, `Classification`, `MatchScore`: their columns, without `owner_id`.
- `MorningSummary`: its columns plus `items` (`rank`, `match_score`, `offer`).

`owner_id` is never part of a request or response.

Error codes in the baseline: `validation_failed` (422), `not_found` (404), `offer_merge_invalid` (409), `payload_too_large` (413), `unsupported_media_type` (415), `not_implemented` (501), `internal_error` (500).

### Migration baseline

- **Tool:** SQLAlchemy 2.x (typed ORM, `Mapped[...]`) with Alembic, driver psycopg 3. Models live in `apps/api` (`lunarhunt_api.db`). `apps/worker` imports them as a uv workspace dependency and has no migrations of its own (ADR-0018 D7).
- **Location and naming:** `apps/api/migrations/versions/`. Revision ids are sequential four-digit numbers passed with `--rev-id`; file names `NNNN_<slug>.py`. The first is `0001_baseline.py`.
- **Protection:** `apps/api/migrations/**` is an `ask` path (C-24, Charter `paths.protected.ask`) and `risk:high` (Charter `risk.high.paths`). An agent edit there needs Krzysztof's approval and is denied in headless runs.
- **First migration scope:** create schema `lunarhunt`; every table, constraint, index and trigger in this spec; insert the single `owners` row and its `owner_settings`. No sample data.
- **Checks** (added in Task 2): a test runs `alembic upgrade head`, `downgrade base` and `upgrade head` on Postgres 18; `alembic check` reports no model drift; exactly one head exists.
- **Serialization:** migrations should join ADR-0016 `concurrency.serialize_on` (ADR-0018, proposed Charter change), so two tasks never add revision `0002` in parallel.

### Affected packages and ADRs

- `apps/api`: models, migrations, routes, `current_owner`, `Problem` handler.
- `packages/contracts`, `packages/api-client`: regenerated only.
- `apps/worker`: imports models; later feature tasks add jobs.
- `apps/web`: none in the baseline.
- ADRs: [ADR-0018](../decisions/0018-lunarhunt-data-model-and-api-contract-baseline.md) (this baseline, `proposed`); the auth ADR (later).

## Tasks

1. **This spec and ADR-0018.** Krzysztof answers the open questions and sets `status: ready`; Sentinel reviews first (ADR-0016 D8). Rule from then on: a feature that needs a new field or resource changes this spec in its own `docs/specs/**` PR before its `apps/**` PR. **Allowed paths:** `docs/specs/**`, `docs/decisions/**`.
2. **Persistence baseline:** SQLAlchemy models, Alembic setup, `0001_baseline.py`, triggers, owner seed, migration and schema tests (owner column, composite FKs, immutability, uniqueness). `risk:high` (migrations). Serialized (ADR-0016 D3). **Allowed paths:** `apps/api/**`, `apps/worker/pyproject.toml`, `pyproject.toml`, `uv.lock`.
3. **API contract baseline:** `/v1` routers with the final models and `501` stubs, `Problem` handler, `Page`, `current_owner`, `x-lunarhunt-data` marks and a contract test that checks the marks against this spec; regenerated contract and client. Serialized (contract paths). Depends on 2. **Allowed paths:** `apps/api/**`, `packages/contracts/openapi.json`, `packages/api-client/src/**`.

After Task 3 merges, ADR-0016 D8's start conditions hold. Each feature then gets its own feature spec that refers to this one: manual and paste capture with extraction; ATS sources and scans; Notion import; CV upload and versions; classification and match score; CV tailoring; Nightwatch and the morning summary; the admin panel.

## Open questions (Krzysztof)

Each question names the options, their consequences and a recommendation. The model above assumes the recommendation.

1. **Classification taxonomy.** (a) Fixed fields `seniority`, `work_mode`, `employment_type`, `role_family`, plus free `tags`: queryable, needs a migration to add a field. (b) One free JSON object: flexible, not filterable or checkable. **Recommend (a)**, with the value lists set in the classification feature spec.
2. **Duplicates by fingerprint.** (a) Suggest only; the user merges: no wrong merges, some manual work. (b) Auto-merge: less work, but two real openings with the same title and company merge silently. **Recommend (a).**
3. **Editing offer fields.** (a) The user may edit canonical fields; edits survive re-derivation (`user_edited_fields`); raw content stays immutable. (b) Offer fields are read-only derivations: simpler, but extraction errors cannot be fixed. **Recommend (a).**
4. **Application tracking** (applied, interview, rejected). Not in the `AGENTS.md` scope. (a) Leave out of the baseline; add later as an additive migration. (b) Add now: guesses product behaviour. **Recommend (a).**
5. **Closed postings.** (a) Later: a scan that no longer sees a posting marks the offer closed (new `listing_status` column, additive). (b) Now: needs rules for partial scans. **Recommend (a).**
6. **Notion import method.** (a) Upload of a Notion export file, one-shot: no Notion credential in the system, no live sync. (b) Notion API with an integration token: live sync, but a new secret (C-18) and outbound calls. **Recommend (a).**
7. **CV input and storage.** Structured CV as JSON with our own versioned schema, parsed from an uploaded file. (a) Keep the original file in `cv_uploads.content`: re-parsing possible, more `PD` stored. (b) Discard it after parsing: less `PD`, no re-parse. Also: several base CVs (for example per language) or one. **Recommend (a)**, several base lineages allowed, one active; allowed upload media types set in the CV feature spec.
8. **Encryption at rest for `PD`.** (a) Encrypted disk volume and encrypted backups now; column encryption later: simple, but anyone with database access reads `PD`. (b) Application-level column encryption now: stronger, but needs key management (a new secret) and blocks search. **Recommend (a)** for the single-user MVP; revisit with multi-user.
9. **Morning summary.** (a) Deterministic list of new offers with their scores, shown in the web app: no model call, no offer text copied. (b) Model-written narrative: nicer, adds a `summarize` purpose and more `UX` text. Delivery by email would send offer data to a mail provider. **Recommend (a)**, in-app only.
10. **Retention and deletion of `PD`.** (a) Keep until the user deletes; add hard-delete routes for CV uploads and versions (cascade to tailored versions and scores) in the CV feature spec. (b) Fixed retention periods. **Recommend (a)**; raw offer records are kept for provenance.
11. **First ATS providers.** The model is provider-agnostic. **Recommend** naming them in the ATS feature spec; each adds a `provider` CHECK value and a fixed host list.
12. **Job queue.** (a) Rows in `ai_runs`, `ingest_runs` and `nightwatch_runs` are the queue; the worker claims them with `SELECT … FOR UPDATE SKIP LOCKED`: no extra service. (b) A broker (Redis or similar): another service to run. **Recommend (a).**
