// Bot assembly: the update router skeleton every feature plugs into
// (docs/details.md §1, §12, §13; docs/work_breakdown.json `core`).
//
// Features (catalog/slots/booking/manage/scheduler) are INSTALLERS: they get
// the BotApp and register commands, menu actions, callback namespaces and
// text-step states. Core wires /start, /help, the callback router and the
// fallbacks AROUND them, so registration order is always correct: commands
// first, generic text/callback fallbacks last.

import { createBot, type BotContext } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import type { BotConfig } from "./config.js";
import { helpText, mainMenu } from "./menu.js";
import { Store, type User } from "./store.js";

/** Per-chat session scratch for multi-step flows. The authoritative
 *  conversation state is `users.conversation_state` in the store (details.md
 *  §1.2); the session only carries the in-flow draft data. */
export interface Session {
  book?: { barberId?: number; serviceId?: number; date?: string };
  slotsDraft?: { date: string; on: number[] };
  svcDraft?: { editingId: number | null; name?: string; durationMin?: number; price?: number };
  addBarber?: { targetTgId: number; serviceIds: number[] };
}

export type Ctx = BotContext<Session>;

export type CallbackHandler = (ctx: Ctx, data: string, user: User) => Promise<void>;
export type StateHandler = (ctx: Ctx, text: string, user: User) => Promise<void>;
export type MenuAction = (ctx: Ctx, user: User) => Promise<void>;

export interface BotApp {
  bot: Bot<Ctx>;
  store: Store;
  cfg: BotConfig;
  /** Register a callback namespace: data `"<ns>:..."` → handler. */
  onCallback(ns: string, fn: CallbackHandler): void;
  /** Register a main-menu action: callback `"menu:<key>"` → handler. */
  onMenu(key: string, fn: MenuAction): void;
  /** Register a text-step state namespace: `users.state "<ns>:..."` → handler. */
  onState(ns: string, fn: StateHandler): void;
  /** Send the role main menu and reset the user to state "menu". */
  showMenu(ctx: Ctx, user: User, text?: string): Promise<void>;
}

export type Feature = (app: BotApp) => void;

export function buildBot(token: string, store: Store, cfg: BotConfig, features: Feature[]): Bot<Ctx> {
  const bot = createBot<Session>(token, { initial: () => ({}) });

  const callbacks = new Map<string, CallbackHandler>();
  const menuActions = new Map<string, MenuAction>();
  const states = new Map<string, StateHandler>();

  const app: BotApp = {
    bot,
    store,
    cfg,
    onCallback: (ns, fn) => callbacks.set(ns, fn),
    onMenu: (key, fn) => menuActions.set(key, fn),
    onState: (ns, fn) => states.set(ns, fn),
    showMenu: async (ctx, user, text) => {
      user.state = "menu";
      await ctx.reply(text ?? "Главное меню:", { reply_markup: mainMenu(user.role) });
    },
  };

  // Error boundary (details.md §13): a single handler failure logs, resets the
  // user to the menu state and apologises — the update loop never crashes.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error("[barberbook] handler error:", err);
      const tgId = ctx.from?.id;
      if (tgId) store.upsertUser(tgId).state = "menu";
      try {
        await ctx.reply("Что-то пошло не так, попробуйте ещё раз");
      } catch {
        /* replying itself failed — nothing left to do */
      }
    }
  });

  // ── /start: registration + role menu (details.md §1) ──
  bot.command("start", async (ctx) => {
    const user = store.upsertUser(ctx.from!.id, ctx.from!.username ?? null);
    if (cfg.adminTgId !== null && user.tgId === cfg.adminTgId && user.role !== "admin") {
      user.role = "admin";
    }
    if (!user.name) {
      user.state = "reg:name";
      await ctx.reply("Как вас зовут?");
      return;
    }
    user.state = "menu";
    await ctx.reply(`Привет, ${user.name}!`, { reply_markup: mainMenu(user.role) });
  });

  // ── /help (details.md §12) ──
  bot.command("help", async (ctx) => {
    const user = store.upsertUser(ctx.from!.id, ctx.from!.username ?? null);
    await ctx.reply(helpText(user.role), { reply_markup: mainMenu(user.role) });
  });

  // ── feature installers (commands, menu actions, callbacks, states) ──
  for (const install of features) install(app);

  // ── callback router (after features so their namespaces are known) ──
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const user = store.upsertUser(ctx.from.id, ctx.from.username ?? null);
    const ns = data.split(":", 1)[0]!;

    if (ns === "menu") {
      const key = data.slice("menu:".length);
      if (key === "home") {
        await ctx.answerCallbackQuery();
        await app.showMenu(ctx, user);
        return;
      }
      const action = menuActions.get(key);
      if (action) {
        await ctx.answerCallbackQuery();
        await action(ctx, user);
        return;
      }
    } else {
      const handler = callbacks.get(ns);
      if (handler) {
        await handler(ctx, data, user);
        return;
      }
    }

    // Stale/unknown button (details.md §13).
    await ctx.answerCallbackQuery({ text: "Устарело, начните заново" });
    await app.showMenu(ctx, user);
  });

  // ── text router: registration step, feature states, fallback (§1, §13) ──
  bot.on("message:text", async (ctx) => {
    const user = store.upsertUser(ctx.from!.id, ctx.from!.username ?? null);
    const text = ctx.message.text.trim();

    if (user.state === "reg:name") {
      if (text.length < 1 || text.length > 64) {
        await ctx.reply("Как вас зовут?");
        return;
      }
      user.name = text;
      user.state = "menu";
      await ctx.reply(`Привет, ${user.name}!`, { reply_markup: mainMenu(user.role) });
      return;
    }

    const ns = user.state.split(":", 1)[0]!;
    const handler = states.get(ns);
    if (handler) {
      await handler(ctx, text, user);
      return;
    }

    // Unknown command / stray text (details.md §13).
    await ctx.reply("Не понял. /help — список команд", { reply_markup: mainMenu(user.role) });
  });

  return bot;
}
