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

It is the source of intent for the generated contract (C-13). Feature specs refer to its entities and do not define their own. This spec is a living baseline (ADR-0018 D10): it stays in `docs/specs/` and is changed in place, never moved to `implemented/`. [ADR-0018](../decisions/0018-lunarhunt-data-model-and-api-contract-baseline.md) records the baseline decisions and their enforcers.

**Out of scope:**

- auth and identity (own ADR; the seam is defined under "Owner seam");
- LLM prompts, model choice and the LLM provider integration (provider data handling is Q15);
- UI and the admin panel screens;
- The Ledger, which is PANOPTICON's agent run log, not product data (ADR-0010).

## Acceptance criteria (EARS)

### Capture and provenance

- WHEN an offer is captured from any channel, THE SYSTEM SHALL store the received content as one `source_record` linked to exactly one `offer`.
- IF an update changes any immutable column of a `source_record` (listed under "Entities"), THEN THE SYSTEM SHALL reject it at the database level.
- IF a captured record has the same `owner_id`, `channel`, `source_id`, `external_id` and `content_sha256` as an existing record, THEN THE SYSTEM SHALL create no new record, SHALL set the existing record's `last_seen_at` to the capture time, and SHALL return the existing offer with outcome `duplicate`.
- WHEN an ATS or Notion record has the same `channel`, `source_id` and `external_id` as an existing record but a different `content_sha256`, THE SYSTEM SHALL store a new `source_record` and link it to the existing offer.
- WHEN rule 2 links a record, THE SYSTEM SHALL re-derive the offer's fields only if the record named in `derived_from_record_id` has the same `channel`, `source_id` and `external_id`.
- WHEN a captured record carries a user-supplied or ATS-supplied URL whose normalized form equals the `canonical_url` of an existing non-merged offer, THE SYSTEM SHALL link the record to that offer, unless the record is from `ats` and the offer has any record that is not an `ats` record of the same `source_id`.
- WHEN rule 3 links a record, THE SYSTEM SHALL leave the offer's fields unchanged.
- THE SYSTEM SHALL NOT link or merge offers automatically on `fingerprint`, on `suggested_url`, or on any value produced by a model.
- WHEN the user merges offer A into offer B, THE SYSTEM SHALL relink A's records to B, set A to `merged` with `merged_into_id` = B, repoint offers merged into A to B, and keep A's derived records.
- IF a merge names the same offer or a `merged` offer, THEN THE SYSTEM SHALL reject it with `409` and code `offer_merge_invalid`.
- IF a request names an id that does not exist for the current owner, THEN THE SYSTEM SHALL answer `404` with code `not_found`, also when the id belongs to another owner.
- IF a write would violate a unique key, THEN THE SYSTEM SHALL answer `409` with code `conflict` and the existing row's id in `conflict_id`, except for captures, which return `IngestResult`.

### Derived data

- THE SYSTEM SHALL fill offer fields for `manual`, `ats` and `notion` captures by deterministic mapping, with no model call and `derived_by_ai_run_id` null.
- THE SYSTEM SHALL fill offer fields for `paste` captures only through a succeeded `extract` `ai_run`, and SHALL set `derived_by_ai_run_id` to that run.
- IF an `extract` request names a `source_record_id` that is not a `paste` record of its `offer_id`, THEN THE SYSTEM SHALL reject it with `422`.
- IF an insert or update sets `offers.derived_by_ai_run_id` to a run that is not a succeeded `extract` run for that offer, THEN THE SYSTEM SHALL reject it at the database level.
- THE SYSTEM SHALL create classifications, match scores, parsed CVs and tailored CVs only through a succeeded `ai_run`, except classifications with `method` = `user` and CV versions with `origin` = `user_edit`.
- THE SYSTEM SHALL record `model`, `prompt_version` and `input_sha256` on every `ai_run` that calls a model.
- IF an `ai_run` fails, THEN THE SYSTEM SHALL keep the previous derived record as current and store only an `error_code`, never content.
- THE SYSTEM SHALL allow at most one `queued` or `running` `ai_run` per `purpose`, subject and `input_sha256`, and SHALL return the existing run when a request would start a second one.
- IF an update targets a `cv_version`, THEN THE SYSTEM SHALL reject it at the database level; an edit SHALL create a new version whose `parent_id` is the edited version.

### Deletion

- WHEN the user deletes an offer, a source record, a CV upload or a CV version, THE SYSTEM SHALL hard-delete the row, apply the `ON DELETE` action of every relation as listed under "Relations", and return the number of deleted rows per table.
- WHEN a delete request has `dry_run=true`, THE SYSTEM SHALL return the same counts and delete nothing.
- IF a delete request names an id that does not exist for the current owner, THEN THE SYSTEM SHALL answer `404` with code `not_found`.
- THE SYSTEM SHALL allow `DELETE` on immutable tables; immutability triggers SHALL reject only `UPDATE`.
- IF the user deletes the last source record of a non-merged offer, THEN THE SYSTEM SHALL reject it with `409` and code `last_source_record`.
- IF a `notion_import` run is `queued` or `running` for the owner, THEN THE SYSTEM SHALL reject a new import with `409` and code `conflict`.
- WHEN a row that a `queued` or `running` `ai_run` reads is deleted, THE SYSTEM SHALL finish that run as `failed` with `error_code` `input_deleted` and write no derived row.
- WHEN a Notion import runs, THE SYSTEM SHALL store only pages that map to an offer, and SHALL store no other page of the export.
- WHEN an `ingest_run` reaches `succeeded`, `partial` or `failed`, THE SYSTEM SHALL delete its `ingest_uploads` row in the same transaction.

### Sensitive and untrusted data

- THE SYSTEM SHALL NOT write the value of any field marked `PD` or `UX` to logs, trace or span attributes, recorded exceptions, metrics, error responses or The Ledger, in `apps/api` and in `apps/worker`.
- THE SYSTEM SHALL mark every `PD` and `UX` field of the generated OpenAPI schema with the extension `x-lunarhunt-data`.
- THE SYSTEM SHALL return `raw_content` only from `GET /v1/source-records/{id}`.
- WHEN THE SYSTEM sends offer content to a model, THE SYSTEM SHALL call the model with no tools, validate the output against the purpose's schema and write the result only as that run's derived record.
- THE SYSTEM SHALL NOT fetch any URL taken from offer content.
- WHEN an ATS adapter fetches postings, THE SYSTEM SHALL request only the fixed host list of that provider's adapter.
- IF a `board_token` does not match `^[A-Za-z0-9_-]{1,100}$`, THEN THE SYSTEM SHALL reject it with `422`.
- IF a URL in a request has a scheme other than `http` or `https`, THEN THE SYSTEM SHALL reject it with `422`.
- THE SYSTEM SHALL return `external_url` and `suggested_url` in responses only when their scheme is `http` or `https`, and `null` otherwise.
- IF a request field exceeds its bound in "Request bounds", THEN THE SYSTEM SHALL reject it with `422`, or `413` for a body over its size cap.
- IF a request with a method other than `GET`, `HEAD` or `OPTIONS` lacks the header `X-LunarHunt-Client`, or carries an `Origin` other than the web app's, THEN THE SYSTEM SHALL reject it with `403` and code `forbidden_origin`.
- THE SYSTEM SHALL use only synthetic personal data and synthetic offer text in tests, fixtures and OpenAPI `examples`.
- WHILE no auth is implemented, THE SYSTEM SHALL be reachable only from localhost or the private Dev Container network.

### Lifecycle and Nightwatch

