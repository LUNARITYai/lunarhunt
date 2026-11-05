import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";
import { z } from "zod";
import {
  BASE_MODEL_MESSAGE,
  ENGINES,
  isEngineName,
  modelHasEmbeddedSuffix,
} from "./engines.ts";

const schemaPath = fileURLToPath(
  new URL("../schema/charter.schema.json", import.meta.url),
);

const CHARTER_FILENAME = "panopticon.charter.yaml";
const ALLOWED_NEGATION = "!*.example";
const NEGATION_LISTS = new Set([
  "paths.protected.deny",
  "paths.secrets_deny_read",
]);

const glob = z.string().min(1);

const MAGIC = /[*?[\]{}()!+@]/;

/** Reason an `paths.external` glob is not acceptable, or null. */
export function externalGlobError(value: string): string | null {
  let rest: string;
  if (value.startsWith("~/")) {
    rest = value.slice(2);
  } else if (value.startsWith("/")) {
    rest = value.slice(1);
  } else {
    return "must be absolute or start with ~/";
  }
  const segments = rest.split("/").filter((part) => part.length > 0);
  if (segments.includes("..")) {
    return "must not contain ..";
  }
  const first = segments[0];
  if (first === undefined || MAGIC.test(first)) {
    return "is too broad: the first path segment must be literal";
  }
  return null;
}

const externalGlob = glob.superRefine((value, ctx) => {
  const error = externalGlobError(value);
  if (error) {
    ctx.addIssue({ code: "custom", message: `external glob ${error}` });
  }
});

const engineSchema = z.string().min(1).refine(isEngineName, {
  message: "unknown engine",
});

const invocationShape = {
  engine: engineSchema,
  model: z.string().min(1),
  effort: z.string().min(1),
  fast: z.boolean().optional(),
};

function refineInvocation(
  role: { engine: string; model: string; effort: string },
  ctx: z.RefinementCtx,
): void {
  if (!isEngineName(role.engine)) {
    return;
  }
  const adapter = ENGINES[role.engine];
  if (!adapter.efforts.includes(role.effort)) {
    const allowed = adapter.efforts.join(", ");
    ctx.addIssue({
      code: "custom",
      path: ["effort"],
      message: `effort ${role.effort} is not valid for ${role.engine} (${allowed})`,
    });
  }
  if (
    adapter.embedsEffort &&
    modelHasEmbeddedSuffix(role.model, adapter.efforts)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["model"],
      message: BASE_MODEL_MESSAGE,
    });
  }
}

const invocationSchema = z
  .strictObject(invocationShape)
  .superRefine(refineInvocation);

const roleSchema = z
  .strictObject({
    ...invocationShape,
    allowed_paths: z.array(glob).optional(),
    read_only: z.boolean().optional(),
    escalate_to: invocationSchema.optional(),
  })
  .superRefine(refineInvocation);

const roleGate = z.strictObject({
  roles: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
});

const port = z.int().min(1024).max(65535);

const worktreeSchema = z.strictObject({
  required_for_agents: z.boolean(),
  protected_branches: z.array(z.string().min(1)),
  base_ref: z.string().min(1),
  naming: z.strictObject({
    worktree: z.string().min(1),
    branch: z.string().min(1),
    slug_max_length: z.int().min(1),
  }),
  location: z.strictObject({ default: z.string().min(1) }),
  setup: z.strictObject({
    steps: z.array(z.string().min(1)),
    env_template: z.string().min(1),
    copy_from_primary: z.array(z.string()).max(0).optional(),
  }),
  resources: z.strictObject({
    database: z.string().min(1).optional(),
    ports: z.strictObject({ web: port, api: port }),
  }),
  primary_read_only_commands: z.array(z.string().min(1)),
  cleanup: z.strictObject({ stale_after_days: z.int().min(1) }),
});

export const charterSchema = z.strictObject({
  version: z.literal(1),
  project: z.string().min(1),
  autonomy: z.strictObject({
    phase: z.int().min(0).max(3),
    kill_switch: z.boolean(),
  }),
  roles: z.strictObject({
    overseer: roleSchema,
    "spec-writer": roleSchema,
    implementer: roleSchema,
    reviewer: roleSchema,
    sentinel: roleSchema,
    debugger: roleSchema,
  }),
  paths: z.strictObject({
    allowed_paths: z.array(glob),
    protected: z.strictObject({
      deny: z.array(glob),
      ask: z.array(glob),
      non_interactive_ask: z.literal("deny"),
    }),
    generated: z.array(glob),
    secrets_deny_read: z.array(glob),
    external: z
      .strictObject({
        read: z.array(externalGlob).optional(),
        write: z.array(externalGlob).optional(),
      })
      .optional(),
  }),
  commands: z.strictObject({
    deny: z.array(z.string().min(1)),
    allow: z.array(z.string().min(1)),
    rewrite: z.record(z.string(), z.string().min(1)),
  }),
  covenant: z.strictObject({
    agents_md_exempt: z.array(z.string().min(1)),
  }),
  risk: z.strictObject({
    high: z.strictObject({
      paths: z.array(glob),
      labels: z.array(z.string().min(1)),
    }),
    medium: z.strictObject({
      default: z.literal(true),
    }),
    low: z.strictObject({
      paths: z.array(glob),
      all_files_must_match: z.boolean(),
      max_changed_lines: z.int().min(0),
    }),
  }),
  require_spec_for: z.array(
    z.strictObject({
      issue_types: z.array(z.string().min(1)),
      paths: z.array(glob),
    }),
  ),
  specs: z.strictObject({
    non_spec_files: z.array(glob),
  }),
  quality_gates: z.strictObject({
    definition_of_done: z.array(z.string().min(1)),
    diff_coverage_min: z.number().min(0).max(100),
    max_pr_changed_lines: z.int().min(0),
  }),
  budgets: z.strictObject({
    per_task: z.strictObject({
      max_cost_usd: z.number().nullable(),
      max_turns: z.int().nullable(),
    }),
    per_night: z.strictObject({
      max_cost_usd: z.number().nullable(),
    }),
  }),
  log_access: z.strictObject({
    local: roleGate,
    preview: roleGate,
    staging: roleGate,
    production: z.strictObject({
      requires: z.literal("human_approval"),
    }),
    limits: z.strictObject({
      max_time_range: z.string().min(1),
      max_results: z.int().min(1),
    }),
    redact: z.array(z.string().min(1)),
  }),
  ledger: z.strictObject({
    sink: z.array(z.string().min(1)).min(1),
    capture_content: z.boolean(),
  }),
  worktree: worktreeSchema.optional(),
});

