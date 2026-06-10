// `catalog` feature: admin service CRUD (/services, details.md §10) and barber
// promotion with service assignment (/addbarber, details.md §11).

import { confirmKeyboard, inlineButton, inlineKeyboard } from "@agntdev/bot-toolkit";
import type { BotApp, Ctx } from "../bot.js";
import type { Service, User } from "../store.js";
import { navRow } from "../menu.js";

function isAdmin(user: User): boolean {
  return user.role === "admin";
}

export function catalogFeature(app: BotApp): void {
  const { store } = app;

  // Inert label buttons (service rows) — acknowledge silently.
  app.onCallback("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  // ── service list (the /services screen) ──
  async function renderServices(ctx: Ctx): Promise<void> {
    const services = store.activeServices();
    const rows = services.map((s) => [
      inlineButton(`${s.name} · ${s.price}₽ · ${s.durationMin} мин`, "noop:"),
      inlineButton("✏️", `sv:e:${s.id}`),
      inlineButton("🗑", `sv:d:${s.id}`),
    ]);
    rows.push([inlineButton("➕ Добавить", "sv:add")]);
    rows.push(navRow("menu:home"));
    const text = services.length ? "Услуги:" : "Услуг пока нет.";
    await ctx.reply(text, { reply_markup: inlineKeyboard(rows) });
  }

  async function requireAdmin(ctx: Ctx, user: User): Promise<boolean> {
    if (isAdmin(user)) return true;
    await ctx.reply("Команда доступна только администратору");
    return false;
  }

  app.bot.command("services", async (ctx) => {
    const user = store.upsertUser(ctx.from!.id);
    if (!(await requireAdmin(ctx, user))) return;
    user.state = "menu";
    await renderServices(ctx);
  });
  app.onMenu("svc", async (ctx, user) => {
    if (!(await requireAdmin(ctx, user))) return;
    await renderServices(ctx);
  });

  // ── add / edit flow: name → duration → price → confirm (details.md §10) ──
  app.onCallback("sv", async (ctx, data, user) => {
    if (!isAdmin(user)) {
      await ctx.answerCallbackQuery({ text: "Только для администратора" });
      return;
    }
    const [, op, arg] = data.split(":");

    if (op === "add" || op === "e") {
      const editing = op === "e" ? store.services.get(Number(arg)) : undefined;
      if (op === "e" && !editing) {
        await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
        return;
      }
      ctx.session.svcDraft = { editingId: editing ? editing.id : null };
      user.state = "svc:name";
      await ctx.answerCallbackQuery();
      await ctx.reply(
        editing
          ? `Название услуги (сейчас: ${editing.name}; «-» — оставить):`
          : "Название услуги:",
      );
      return;
    }

    if (op === "d") {
      const svc = store.services.get(Number(arg));
      if (!svc || !svc.active) {
        await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.reply(`Удалить услугу «${svc.name}»?`, {
        reply_markup: confirmKeyboard(`sv:del:${svc.id}`, { yes: "Да, удалить", no: "Нет" }),
      });
      return;
    }

    if (op === "del") {
      const [, , id, answer] = data.split(":");
      if (answer === "yes") {
        const svc = store.services.get(Number(id));
        if (svc) svc.active = false; // soft-delete: history keeps the FK (details.md §10)
        await ctx.answerCallbackQuery({ text: "Удалено" });
      } else {
        await ctx.answerCallbackQuery();
      }
      await renderServices(ctx);
      return;
    }

    await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
  });

  app.onState("svc", async (ctx, text, user) => {
    const draft = ctx.session.svcDraft;
    if (!draft) {
      await app.showMenu(ctx, user);
      return;
    }
    const editing = draft.editingId !== null ? store.services.get(draft.editingId) : undefined;
    const keep = text === "-" && editing !== undefined;

    if (user.state === "svc:name") {
      if (!keep && (text.length < 1 || text.length > 100)) {
        await ctx.reply("Название услуги: 1–100 символов");
        return;
      }
      draft.name = keep ? editing!.name : text;
      user.state = "svc:dur";
      await ctx.reply(
        editing
          ? `Длительность в минутах (сейчас: ${editing.durationMin}; «-» — оставить):`
          : "Длительность в минутах (кратно 30, от 15 до 480):",
      );
      return;
    }

    if (user.state === "svc:dur") {
      let dur: number;
      if (keep) {
        dur = editing!.durationMin;
      } else {
        dur = Number(text);
        if (!Number.isInteger(dur) || dur < 15 || dur > 480 || dur % 30 !== 0) {
          await ctx.reply("Длительность: целое число минут, кратное 30, от 15 до 480");
          return;
        }
      }
      draft.durationMin = dur;
      user.state = "svc:price";
      await ctx.reply(
        editing ? `Цена в рублях (сейчас: ${editing.price}; «-» — оставить):` : "Цена в рублях:",
      );
      return;
    }

    if (user.state === "svc:price") {
      let price: number;
      if (keep) {
        price = editing!.price;
      } else {
        price = Number(text);
        if (!Number.isInteger(price) || price < 0 || price > 1_000_000) {
          await ctx.reply("Цена: целое число от 0 до 1000000");
          return;
        }
      }
      draft.price = price;
      const svc: Service = editing ?? {
        id: store.nextId(),
        name: draft.name!,
        durationMin: draft.durationMin!,
        price,
        active: true,
      };
      svc.name = draft.name!;
      svc.durationMin = draft.durationMin!;
      svc.price = price;
      store.services.set(svc.id, svc);
      ctx.session.svcDraft = undefined;
      user.state = "menu";
      await ctx.reply(
        `${editing ? "Обновлено" : "Добавлено"}: ${svc.name} · ${svc.price}₽ · ${svc.durationMin} мин`,
      );
      await renderServices(ctx);
      return;
    }

    await app.showMenu(ctx, user);
  });

  // ── /addbarber: promote + assign services (details.md §11) ──
  app.bot.command("addbarber", async (ctx) => {
    const user = store.upsertUser(ctx.from!.id);
    if (!(await requireAdmin(ctx, user))) return;
    user.state = "ab:who";
    await ctx.reply("Перешлите сообщение от пользователя или отправьте его @username / tg id:");
  });
  app.onMenu("barbers", async (ctx, user) => {
    if (!(await requireAdmin(ctx, user))) return;
    user.state = "ab:who";
    await ctx.reply("Перешлите сообщение от пользователя или отправьте его @username / tg id:");
  });

  function barberServicesKeyboard(targetTgId: number, selected: number[]): ReturnType<typeof inlineKeyboard> {
    const rows = store.activeServices().map((s) => [
      inlineButton(`${selected.includes(s.id) ? "✅" : "⬜"} ${s.name}`, `ab:t:${s.id}`),
    ]);
    rows.push([inlineButton("💾 Готово", "ab:save")]);
    rows.push(navRow("menu:home"));
    return inlineKeyboard(rows);
  }

  app.onState("ab", async (ctx, text, user) => {
    if (!isAdmin(user)) {
      await app.showMenu(ctx, user);
      return;
    }
    // Resolve the target: forwarded message → its sender; "@username" → a user
    // who /start-ed with that username; digits → tg id.
    let targetTgId: number | null = null;
    const fwd = ctx.message?.forward_origin;
    if (fwd && fwd.type === "user") {
      targetTgId = fwd.sender_user.id;
    } else if (/^@/.test(text)) {
      const uname = text.slice(1).toLowerCase();
      const hit = [...store.users.values()].find((u) => u.username?.toLowerCase() === uname);
      targetTgId = hit ? hit.tgId : null;
    } else if (/^\d+$/.test(text)) {
      targetTgId = Number(text);
    }
    const target = targetTgId !== null ? store.users.get(targetTgId) : undefined;
    if (!target) {
      await ctx.reply("Пользователь ещё не открывал бота");
      return;
    }
    target.role = target.role === "admin" ? "admin" : "barber";
    const selected = [...(store.barberServices.get(target.tgId) ?? [])];
    ctx.session.addBarber = { targetTgId: target.tgId, serviceIds: selected };
    user.state = "menu";
    await ctx.reply(`Услуги мастера ${target.name ?? target.tgId}:`, {
      reply_markup: barberServicesKeyboard(target.tgId, selected),
    });
  });

  app.onCallback("ab", async (ctx, data, user) => {
    if (!isAdmin(user)) {
      await ctx.answerCallbackQuery({ text: "Только для администратора" });
      return;
    }
    const sel = ctx.session.addBarber;
    if (!sel) {
      await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
      return;
    }
    const [, op, arg] = data.split(":");
    if (op === "t") {
      const id = Number(arg);
      const i = sel.serviceIds.indexOf(id);
      if (i >= 0) sel.serviceIds.splice(i, 1);
      else sel.serviceIds.push(id);
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({
        reply_markup: barberServicesKeyboard(sel.targetTgId, sel.serviceIds),
      });
      return;
    }
    if (op === "save") {
      store.barberServices.set(sel.targetTgId, new Set(sel.serviceIds));
      ctx.session.addBarber = undefined;
      await ctx.answerCallbackQuery({ text: "Сохранено" });
      await ctx.reply("Мастер настроен. Ему доступна команда /slots — задать рабочие окна.");
      await app.bot.api.sendMessage(
        sel.targetTgId,
        "Вы добавлены как мастер. /slots — задать рабочие окна",
      ).catch(() => {/* target may have blocked the bot — non-fatal */});
      return;
    }
    await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
  });
}
