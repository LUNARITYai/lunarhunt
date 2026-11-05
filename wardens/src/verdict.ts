export type Decision = "allow" | "deny" | "ask" | "rewrite";

export type Verdict = {
  rule: string;
  decision: Decision;
  message: string | null;
  replacement: string | null;
  rendered: Decision;
  /** Extra text for the agent only (for example `pnpm check` output). Never logged. */
  detail?: string;
};

export function allowVerdict(): Verdict {
  return {
    rule: "none",
    decision: "allow",
    message: null,
    replacement: null,
    rendered: "allow",
  };
}

export function checkExitCode(decision: Decision): 0 | 2 {
  return decision === "allow" ? 0 : 2;
}
