// Role main menus + /help texts (docs/details.md §1, §12).

import { inlineButton, inlineKeyboard, type InlineKeyboardMarkup } from "@agntdev/bot-toolkit";
import type { Role } from "./store.js";

export function mainMenu(role: Role): InlineKeyboardMarkup {
  const rows = [
    [inlineButton("📅 Записаться", "menu:book")],
    [inlineButton("📋 Мои записи", "menu:my"), inlineButton("❌ Отменить запись", "menu:cancel")],
  ];
  if (role === "barber" || role === "admin") {
    rows.push([inlineButton("🗓 Моё расписание", "menu:sched"), inlineButton("🕐 Задать слоты", "menu:slots")]);
    rows.push([inlineButton("✅ Отметить визит", "menu:done")]);
  }
  if (role === "admin") {
    rows.push([inlineButton("🛠 Услуги", "menu:svc"), inlineButton("👤 Барберы", "menu:barbers")]);
  }
  return inlineKeyboard(rows);
}

/** `⬅️ Назад` + `🏠 Меню` row appended to every in-flow step (details.md conventions). */
export function navRow(backData: string): [ReturnType<typeof inlineButton>, ReturnType<typeof inlineButton>] {
  return [inlineButton("⬅️ Назад", backData), inlineButton("🏠 Меню", "menu:home")];
}

const clientHelp = [
  "/book — записаться к мастеру",
  "/my — мои предстоящие записи",
  "/cancel — отменить запись",
  "/help — эта справка",
];

const barberHelp = [
  "/schedule — записи на день",
  "/done — отметить визит выполненным",
  "/slots — задать рабочие окна",
  "/report — сводка за день",
];

const adminHelp = ["/services — управление услугами", "/addbarber — добавить мастера"];

export function helpText(role: Role): string {
  const lines = ["Команды:", ...clientHelp];
  if (role === "barber" || role === "admin") lines.push("", "Для мастеров:", ...barberHelp);
  if (role === "admin") lines.push("", "Для администратора:", ...adminHelp);
  return lines.join("\n");
}