- WHEN a `paste` capture creates an offer, THE SYSTEM SHALL create it as `pending` and queue an `extract` run.
- WHEN an `extract` run succeeds, or the user sets `title` and `company_name` on a `pending` offer, THE SYSTEM SHALL set the offer to `active`.
- THE SYSTEM SHALL allow the user to move an offer only between `active` and `archived`, and SHALL treat `merged` as terminal.
- WHILE `nightwatch_enabled` is true, WHEN the owner's local time reaches `nightwatch_local_time`, THE SYSTEM SHALL start one Nightwatch run for that local date.
- IF a Nightwatch run for the same `run_date` exists and is not `failed`, THEN THE SYSTEM SHALL start no second run.
- WHEN a Nightwatch run starts, THE SYSTEM SHALL start one `ats_scan` per source with `enabled` and `nightwatch` both true.
- WHEN a Nightwatch scan creates an offer, THE SYSTEM SHALL queue `classify` and, if an active base CV exists, `score` with trigger `nightwatch` and that run's `nightwatch_run_id`, up to `nightwatch_max_ai_runs` runs per Nightwatch run (Q13).
- WHEN the scans and the `ai_runs` with that `nightwatch_run_id` have finished, or 60 minutes after the run started, THE SYSTEM SHALL write one morning summary listing the offers created by that run's scans.

### API

- THE SYSTEM SHALL serve every resource of this spec under `/v1`; `GET /health` stays unversioned.
- WHEN a request fails, THE SYSTEM SHALL respond with the `Problem` shape and media type `application/problem+json`, including validation errors.
- WHEN a request fails with `500`, THE SYSTEM SHALL return a generic `detail` with no SQL, stack trace or exception text.
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
- **Keys:** `id uuid` primary key, UUIDv7 generated by the application (`uuid.uuid7()`, Python 3.14). Every owned table also has a unique `(owner_id, id)`, the target of composite foreign keys.
- **Time:** `timestamptz`, stored and returned in UTC, ISO 8601 in the API. `created_at` on every table; `updated_at` on mutable tables.
- **Enums:** `text` with a `CHECK` constraint, not Postgres `ENUM` types, so adding a value is a plain migration.
- **Hashes:** `content_sha256 char(64)`, lowercase hex SHA-256 of the stored bytes (UTF-8 for text).
- **Deletes:** every foreign key states its `ON DELETE` action (table under "Relations"). A `SET NULL` on a composite key names its column, `ON DELETE SET NULL (x_id)`, so `owner_id` stays set.
- **Size caps:** pasted text ≤ 100 000 characters; JSON request body ≤ 1 MiB; CV upload ≤ 10 MiB; Notion export ≤ 50 MiB (the Notion feature spec may lower it); `raw_content` ≤ 2 MiB. A request over a cap gets `413`. An ATS or Notion record over 2 MiB is skipped and counted in `records_skipped` with `error_code` `record_too_large`; the run continues.

### Data classes

Every field that holds sensitive or untrusted data carries a class in the entity tables:

| Class | Meaning | Stored | Logged | Exposed |
|---|---|---|---|---|
| `PD` | Personal data or CV content (C-19), including third-party contacts that offers may contain | Postgres schema `lunarhunt`, no column encryption in the baseline (Q8) | Never. Logs carry ids, enums, counts, lengths, `content_sha256` and `input_sha256` only, never a hash of one short field | Only through the API routes below; never in errors, traces, metrics or The Ledger. Sent outside the system only to the LLM provider (Q15), for `extract`, `classify`, `score`, `parse_cv` and `tailor` |
| `UX` | Untrusted external content (C-20): offer text from any channel, and model output derived from it | Raw as received, immutable; derived values in their own rows | Never; length and hash only | API returns it as plain JSON strings marked `x-lunarhunt-data: ["untrusted"]`. The web app renders it as text, never as HTML or Markdown, and links only `http` and `https` URLs |

Rules for `UX` beyond storage:

- Offer content is data, never instructions. A model call that receives it has no tools. Its output is parsed with a strict Pydantic schema. The only effect of the call is the derived row of its own `ai_run`. Offer content never chooses an action, a URL to fetch, a record to change or a model to call.
- A value produced by a model never links, merges or deletes a record. Model-extracted URLs and fingerprints are suggestions shown to the user.
- No component fetches a URL found in offer content (SSRF). ATS adapters build request URLs from a fixed provider host and a validated `board_token` only.
- ATS HTML is stored raw in `raw_content` and converted to plain text deterministically for `description_text`. It is never rendered as HTML.
- An enum field in a derived row (for example `seniority`) is validated against its `CHECK` list; free-text derived fields stay `UX`.
- `sources` has no credential column. Secrets live in the secret store (C-18). A provider that needs a key requires an ADR first.

### Entities

`owner_id` is `uuid not null` with a foreign key to `owners` on every table except `owners`; it is not repeated in the tables below. Foreign keys between owned tables are composite, `(owner_id, x_id)` → `(owner_id, id)`, so a row can never point to another owner's row.

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
| `active_base_cv_version_id` | uuid | yes | FK `cv_versions`, must be `kind = base` (trigger) | |
| `timezone` | text | no | IANA name, default `UTC`; defines Nightwatch's run date | |
| `nightwatch_enabled` | boolean | no | Default `false` | |
| `nightwatch_local_time` | time | no | Default `06:00`, in `timezone` | |
| `nightwatch_max_ai_runs` | smallint | no | Default 50, CHECK 0–500; cap on `classify` and `score` runs per Nightwatch run | |
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
| `raw_content` | text | no | Content as received: pasted text, ATS posting JSON, the mapped Notion page as JSON, or the manual form as JSON | `PD` `UX` |
| `content_sha256` | char(64) | no | | |
| `captured_at` | timestamptz | no | | |
| `offer_id` | uuid | no | FK `offers`; mutable, changes only by merge | |
| `last_seen_at` | timestamptz | no | Mutable; set when a later capture sees the same content | |

- Immutable columns: every column except `offer_id` and `last_seen_at`. A `BEFORE UPDATE` trigger rejects changes to them. `DELETE` is allowed.
- Unique `NULLS NOT DISTINCT (owner_id, channel, source_id, external_id, content_sha256)`.
- Index `(owner_id, channel, source_id, external_id)` for posting identity.
- `raw_content` is `PD` because offers and Notion pages can contain recruiter contacts and the user's own notes.

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
| `canonical_url` | text | yes | Normalized; only from a user-supplied or ATS-supplied URL (Deduplication) | `UX` |
| `suggested_url` | text | yes | Normalized; from `extract`, the Notion URL property, or a URL that rule 3 did not link; a suggestion only | `UX` |
| `fingerprint` | char(64) | yes | Normalized below | |
| `posted_at` | timestamptz | yes | As stated by the source | `UX` |
| `derived_from_record_id` | uuid | yes | FK `source_records`; the record the fields were last derived from | |
| `derived_by_ai_run_id` | uuid | yes | FK `ai_runs`; the `extract` run that derived the fields; null for deterministic mapping. A `BEFORE INSERT OR UPDATE` trigger requires a succeeded `extract` run with the same `offer_id` | |
| `user_edited_fields` | text[] | no | Fields the user changed; re-derivation leaves them alone (Q3) | |
| `created_at`, `updated_at` | timestamptz | no | | |

- Unique `(owner_id, canonical_url) WHERE status <> 'merged' AND canonical_url IS NOT NULL`.
- Index `(owner_id, fingerprint)` and `(owner_id, suggested_url)`.
- **URL normalization:** keep only `http` and `https`, any other scheme gives `null`; lowercase scheme and host; drop the default port; keep the fragment (Q16); drop the tracking parameters `utm_*`, `gclid`, `dclid`, `fbclid`, `msclkid`, `mc_cid`, `mc_eid`, `gh_src`, `lever-source`; sort the remaining query parameters; drop one trailing `/` from the path. The parameter list is one constant in code with a test; a change to it changes this spec.
- **Fingerprint:** for each of `company_name`, `title`, `location_text` (empty string when null): Unicode NFKC, casefold, replace every run of characters that are not letters or digits with one space, trim. Join the three with U+001F and take the lowercase hex SHA-256. Null while `pending`.
- Lifecycle:

| From | To | Trigger |
|---|---|---|
| (new) | `pending` | `paste` capture, before extraction |
| (new) | `active` | `manual`, `ats` or `notion` capture (deterministic mapping gives title and company) |
| `pending` | `active` | `extract` succeeds, or the user sets title and company |
| `active` | `archived` | user |
| `archived` | `active` | user |
| `pending`, `active`, `archived` | `merged` | user merge; terminal |
| any | (deleted) | user delete |

#### `ingest_runs`

