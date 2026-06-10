// /slots — barber sets availability (docs/details.md §5).
// Step 1: date picker (today + 13 days).
// Step 2: half-hour grid 09:00–20:30 with toggles, save upserts.
//
//   1. Date   — buttons for today + 13 days.   CB `sl:date:<YYYY-MM-DD>`
//   2. Grid   — 09:00–20:30 in 30-min steps.
//                🟢 free · ⚪ off · 🔒 covered by confirmed appt (not toggleable)
//                CB `sl:t:<HH:MM>` toggles in place (editMessageReplyMarkup).
//   3. Save   — CB `sl:save` upserts `barber_schedules`; off slots with no
//                appointment are deleted.
//                Reply "Слоты на {date} сохранены: {n} окон".
//
// The draft state lives on the session (`Session.slotsDraft`); the conversation
// state stays `menu` — there is no per-step text prompt.

import { inlineButton, inlineKeyboard, type InlineKeyboardMarkup } from "@agntdev/bot-toolkit";
import type { BotApp } from "./bot.js";
import { fmtMin, isoDate, localToUtcMs } from "./config.js";

/** Grid bounds in minutes from local midnight. */
const FIRST_MIN = 9 * 60; // 09:00
const LAST_MIN = 20 * 60 + 30; // 20:30
const STEP_MIN = 30;
/** today + 13 days. */
const DATE_COUNT = 14;

function isBarberLike(role: string): boolean {
  return role === "barber" || role === "admin";
}

/** "Чт 12.06" — short weekday + day.month in the shop timezone. */
function dayLabel(date: string, tz: string): string {
  const ms = localToUtcMs(date, 0, tz);
  const wd = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: tz }).format(new Date(ms));
  const dm = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", timeZone: tz }).format(new Date(ms));
  return `${wd} ${dm}`;
}

function todayIso(tz: string): string {
  return isoDate(Date.now(), tz);
}

