// Times as the command and the menu bar print them: local wall clock, English month names from a table (no locale API).

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** `limited until 14:05` when the limit ends today (local time), else `limited until 18 Nov 14:05`. */
export function limitedUntil(until: number, now: number): string {
  const d = new Date(until);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return sameDay(d, new Date(now)) ? `limited until ${time}` : `limited until ${d.getDate()} ${MONTH[d.getMonth()]} ${time}`;
}