| Field | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `kind` | text | no | `ats_scan`, `notion_import` |
| `source_id` | uuid | yes | FK `sources`; CHECK not null exactly when `kind = ats_scan` |
| `nightwatch_run_id` | uuid | yes | FK `nightwatch_runs` |
| `trigger` | text | no | `user`, `nightwatch` |
| `status` | text | no | `queued` → `running` → `succeeded` \| `partial` \| `failed` |
| `records_seen`, `records_new`, `records_skipped`, `offers_created`, `offers_linked`, `errors` | integer | no | Counters, default 0 |
| `error_code` | text | yes | Stable code; never content |
| `created_at` | timestamptz | no | |
| `started_at`, `finished_at` | timestamptz | yes | |

- `manual` and `paste` captures are synchronous and have no ingest run.
- Unique `(owner_id, id, kind)`, the target of the `ingest_uploads` foreign key.
- Unique `(owner_id) WHERE kind = 'notion_import' AND status IN ('queued', 'running')`: at most one Notion import in flight per owner, so at most one staged export.
- `offers_linked` is reported per run, so the user sees how many records joined existing offers.

#### `ingest_uploads` (staging for a Notion export)

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `ingest_run_id` | uuid | no | PK | |
| `kind` | text | no | CHECK `= 'notion_import'`; with `owner_id` and `ingest_run_id` a composite FK to `ingest_runs (owner_id, id, kind)`, so only a Notion import run can have a staged file | |
| `media_type` | text | no | | |
| `size_bytes` | integer | no | | |
| `content_sha256` | char(64) | no | | |
| `content` | bytea | no | The uploaded export file | `PD` `UX` |
| `mapping` | jsonb | no | `NotionMapping` from the request | |
| `created_at` | timestamptz | no | | |

- `importNotion` writes the run and this row in one transaction. The worker deletes the row in the transaction that sets the run to `succeeded`, `partial` or `failed`.
- The worker's startup and hourly sweep fail any run still `queued` or `running` after 24 hours (`error_code` `stale`) and delete its row.

#### `nightwatch_runs`

| Field | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `run_date` | date | no | Local date in `owner_settings.timezone` |
| `trigger` | text | no | `schedule`, `user` |
| `status` | text | no | `queued` → `running` → `succeeded` \| `partial` \| `failed` |
| `created_at` | timestamptz | no | |
| `started_at`, `finished_at` | timestamptz | yes | |

- Unique `(owner_id, run_date) WHERE status <> 'failed'`, so a failed night can be run again.
- Pipeline: (1) start one `ats_scan` per source with `enabled` and `nightwatch`; (2) for each offer those scans create, queue `classify` and, if `active_base_cv_version_id` is set, `score`, both with trigger `nightwatch` and this run's id in `ai_runs.nightwatch_run_id`, in creation order until `nightwatch_max_ai_runs` is reached (Q13); (3) when the scans and the `ai_runs` with this `nightwatch_run_id` are finished, or 60 minutes after `started_at`, write the morning summary; (4) set the status. `partial` means at least one scan or `ai_run` failed or was not queued because of the cap.

#### `ai_runs` (provenance and job record for derived data)

| Field | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `purpose` | text | no | `extract`, `classify`, `score`, `parse_cv`, `tailor` |
| `trigger` | text | no | `user`, `ingest`, `nightwatch` |
| `status` | text | no | `queued` → `running` → `succeeded` \| `failed` |
| `offer_id` | uuid | yes | FK `offers`; input for `extract`, `classify`, `score`, `tailor` |
| `source_record_id` | uuid | yes | FK `source_records`; input for `extract` |
| `cv_version_id` | uuid | yes | FK `cv_versions`; input CV for `score` and `tailor` |
| `cv_upload_id` | uuid | yes | FK `cv_uploads`; input for `parse_cv` |
| `nightwatch_run_id` | uuid | yes | FK `nightwatch_runs`; CHECK not null exactly when `trigger = nightwatch` |
| `model` | text | yes | Model id, set when a model is called |
| `prompt_version` | text | yes | Version label of the prompt, not the prompt |
| `input_sha256` | char(64) | yes | Hash of all inputs, for idempotency and audit |
| `input_tokens`, `output_tokens` | integer | yes | |
| `error_code` | text | yes | Stable code; never content or validation messages |
| `created_at` | timestamptz | no | |
| `started_at`, `finished_at` | timestamptz | yes | |

- A `CHECK` requires every reference that the `purpose` does not use to be null. A `BEFORE INSERT` trigger requires the references the `purpose` uses to be set. The input references are `ON DELETE SET NULL`, so a run row survives the deletion of its inputs without content. A `BEFORE UPDATE` trigger clears `input_sha256` when an input reference becomes null, so the hash cannot confirm deleted content (Q10).
- For an `extract` run, `source_record_id` is a `paste` record of `offer_id` (checked by the `BEFORE INSERT` trigger).
- Unique `(owner_id, purpose, offer_id, cv_version_id, cv_upload_id, input_sha256) NULLS NOT DISTINCT WHERE status IN ('queued', 'running')`.
- No prompt, input or output text is stored here.
- A derived row is written only when its run succeeds, in the same transaction as `status = succeeded`. If an input was deleted, the derived row's foreign key fails and the run ends `failed` with `input_deleted`.
- A `BEFORE INSERT` trigger on each derived table checks that the derived row's `offer_id` and `cv_version_id` equal its run's.

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
| `cv_version_id` | uuid | no | FK `cv_versions`, `kind = base` (trigger) | |
| `ai_run_id` | uuid | no | FK `ai_runs` | |
| `score` | smallint | no | CHECK 0–100 | |
| `rationale` | text | yes | Model output over CV and offer | `PD` `UX` |
| `created_at` | timestamptz | no | | |

Insert-only. The current score of an offer is its newest row for the active base CV version.

#### `cv_uploads`

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `filename` | text | no | As uploaded; may contain the user's name; never used as a path | `PD` |
| `media_type` | text | no | Detected from content; allowed types set in the CV feature spec | |
| `size_bytes` | integer | no | | |
| `content_sha256` | char(64) | no | Unique `(owner_id, content_sha256)` | |
| `content` | bytea | no | Original file (Q7a) | `PD` |
| `created_at` | timestamptz | no | | |

#### `cv_versions` (immutable)

| Field | Type | Null | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | no | PK | |
| `kind` | text | no | `base`, `tailored` | |
| `origin` | text | no | `upload_parse`, `user_edit`, `ai_tailor` | |
| `parent_id` | uuid | yes | FK `cv_versions`; null exactly when `origin = upload_parse` | |
| `offer_id` | uuid | yes | FK `offers`; CHECK not null exactly when `kind = tailored` | |
| `cv_upload_id` | uuid | yes | FK `cv_uploads`; CHECK not null exactly when `origin = upload_parse` | |
| `ai_run_id` | uuid | yes | FK `ai_runs`; CHECK not null exactly when `origin` is `upload_parse` or `ai_tailor` | |
| `label` | text | yes | User label, for example "Backend, EN" | `PD` |
| `schema_version` | text | no | Version of the structured CV schema | |
| `content` | jsonb | no | Structured CV (Q7a) | `PD` `UX` |
| `content_sha256` | char(64) | no | | |
| `created_at` | timestamptz | no | | |

- A `BEFORE UPDATE` trigger rejects every update. Edits create a new row. `DELETE` is allowed.
- Single-row rules are `CHECK`s: `upload_parse` gives `kind = base`; `ai_tailor` gives `kind = tailored`.
- A `BEFORE INSERT` trigger enforces lineage: the parent of a `base` version is `base`; the parent of a `tailored` version is a `base` version or a `tailored` version with the same `offer_id`; a `user_edit` keeps its parent's `kind` and `offer_id`.
- `content` is `UX` for every row: parsed and tailored content is model output, and a `user_edit` child of a tailored version still holds it.

#### `morning_summaries` and `morning_summary_items`

| Field | Type | Null | Notes |
|---|---|---|---|
| `morning_summaries.id` | uuid | no | PK |
| `morning_summaries.nightwatch_run_id` | uuid | no | FK `nightwatch_runs`, unique |
| `morning_summaries.created_at` | timestamptz | no | |
| `morning_summary_items.summary_id` | uuid | no | FK `morning_summaries`; PK with `offer_id` |
| `morning_summary_items.offer_id` | uuid | no | FK `offers` |
| `morning_summary_items.rank` | integer | no | |
| `morning_summary_items.match_score` | smallint | yes | Score at summary time |

