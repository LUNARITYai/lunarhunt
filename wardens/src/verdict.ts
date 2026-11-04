export type Decision = "allow" | "deny" | "ask" | "rewrite";

export type Verdict = {
  rule: string;
  decision: Decision;
  message: string | null;
  replacement: string | null;
  rendered: Decision;
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