export type Charter = z.infer<typeof charterSchema>;
export type WorktreeConfig = NonNullable<Charter["worktree"]>;

export type ValidateResult =
  | { ok: true; charter: Charter }
  | { ok: false; errors: string[] };

type ValidatorState =
  | { ok: true; validate: ValidateFunction }
  | { ok: false; errors: string[] };

let validatorState: ValidatorState | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaValidator(): ValidatorState {
  if (validatorState) {
    return validatorState;
  }
  try {
    const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
    });
    validatorState = { ok: true, validate: ajv.compile(schema as object) };
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "schema could not be compiled";
    validatorState = {
      ok: false,
      errors: [`Charter schema failed to load: ${detail}`],
    };
  }
  return validatorState;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ["schema validation failed"];
  }
  return errors.map((err) => {
    const path = err.instancePath.length > 0 ? err.instancePath : "/";
    const embedded =
      path.endsWith("/model") &&
      (err.keyword === "not" || err.schemaPath.includes("cursorModelSuffix"));
    if (embedded) {
      return `${path} ${BASE_MODEL_MESSAGE}`;
    }
    return `${path} ${err.message ?? "is invalid"}`;
  });
}

function walk(
  value: unknown,
  path: string,
  visit: (value: unknown, path: string) => void,
): void {
  visit(value, path);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walk(value[index], `${path}[${index}]`, visit);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path.length > 0 ? `${path}.${key}` : key, visit);
    }
  }
}

/** `!` is legal only as the exact item `!*.example` on the two deny lists. */
export function negationErrors(data: unknown): string[] {
  const errors: string[] = [];
  walk(data, "", (value, path) => {
    if (typeof value !== "string" || !value.startsWith("!")) {
      return;
    }
    const list = path.replace(/\[\d+\]$/, "");
    const allowed = value === ALLOWED_NEGATION && NEGATION_LISTS.has(list);
    if (!allowed) {
      errors.push(`negated glob ${value} is not allowed at ${path}`);
    }
  });
  return errors;
}

export function denyEntryErrors(data: unknown): string[] {
  if (
    !isRecord(data) ||
    !isRecord(data.paths) ||
    !isRecord(data.paths.protected)
  ) {
    return [`paths.protected.deny must contain ${CHARTER_FILENAME}`];
  }
  const deny = data.paths.protected.deny;
  if (!Array.isArray(deny) || !deny.includes(CHARTER_FILENAME)) {
    return [`paths.protected.deny must contain ${CHARTER_FILENAME}`];
  }
  return [];
}

export function validateWithAjv(
  data: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  const state = schemaValidator();
  if (!state.ok) {
    return state;
  }
  if (state.validate(data)) {
    return { ok: true };
  }
  return { ok: false, errors: formatAjvErrors(state.validate.errors) };
}

export function parseWithZod(data: unknown): ValidateResult {
  const parsed = charterSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")} ${issue.message}`,
      ),
    };
  }
  return { ok: true, charter: parsed.data };
}

export function validateCharterDocument(data: unknown): ValidateResult {
  if (!isRecord(data)) {
    return { ok: false, errors: ["Charter must be a YAML mapping"] };
  }
  const schemaResult = validateWithAjv(data);
  if (!schemaResult.ok) {
    return schemaResult;
  }
  const policyErrors = [...negationErrors(data), ...denyEntryErrors(data)];
  if (policyErrors.length > 0) {
    return { ok: false, errors: policyErrors };
  }
  return parseWithZod(data);
}

export function loadCharterYaml(text: string): ValidateResult {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "parse error";
    return { ok: false, errors: [`invalid YAML: ${detail}`] };
  }
  return validateCharterDocument(data);
}

export function loadCharterAt(toplevel: string): ValidateResult {
  const file = join(toplevel, CHARTER_FILENAME);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, errors: ["Charter file is missing or unreadable"] };
  }
  return loadCharterYaml(text);
}
