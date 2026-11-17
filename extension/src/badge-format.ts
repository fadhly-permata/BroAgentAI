// Activity Bar badge text: at most 4 characters so it fits on a 48px rail icon.
// 0-999 as is, then 1.2k / 12k / 999k, then 1M+. `capped` (the count hit a list
// limit, the real number is higher) adds "+" when it still fits.

export function formatBadgeCount(count: number, capped = false): string {
  const n = Math.max(0, Math.floor(count));
  let text: string;
  if (n < 1000) text = String(n);
  else if (n < 10_000) text = trimZero(Math.floor(n / 100) / 10) + 'k';
  else if (n < 1_000_000) text = Math.floor(n / 1000) + 'k';
  else return '1M+';
  return capped && text.length < 4 ? text + '+' : text;
}

/** 2.0 -> "2", 1.2 -> "1.2". */
function trimZero(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
