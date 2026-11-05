export type IssueInfo = {
  title: string;
  labels: string[];
  body: string;
};

const TYPE_BY_LABEL: Record<string, string> = {
  feature: "feat",
  bug: "fix",
  chore: "chore",
  docs: "docs",
  spike: "spike",
};

const BRANCH_TYPES = new Set(Object.values(TYPE_BY_LABEL));

/** Branch type from the first known `type:*` label, or null. */
export function typeFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    if (label.startsWith("type:")) {
      const mapped = TYPE_BY_LABEL[label.slice("type:".length)];
      if (mapped !== undefined) {
        return mapped;
      }
    }
  }
  return null;
}

/** Lowercase kebab slug, at most `max` characters, no edge dashes. */
export function slugify(text: string, max: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Non-empty lines of the `### Allowed paths` section, trimmed, backticks and bullets stripped. */
export function allowedPaths(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^###\s+Allowed paths\s*$/i.test(l));
  if (start === -1) {
    return [];
  }
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) {
      break;
    }
    const cleaned = line
      .replace(/`/g, "")
      .replace(/^\s*[-*]\s+/, "")
      .trim();
    if (cleaned.length > 0 && cleaned !== "_No response_") {
      out.push(cleaned);
    }
  }
  return out;
}

export type BranchInfo = { type: string; issue: number; slug: string };

/** Parses `<type>/<issue>-<slug>`; null for any other branch name. */
export function parseBranch(branch: string | null): BranchInfo | null {
  if (branch === null) {
    return null;
  }
  const match = /^([a-z]+)\/([1-9][0-9]*)-([a-z0-9][a-z0-9-]*)$/.exec(branch);
  if (!match || !BRANCH_TYPES.has(match[1] ?? "")) {
    return null;
  }
  return {
    type: match[1] as string,
    issue: Number(match[2]),
    slug: match[3] as string,
  };
}