- Items are the offers that have a source record from one of the run's `ats_scan` runs and were created after the run's `started_at`. Rank: `match_score` descending with nulls last, then `created_at`.
- The summary is a deterministic list of references; it stores no offer text (Q9).

### Relations

```text
owners 1─1 owner_settings ─0..1→ cv_versions (active base)
owners 1─* sources 1─* ingest_runs *─0..1 nightwatch_runs 1─0..1 morning_summaries 1─* morning_summary_items *─1 offers
ingest_runs 1─0..1 ingest_uploads
sources 1─* source_records *─1 offers (offer_id) ; offers *─0..1 offers (merged_into_id)
offers *─0..1 source_records (derived_from_record_id) ; offers *─0..1 ai_runs (derived_by_ai_run_id, extract)
offers 1─* classifications ; offers 1─* match_scores *─1 cv_versions (base)
offers 1─* cv_versions (tailored) ; cv_versions *─0..1 cv_versions (parent_id) ; cv_uploads 1─* cv_versions
ai_runs 1─0..1 classifications, match_scores, cv_versions (each derived row) ; ai_runs *─0..1 nightwatch_runs
```

`ON DELETE` action per foreign key (every `owner_id` → `owners` is `RESTRICT`):

| Child column | Parent | Action | Effect |
|---|---|---|---|
| `owner_settings.active_base_cv_version_id` | `cv_versions` | `SET NULL` | No active CV until the user picks one |
| `source_records.source_id` | `sources` | `RESTRICT` | Sources are disabled, not deleted |
| `source_records.ingest_run_id` | `ingest_runs` | `RESTRICT` | Runs are never deleted |
| `source_records.offer_id` | `offers` | `CASCADE` | Deleting an offer deletes its raw records |
| `offers.merged_into_id` | `offers` | `CASCADE` | Deleting an offer deletes the offers merged into it. They have no records, but they keep derived rows (classifications, scores, tailored CVs), and the cascade deletes those too |
| `offers.derived_from_record_id` | `source_records` | `SET NULL` | |
| `offers.derived_by_ai_run_id` | `ai_runs` | `RESTRICT` | Runs are never deleted |
| `ingest_runs.source_id`, `ingest_runs.nightwatch_run_id` | `sources`, `nightwatch_runs` | `RESTRICT` | |
| `ingest_uploads (ingest_run_id, kind)` | `ingest_runs (id, kind)` | `CASCADE` | |
| `ai_runs.offer_id`, `source_record_id`, `cv_version_id`, `cv_upload_id` | inputs | `SET NULL` | Run row survives without content; `input_sha256` is cleared |
| `ai_runs.nightwatch_run_id` | `nightwatch_runs` | `RESTRICT` | |
| `classifications.offer_id`, `match_scores.offer_id` | `offers` | `CASCADE` | |
| `match_scores.cv_version_id` | `cv_versions` | `CASCADE` | |
| `classifications.ai_run_id`, `match_scores.ai_run_id`, `cv_versions.ai_run_id` | `ai_runs` | `RESTRICT` | |
| `cv_versions.parent_id` | `cv_versions` | `CASCADE` | Deleting a version deletes its edits and tailored descendants |
| `cv_versions.offer_id` | `offers` | `CASCADE` | Deleting an offer deletes its tailored CVs |
| `cv_versions.cv_upload_id` | `cv_uploads` | `CASCADE` | Deleting an upload deletes the whole CV chain parsed from it |
| `morning_summaries.nightwatch_run_id` | `nightwatch_runs` | `RESTRICT` | |
| `morning_summary_items.summary_id`, `offer_id` | `morning_summaries`, `offers` | `CASCADE` | A deleted offer leaves the summary |

- `ingest_runs`, `nightwatch_runs` and `ai_runs` hold no content and have no delete route.
- **CV lineage:** deleting a CV version deletes every later version built on it, base and tailored, and their scores. If the active base CV is among them, `active_base_cv_version_id` becomes null. Deleting an upload deletes the whole lineage parsed from it.
- **Last source record:** a deferred constraint trigger (`AFTER DELETE` on `source_records`, `DEFERRABLE INITIALLY DEFERRED`) raises at commit if the record's offer still exists, is not `merged`, and has no records left. An offer delete that cascades to its records passes, because the offer is gone at commit. The `deleteSourceRecord` service also checks it first, under a row lock on the offer, to answer `409 last_source_record`.
- Deleting an ATS offer that is still posted brings it back on the next scan as a new offer; archiving hides it instead (Q10).
- Every delete route answers `200 DeleteResult` (`deleted`: a map from table name to row count). With `dry_run=true` it returns the counts and deletes nothing, so the web app can show them before the user confirms.

### Deduplication

Applied in order at capture, inside one transaction that first takes `pg_advisory_xact_lock` on a hash of `(owner_id, channel, source_id, external_id)` when `external_id` is set. The first rule that matches wins.

1. **Same record:** unique key `(owner_id, channel, source_id, external_id, content_sha256)`. No new record; `last_seen_at` is set. Outcome `duplicate`.
2. **Same posting, new content:** same `(channel, source_id, external_id)` for `ats`, or same `(channel, external_id)` for `notion`. New record, linked to the existing offer. Fields are re-derived by the channel's deterministic mapping, except `user_edited_fields`, and only if the record named in `derived_from_record_id` is the same posting (same `channel`, `source_id`, `external_id`). Otherwise the fields stay, so a posting never overwrites fields that came from another channel or source. Outcome `linked`.
3. **Same canonical URL:** the record carries a trusted URL (below), and its normalized form equals an existing non-merged offer's `canonical_url`. New record, linked. Fields are never re-derived. For `ats`, the link happens only if every record of the offer is an `ats` record from the same `source_id`; otherwise rule 4 applies and the URL goes to the new offer's `suggested_url`. Outcome `linked`.
4. **Otherwise:** new offer. A trusted URL becomes its `canonical_url`. Outcome `created`.

Trusted URLs, the only input to rule 3 and to `canonical_url`:

- `manual` and `paste`: the `url` the user typed in the request;
- `ats`: the posting URL field of the provider's response, mapped by the adapter;
- the user's `PATCH` of `canonical_url`.

A URL that `extract` finds in pasted text, and the Notion `url_property` (Q17), are stored only in `suggested_url`. A pasted offer with a trusted URL runs rule 3 at capture, before extraction; if it links, no `extract` run starts.

Rule 1 and rule 3 are backed by unique indexes; rule 2 by the advisory lock. A concurrent capture that loses on the `canonical_url` index retries and lands in rule 3. `fingerprint` and `suggested_url` matches are only listed for the user (`listOfferDuplicateCandidates`); merging is a user action (Q2).

### Channel mapping

| Channel | Offer fields come from | Model call |
|---|---|---|
| `manual` | The `ManualOfferCreate` fields, as typed | None |
| `paste` | `extract` over the pasted text: `title`, `company_name`, `location_text`, `description_text`, `posted_at`, `suggested_url` | `extract` |
| `ats` | The adapter's fixed field map for the provider's posting JSON; HTML description converted to plain text | None |
| `notion` | `NotionMapping`: the named page properties give `title`, `company_name`, optional `location_text`, and `suggested_url`; the page body, converted to plain text, gives `description_text` | None |

- A Notion page maps to an offer only when its title and company properties are non-empty. Other pages and files of the export are skipped, counted in `records_skipped`, and never stored.
- A Notion record's `raw_content` holds only the mapped page: its properties and its body as text, not attachments.
- The Notion feature spec fixes the export format and the body-to-text conversion.

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
- Per-owner data export and account deletion (GDPR), on top of the deletion routes here.
- Optional sharing of raw ATS records across owners. That would move `source_records` ownership and is a new ADR.
- No change to uniqueness keys or foreign keys, because they already include `owner_id`.

### API

Contract rules:

