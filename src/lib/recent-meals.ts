/** Helpers for the optional "what did you eat recently?" opener (pure, testable). */
import type { ConfirmedMeal } from "@/engine";

export type WhenChoice = "earlier_today" | "last_night" | "yesterday" | "two_days_ago";

export const WHEN_LABELS: Record<WhenChoice, string> = {
  earlier_today: "Earlier today",
  last_night: "Last night",
  yesterday: "Yesterday lunch",
  two_days_ago: "2 days ago",
};

/** Approximate local time for a recalled meal. Never in the future. */
export function whenToIso(choice: WhenChoice, now: Date): string {
  const at = (daysAgo: number, h: number, m: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d;
  };
  let d: Date;
  switch (choice) {
    case "earlier_today":
      d = new Date(now.getTime() - 3 * 3_600_000);
      break;
    case "last_night":
      d = at(1, 19, 30);
      break;
    case "yesterday":
      d = at(1, 12, 30);
      break;
    case "two_days_ago":
      d = at(2, 12, 30);
      break;
  }
  if (d.getTime() > now.getTime()) d = new Date(now.getTime() - 3_600_000);
  return d.toISOString();
}

/** Confirmed meals in the last `days`, newest first. */
export function recentMeals(meals: ConfirmedMeal[], now: Date, days = 3): ConfirmedMeal[] {
  const cutoff = now.getTime() - days * 24 * 3_600_000;
  return meals
    .filter((m) => m.confirmed && Date.parse(m.consumedAt) >= cutoff && Date.parse(m.consumedAt) <= now.getTime() + 60_000)
    .sort((a, b) => b.consumedAt.localeCompare(a.consumedAt));
}

/** "Today, 1:30 PM" / "Yesterday" / "Mon" style label. */
export function relativeWhen(iso: string, now: Date, approx = false): string {
  const d = new Date(iso);
  const dayDiff = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  const part = d.getHours() >= 17 ? "evening" : d.getHours() >= 11 ? "lunch" : "morning";
  if (dayDiff <= 0) return approx ? "Earlier today" : `Today ${part}`;
  if (dayDiff === 1) return `Yesterday ${part}`;
  return `${dayDiff} days ago`;
}
