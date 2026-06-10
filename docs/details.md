# DETAILS Specification

Concrete per-command behaviour for the BarberBook bot. Refines `docs/design.md`;
every command/flow here is the contract the Dev tasks implement and the Tests
phase writes specs against.

Conventions used below:
- **State** — the per-chat conversation state (`users.conversation_state`),
  reset to `menu` on `/start`, `🏠 Меню`, or any unknown state.
- **CB** — inline-button callback data.
- All times rendered in `SHOP_TZ` (env, default `Europe/Moscow`); stored UTC.
- Every reply that is part of a flow carries `⬅️ Назад` and `🏠 Меню` buttons
  unless stated otherwise.

## 1. /start — registration & main menu

1. Upsert `users` row by `tg_id`.
2. First contact (no `name`): ask "Как вас зовут?" → State `reg:name` →
   any text 1–64 chars is accepted as the display name; longer → re-ask.
3. Reply "Привет, {name}!" + role menu:
   - client: `📅 Записаться` (CB `menu:book`) · `📋 Мои записи` (CB `menu:my`)
     · `❌ Отменить запись` (CB `menu:cancel`)
   - barber adds: `🗓 Моё расписание` (CB `menu:sched`) · `🕐 Задать слоты`
     (CB `menu:slots`) · `✅ Отметить визит` (CB `menu:done`)
   - admin adds: `🛠 Услуги` (CB `menu:svc`) · `👤 Барберы` (CB `menu:barbers`)
4. The user whose `tg_id == ADMIN_TG_ID` (env) is auto-promoted to `admin` on
   first /start.

## 2. /book — client booking flow

Entry: `/book` or CB `menu:book`. State machine, all steps inline-driven:

1. **Barber** — one button per user with role=`barber` that has ≥1 assigned
   active service. None exist → "Пока нет доступных мастеров" + menu.
   CB `bk:barber:<tg_id>`.
2. **Service** — services assigned to that barber: `{name} · {price}₽ ·
   {duration} мин`. CB `bk:svc:<service_id>`.
3. **Date** — the next 7 calendar days that contain ≥1 bookable window for
   (barber, service.duration). Label `Чт 12.06`. CB `bk:date:<YYYY-MM-DD>`.
4. **Slot** — bookable start times for that date. A start time T is bookable
   iff every half-hour slot in `[T, T+duration)` is `free=true` and not in the
   past. CB `bk:slot:<RFC3339>`.
5. **Confirm** — card: `{barber} · {service} · {price}₽ · {date} {time}` with
   `✅ Подтвердить` (CB `bk:ok`).
6. **On confirm**, in ONE transaction:
   - re-validate every covered slot is still free; if not → answerCallbackQuery
     "Слот уже занят 😔" and re-render step 4 with fresh slots;
   - insert `appointments` (status `confirmed`, `ends_at = starts_at + duration`);
   - mark covered schedule slots `free=false`;
   - insert reminders: `pre_visit` at `starts_at − 60m` (only if that instant is
     still in the future), `no_show_check` at `starts_at + 15m`.
   - Reply receipt: "Записал: {service} у {barber}, {date} в {time}. Напомню за
     час до визита." (no Назад button; menu only).

## 3. /my — client's upcoming appointments

Lists `confirmed` appointments with `starts_at > now`, ordered ascending, each
as `{date} {time} · {service} · {barber}` with a `❌` button
(CB `cx:<appointment_id>`). Empty → "У вас нет предстоящих записей".

## 4. /cancel — client cancels

Entry: `/cancel`, CB `menu:cancel`, or `❌` from /my.
1. Same list as /my; tap → confirm dialog "Отменить {service} {date} {time}?"
   `[Да, отменить]` (CB `cx:yes:<id>`) / `[Нет]`.
2. On yes, in one transaction: status → `cancelled`; covered slots `free=true`;
   delete unsent reminders of the appointment.
3. Notify the barber: "❌ Отмена: {date} {time} {service}, клиент {name}".
4. Only the owning client can cancel; a foreign/raced id → "Запись не найдена".
   Already-started appointments are not listed and not cancellable.

## 5. /slots — barber sets availability