- **Contract:** `apps/api` routes and Pydantic models generate `packages/contracts/openapi.json` through `uv run export-openapi`. The file is never hand-written (C-13).
- **Versioning:** path prefix `/v1`. Breaking changes inside `v1` fail CI `oasdiff` (`fail-on: ERR`). A `v2` needs an ADR. Task 3 sets `info.version` from the `apps/api` package metadata instead of the literal `"0.0.0"`.
- **Pre-release window:** every route starts with `x-stability-level: alpha`, which `oasdiff` excludes from breaking-change errors. A feature task sets its routes to `stable` when Krzysztof merges it; from then on the route is frozen. Task 3 verifies this with the pinned `oasdiff` action; if it does not hold, Task 3 stops and asks Krzysztof.
- **Error shape `Problem`** (RFC 9457, `application/problem+json`): `type` (URI), `title`, `status`, `detail`, `code` (stable snake_case), `errors` (for `422` only: a list of `{loc, code}`, with no message and no input value; `loc` holds schema field names and list indexes only, and a key from free JSON becomes `*`), `conflict_id` (for `409` `conflict` only). `detail` is a fixed text per `code` and never contains a `PD` or `UX` value. FastAPI's default validation error is replaced with this shape. A `500` detail is generic.
- **Pagination `Page[T]`:** `{items: T[], next_cursor: string | null}`. Query `limit` (1–200, default 50) and `cursor` (opaque). Order `created_at desc, id desc`. No total count.
- **IDs and times:** UUID strings; ISO 8601 UTC times.
- **Data class marks:** `PD` fields carry `x-lunarhunt-data: ["personal"]`, `UX` fields `["untrusted"]`, fields with both carry both.
- **Request bounds:** every string in a request model or query has `maxLength`, every number a minimum and maximum, every array `maxItems`, every free JSON object a serialized size and depth cap (table below). OpenAPI cannot express size and depth, so a validator in `api/` enforces them and Task 3 tests them. A new request field needs a bound in this table.
- **Async work:** routes that start a model call or a scan answer `202` with the `AiRun`, `IngestRun` or `NightwatchRun`. Clients poll the run.
- **Stubs:** until a feature task implements a route, it answers `501` with code `not_implemented`.

Request bounds:

| Field | Bound |
|---|---|
| `title`, `company_name`, `location_text` | ≤ 300 characters |
| `description_text`, `PasteOfferCreate.text` | ≤ 100 000 characters |
| `url`, `canonical_url` | ≤ 2 048 characters, `http` or `https` |
| `display_name` | ≤ 200 characters |
| `board_token` | pattern above (≤ 100) |
| `label` | ≤ 100 characters |
| `role_family` | ≤ 100 characters |
| `tags` | ≤ 30 items, each ≤ 50 characters |
| `timezone` | ≤ 64 characters, a valid IANA name |
| `taxonomy_version`, `schema_version` | ≤ 32 characters |
| `NotionMapping.title_property`, `company_property`, `location_property`, `url_property` | ≤ 100 characters each |
| multipart `filename` | ≤ 255 characters |
| `nightwatch_max_ai_runs` | 0–500 |
| `CvVersionCreate.content` | ≤ 256 KiB serialized, depth ≤ 8, valid against the CV schema of its `schema_version` |
| query `min_score` | integer 0–100 |
| query `q` | ≤ 200 characters |
| query `cursor` | ≤ 200 characters |
| JSON body | ≤ 1 MiB; multipart as in "Size caps" |

Resources:

