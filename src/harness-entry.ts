// TOKENLESS factory for the replay harness (AGNTDEV_BOT_MODULE →
// dist/harness-entry.js). Builds the SAME bot as main.ts but with a dummy
// token, a fresh in-memory store and a fixed admin id — and never calls
// .start(). No top-level side effects: everything happens inside makeBot().

import type { Bot } from "grammy";
import { buildBot, type Ctx } from "./bot.js";
import { defaultFeatures } from "./features.js";
import { Store } from "./store.js";

/** Admin tg_id the harness specs use (send with userId: 9000). */
export const HARNESS_ADMIN_TG_ID = 9000;

export function makeBot(): Bot<Ctx> {
  const store = new Store();
  return buildBot(
    "0:harness-tokenless",
    store,
    { adminTgId: HARNESS_ADMIN_TG_ID, shopTz: "Europe/Moscow", shopAddr: "Тестовая 1" },
    defaultFeatures,
  );
}

export default makeBot;
