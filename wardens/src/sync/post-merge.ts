/**
 * Plain shell for the `post-merge` and `post-rewrite` hooks: rebuild the primary
 * bundle after a pull. It must work before dependencies are installed and must
 * never fail the pull. `ORIG_HEAD` is the pre-pull HEAD for merge and rebase pulls;
 * without it everything counts as changed.
 */
export const POST_PULL_SCRIPT = `gd=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
if [ "$gd" != "$common" ]; then exit 0; fi
if [ "$(git branch --show-current)" != main ]; then exit 0; fi
if changed=$(git diff --name-only ORIG_HEAD HEAD -- 2>/dev/null); then
  lock=0; wd=0
  if printf '%s\\n' "$changed" | grep -qx 'pnpm-lock.yaml'; then lock=1; fi
  if printf '%s\\n' "$changed" | grep -q '^wardens/'; then wd=1; fi
else
  lock=1; wd=1
fi
next='Run pnpm install && pnpm --filter wardens build in the primary checkout.'
if [ "$lock" = 1 ]; then
  if ! pnpm install --frozen-lockfile; then echo "wardens: pnpm install failed. $next"; exit 0; fi
fi
if [ "$wd" = 1 ]; then
  if ! pnpm --filter wardens build; then echo "wardens: bundle build failed. $next"; exit 0; fi
fi
exit 0
`;

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/** The YAML for both hooks. `post-rewrite` acts only for a rebase (`{1}` is rebase or amend). */
export function postPullYaml(): string {
  const rewrite = `if [ "{1}" != rebase ]; then exit 0; fi\n${POST_PULL_SCRIPT}`;
  return `post-merge:
  commands:
    rebuild-wardens:
      run: |
${indent(POST_PULL_SCRIPT, 8)}

post-rewrite:
  commands:
    rebuild-wardens:
      run: |
${indent(rewrite, 8)}
`;
}
