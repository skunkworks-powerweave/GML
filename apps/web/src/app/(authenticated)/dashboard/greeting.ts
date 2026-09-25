// The dashboard's time-of-day greeting, by the programme's clock.
//
// It read `new Date().getUTCHours()`. The programme runs in IST (UTC+5:30), so
// every user was told "Late night" from 05:30 to 10:30 and "Good evening"
// after midnight. The zone is named here rather than taken from the server
// process, whose TZ is only IST because docker-compose happens to set it.

export const PROGRAMME_TIME_ZONE = "Asia/Kolkata";

export type GreetingKey = "lateNight" | "morning" | "afternoon" | "evening";

/** The dashboard.* message key for the hour at `now` in `timeZone`. */
export function greetingKey(now: Date, timeZone: string = PROGRAMME_TIME_ZONE): GreetingKey {
  // hourCycle "h23", not hour12:false: some ICU builds print midnight as "24"
  // under hour12:false, which would read as evening.
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  if (h < 5) return "lateNight";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}
