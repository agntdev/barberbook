// Storage layer. Mirrors the schema in docs/design.md §1.2 / docs/details.md.
// The engine is in-memory (the toolkit's blessed default persistence — swap
// point for SQLite/Redis is this one class; the handler code only sees the
// query methods). All times are stored as UTC epoch millis.

export type Role = "client" | "barber" | "admin";

export type ConversationState =
  | "menu"
  | "reg:name"
  | string; // feature flows register their own states (e.g. "svc:add:name")

export interface User {
  tgId: number;
  name: string | null;
  /** Telegram @username (without @), captured on contact — /addbarber resolves it. */
  username: string | null;
  role: Role;
  state: ConversationState;
}

export interface Service {
  id: number;
  name: string;
  durationMin: number;
  price: number;
  active: boolean;
}

/** One half-hour availability window of a barber. */
export interface ScheduleSlot {
  id: number;
  barberTgId: number;
  date: string; // YYYY-MM-DD in shop TZ
  startMin: number; // minutes from local midnight (e.g. 540 = 09:00)
  free: boolean;
}

export type AppointmentStatus = "confirmed" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: number;
  clientTgId: number;
  barberTgId: number;
  serviceId: number;
  startsAt: number; // UTC ms
  endsAt: number; // UTC ms
  status: AppointmentStatus;
}

export type ReminderKind = "pre_visit" | "no_show_check" | "daily_summary";

export interface Reminder {
  id: number;
  appointmentId: number | null; // null for daily_summary (barber-wide)
  barberTgId: number | null;
  fireAt: number; // UTC ms
  kind: ReminderKind;
  sentAt: number | null;
}

export class Store {
  private seq = 0;
  readonly users = new Map<number, User>();
  readonly services = new Map<number, Service>();
  /** barberTgId → set of serviceIds the barber offers. */
  readonly barberServices = new Map<number, Set<number>>();
  readonly slots = new Map<number, ScheduleSlot>();
  readonly appointments = new Map<number, Appointment>();
  readonly reminders = new Map<number, Reminder>();

  nextId(): number {
    return ++this.seq;
  }

  // ── users ──
  upsertUser(tgId: number, username?: string | null): User {
    let u = this.users.get(tgId);
    if (!u) {
      u = { tgId, name: null, username: null, role: "client", state: "menu" };
      this.users.set(tgId, u);
    }
    if (username !== undefined && username !== null) u.username = username;
    return u;
  }

  barbers(): User[] {
    return [...this.users.values()].filter((u) => u.role === "barber" || u.role === "admin");
  }

  // ── services ──
  activeServices(): Service[] {
    return [...this.services.values()].filter((s) => s.active).sort((a, b) => a.id - b.id);
  }

  servicesOf(barberTgId: number): Service[] {
    const ids = this.barberServices.get(barberTgId);
    if (!ids) return [];
    return this.activeServices().filter((s) => ids.has(s.id));
  }

  /** Barbers that can actually be booked (≥1 assigned active service). */
  bookableBarbers(): User[] {
    return this.barbers().filter((b) => this.servicesOf(b.tgId).length > 0);
  }

  // ── schedule slots ──
  slotsFor(barberTgId: number, date: string): ScheduleSlot[] {
    return [...this.slots.values()]
      .filter((s) => s.barberTgId === barberTgId && s.date === date)
      .sort((a, b) => a.startMin - b.startMin);
  }

  // ── appointments ──
  appointmentsOfClient(clientTgId: number): Appointment[] {
    return [...this.appointments.values()]
      .filter((a) => a.clientTgId === clientTgId)
      .sort((a, b) => a.startsAt - b.startsAt);
  }

  appointmentsOfBarberBetween(barberTgId: number, fromMs: number, toMs: number): Appointment[] {
    return [...this.appointments.values()]
      .filter((a) => a.barberTgId === barberTgId && a.startsAt >= fromMs && a.startsAt < toMs)
      .sort((a, b) => a.startsAt - b.startsAt);
  }

  // ── reminders ──
  dueReminders(nowMs: number): Reminder[] {
    return [...this.reminders.values()]
      .filter((r) => r.sentAt === null && r.fireAt <= nowMs)
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  unsentRemindersOf(appointmentId: number): Reminder[] {
    return [...this.reminders.values()].filter(
      (r) => r.appointmentId === appointmentId && r.sentAt === null,
    );
  }
}
