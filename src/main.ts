// Runtime entry (toolkit/templates/Dockerfile CMD ["node","dist/main.js"]).
// BOT_TOKEN is injected at runtime by the deploy container — never baked.

import { buildBot } from "./bot.js";
import { configFromEnv } from "./config.js";
import { defaultFeatures } from "./features.js";
import { Store } from "./store.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("[barberbook] BOT_TOKEN is required");
  process.exit(1);
}

const store = new Store();
const bot = buildBot(token, store, configFromEnv(), defaultFeatures);

console.log("[barberbook] starting long polling");
void bot.start();
