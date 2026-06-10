# DESIGN Document

Architecture, command set and conversation flows for the BarberBook Telegram bot.
Satisfies every entity, dependency and feature in `docs/general.md`.

## 1. Architecture

### 1.1 Components

```
┌────────────────────────────────────────────────────────────┐
│                        Telegram Bot                        │
│  long-polling (getUpdates) → Update Router                 │
├──────────────┬──────────────────┬──────────────────────────┤
│ Command      │ Callback         │ Conversation State        │
│ Handlers     │ Handlers         │ Machine (per chat)        │
├──────────────┴──────────────────┴──────────────────────────┤
│                       Service Layer                        │
│  BookingService · ScheduleService · ServiceCatalog ·       │
│  ReminderScheduler · ReportService · UserService           │
├────────────────────────────────────────────────────────────┤
│                       Storage (SQLite)                     │
│  users · services · barber_schedules · appointments ·      │
│  reminders                                                 │
└────────────────────────────────────────────────────────────┘
```

- **Update Router** — dispatches incoming updates: commands (`/...`) to command
  handlers, `callback_query` to callback handlers (by `data` prefix), plain text
  to the active conversation step of that chat.
- **Conversation State Machine** — per-chat finite state stored in memory with
  a DB fallback (`users.conversation_state`), so a restart never strands a user
  mid-flow: unknown state → reset to main menu.
- **Service Layer** — all business rules live here; handlers only parse/render.
- **ReminderScheduler** — a single goroutine ticking every 30s; reads due rows
  from `reminders`, sends the message, marks `sent_at`. The same loop drives
  no-show auto-cancel and the nightly summary (see §4.6–§4.8). Restart-safe:
  schedule lives in the DB, not in timers.
- **Storage** — SQLite (single file, fits the preview deployment). All times
  stored in UTC; rendered in the shop's configured timezone (`SHOP_TZ` env,
  default `Europe/Moscow`).

### 1.2 Data model (maps 1:1 to general.md Core Entities)

| Table | Columns (key ones) |
|---|---|
| `users` | `tg_id` PK, `name`, `phone`, `role` (`client`/`barber`/`admin`), `conversation_state` |
| `services` | `id` PK, `name`, `duration_min`, `price`, `active` |
| `barber_services` | `barber_tg_id` FK, `service_id` FK — which barber offers what |
| `barber_schedules` | `id` PK, `barber_tg_id` FK, `date`, `slot_start`, `slot_len_min`, `free` |
| `appointments` | `id` PK, `client_tg_id` FK, `barber_tg_id` FK, `service_id` FK, `starts_at`, `ends_at`, `status` (`confirmed`/`completed`/`cancelled`/`no_show`) |
| `reminders` | `id` PK, `appointment_id` FK, `fire_at`, `kind` (`pre_visit`/`no_show_check`/`daily_summary`), `sent_at` NULL |

Roles: first `/start` creates a `client`. Barbers/admin are promoted by the
admin (`/addbarber`, see §3). The deploy seeds one admin from `ADMIN_TG_ID` env.

## 2. Roles & entry

`/start` — registers the user (asks for a display name on first contact),
then shows the role-specific main menu as an inline keyboard:

- **Client**: `📅 Записаться` · `📋 Мои записи` · `❌ Отменить запись`
- **Barber**: everything a client sees, plus `🗓 Моё расписание` ·
  `🕐 Задать слоты` · `✅ Отметить визит`
- **Admin**: everything a barber sees, plus `🛠 Услуги` · `👤 Барберы`

## 3. Command set

| Command | Role | Purpose |
|---|---|---|
| `/start` | all | register + main menu |
| `/help` | all | command cheat-sheet for the user's role |
| `/book` | client | start the booking flow (§4.1) |
| `/my` | client | list upcoming appointments (with cancel buttons) |
| `/cancel` | client | cancel an upcoming appointment (§4.3) |
| `/schedule` | barber | today's appointments, ordered by time (§4.4) |
| `/done` | barber | mark an appointment completed (§4.5) |
| `/slots` | barber | set available slots for a date (§4.2) |
| `/services` | admin | manage the service catalog: add / edit / delete (§4.9) |
| `/addbarber` | admin | promote a user to barber & assign services |
| `/report` | barber/admin | yesterday/today summary on demand (same renderer as the nightly one) |

Unknown commands and stray text outside a flow → short hint + main menu.
Every multi-step flow accepts `⬅️ Назад` and `🏠 Меню` buttons at each step.

