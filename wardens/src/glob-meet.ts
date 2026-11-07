/**
 * Can a shell glob and a deny pattern match the same name? A sound test for
 * one path segment (#78): both are compiled to a small NFA over literal
 * characters, `?`, `*` and character classes (ranges, `!` and `^` negation),
 * and the product is searched for a string both accept and no negated pattern
 * (`!*.example`) excludes. Picomatch is not used: it has no shell `[!x]`.
 */

type Range = readonly [number, number];
type Token =
  | { kind: "lit"; code: number }
  | { kind: "any" }
  | { kind: "star" }
  | { kind: "class"; negated: boolean; ranges: Range[] };

const DOT = 46;
const SLASH = 47;

/**
 * `shell` reads the zsh `extendedglob` forms conservatively: `^` and `#`
 * become `*` (a superset of what they match), and `A~B` becomes `A`.
 */
function compile(segment: string, shell: boolean): Token[] {
  const chars = [...segment];
  const tokens: Token[] = [];
  for (let at = 0; at < chars.length; at += 1) {
    const ch = chars[at] ?? "";
    if (shell && ch === "~") {
      break;
    }
    if (ch === "*" || (shell && (ch === "^" || ch === "#"))) {
      tokens.push({ kind: "star" });
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
    } else if (ch === "[") {
      const negated = chars[at + 1] === "!" || chars[at + 1] === "^";
      const first = at + (negated ? 2 : 1);
      const ranges: Range[] = [];
      let end = first;
      while (end < chars.length && (chars[end] !== "]" || end === first)) {
        const lo = chars[end]?.codePointAt(0) ?? 0;
        const hi = chars[end + 2]?.codePointAt(0) ?? lo;
        if (chars[end + 1] === "-" && end + 2 < chars.length && hi !== 93) {
          ranges.push([lo, hi]);
          end += 3;
        } else {
          ranges.push([lo, lo]);
          end += 1;
        }
      }
      if (chars[end] === "]") {
        tokens.push({ kind: "class", negated, ranges });
        at = end;
      } else {
        tokens.push({ kind: "lit", code: 91 });
      }
    } else {
      tokens.push({ kind: "lit", code: ch.codePointAt(0) ?? 0 });
    }
  }
  return tokens;
}

function accepts(token: Token, code: number): boolean {
  if (token.kind === "lit") {
    return token.code === code;
  }
  if (token.kind === "class") {
    const inside = token.ranges.some(([lo, hi]) => code >= lo && code <= hi);
    return inside !== token.negated;
  }
  return true;
}

/**
 * The shell never lets a pattern that does not start with a literal dot match
 * a name that does (`*.env` is not `.env`), unless dotfile globbing is on. A
 * class that names the dot (`[.]env`) counts as explicit, conservatively.
 */
function hidesDotfiles(tokens: Token[]): boolean {
  const head = tokens[0];
  if (!head || head.kind === "lit") {
    return false;
  }
  if (head.kind === "class") {
    const names = head.ranges.some(([lo, hi]) => DOT >= lo && DOT <= hi);
    return head.negated || !names;
  }
  return true;
}

function close(tokens: Token[], from: Iterable<number>): number[] {
  const out = new Set<number>();
  for (const start of from) {
    let at = start;
    out.add(at);
    while (tokens[at]?.kind === "star") {
      at += 1;
      out.add(at);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function step(tokens: Token[], set: number[], code: number): number[] {
  const next: number[] = [];
  for (const at of set) {
    const token = tokens[at];
    if (token && accepts(token, code)) {
      next.push(token.kind === "star" ? at : at + 1);
    }
  }
  return close(tokens, next);
}

/** One character per interval the tokens tell apart. */
function alphabet(all: Token[][]): number[] {
  const points = new Set([1, DOT, 97]);
  for (const token of all.flat()) {
    if (token.kind === "lit") {
      points.add(token.code);
      points.add(token.code + 1);
    } else if (token.kind === "class") {
      for (const [lo, hi] of token.ranges) {
        points.add(lo);
        points.add(hi + 1);
      }
    }
  }
  points.delete(SLASH);
  return [...points].filter((code) => code > 0);
}

/**
 * True when one name can match the glob `glob` and the deny pattern `pattern`
 * and none of the `excluded` patterns. `dot` is true when the shell's `*`
 * matches dotfiles. Deny patterns follow the policy rules: wildcards match a
 * leading dot there.
 */
export function segmentsMeet(
  glob: string,
  pattern: string,
  excluded: readonly string[],
  dot: boolean,
): boolean {
  const g = compile(glob, true);
  const p = compile(pattern, false);
  const n = excluded.map((e) => compile(e, false));
  const letters = alphabet([g, p, ...n]);
  type State = { sets: number[][]; first: boolean };
  const tokenSets = [g, p, ...n];
  const hidden = !dot && hidesDotfiles(g);
  const advance = (state: State, code: number): State => ({
    sets: tokenSets.map((tokens, i) =>
      i === 0 && hidden && state.first && code === DOT
        ? []
        : step(tokens, state.sets[i] ?? [], code),
    ),
    first: false,
  });
  const done = (state: State): boolean =>
    !state.first &&
    tokenSets.every((tokens, i) => {
      const reaches = (state.sets[i] ?? []).includes(tokens.length);
      return i < 2 ? reaches : !reaches;
    });
  const seen = new Set<string>();
  const queue: State[] = [
    { sets: tokenSets.map((tokens) => close(tokens, [0])), first: true },
  ];
  while (queue.length > 0) {
    const state = queue.pop();
    if (!state) {
      break;
    }
    for (const code of letters) {
      const next = advance(state, code);
      if (next.sets.slice(0, 2).some((set) => set.length === 0)) {
        continue;
      }
      if (done(next)) {
        return true;
      }
      const key = JSON.stringify(next.sets);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(next);
      }
    }
  }
  return false;
}
