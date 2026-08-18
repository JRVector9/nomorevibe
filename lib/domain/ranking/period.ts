const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SeasonCadence = "weekly" | "monthly";

export type SeasonPeriod = {
  key: string;
  cadence: SeasonCadence;
  startsAt: Date;
  endsAt: Date;
  isTransition: boolean;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function kstCalendarDate(date: Date): Date {
  return new Date(date.getTime() + KST_OFFSET_MS);
}

function instantFromKstCalendar(timestamp: number): Date {
  return new Date(timestamp - KST_OFFSET_MS);
}

function isoWeekKey(date: Date): string {
  const thursday = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const day = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day);

  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${isoYear}-W${pad2(week)}`;
}

function kstDateKey(date: Date): string {
  const shifted = kstCalendarDate(date);
  return [
    shifted.getUTCFullYear(),
    pad2(shifted.getUTCMonth() + 1),
    pad2(shifted.getUTCDate()),
  ].join("");
}

export function periodContaining(now: Date, cadence: SeasonCadence): SeasonPeriod {
  const shifted = kstCalendarDate(now);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();

  if (cadence === "monthly") {
    const start = Date.UTC(year, month, 1);
    const end = Date.UTC(year, month + 1, 1);
    return {
      key: `${year}-${pad2(month + 1)}`,
      cadence,
      startsAt: instantFromKstCalendar(start),
      endsAt: instantFromKstCalendar(end),
      isTransition: false,
    };
  }

  const calendarDay = Date.UTC(year, month, shifted.getUTCDate());
  const weekday = new Date(calendarDay).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const start = calendarDay - daysSinceMonday * DAY_MS;
  const end = start + 7 * DAY_MS;

  return {
    key: isoWeekKey(new Date(start)),
    cadence,
    startsAt: instantFromKstCalendar(start),
    endsAt: instantFromKstCalendar(end),
    isTransition: false,
  };
}

export function nextSeasonPeriod(after: Date, cadence: SeasonCadence): SeasonPeriod {
  const natural = periodContaining(after, cadence);
  if (after.getTime() === natural.startsAt.getTime()) return natural;
  if (after.getTime() >= natural.endsAt.getTime()) {
    throw new Error("Next season must start before the natural period ends");
  }

  return {
    ...natural,
    key: `${natural.key}-transition-${kstDateKey(after)}`,
    startsAt: after,
    isTransition: true,
  };
}