| Method and path | operationId | Request | Response |
|---|---|---|---|
| `GET /v1/offers` | `listOffers` | query `status`, `channel`, `min_score`, `q` (title or company contains), `limit`, `cursor` | `200 Page[OfferSummary]` |
| `POST /v1/offers` | `createOffer` | `ManualOfferCreate` | `201 IngestResult` (`200` when `duplicate` or `linked`) |
| `POST /v1/offers/paste` | `pasteOffer` | `PasteOfferCreate` | `202 IngestResult` (`200` when `duplicate` or `linked`) |
| `GET /v1/offers/{id}` | `getOffer` | | `200 OfferDetail` |
| `PATCH /v1/offers/{id}` | `updateOffer` | `OfferPatch` | `200 OfferDetail` |
| `DELETE /v1/offers/{id}` | `deleteOffer` | query `dry_run` | `200 DeleteResult` |
| `POST /v1/offers/{id}/merge` | `mergeOffer` | `{into_offer_id}` | `200 OfferDetail` (the target) |
| `GET /v1/offers/{id}/duplicate-candidates` | `listOfferDuplicateCandidates` | `limit`, `cursor` | `200 Page[DuplicateCandidate]` |
| `GET /v1/offers/{id}/source-records` | `listOfferSourceRecords` | `limit`, `cursor` | `200 Page[SourceRecordSummary]` |
| `GET /v1/source-records/{id}` | `getSourceRecord` | | `200 SourceRecord` |
| `DELETE /v1/source-records/{id}` | `deleteSourceRecord` | query `dry_run` | `200 DeleteResult` |
| `GET /v1/offers/{id}/classifications` | `listOfferClassifications` | `limit`, `cursor` | `200 Page[Classification]` |
| `POST /v1/offers/{id}/classifications` | `createClassification` | `ClassificationCreate` (`method = user`) | `201 Classification` |
| `GET /v1/offers/{id}/match-scores` | `listOfferMatchScores` | `limit`, `cursor` | `200 Page[MatchScore]` |
| `POST /v1/ai-runs` | `startAiRun` | `AiRunCreate` | `202 AiRun` (an in-flight duplicate returns the existing run) |
| `GET /v1/ai-runs` | `listAiRuns` | `purpose`, `status`, `offer_id`, `limit`, `cursor` | `200 Page[AiRun]` |
| `GET /v1/ai-runs/{id}` | `getAiRun` | | `200 AiRun` |
| `GET /v1/sources` | `listSources` | `limit`, `cursor` | `200 Page[Source]` |
| `POST /v1/sources` | `createSource` | `SourceCreate` | `201 Source` |
| `GET /v1/sources/{id}` | `getSource` | | `200 Source` |
| `PATCH /v1/sources/{id}` | `updateSource` | `SourcePatch` | `200 Source` |
| `POST /v1/sources/{id}/scans` | `scanSource` | | `202 IngestRun` |
| `POST /v1/imports/notion` | `importNotion` | multipart: export file and `mapping` (`NotionMapping`) | `202 IngestRun` (`409 conflict` while another import is in flight) |
| `GET /v1/ingest-runs` | `listIngestRuns` | `kind`, `status`, `source_id`, `limit`, `cursor` | `200 Page[IngestRun]` |
| `GET /v1/ingest-runs/{id}` | `getIngestRun` | | `200 IngestRun` |
| `GET /v1/cv-uploads` | `listCvUploads` | `limit`, `cursor` | `200 Page[CvUpload]` |
| `POST /v1/cv-uploads` | `uploadCv` | multipart: file | `202 AiRun` (`parse_cv`) |
| `GET /v1/cv-uploads/{id}` | `getCvUpload` | | `200 CvUpload` (metadata, no file bytes) |
| `DELETE /v1/cv-uploads/{id}` | `deleteCvUpload` | query `dry_run` | `200 DeleteResult` |
| `GET /v1/cv-versions` | `listCvVersions` | `kind`, `offer_id`, `limit`, `cursor` | `200 Page[CvVersionSummary]` |
| `POST /v1/cv-versions` | `createCvVersion` | `CvVersionCreate` | `201 CvVersion` |
| `GET /v1/cv-versions/{id}` | `getCvVersion` | | `200 CvVersion` |
| `DELETE /v1/cv-versions/{id}` | `deleteCvVersion` | query `dry_run` | `200 DeleteResult` |
| `GET /v1/settings` | `getSettings` | | `200 Settings` |
| `PATCH /v1/settings` | `updateSettings` | `SettingsPatch` | `200 Settings` |
| `GET /v1/nightwatch-runs` | `listNightwatchRuns` | `limit`, `cursor` | `200 Page[NightwatchRun]` |
| `POST /v1/nightwatch-runs` | `startNightwatchRun` | | `202 NightwatchRun` (`409 conflict` if today's run exists and is not `failed`) |
| `GET /v1/nightwatch-runs/{id}` | `getNightwatchRun` | | `200 NightwatchRun` |
| `GET /v1/morning-summaries` | `listMorningSummaries` | `limit`, `cursor` | `200 Page[MorningSummary]` |
| `GET /v1/morning-summaries/{id}` | `getMorningSummary` | | `200 MorningSummary` (items with `OfferSummary`) |

Shapes at entity level (fields as in the entity tables unless listed):

- `OfferSummary`: `id`, `status`, `title`, `company_name`, `location_text`, `canonical_url`, `fingerprint`, `current_score` (`score` only), `current_classification` (enum fields only), `created_at`, `updated_at`.
- `OfferDetail`: `OfferSummary` plus `description_text`, `suggested_url`, `posted_at`, `merged_into_id`, `derived_from_record_id`, `derived_by_ai_run_id`, `user_edited_fields`, `current_classification` (`Classification`), `current_match_score` (`MatchScore`), `latest_runs` (latest `AiRun` per purpose), `channels` (distinct channels of its records).
- `ManualOfferCreate`: `title`, `company_name`, optional `location_text`, `description_text`, `url`.
- `PasteOfferCreate`: `text`, optional `url`.
- `OfferPatch`: any of `title`, `company_name`, `location_text`, `description_text`, `canonical_url`, `posted_at`; `status` limited to `active` and `archived`. Changed fields join `user_edited_fields`. A `canonical_url` that another non-merged offer holds gives `409 conflict`.
- `IngestResult`: `outcome` (`created`, `linked`, `duplicate`), `offer_id`, `source_record_id`, `ai_run_id` (for a `paste` that created an offer).
- `DuplicateCandidate`: `offer` (`OfferSummary`), `reasons` (`fingerprint`, `url`).
- `SourceRecordSummary`: every column except `raw_content`, plus `content_length`. `SourceRecord` adds `raw_content`.
- `ClassificationCreate`: `taxonomy_version`, `seniority`, `work_mode`, `employment_type`, `role_family`, `tags`.
- `DeleteResult`: `dry_run`, `deleted` (map from table name to row count).
- `AiRunCreate`, one of: `{purpose: extract, offer_id, source_record_id?}` (a `paste` record of that offer, default its newest; an offer with no `paste` record gives `422`); `{purpose: classify, offer_id}`; `{purpose: score, offer_id, cv_version_id?}` (a `base` version, default the active one); `{purpose: tailor, offer_id, cv_version_id?}` (a `base` version or a tailored version of the same offer, default the active base); `{purpose: parse_cv, cv_upload_id}` (re-parse).
- `SourceCreate`: `provider`, `board_token`, `display_name`, optional `enabled`, `nightwatch`. `SourcePatch`: `display_name`, `enabled`, `nightwatch` (provider and token are fixed; a new board is a new source). A duplicate `(provider, board_token)` gives `409 conflict`.
- `NotionMapping`: `title_property`, `company_property`, optional `location_property`, `url_property`.
- `CvVersionCreate`: `parent_id`, `content`, `schema_version`, optional `label`; `kind` and `offer_id` come from the parent; `origin` is `user_edit`.
- `CvVersionSummary`: every column except `content`. `CvVersion` adds `content`.
- `CvUpload`: every column except `content`. A duplicate file gives `409 conflict`.
- `Settings` and `SettingsPatch`: `active_base_cv_version_id`, `timezone`, `nightwatch_enabled`, `nightwatch_local_time`, `nightwatch_max_ai_runs`.
- `AiRun`, `IngestRun`, `NightwatchRun`, `Classification`, `MatchScore`: their columns, without `owner_id`.
- `MorningSummary`: its columns plus `items` (`rank`, `match_score`, `offer`).

`owner_id` is never part of a request or response.

The admin panel uses the same routes as the rest of the web app, with no admin-only resources: `sources`, `ingest-runs`, `ai-runs`, `nightwatch-runs`, `settings`, and the delete routes. Whether it is a separate role is for the auth ADR.

Error codes in the baseline: `validation_failed` (422), `not_found` (404), `forbidden_origin` (403), `conflict` (409), `offer_merge_invalid` (409), `last_source_record` (409), `payload_too_large` (413), `unsupported_media_type` (415), `not_implemented` (501), `internal_error` (500). Run error codes (`input_deleted`, `output_invalid`, `record_too_large`, `stale`, `not_implemented`) appear only in `error_code` columns.

### Migration baseline

- **Tool:** SQLAlchemy 2.x (typed ORM, `Mapped[...]`) with Alembic, driver psycopg 3. Models live in `apps/api` (`lunarhunt_api.db` and the area packages below). `apps/worker` imports them as a uv workspace dependency and has no migrations of its own (ADR-0018 D7).
- **Location and naming:** `apps/api/migrations/versions/`. Revision ids are sequential four-digit numbers passed with `--rev-id`; file names `NNNN_<slug>.py`. The first is `0001_baseline.py`.
- **Protection:** `apps/api/migrations/**` is an `ask` path (C-24, Charter `paths.protected.ask`) and `risk:high` (Charter `risk.high.paths`). An agent edit there needs Krzysztof's approval and is denied in headless runs.
- **First migration scope:** create schema `lunarhunt`; every table, constraint, index and trigger in this spec; insert the single `owners` row and its `owner_settings`. No sample data.
- **Checks** (added in Task 2): a test runs `alembic upgrade head`, `downgrade base` and `upgrade head` on Postgres 18; `alembic check` reports no model drift; exactly one head exists.
- **Serialization:** migrations should join ADR-0016 `concurrency.serialize_on` (ADR-0018, proposed Charter change), so two tasks never add revision `0002` in parallel.

### Module layout

Each feature area owns one package in `apps/api/src/lunarhunt_api/<area>/` and one in `apps/worker/src/lunarhunt_worker/<area>/`, with its tests. Every model and every route has exactly one owning area:

| Area | Models | Routes (operationId) | Worker | Built by |
|---|---|---|---|---|
| `db/` | `owners`, base types, owner-scoped repository base, triggers' SQL | | | Task 2 |
| `api/` and `main.py` | | `Problem`, `Page`, bounds validator, origin check, `current_owner`, router registration | | Task 3 |
| `settings/` | `owner_settings` | `getSettings`, `updateSettings` | | Task 4 |
| `ai/` | `ai_runs` | `startAiRun` (dispatch to area services), `listAiRuns`, `getAiRun` | `runner/`: claim loop, dispatch table, schedule tick (Nightwatch start, staging sweep) | Task 4 |
| `ingest/` | `ingest_runs`, `ingest_uploads` | `listIngestRuns`, `getIngestRun` | run lifecycle and staging cleanup | Task 4 |
| `offers/` | `offers`, `source_records` | offer, merge, duplicate-candidate and source-record routes; `extract` service | `extract` handler | Feature 1 |
| `sources/` | `sources` | source routes, `scanSource` | `ats_scan` handler | Feature 2 |
| `notion/` | | `importNotion` | `notion_import` handler | Feature 3 |
| `cv/` | `cv_uploads`, `cv_versions` | CV upload and version routes | `parse_cv` handler | Feature 4 |
| `classification/` | `classifications` | `listOfferClassifications`, `createClassification` | `classify` handler | Feature 5 |
| `scoring/` | `match_scores` | `listOfferMatchScores` | `score` handler | Feature 6 |
| `tailoring/` | | | `tailor` handler | Feature 7 |
| `nightwatch/` | `nightwatch_runs`, `morning_summaries`, `morning_summary_items` | Nightwatch run and morning summary routes | Nightwatch start handler, pipeline, summary | Feature 8 |

- Each area package holds `models.py` (ORM), `schemas.py` (Pydantic API models), `router.py` and `service.py`. Task 2 writes every `models.py`; Task 3 every `schemas.py`, `router.py` and `service.py` with `501` stubs; Task 4 a handler stub per `purpose` and `kind` in each worker area. Feature tasks then fill their own area only.
- Tests mirror the layout: `apps/api/tests/<area>/`, `apps/worker/tests/<area>/`.
- **What runs in parallel:** each area's code and tests. Their paths are disjoint, so feature tasks in different areas can be implemented and reviewed at the same time.
- **What serializes:** every feature PR changes the contract at least once, because it sets its routes from `alpha` to `stable` and regenerates `packages/contracts/openapi.json` and the client (ADR-0016 D3 `serialize_on`). Feature PRs therefore merge one at a time: the next one rebases, regenerates the contract with `uv run export-openapi`, and re-runs `pnpm check`. A task that changes `db/`, `api/`, `ai/`, `ingest/`, `settings/`, `runner/` or a migration is serialized with every other task that does.
- `apps/web` layout is set by the first web feature spec.

Feature order (after Tasks 1–4):

1. Offers: manual and paste capture, `extract`, merge, delete, duplicate candidates.
2. ATS sources and scans (uses Feature 1's capture service).
3. Notion import (uses Feature 1's capture service).
4. CV upload, parse and versions.
5. Classification (needs 1).
6. Match score (needs 1 and 4).
7. Tailoring (needs 1 and 4).
8. Nightwatch and the morning summary (needs 2, 5 and 6).
9. Web screens, including the admin panel (each needs the routes it shows).

Once Feature 1 merges, the code of Features 2–5 can be built in parallel, and 6 and 7 once 4 merges; their PRs still merge one at a time on the contract.

### Affected packages and ADRs

- `apps/api`: models, migrations, routes, `current_owner`, `Problem` handler.
- `packages/contracts`, `packages/api-client`: regenerated only.
- `apps/worker`: imports models; job runner, schedule tick and handler stubs.
- `apps/web`: none in the baseline.
- ADRs: [ADR-0018](../decisions/0018-lunarhunt-data-model-and-api-contract-baseline.md) (this baseline, `proposed`); the auth ADR (later).

## Prerequisites for Krzysztof (before Task 2)

These are human-only paths (`.github/**`, `.env.example`, `.devcontainer/**` are `ask`), so no agent task can do them.

1. **Postgres 18 in CI `check`:** add a `postgres:18.6-alpine` service (or compose) to the `check` job in `.github/workflows/check.yml`, and pass `DATABASE_URL` and `DATABASE_URL_MIGRATE` into the `docker run`. Without it the Task 2 tests cannot run in CI.
2. **Two database roles:** a migration role that owns schema `lunarhunt`, and a runtime role with DML only, no `TRUNCATE`, no `ALTER`, not a table owner. Add `DATABASE_URL_MIGRATE` beside `DATABASE_URL` in `.env.example` and the Dev Container. Without it the immutability triggers can be dropped by the app's own role.
3. **Charter:** add `apps/api/migrations/**` to `concurrency.serialize_on` (ADR-0018, proposed changes).

## Requirements on later specs and tasks

- **Task 2:** create the two roles from Prerequisite 2 in `0001_baseline.py`'s setup or the test fixture; the app and worker connect as the runtime role; a test asserts the runtime role cannot `UPDATE` an immutable row, `TRUNCATE`, or drop a trigger.
- **Task 3:** Host header allowlist (localhost and the Dev Container host names); CORS denied for every origin except the web app's; JSON routes reject a `Content-Type` other than `application/json`, and multipart is accepted only on `uploadCv` and `importNotion`; body size caps enforced before parsing. A request with a method other than `GET`, `HEAD` or `OPTIONS` is rejected server-side (`403 forbidden_origin`) unless it carries the header `X-LunarHunt-Client` and its `Origin`, when present, is the web app's; the custom header forces a CORS preflight, so simple cross-origin `POST`s (body-less or multipart) never reach a handler. The generated client sends the header. Sessions and CSRF tokens stay with the auth ADR.
- **Task 3, owner scoping:** one owner-scoped repository base in `db/` that every area uses, and a SQLAlchemy `do_orm_execute` hook, active in tests, that fails any statement on an owned table without an `owner_id` criterion.
- **Task 3, error bodies:** `loc` in `Problem.errors` carries schema field names and list indexes only; a key from free JSON (`CvVersionCreate.content`) is replaced by `*`. A test sends a body with a synthetic marker as a key and asserts it is absent from the response.
- **Task 4:** the LLM client is built with no tools and has a test for that; exceptions are recorded in spans by type only, never by message; the worker logger uses the same redaction test as the API.
- **Notion feature spec:** detect the archive type from content, not the name; set numeric caps for decompressed size and entry count; open a nested archive at most one level deep, inside the same caps, and reject deeper nesting; never use an entry name as a file path; skip unmapped pages without storing them.
- **CV feature spec:** detect `media_type` from content and allow a fixed list; never use `filename` as a path; the user reviews a tailored CV before any export or sending; CV content is never rendered as Markdown or HTML.
- **ATS feature spec:** no redirect to another host; numeric values for a timeout, a response-size cap and a records-per-scan cap per request; oversize records are skipped with `record_too_large`; the adapter maps the posting URL field into the trusted URL.
- **Every feature spec:** list its new request fields with bounds in this spec's table, and its new `PD` and `UX` fields with their class.

## Tasks

1. **This spec and ADR-0018.** Krzysztof answered the questions on 2026-11-14 ("Decisions on the questions") and sets `status: ready`; Sentinel reviews first (ADR-0016 D8). From then on the spec is a living baseline: a feature that needs a new field or resource changes this spec in its own `docs/specs/**` PR before its `apps/**` PR, and Krzysztof's merge of that PR is the re-approval (C-10). The status stays `ready`. **Allowed paths:** `docs/specs/**`, `docs/decisions/**`.
2. **Persistence baseline:** SQLAlchemy models in every area's `models.py` and `db/`, Alembic setup, `0001_baseline.py`, triggers, roles, owner seed. Tests: migration round trip, single head, `alembic check`, owner column and `(owner_id, id)` uniques on every owned table, composite FKs, `ON DELETE` actions per the Relations table, immutability triggers (update rejected, delete allowed), `ai_runs` insert trigger, relaxed `CHECK` and `input_sha256` clearing, CV lineage and `kind = base` triggers, derived-row consistency triggers, the `derived_by_ai_run_id` trigger, the deferred last-source-record trigger (direct delete rejected, offer cascade and merged offers pass), the `ingest_uploads` composite FK with `kind` (a non-Notion run cannot get a staged file), the one-import-in-flight index, unique indexes per deduplication rule, `nightwatch_runs` rerun after `failed`. `risk:high` (migrations). Serialized (ADR-0016 D3). Needs Prerequisites 1–2. **Allowed paths:** `apps/api/**`, `apps/worker/pyproject.toml`, `pyproject.toml`, `uv.lock`.
3. **API contract baseline:** every area's `schemas.py`, `router.py` and `service.py` with the final models and `501` stubs, `api/` (`Problem`, `Page`, bounds, `current_owner`, the middleware from "Requirements"), `x-lunarhunt-data` marks, `x-stability-level: alpha`, `info.version` from package metadata; tests for the marks against this spec, the D6 conventions, the bounds table, an oversize body (`413`) and a too-deep `CvVersionCreate.content` (`422`), the origin check, the owner-scoping hook, and log and error-body redaction with synthetic markers; regenerated contract and client. Serialized (contract paths). Depends on 2. **Allowed paths:** `apps/api/**`, `packages/contracts/openapi.json`, `packages/api-client/src/**`.
4. **AI, jobs and settings foundation:** `ai/` (LLM client behind an interface with a fake for tests, no-tools wrapper, `ai_runs` lifecycle, `startAiRun` dispatch to per-area stubs), `ingest/` (run lifecycle, staging cleanup), `settings/` (routes implemented), worker `runner/` (claim loop, dispatch table with a stub per `purpose` and `kind`, `input_deleted` handling, a schedule tick every minute that starts due Nightwatch runs through a `nightwatch/` stub and runs the staging sweep). No provider integration (out of scope). Depends on 2 and 3. **Allowed paths:** `apps/api/src/lunarhunt_api/{ai,ingest,settings}/**`, `apps/api/tests/{ai,ingest,settings}/**`, `apps/worker/**`, `packages/contracts/openapi.json`, `packages/api-client/src/**` (settings routes go `stable`).

After Tasks 3 and 4 merge, ADR-0016 D8's start conditions hold, and each feature gets its own feature spec that refers to this one, in the order under "Module layout".

## Decisions on the questions (Krzysztof, 2026-11-14)

Krzysztof accepted the recommended answer to every question below on 2026-11-14 ("Q all ok"; decision queue on #7). The options and consequences stay as the record of what was weighed. The model above uses the recommended answers.

1. **Classification taxonomy.** (a) Fixed fields `seniority`, `work_mode`, `employment_type`, `role_family`, plus free `tags`: queryable, needs a migration to add a field. (b) One free JSON object: flexible, not filterable or checkable. **Recommend (a)**, with the value lists set in the classification feature spec.
2. **Duplicates by fingerprint.** (a) Suggest only; the user merges: no wrong merges, some manual work. (b) Auto-merge: less work, but two real openings with the same title and company merge silently. **Recommend (a).**
3. **Editing offer fields.** (a) The user may edit fields; edits survive re-derivation (`user_edited_fields`); raw content stays immutable. (b) Offer fields are read-only derivations: simpler, but extraction errors cannot be fixed. **Recommend (a).**
4. **Application tracking** (applied, interview, rejected). Not in the `AGENTS.md` scope. (a) Leave out of the baseline; add later as an additive migration. (b) Add now: guesses product behaviour. **Recommend (a).**
5. **Closed postings.** (a) Later: a scan that no longer sees a posting marks the offer closed (new `listing_status` column, additive). (b) Now: needs rules for partial scans. **Recommend (a).**
6. **Notion import method.** (a) Upload of a Notion export file, one-shot: no Notion credential in the system, no live sync. (b) Notion API with an integration token: live sync, but a new secret (C-18), outbound calls and an ADR. **Recommend (a).**
7. **CV storage and lineages.**
   - 7a. **Original file.** (a) Keep it in `cv_uploads.content`: re-parse possible (`parse_cv` re-run), more `PD` stored. (b) Discard it after parsing: less `PD`, no re-parse, `cv_uploads` keeps metadata only. **Recommend (a)**; the user can delete it.
   - 7b. **Base CVs.** (a) Several base lineages (for example per language), one active: no schema cost. (b) One base CV: simpler UI, a second language needs a separate account later. **Recommend (a).**
8. **Encryption at rest for `PD`.** (a) Encrypted disk volume and encrypted backups now; column encryption later. Consequences: plaintext `PD` is also in `pg_dump` output, WAL, backups and every task database (`lunarhunt_t<issue>`, which must hold synthetic data only); adding column encryption later changes column types (`bytea`), re-encrypts existing rows and blocks `q` search on those columns. Volume and backup encryption has no enforcer yet (ADR-0018 D4). (b) Application-level column encryption now: stronger, but needs key management (a new secret, an ADR) and blocks search from the start. **Recommend (a)** for the single-user MVP; revisit with multi-user.
9. **Morning summary.** (a) Deterministic list of new offers with their scores, shown in the web app: no model call, no offer text copied. (b) Model-written narrative: nicer, adds a `summarize` purpose and more `UX` text. Delivery by email would send offer data to a mail provider. **Recommend (a)**, in-app only.
10. **Deletion semantics.** Confirm the model: (a) user-initiated hard delete with the routes and `ON DELETE` actions above; run rows survive with references set to null; no retention period. Consequences: deleted data is gone from the API (no undo, no audit of content); deleting an offer also deletes the offers merged into it with their derived rows and tailored CVs; deleting a CV version deletes its whole later lineage; an ATS offer still posted comes back on the next scan. Deletion is logical at first: dead tuples stay in table files until `VACUUM`, the WAL holds the old rows until it is recycled, and backups keep them until they expire. `ai_runs.input_sha256` is a hash of the whole CV and offer input, so anyone holding the original could confirm it was processed; the model clears it when an input is deleted. Alternative for the hash: an HMAC with a per-owner key kept outside `ai_runs` (in the secret store), which needs a new secret. (b) Soft delete or redaction (tombstone rows): undo and audit possible, but `PD` stays in the database and every query must filter. (c) Fixed retention periods on top of (a): less `PD` over time, but needs a scheduled job and a period per entity. **Recommend (a).**
11. **First ATS providers.** (a) Two keyless public board APIs in the first ATS feature (candidates: Greenhouse, Lever, Ashby): no secret, quick to test, covers many tech employers. (b) Only one: smaller first feature, less coverage. (c) Include a provider that needs an API key: wider coverage, but a secret (C-18) and an ADR. **Recommend (a)**; each provider adds a `provider` CHECK value and a fixed host list.
12. **Job queue** (technical, confirm). (a) Rows in `ai_runs`, `ingest_runs` and `nightwatch_runs` are the queue; the worker claims them with `SELECT … FOR UPDATE SKIP LOCKED`: no extra service, one transaction for state and result. (b) A broker (Redis or similar): another service to run and secure, and job state split from row state. **Recommend (a).**
13. **Automatic classify and score.** (a) Only Nightwatch queues them, for offers its scans create, capped by `nightwatch_max_ai_runs`; user captures run them on request. Consequences: nightly LLM cost and `PD` (the CV, for `score`) sent to the provider without a user action; Charter `budgets.per_night` is still null, so the cap is the only limit. (b) On every capture: always up to date, highest cost and egress. (c) Never automatic: no unattended egress, but the morning summary has no scores. **Recommend (a)**, with the cap set by Krzysztof.
14. **Extraction for pasted text.** (a) An LLM `extract` run: handles any layout; sends pasted text (`PD` `UX`) to the provider. (b) A deterministic parser: no egress, but poor on free text. (c) No extraction; the user fills title and company: no egress, more typing. **Recommend (a)**; `paste` is the only channel with a model step.
15. **LLM provider data handling.** Every purpose sends `PD` to the provider. (a) A commercial API whose terms exclude training on API data, with zero data retention where offered; the provider is named in the LLM client spec. (b) A self-hosted model: no egress, but hardware cost and lower quality. (c) Strip `PD` before sending: breaks `parse_cv`, `score` and `tailor`. **Recommend (a)**, recorded in the LLM client spec with the provider's retention terms.
16. **URL fragment.** (a) Keep the fragment in normalization: hash-routed career sites (`/#/jobs/123`) stay separate offers; the same page with and without an anchor becomes two offers, shown as a fingerprint duplicate. (b) Drop it: fewer missed links, but every posting of a hash-routed site merges into one offer, silently. **Recommend (a)**: a missed link is visible, a wrong merge is not.
17. **Notion URL property as trusted.** (a) The mapped Notion URL property is user-supplied, so it auto-links by rule 3: fewer manual merges, but one URL repeated across rows (a careers page, for example) silently collapses many distinct offers into one in a bulk import. (b) It is only a suggestion (`suggested_url`), shown as a duplicate candidate: no silent collapse, more manual merges. **Recommend (b)**; `offers_linked` per run shows rule 2 links; URLs in the page body are never used.

Which part of the model each answer affects:

| Q | Affects |
|---|---|
| 1 | `classifications` columns, `ClassificationCreate` |
| 2, 16, 17 | Deduplication rules, `offers.canonical_url`, `listOfferDuplicateCandidates` |
| 3 | `offers.user_edited_fields`, `OfferPatch` |
| 4, 5 | None now; additive later |
| 6 | `importNotion`, `ingest_uploads`, Channel mapping |
| 7a, 7b | `cv_uploads.content`, `AiRunCreate` `parse_cv`, `owner_settings.active_base_cv_version_id` |
| 8 | Data classes, ADR-0018 D4, deployment |
| 9 | `morning_summaries`, `morning_summary_items` |
| 10 | Relations `ON DELETE` table, delete routes, `ai_runs` triggers and `input_sha256` |
| 11 | `sources.provider` CHECK |
| 12 | `ai_runs`, `ingest_runs`, `nightwatch_runs` status columns, Task 4 |
| 13 | `owner_settings.nightwatch_max_ai_runs`, Nightwatch pipeline |
| 14 | Channel mapping, `offers.derived_by_ai_run_id`, `pending` state |
| 15 | Data classes egress, LLM client spec |
