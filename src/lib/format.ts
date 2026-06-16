/** Parse an ISO timestamp into milliseconds since epoch. Returns null on
 *  failure. The DB stores UTC timestamps in a strict subset of ISO-8601. */
export function parseIso(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** "5 min ago", "2 hr ago", "3 days ago", or "Just now" */
export function relativeTime(iso: string, nowMs = Date.now()): string {
  const t = parseIso(iso);
  if (t === null) return iso;
  const diffSec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (diffSec < 30) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.round(days / 365);
  return `${years} yr ago`;
}

/** Same-day check using the local timezone. */
export function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "May 10", "May 10, 2027" if year differs from current. */
export function shortDate(iso: string, nowMs = Date.now()): string {
  const t = parseIso(iso);
  if (t === null) return iso;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  const opts: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

/** Compact number: 1234 → "1.2K", 1_500_000 → "1.5M", 2_000_000_000 → "2B".
 *  Values < 1000 render as-is. Trailing ".0" is stripped (1000 → "1K"). */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const tiers: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [base, suffix] of tiers) {
    if (abs >= base) {
      const v = abs / base;
      const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(1);
      return `${sign}${s.replace(/\.0$/, "")}${suffix}`;
    }
  }
  return `${sign}${abs}`;
}

/** Convert an ISO timestamp to the value format used by an
 *  <input type="date"> control. Returns "" if invalid. */
export function isoToDateInput(iso: string | null | undefined): string {
  const t = parseIso(iso);
  if (t === null) return "";
  const d = new Date(t);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Convert a yyyy-mm-dd from a date input into an ISO UTC timestamp at
 *  end-of-day local. Returns null if the input is empty. */
export function dateInputToIso(value: string): string | null {
  if (!value) return null;
  // Treat the date as the user's local end-of-day so deadlines feel natural.
  const d = new Date(`${value}T23:59:59`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Human-readable byte size: 1536 → "1.5 KB", 3_400_000_000 → "3.2 GB".
 *  Returns "" for non-positive values. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const fixed = value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[i]}`;
}
