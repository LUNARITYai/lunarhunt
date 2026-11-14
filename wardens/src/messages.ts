/** C-30 block line. Two sentences, each ending with a period. */
export const MESSAGE_PATTERN = /^Blocked by Warden [a-z0-9-]+: .+\. .+\.$/;

export function wardenMessage(
  rule: string,
  what: string,
  next: string,
): string {
  return `Blocked by Warden ${rule}: ${what}. ${next}.`;
}

export const CHARTER_INVALID_MESSAGE = wardenMessage(
  "engine",
  "Charter validation failed",
  "Label the issue needs:human",
);

/** A hook run whose bundle is not the one of a primary listed in the launcher anchor (#73). */
export const NO_PRIMARY_MESSAGE = wardenMessage(
  "engine",
  "no trusted primary checkout could be resolved for this hook run, so the Charter cannot be trusted",
  "Ask Krzysztof to run wardens sync in the primary checkout",
);

export const TOPLEVEL_UNRESOLVED = "git toplevel could not be resolved";

/** Next action that needs no tool call: tools are blocked without a toplevel. */
const TOPLEVEL_NEXT =
  "Move the session into an existing worktree (EnterWorktree) or restart it in the primary checkout";

export function engineMessage(what: string): string {
  return wardenMessage(
    "engine",
    what,
    what === TOPLEVEL_UNRESOLVED
      ? TOPLEVEL_NEXT
      : "Label the issue needs:human",
  );
}
