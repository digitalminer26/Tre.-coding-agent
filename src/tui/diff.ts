/**
 * WS10 — diff view for `edit` tool calls (pure, no Ink, no I/O).
 *
 * Renders the oldText → newText replacement as unified-diff-style lines
 * (LCS over lines — the edit contract is an exact region replacement, so a
 * real diff is meaningful, not just -old/+new). Callers pass the tool call's
 * arguments object; undefined means "not an edit-shaped call" (or too big to
 * diff) and the caller skips the view.
 */
const MAX_DIFF_LINES = 500; // don't run the O(n·m) LCS on huge regions

/** splitlines semantics: no phantom line for a trailing newline. */
const splitLines = (s: string): string[] => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

export function renderEditDiff(args: Record<string, unknown>): string[] | undefined {
  if (typeof args.oldText !== "string" || typeof args.newText !== "string") return undefined;
  const a = splitLines(args.oldText);
  const b = splitLines(args.newText);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return undefined;

  // LCS table (bottom-up), then walk it to emit context / - / + lines.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}
