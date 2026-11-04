/** One Charter role, or its `escalate_to`, before an adapter composes the call. */
export type RoleInvocation = {
  engine: string;
  model: string;
  effort: string;
  /** When true, Cursor appends `-fast` to the model id. Default false. */
  fast?: boolean | undefined;
};

export type ResolvedInvocation = {
  model: string;
  args: string[];
};

export type EngineAdapter = {
  readonly efforts: readonly string[];
  /** True when this engine's model id embeds effort and optional `-fast`. */
  readonly embedsEffort: boolean;
  resolve(role: RoleInvocation): ResolvedInvocation;
};

export const BASE_MODEL_MESSAGE =
  "must be the base model; set effort and fast separately";

/** Suffix pattern for engines whose model id embeds effort. */
export function embeddedModelSuffixPattern(efforts: readonly string[]): string {
  const body = [...efforts]
    .sort((a, b) => b.length - a.length)
    .map((effort) => effort.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("|");
  return `-(?:${body})(?:-fast)?$|-fast$`;
}

export function modelHasEmbeddedSuffix(
  model: string,
  efforts: readonly string[],
): boolean {
  return new RegExp(embeddedModelSuffixPattern(efforts)).test(model);
}

const claude: EngineAdapter = {
  efforts: ["low", "medium", "high"],
  embedsEffort: false,
  // Claude Code documents `claude --effort <level>` (low, medium, high,
  // xhigh, max, ultracode). Checked 2026-11-04:
  // https://code.claude.com/docs/en/cli-reference
  // The Charter offers low|medium|high only. `fast` has no Claude flag.
  resolve(role) {
    return { model: role.model, args: ["--effort", role.effort] };
  },
};

const cursor: EngineAdapter = {
  efforts: ["low", "medium", "high", "xhigh"],
  embedsEffort: true,
  resolve(role) {
    const fast = role.fast === true ? "-fast" : "";
    return { model: `${role.model}-${role.effort}${fast}`, args: [] };
  },
};

/** Add an engine by adding one entry. Keys are the Charter `engine` enum. */
export const ENGINES = {
  claude,
  cursor,
} satisfies Record<string, EngineAdapter>;

export type EngineName = keyof typeof ENGINES;

export function isEngineName(value: string): value is EngineName {
  return Object.hasOwn(ENGINES, value);
}

/** Concrete model id and args for a future launcher (`lh-run`, `role-cmd`). */
export function resolveRole(role: RoleInvocation): ResolvedInvocation {
  if (!isEngineName(role.engine)) {
    throw new Error(`unknown engine ${role.engine}`);
  }
  return ENGINES[role.engine].resolve(role);
}
