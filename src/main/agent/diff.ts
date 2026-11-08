type Op = { type: " " | "-" | "+"; text: string };

/** Past this many edits the exact diff is not worth the time: show it as a whole replacement. */
const MAX_EDIT_DISTANCE = 1_000;

/** Myers' O(ND) diff, which stays fast because an edit changes few lines. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, offset);
    }
  }

  return [
    ...a.map((text): Op => ({ type: "-", text })),
    ...b.map((text): Op => ({ type: "+", text })),
  ];
}

function backtrack(a: string[], b: string[], trace: Int32Array[], offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: " ", text: a[--x]! });
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "+", text: b[--y]! });
      else ops.push({ type: "-", text: a[--x]! });
    }
  }
  return ops.reverse();
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A unified diff of two versions of a file, with a few lines of context around each change. */
export function unifiedDiff(before: string, after: string, context = 2): string {
  const a = splitLines(before);
  const b = splitLines(after);

  // Most of the file is unchanged, so only the middle goes through the diff.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const ops: Op[] = [
    ...a.slice(0, head).map((text): Op => ({ type: " ", text })),
    ...myers(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text): Op => ({ type: " ", text })),
  ];

  const hunks: string[] = [];
  let i = 0;
  let lineA = 1;
  let lineB = 1;
  while (i < ops.length) {
    if (ops[i]!.type === " ") {
      i++;
      lineA++;
      lineB++;
      continue;
    }
    // Start a hunk a few lines back, then extend it while changes are close together.
    const start = Math.max(0, i - context);
    const startA = lineA - (i - start);
    const startB = lineB - (i - start);
    let end = i;
    let quiet = 0;
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.type === " ") {
        if (++quiet > context * 2) break;
      } else {
        quiet = 0;
        end = j;
      }
    }
    const stop = Math.min(ops.length, end + 1 + context);
    const slice = ops.slice(start, stop);
    const countA = slice.filter((op) => op.type !== "+").length;
    const countB = slice.filter((op) => op.type !== "-").length;
    hunks.push(
      `@@ -${startA},${countA} +${startB},${countB} @@\n` +
        slice.map((op) => `${op.type}${op.text}`).join("\n"),
    );
    for (let j = i; j < stop; j++) {
      if (ops[j]!.type !== "+") lineA++;
      if (ops[j]!.type !== "-") lineB++;
    }
    i = stop;
  }
  return hunks.join("\n");
}
