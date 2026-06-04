const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

export type DateQueryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export function parseRequiredDateRange(params: URLSearchParams): DateQueryResult<DateRange> {
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to) {
    return { ok: false, error: "Missing from or to parameter" };
  }
  return validateDateRange(from, to);
}

export function parseDateRange(from: string, to: string): DateQueryResult<DateRange> {
  return validateDateRange(from, to);
}

function validateDateRange(from: string, to: string): DateQueryResult<DateRange> {
  const fromMs = parseDateMs(from, "from");
  if (!fromMs.ok) return fromMs;

  const toMs = parseDateMs(to, "to");
  if (!toMs.ok) return toMs;

  if (fromMs.value > toMs.value) {
    return { ok: false, error: "from must be on or before to" };
  }

  const rangeDays = (toMs.value - fromMs.value) / DAY_MS + 1;
  if (rangeDays > MAX_RANGE_DAYS) {
    return { ok: false, error: `Date range cannot exceed ${MAX_RANGE_DAYS} days` };
  }

  return { ok: true, value: { from, to } };
}

function parseDateMs(value: string, name: "from" | "to"): DateQueryResult<number> {
  if (!DATE_PATTERN.test(value)) {
    return { ok: false, error: `Invalid ${name} parameter; expected YYYY-MM-DD` };
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return { ok: false, error: `Invalid ${name} parameter; expected YYYY-MM-DD` };
  }

  return { ok: true, value: parsed.getTime() };
}
