// Runtime configuration (docs/details.md conventions). Everything is read
// lazily by buildBot so the harness can construct the bot with explicit
// options and no env dependence.

export interface BotConfig {
  /** tg_id auto-promoted to admin on first /start (ADMIN_TG_ID env). */
  adminTgId: number | null;
  /** IANA timezone all dates/times are rendered in (SHOP_TZ env). */
  shopTz: string;
  /** Shop address appended to the pre-visit reminder (SHOP_ADDR env). */
  shopAddr: string;
}

export function configFromEnv(): BotConfig {
  const admin = Number(process.env.ADMIN_TG_ID ?? "");
  return {
    adminTgId: Number.isFinite(admin) && admin > 0 ? admin : null,
    shopTz: process.env.SHOP_TZ || "Europe/Moscow",
    shopAddr: process.env.SHOP_ADDR || "",
  };
}

/** Минуты от локальной полуночи → "HH:MM". */
export function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** UTC ms → "HH:MM" in the shop timezone. */
export function fmtTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(new Date(ms));
}

/** UTC ms → "DD.MM" in the shop timezone. */
export function fmtDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: tz,
  }).format(new Date(ms));
}

/** "YYYY-MM-DD" of a UTC instant in the shop timezone. */
export function isoDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  }).format(new Date(ms));
}

/**
 * Convert a shop-local (date, minutes-from-midnight) to UTC ms. Walks the
 * timezone offset via Intl (no deps): start from the naive UTC guess and
 * correct by the rendered difference, twice (handles DST edges).
 */
export function localToUtcMs(date: string, startMin: number, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  let guess = Date.UTC(y!, mo! - 1, d!, Math.floor(startMin / 60), startMin % 60);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: tz,
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const rendered = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    const want = Date.UTC(y!, mo! - 1, d!, Math.floor(startMin / 60), startMin % 60);
    guess += want - rendered;
  }
  return guess;
}
