/**
 * Word-level unified diff for the history diff view.
 *
 * Splits text into word+whitespace tokens and runs a Longest Common Subsequence
 * to produce insert/delete/equal token sequences. Word granularity is much
 * more readable than character-level for prose note content.
 *
 * O(m×n) in token count — correct for note-length texts; capped at 2000 tokens
 * (many thousands of words) as a defensive ceiling against pathological inputs.
 */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffToken {
  op: DiffOp;
  text: string;
}

/** Split text into alternating word/whitespace tokens (including the separators). */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/);
}

function lcsSizes(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp;
}

/**
 * Diff `prev` against `next` at word granularity.
 * `insert` = in `next` only; `delete` = in `prev` only; `equal` = in both.
 */
export function diffText(prev: string, next: string): DiffToken[] {
  if (prev === next) return prev ? [{ op: 'equal', text: prev }] : [];

  const MAX_TOKENS = 2000;
  const a = tokenize(prev).slice(0, MAX_TOKENS);
  const b = tokenize(next).slice(0, MAX_TOKENS);

  const dp = lcsSizes(a, b);
  const result: DiffToken[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ op: 'equal', text: a[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ op: 'insert', text: b[j - 1]! });
      j--;
    } else {
      result.unshift({ op: 'delete', text: a[i - 1]! });
      i--;
    }
  }

  return result;
}
