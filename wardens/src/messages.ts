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