function datePicker(tz: string): InlineKeyboardMarkup {
  const todayMs = localToUtcMs(todayIso(tz), 0, tz);
  const rows: ReturnType<typeof inlineButton>[][] = [];
  let row: ReturnType<typeof inlineButton>[] = [];
  for (let i = 0; i < DATE_COUNT; i++) {
    const iso = isoDate(todayMs + i * 86_400_000, tz);
    row.push(inlineButton(dayLabel(iso, tz), `sl:date:${iso}`));
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  rows.push([inlineButton("🏠 Меню", "menu:home")]);
  return inlineKeyboard(rows);
}

/** A half-hour starting at `startMin` on `date` is covered iff any confirmed
 *  appointment of this barber overlaps [slotStart, slotStart+30m). */
function isCovered(apps: ReadonlyArray<{ startsAt: number; endsAt: number; status: string }>, date: string, startMin: number, tz: string): boolean {
  const slotStart = localToUtcMs(date, startMin, tz);
  const slotEnd = slotStart + STEP_MIN * 60_000;
  for (const a of apps) {
    if (a.status !== "confirmed") continue;
    if (a.startsAt < slotEnd && a.endsAt > slotStart) return true;
  }
  return false;
}

function gridMarkup(barberTgId: number, date: string, draftOn: ReadonlyArray<number>, app: BotApp): InlineKeyboardMarkup {
  const apps = [...app.store.appointments.values()].filter((a) => a.barberTgId === barberTgId);
  const onSet = new Set<number>(draftOn);
  const rows: ReturnType<typeof inlineButton>[][] = [];
  let row: ReturnType<typeof inlineButton>[] = [];
  for (let m = FIRST_MIN; m <= LAST_MIN; m += STEP_MIN) {
    if (isCovered(apps, date, m, app.cfg.shopTz)) {
      // 🔒 not toggleable — `sl:noop` is a benign no-op handled below.
      row.push(inlineButton(`🔒 ${fmtMin(m)}`, "sl:noop"));
    } else if (onSet.has(m)) {
      row.push(inlineButton(`🟢 ${fmtMin(m)}`, `sl:t:${fmtMin(m)}`));
    } else {
      row.push(inlineButton(`⚪ ${fmtMin(m)}`, `sl:t:${fmtMin(m)}`));
    }
    if (row.length === 3) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  rows.push([
    inlineButton("💾 Сохранить", "sl:save"),
    inlineButton("⬅️ Назад", "sl:back"),
    inlineButton("🏠 Меню", "menu:home"),
  ]);
  return inlineKeyboard(rows);
}

function accessDeniedMarkup(): InlineKeyboardMarkup {
  return inlineKeyboard([[inlineButton("🏠 Меню", "menu:home")]]);
}

export function slotsFeature(app: BotApp): void {
  // /slots — entry point. Role gate (details.md §5).
  app.bot.command("slots", async (ctx) => {
    const user = app.store.upsertUser(ctx.from!.id);
    if (!isBarberLike(user.role)) {
      await ctx.reply("Команда доступна только мастерам", { reply_markup: accessDeniedMarkup() });
      return;
    }
    await ctx.reply("Выберите дату:", { reply_markup: datePicker(app.cfg.shopTz) });
  });

  // menu:slots — same entry from the role main menu.
  app.onMenu("slots", async (ctx, user) => {
    if (!isBarberLike(user.role)) {
      await ctx.reply("Команда доступна только мастерам", { reply_markup: accessDeniedMarkup() });
      return;
    }
    await ctx.reply("Выберите дату:", { reply_markup: datePicker(app.cfg.shopTz) });
  });

  // sl: callback namespace — date picker / grid toggles / save / back / noop.
  app.onCallback("sl", async (ctx, data, user) => {
    if (!isBarberLike(user.role)) {
      await ctx.answerCallbackQuery({ text: "Команда доступна только мастерам" });
      return;
    }
    const parts = data.split(":");
    const action = parts[1];

    if (action === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    if (action === "date") {
      const date = parts[2];
      if (!date) {
        await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
        return;
      }
      // Seed the draft with the barber's currently-free slots for that date.
      const existingFree = app.store
        .slotsFor(user.tgId, date)
        .filter((s) => s.free)
        .map((s) => s.startMin);
      ctx.session.slotsDraft = { date, on: existingFree };
      const draft = ctx.session.slotsDraft!;
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(`Слоты на ${dayLabel(date, app.cfg.shopTz)}:`, {
          reply_markup: gridMarkup(user.tgId, date, draft.on, app),
        });
      } catch {
        // Message content unchanged (race) — leave the picker as-is.
      }
      return;
    }

    if (action === "t") {
      const draft = ctx.session.slotsDraft;
      if (!draft) {
        await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
        return;
      }
      // Reassemble HH:MM (parts[2] and parts[3] when the time is e.g. 14:30).
      const hhmm = parts.slice(2).join(":");
      const [hStr, mStr] = hhmm.split(":");
      const h = Number(hStr);
      const m = Number(mStr);
      if (!Number.isFinite(h) || !Number.isFinite(m)) {
        await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
        return;
      }
      const startMin = h * 60 + m;
      const i = draft.on.indexOf(startMin);
      if (i >= 0) draft.on.splice(i, 1);
      else draft.on.push(startMin);
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: gridMarkup(user.tgId, draft.date, draft.on, app),
        });
      } catch {
        // Identical markup — Telegram may throw; ignore.
      }
      return;
    }

    if (action === "back") {
      ctx.session.slotsDraft = undefined;
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText("Выберите дату:", { reply_markup: datePicker(app.cfg.shopTz) });
      } catch {
        /* */
      }
      return;
    }

    if (action === "save") {
      const draft = ctx.session.slotsDraft;
      if (!draft) {
        await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
        return;
      }
      const existing = app.store.slotsFor(user.tgId, draft.date);
      const onSet = new Set<number>(draft.on);
      // Delete existing free slots the barber just turned off.
      for (const s of existing) {
        if (s.free && !onSet.has(s.startMin)) {
          app.store.slots.delete(s.id);
        }
      }
      // Insert any newly-on slot that doesn't exist yet.
      for (const m of draft.on) {
        const have = existing.find((s) => s.startMin === m);
        if (!have) {
          const id = app.store.nextId();
          app.store.slots.set(id, {
            id,
            barberTgId: user.tgId,
            date: draft.date,
            startMin: m,
            free: true,
          });
        }
      }
      // 🔒 slots (free=false) are covered by a confirmed appointment — leave them
      // untouched. The barber can't toggle those in the grid anyway.
      const n = draft.on.length;
      const date = draft.date;
      ctx.session.slotsDraft = undefined;
      await ctx.answerCallbackQuery({ text: "Сохранено" });
      try {
        await ctx.editMessageText(`Слоты на ${date} сохранены: ${n} окон`, {
          reply_markup: inlineKeyboard([[inlineButton("🏠 Меню", "menu:home")]]),
        });
      } catch {
        /* */
      }
      return;
    }

    // Unknown sl: sub-action.
    await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
  });
}