Entry: `/slots` or CB `menu:slots`. Role gate: barber/admin, else "Команда
доступна только мастерам".
1. **Date** — buttons for today + 13 days. CB `sl:date:<YYYY-MM-DD>`.
2. **Grid** — half-hour slots `09:00`–`20:30` rendered as a toggle grid:
   `🟢 14:00` free / `⚪ 14:30` off / `🔒 15:00` covered by a confirmed
   appointment (not toggleable). Tap toggles 🟢/⚪ in place
   (editMessageReplyMarkup). CB `sl:t:<HH:MM>`.
3. `💾 Сохранить` (CB `sl:save`) → upsert `barber_schedules` rows for that
   date; off slots that had no appointment are deleted. Reply "Слоты на
   {date} сохранены: {n} окон".

## 6. /schedule — barber's day view

Entry: `/schedule` (today), `/schedule tomorrow`, or CB `menu:sched`.
Role gate as §5. Renders appointments of that day ordered by time:
`14:00–15:00 · Стрижка · Иван · confirmed` with `[✅ Done]`
(CB `dn:<appointment_id>`) per `confirmed` row; `completed` rows render with
✔️ and no button. Footer: `Всего: {n} · Выручка (ожид.): {sum}₽`.
Empty day → "На {date} записей нет".

## 7. /done — mark visit completed

Entry: `/done` (lists today's `confirmed` appointments as buttons) or the
`[✅ Done]` button. Gate: the appointment's barber or an admin.
Effect: status `confirmed → completed`, delete its unsent `no_show_check`,
reply "✅ Готово: {time} {service} — {client}". Completing a non-`confirmed`
appointment → answerCallbackQuery "Уже обработана".

## 8. Reminders (system, no command)

`ReminderScheduler` ticks every 30s, takes due unsent rows (`fire_at ≤ now`,
`sent_at IS NULL`) in one batch:
- `pre_visit` → client: "⏰ Через час: {service} у {barber} в {time}.
  {SHOP_ADDR}". Skipped (marked sent, not delivered) if the appointment is no
  longer `confirmed`.
- `no_show_check` → if the appointment is still `confirmed`: status →
  `no_show`; client gets "Запись отменена: вы не пришли"; barber gets
  "🚫 Не пришёл: {time} {service} — {client}" with `[↩️ Вернуть]`
  (CB `ns:undo:<id>` → back to `confirmed`, only while the day isn't over).
  Slots are NOT freed (the time has passed).
- `daily_summary` → see §9. After send, the next day's summary row is inserted.
Every send marks `sent_at` first-write-wins; a crashed tick re-sends nothing.

## 9. /report + nightly summary

`/report` (barber/admin) renders for today; the scheduler sends the same card
at 21:30 shop time to every barber with ≥1 appointment that day:
`📊 {date}: выполнено {a} · не пришли {b} · отменено {c} · выручка {sum}₽`
(revenue counts `completed` only).

## 10. /services — admin service management

Entry: `/services` or CB `menu:svc`. Gate: admin only.
- List: `{name} · {price}₽ · {duration} мин` + `✏️` (CB `sv:e:<id>`),
  `🗑` (CB `sv:d:<id>`), footer `➕ Добавить` (CB `sv:add`).
- **Add**: text steps — name (1–100 chars) → duration in minutes (integer
  15–480, must be a multiple of 30; else re-ask) → price (integer 0–1 000 000)
  → confirm card → insert `active=true`.
- **Edit**: same steps pre-filled, Enter/«-» keeps the old value → update.
- **Delete**: confirm → `active=false` (soft; history and FKs survive). The
  service disappears from booking and from barbers' assignable lists.

## 11. /addbarber — admin promotes a barber

1. Admin sends `@username` or a forwarded message from the target user; the
   user must have /start-ed before (else "Пользователь ещё не открывал бота").
2. Role → `barber`; then a multi-toggle list of active services
   (CB `ab:t:<service_id>`, `💾 Готово`) fills `barber_services`.
3. The new barber gets "Вы добавлены как мастер. /slots — задать рабочие окна".
Re-running on an existing barber edits their service set.

## 12. /help

Static per-role command list (client/barber/admin variants) — one message,
menu button only.

## 13. Fallbacks & errors

- Unknown command → "Не понял. /help — список команд" + role menu.
- Stray text with State `menu` → same as unknown command.
- Callback for a stale message (state mismatch / entity gone) →
  answerCallbackQuery "Устарело, начните заново" + role menu.
- Any handler error → log, generic "Что-то пошло не так, попробуйте ещё раз";
  state resets to `menu`. The update loop never crashes on a single update.
