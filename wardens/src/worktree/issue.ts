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

/** The branch type from the single `type:*` label, or an error text. */
export function typeFromLabels(
  labels: string[],
): { type: string } | { error: string } {
  const typed = labels.filter((l) => l.startsWith("type:"));
  if (typed.length === 0) {
    return { error: "has no type:* label (missing field: type label)" };
  }
  if (typed.length > 1) {
    return { error: `has several type:* labels (${typed.join(", ")})` };
  }
  const mapped = TYPE_BY_LABEL[(typed[0] ?? "").slice("type:".length)];
  return mapped === undefined
    ? { error: `has an unknown type label ${typed[0]}` }
    : { type: mapped };
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

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^###\s+Allowed paths\s*$/i;

function badEntry(entry: string): string | null {
  if (entry.startsWith("!")) {
    return "starts with !";
  }
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
    return "is absolute";
  }
  if (entry.split(/[\\/]/).includes("..")) {
    return "contains ..";
  }
  return null;
}

/**
 * Entries of the single `### Allowed paths` section: non-empty lines, trimmed,
 * backticks and bullets stripped, fenced blocks skipped. Errors name the field.
 */
export function allowedPaths(
  body: string,
): { paths: string[] } | { error: string } {
  const lines = body.split(/\r?\n/);
  const headings: number[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
    } else if (!fenced && HEADING.test(line)) {
      headings.push(i);
    }
  });
  if (headings.length === 0) {
    return {
      error: "has no Allowed paths section (missing field: Allowed paths)",
    };
  }
  if (headings.length > 1) {
    return {
      error: `has ${headings.length} Allowed paths headings, expected exactly one`,
    };
  }
  const paths: string[] = [];
  fenced = false;
  for (const line of lines.slice((headings[0] ?? 0) + 1)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      break;
    }
    const cleaned = line
      .replace(/`/g, "")
      .replace(/^\s*[-*]\s+/, "")
      .trim();
    if (cleaned.length === 0 || cleaned === "_No response_") {
      continue;
    }
    const bad = badEntry(cleaned);
    if (bad !== null) {
      return { error: `has an Allowed paths entry that ${bad}: ${cleaned}` };
    }
    paths.push(cleaned);
  }
  return paths.length === 0
    ? {
        error:
          "has an empty Allowed paths section (missing field: Allowed paths)",
      }
    : { paths };
}

export type BranchInfo = { type: string; issue: number; slug: string };

/** Parses `<type>/<issue>-<slug>`; null for any other branch name. */
export function parseBranch(branch: string | null): BranchInfo | null {
  if (branch === null) {
    return null;
  }
  const match = /^([a-z]+)\/([1-9][0-9]{0,8})-([a-z0-9][a-z0-9-]*)$/.exec(
    branch,
  );
  if (!match || !BRANCH_TYPES.has(match[1] ?? "")) {
    return null;
  }
  return {
    type: match[1] as string,
    issue: Number(match[2]),
    slug: match[3] as string,
  };
}