## 4. Conversation / UX flows

### 4.1 Client books an appointment (`/book` or `📅 Записаться`)

```
/book
 → [inline] choose BARBER          (one button per active barber)
 → [inline] choose SERVICE          (services that barber offers; name + price + duration)
 → [inline] choose DATE             (next 7 days that have ≥1 free slot)
 → [inline] choose TIME SLOT        (free slots of that barber/date, duration-aware:
                                     a 60-min service hides slots that can't fit)
 → confirmation card: barber, service, price, date/time
   [✅ Подтвердить] [⬅️ Назад] [🏠 Меню]
 → on confirm (transactional):
     - re-check the slot is still free (the "two clients race" case → polite
       "слот уже занят" + back to slot list)
     - INSERT appointment status=confirmed; mark schedule slot busy
     - schedule reminders: pre_visit at starts_at−60m, no_show_check at starts_at+15m
     - reply with a receipt card
```

Callback data convention: `bk:<step>:<id>` (e.g. `bk:barber:42`,
`bk:slot:2026-06-12T14:00`), so the router needs no per-chat parsing state for
inline steps.

### 4.2 Barber sets availability (`/slots`)

```
/slots → [inline] choose DATE (today + 13 days)
       → [inline] toggle grid of half-hour slots 09:00–21:00
         (tap = toggle free/busy; busy-by-appointment slots are locked 🔒)
       → [💾 Сохранить] → upsert barber_schedules rows for that date
```

### 4.3 Client cancels (`/cancel` or from `/my`)

List of the client's `confirmed` future appointments as buttons →
tap → confirm dialog → status=`cancelled`, slot freed, pending reminders for
that appointment deleted, barber gets a notification message.

### 4.4 Barber daily view (`/schedule`)

Renders today's (or `/schedule tomorrow`) appointments:
`14:00–15:00 · Стрижка · Иван (+7…) · confirmed`, plus a footer with
totals (count / expected revenue). Each row carries a `[✅ Done]` button (§4.5).

### 4.5 Mark visit done (`/done` or the row button)

`confirmed` → `completed` (sets `completed_at`). Only the owning barber (or
admin) can complete an appointment; completing kills its no-show check.

### 4.6 Automated reminder (System)

`ReminderScheduler` fires `pre_visit` reminders due `now ≥ fire_at`:
sends the client *"Через час: Стрижка у Алексея в 14:00 (адрес из SHOP_ADDR)"*,
marks `sent_at`. At-least-once semantics; `sent_at` makes it idempotent.

### 4.7 No-show auto-cancel (System)

`no_show_check` fires at `starts_at+15m`: if the appointment is still
`confirmed` (barber never pressed Done) → status=`no_show`, slot stays
consumed, client and barber are both notified. The barber message includes
`[↩️ Вернуть]` to undo a mistaken auto-cancel (sets back to `confirmed`).

### 4.8 Daily summary (System)

A `daily_summary` reminder is (re)scheduled for every barber at 21:30 shop
time: appointments served / no-shows / cancellations / revenue for the day.
`/report` renders the same card on demand.

### 4.9 Admin manages services (`/services`)

```
/services → list of services with [✏️][🗑] per row + [➕ Добавить]
  ➕ → text-step flow: name → duration (min) → price → confirm → INSERT
  ✏️ → same flow pre-filled → UPDATE
  🗑 → confirm → soft-delete (active=false; history keeps the FK)
```

`/addbarber` → admin forwards any message from the user or enters their
@username/tg_id → choose services the barber offers (multi-toggle) → promote.

## 5. Edge cases & rules

- **Slot races** — booking re-validates the slot inside a transaction (§4.1).
- **Overlap guard** — a slot is bookable only if `starts_at + service.duration`
  fits in contiguous free slots of that barber.
- **Timezone** — all storage UTC, all rendering in `SHOP_TZ`; reminder math in
  UTC so DST shifts can't double-fire.
- **Restart safety** — reminders/no-show checks/summaries are DB rows, not
  in-memory timers; conversation state degrades to the main menu.
- **Cancelled/no-show slots** — a client-cancelled slot is freed; a no-show
  slot is not (the time has already passed by then).

## 6. Non-goals (inherited from general.md)

No payments, no multi-location, no ratings, no social sharing, no voice.
"Confirm appointment with payment (optional)" from the feature list is
implemented as a plain confirmation step — payment itself stays out of scope.
