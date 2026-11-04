const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMBINED_SHORT = /^-[a-zA-Z]{2,}$/;

export type ArgToken = { text: string; value: boolean };

export type Segment = {
  env: Record<string, string>;
  argv: string[];
  tokens: ArgToken[];
};

export type Pipeline =
  | { ok: true; segments: Segment[]; pipes: boolean[] }
  | { ok: false };

type RawSegment = { words: string[]; pipeAfter: boolean };

export function tokenize(command: string): Pipeline {
  const raw = scan(command);
  if (!raw) {
    return { ok: false };
  }
  const segments = raw.map((segment) => prepare(segment.words));
  const pipes = raw.slice(0, -1).map((segment) => segment.pipeAfter);
  return { ok: true, segments, pipes };
}

function scan(command: string): RawSegment[] | null {
  const segments: RawSegment[] = [];
  let words: string[] = [];
  let buf = "";
  let wordStarted = false;
  let quote: "single" | "double" | null = null;

  const flushWord = (): void => {
    if (!wordStarted) {
      return;
    }
    words.push(buf);
    buf = "";
    wordStarted = false;
  };

  const endSegment = (pipeAfter: boolean): void => {
    flushWord();
    segments.push({ words, pipeAfter });
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? "";
    if (quote === "single") {
      if (ch === "'") {
        quote = null;
      } else {
        buf += ch;
        wordStarted = true;
      }
      continue;
    }
    if (quote === "double") {
      if (ch === "\\") {
        const next = command[index + 1];
        if (next === undefined) {
          return null;
        }
        if (next === "\\" || next === '"') {
          buf += next;
          wordStarted = true;
          index += 1;
          continue;
        }
        buf += ch;
        wordStarted = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        wordStarted = true;
        continue;
      }
      buf += ch;
      wordStarted = true;
      continue;
    }
    if (ch === "\\") {
      const next = command[index + 1];
      if (next === undefined) {
        return null;
      }
      buf += next;
      wordStarted = true;
      index += 1;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      wordStarted = true;
      continue;
    }
    if (ch === '"') {
      quote = "double";
      wordStarted = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flushWord();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      endSegment(false);
      continue;
    }
    if (ch === "|" && command[index + 1] === "|") {
      endSegment(false);
      index += 1;
      continue;
    }
    if (ch === "|") {
      endSegment(true);
      continue;
    }
    if (ch === "&" && command[index + 1] === "&") {
      endSegment(false);
      index += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && command[index + 1] === "(")) {
      return null;
    }
    buf += ch;
    wordStarted = true;
  }

  if (quote !== null) {
    return null;
  }
  flushWord();
  segments.push({ words, pipeAfter: false });
  return segments;
}

function prepare(words: string[]): Segment {
  const env: Record<string, string> = {};
  const argv: string[] = [];
  let assigning = true;
  for (const word of words) {
    if (assigning && ENV_ASSIGNMENT.test(word)) {
      const eq = word.indexOf("=");
      env[word.slice(0, eq)] = word.slice(eq + 1);
      continue;
    }
    assigning = false;
    argv.push(word);
  }
  return { env, argv, tokens: annotate(argv) };
}

function consumesValue(flag: string, subcommand: string | null): boolean {
  if (flag === "-c" || flag === "--config" || flag === "-C") {
    return true;
  }
  return (
    subcommand === "commit" &&
    (flag === "-m" ||
      flag === "--message" ||
      flag === "-F" ||
      flag === "--file")
  );
}

function annotate(argv: string[]): ArgToken[] {
  if (argv[0] !== "git") {
    return argv.map((text) => ({ text, value: false }));
  }
  const valueIndexes = new Set<number>();
  let subcommand: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    if (valueIndexes.has(index)) {
      continue;
    }
    const token = argv[index] ?? "";
    if (COMBINED_SHORT.test(token)) {
      const consumes = [...token.slice(1)].some((letter) =>
        consumesValue(`-${letter}`, subcommand),
      );
      if (consumes && index + 1 < argv.length) {
        valueIndexes.add(index + 1);
      }
      continue;
    }
    if (consumesValue(token, subcommand)) {
      if (index + 1 < argv.length) {
        valueIndexes.add(index + 1);
      }
      continue;
    }
    if (!token.startsWith("-") && subcommand === null) {
      subcommand = token;
    }
  }

  const tokens: ArgToken[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (valueIndexes.has(index)) {
      tokens.push({ text: token, value: true });
      continue;
    }
    if (index > 0 && COMBINED_SHORT.test(token)) {
      for (const letter of token.slice(1)) {
        tokens.push({ text: `-${letter}`, value: false });
      }
      continue;
    }
    tokens.push({ text: token, value: false });
  }
  return tokens;
}

