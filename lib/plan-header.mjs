export function applyAgreedPlanHeader(markdown, { agreedOn }) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  let statusChanged = false;
  const next = lines.map((line) => {
    if (statusChanged || !/status\s*:/i.test(line) || !/\bdraft\b/.test(line)) return line;
    statusChanged = true;
    return line.replace(/\bdraft\b/, "agreed");
  });
  if (!statusChanged) throw new Error("plan status line is missing");
  const header = next.findIndex((line) => /^\|\s*Version\s*\|/i.test(line));
  if (header < 0) throw new Error("plan version history is missing");
  let at = header + 1;
  if (/^\|\s*-/.test(next[at] ?? "")) at += 1;
  const date = String(agreedOn ?? "").slice(0, 10);
  next.splice(at, 0, `|  | ${date} | team | Agreed |`);
  return next.join("\n");
}

export function planHeaderDiffAllowed(before, after) {
  const left = String(before ?? "").replace(/\r\n/g, "\n").split("\n");
  const right = String(after ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let j = 0;
  let status = 0;
  let inserted = 0;
  while (i < left.length || j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (
      i < left.length &&
      j < right.length &&
      /status\s*:/i.test(left[i]) &&
      left[i].replace(/\bdraft\b/, "agreed") === right[j]
    ) {
      status += 1;
      i += 1;
      j += 1;
      continue;
    }
    if (j < right.length && right[j].startsWith("| ") && (i >= left.length || left[i] !== right[j])) {
      inserted += 1;
      j += 1;
      continue;
    }
    return false;
  }
  return status === 1 && inserted === 1;
}
