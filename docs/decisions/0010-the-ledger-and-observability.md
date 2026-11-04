---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0010: The Ledger and observability

## Context and Problem Statement

Two kinds of telemetry are needed. **The Ledger** records every agent run: role, model, Warden verdicts, gate results, token usage and cost, and the PR outcome. It feeds the autonomy entry criteria (ADR-0008) and model routing (ADR-0009). **Server observability** covers logs, traces and metrics of LunarHunt (Next.js, FastAPI, workers) so failures can be diagnosed, including by agents. Agents reading logs is useful for debugging, but logs may contain secrets, personal data (CV) and untrusted job-offer content that can carry prompt injection.

## Decision Drivers

- Ledger data queryable with plain SQL for the autonomy and routing metrics
- No extra heavy services on a single VPS for the MVP
- Ability to move to a dedicated LLM-observability tool later without changing agents
- One correlation ID from a server log line to a Ledger run
- Agent log access that is read-only, scoped, redacted and audited
- Privacy by default: metadata, not prompt or code content

## Considered Options

For The Ledger:

1. Postgres tables with JSONB events, instrumented via OpenTelemetry
2. Langfuse (self-hosted or cloud)
3. ClickHouse
4. OpenTelemetry stack only (traces and logs, no Ledger tables)

For server observability:

A. Grafana + Loki + Tempo + Prometheus fed by an OpenTelemetry Collector
B. SigNoz (all-in-one)

## Decision Outcome

Chosen options: **Ledger v0 in Postgres with JSONB events via OpenTelemetry (1)** and **Grafana + Loki + Tempo + Prometheus (A)**.

Postgres is already part of the application, Ledger events are ordinary tables queryable with SQL, and because data is emitted through OpenTelemetry, a later switch to Langfuse is a change of sink, not of agents. Langfuse v3 self-hosted needs additional services (including ClickHouse and Redis), and ClickHouse alone is oversized for one user and tens of runs per day.

### The Ledger v0

- **Writers:** Wardens hooks (session start/end, tool events, verdicts), CI (gate results), a GitHub webhook job (PR outcomes), tool telemetry via OTLP where available. Claude Code `OTEL_*` variables cannot be set from the project `.claude/settings.json`; they are set in the Cell environment (Dev Container).
- **Minimal schema:** `run` (run_id, issue, spec, cell, branch, tool, role, model, started/ended, status), `event` (run_id, ts, hook event, tool name, decision, warden_rule_id, duration, `payload JSONB`), `warden_verdict`, `gate_result`, `usage` (input/output/cache tokens, cost), `outcome` (PR, merged, human fix commits, review comments, reverted, time to merge, CI reruns), `log_query` (agent log access audit).
- **Privacy:** metadata only by default (`ledger.capture_content: false` in The Charter); optional content is redacted (gitleaks on the payload) before storage.
- **Metrics:** CI first-pass green rate, human rework rate, revert rate, Warden blocks per task, escalations, cost and time per task, broken down by role, model and task class.

### Server observability

- All services log **structured JSON** with `trace_id` and `request_id` through OpenTelemetry. `trace_id` is stored on Ledger runs, linking a server log line to the agent run that caused it.
- On k3s: OpenTelemetry Collector → **Loki** (logs), **Tempo** (traces), **Prometheus** (metrics), **Grafana** (dashboards, including the Ledger dashboard on Postgres). MVP: the same stack in the local `docker compose` of the Dev Container.
- **Alerts:** high 5xx rate and failed nightly runs (Nightwatch, night shift), sent by email or Discord.

### Agent access to logs and traces

- **Read-only** through one scoped tool (MCP server or CLI); no direct access to Loki, Tempo or Grafana credentials.
- **Scopes from The Charter `log_access:`:** local and preview by default; staging only for the `debugger` role; production only with Krzysztof's explicit approval per request. Limits on time range and number of results.
- **Redaction** of secrets, personal data and CV data before results reach an agent; results are marked as untrusted external content.
- **Audit:** every query is recorded in The Ledger (`log_query`).
- Target loop: alert → issue with a trace link → agent analyses logs → fix PR (with reproduction test, ADR-0004) → human approval.

### Consequences

- Good, because there is no new service for the Ledger, and SQL answers questions like "which model fails Wardens most often".
- Good, because OpenTelemetry keeps the door open to Langfuse or another backend.
- Good, because `trace_id` correlation makes agent-caused incidents traceable.
- Good, because agent log access is useful for debugging without exposing secrets or production by default.
- Bad, because we must build the Ledger dashboard ourselves (Grafana on Postgres) instead of getting Langfuse's UI.
- Bad, because the full Grafana stack is several services to run on one VPS.
- Bad, because redaction is heuristic and can miss data; it reduces but does not remove risk.

### Confirmation

- CI job `ledger-migrations`: Ledger schema migrations apply cleanly and an integration test writes and reads one run with events through the OTLP path.
- Warden tests assert that every hook invocation emits a Ledger event (no silent paths).
- CI job `log-format`: a contract test asserts that API and worker log lines are valid JSON containing `trace_id` and `request_id`.
- Log-access tool tests: production queries without approval are denied; staging queries are denied for non-`debugger` roles; seeded secrets, emails and CV snippets are redacted; every query writes a `log_query` row.
- The Ledger flags agent sessions without hook events (ring 0 disabled), see ADR-0004.

## Pros and Cons of the Options

### Postgres + JSONB + OpenTelemetry

- Good, because it is already in the stack, simple and SQL-queryable.
- Bad, because there is no built-in LLM trace UI or evaluation features.

### Langfuse

- Good, because of ready-made LLM tracing, costs, latencies, evaluations and UI.
- Bad, because self-hosted v3 needs ClickHouse, Redis and more; cloud keeps data outside our infrastructure.

### ClickHouse

- Good, because it is very fast at millions of events.
- Bad, because it is excessive for one user and tens of runs per day.

### OpenTelemetry stack only

- Good, because it shows what happened operationally.
- Bad, because it is poor at analytical questions about agent behaviour.

### Grafana stack vs. SigNoz

- Grafana + Loki + Tempo + Prometheus: widely used components, flexible, more pieces to run.
- SigNoz: lighter all-in-one alternative, less common.

## More Information

- Langfuse OpenTelemetry: <https://langfuse.com/integrations/native/opentelemetry>; Claude Code monitoring: <https://code.claude.com/docs/en/monitoring-usage>; OpenTelemetry GenAI conventions (status: Development).
- Research report, section 9 and 11.1 (lethal trifecta).
- Related: ADR-0003 (`log_access`, `ledger`), ADR-0004 (verdicts), ADR-0008 (entry criteria), ADR-0009 (routing metrics).
- See also ADR-0013: `debugger` role model and effort.