function isEnvToken(token: string): boolean {
  return ENV_ASSIGNMENT.test(token);
}

function isFlagPattern(token: string): boolean {
  return token.startsWith("-");
}

function globToken(pattern: string, text: string): boolean {
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${body}$`).test(text);
}

function tokenMatches(pattern: string, token: ArgToken): boolean {
  if (isFlagPattern(pattern) && token.value) {
    return false;
  }
  if (!pattern.includes("*")) {
    return pattern === token.text;
  }
  return globToken(pattern, token.text);
}

function matchRest(
  parts: string[],
  partIndex: number,
  tokens: ArgToken[],
  argIndex: number,
): boolean {
  if (partIndex >= parts.length) {
    return true;
  }
  const part = parts[partIndex] ?? "";
  const last = partIndex === parts.length - 1;
  if (part === "*") {
    if (last) {
      const head = parts[0];
      if ((head === "curl" || head === "wget") && parts.length === 2) {
        return argIndex < tokens.length;
      }
      return true;
    }
    for (let take = 1; argIndex + take <= tokens.length; take += 1) {
      if (matchRest(parts, partIndex + 1, tokens, argIndex + take)) {
        return true;
      }
    }
    return false;
  }
  for (let index = argIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (
      tokenMatches(part, token) &&
      matchRest(parts, partIndex + 1, tokens, index + 1)
    ) {
      return true;
    }
  }
  return false;
}

export function segmentMatches(pattern: string, segment: Segment): boolean {
  const parts = pattern
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return false;
  }
  const head = parts[0] ?? "";
  if (isEnvToken(head)) {
    const eq = head.indexOf("=");
    if (segment.env[head.slice(0, eq)] !== head.slice(eq + 1)) {
      return false;
    }
    return matchRest(parts, 1, segment.tokens, 0);
  }
  const first = segment.tokens[0];
  if (!first || !tokenMatches(head, first)) {
    return false;
  }
  return matchRest(parts, 1, segment.tokens, 1);
}

function rightSideMatches(pattern: string, segment: Segment): boolean {
  const parts = pattern
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 1) {
    return segment.argv[0] === parts[0];
  }
  if (parts.length === 2) {
    return segment.argv[0] === parts[0] && segment.argv[1] === parts[1];
  }
  return false;
}

export function pipelineMatches(
  pattern: string,
  pipeline: Extract<Pipeline, { ok: true }>,
): boolean {
  const pipeAt = pattern.indexOf(" | ");
  if (pipeAt !== -1) {
    const left = pattern.slice(0, pipeAt);
    const right = pattern.slice(pipeAt + 3);
    for (let index = 0; index < pipeline.segments.length - 1; index += 1) {
      const leftSegment = pipeline.segments[index];
      const rightSegment = pipeline.segments[index + 1];
      if (!pipeline.pipes[index] || !leftSegment || !rightSegment) {
        continue;
      }
      if (
        segmentMatches(left, leftSegment) &&
        rightSideMatches(right, rightSegment)
      ) {
        return true;
      }
    }
    return false;
  }
  return pipeline.segments.some((segment) => segmentMatches(pattern, segment));
}

export function firstDeny(
  patterns: readonly string[],
  pipeline: Extract<Pipeline, { ok: true }>,
): string | null {
  for (const pattern of patterns) {
    if (pipelineMatches(pattern, pipeline)) {
      return pattern;
    }
  }
  return null;
}

export function rewriteCommand(
  rewrite: Record<string, string>,
  pipeline: Extract<Pipeline, { ok: true }>,
): string | null {
  if (pipeline.segments.length !== 1) {
    return null;
  }
  const segment = pipeline.segments[0];
  if (!segment || Object.keys(segment.env).length > 0) {
    return null;
  }
  for (const [from, to] of Object.entries(rewrite)) {
    const parts = from
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
    if (
      parts.length === segment.argv.length &&
      parts.every((part, index) => part === segment.argv[index])
    ) {
      return to;
    }
  }
  return null;
}

/** Paths a shell segment might read. Best effort: no variable expansion and no `sh -c`. */
export function secretCandidates(segment: Segment): string[] {
  const found: string[] = [];
  const argv = segment.argv;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (word === "<") {
      const next = argv[index + 1];
      if (next && next.length > 0) {
        found.push(next);
      }
      continue;
    }
    if (word.startsWith("<") && word.length > 1) {
      found.push(word.slice(1));
      continue;
    }
    if (word.startsWith("--") && word.includes("=")) {
      const value = word.slice(word.indexOf("=") + 1);
      if (value.length > 0) {
        found.push(value);
      }
    }
    if (!word.startsWith("-")) {
      found.push(word);
    }
  }
  return found;
}
