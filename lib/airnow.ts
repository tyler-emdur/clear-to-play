/**
 * AirNow publishes hourly observation files with no API key and no rate limit:
 *   https://files.airnowtech.org/airnow/<YYYY>/<YYYYMMDD>/HourlyData_<YYYYMMDDHH>.dat
 *   https://files.airnowtech.org/airnow/today/Monitoring_Site_Locations_V2.dat
 * Both are pipe-delimited and stamped in UTC. The keyed airnowapi.org service is
 * the usual choice and returned a 504 on our first call, so we use the files instead.
 * These parsers are pure so they can be tested against saved fixtures.
 */

export type Site = {
  stationKey: string;
  siteName: string;
  lat: number;
  lon: number;
  county: string;
  agency: string;
  active: boolean;
};

export type Observation = {
  stationKey: string;
  siteName: string;
  value: number;
  unit: string;
  observedAt: Date;
};

/** Hourly rows carry a 12-digit id; the site table keys on 9. Compare the tail. */
export const stationKey = (id: string) => id.trim().slice(-9);

export function parseSites(text: string): Site[] {
  const lines = text.split("\n");
  const header = lines[0].replace(/\r$/, "").split("|");
  const ix = Object.fromEntries(header.map((n, i) => [n, i])) as Record<string, number>;
  const out: Site[] = [];
  for (const raw of lines.slice(1)) {
    const p = raw.replace(/\r$/, "").split("|");
    if (p.length < header.length) continue;
    if (p[ix.Parameter] !== "PM2.5") continue;
    const lat = Number(p[ix.Latitude]);
    const lon = Number(p[ix.Longitude]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) continue;
    out.push({
      stationKey: stationKey(p[ix.AQSID]),
      siteName: p[ix.SiteName],
      lat,
      lon,
      county: p[ix.CountyName] ?? "",
      agency: p[ix.AgencyName] ?? "",
      active: p[ix.Status] === "Active",
    });
  }
  return out;
}

/** Row: MM/DD/YY|HH:MM|stationId|siteName|gmtOffset|parameter|unit|value|agency */
export function parseHourly(text: string): Observation[] {
  const out: Observation[] = [];
  for (const raw of text.split("\n")) {
    const p = raw.replace(/\r$/, "").split("|");
    if (p.length < 9 || p[5] !== "PM2.5") continue;
    const value = Number(p[7]);
    if (!Number.isFinite(value)) continue;
    const [mm, dd, yy] = p[0].split("/").map(Number);
    const [hh, mi] = p[1].split(":").map(Number);
    if ([mm, dd, yy, hh, mi].some((n) => !Number.isFinite(n))) continue;
    out.push({
      stationKey: stationKey(p[2]),
      siteName: p[3],
      value,
      unit: p[6],
      observedAt: new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi)),
    });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** URL of the file holding the UTC hour containing `at`. */
export function hourlyUrl(at: Date): string {
  const y = at.getUTCFullYear();
  const stamp = `${y}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  return `https://files.airnowtech.org/airnow/${y}/${stamp}/HourlyData_${stamp}${pad(at.getUTCHours())}.dat`;
}

export const SITES_URL =
  "https://files.airnowtech.org/airnow/today/Monitoring_Site_Locations_V2.dat";

/**
 * Minutes to add to UTC to get wall-clock time in `tz`. Avoids hardcoding -6,
 * which would silently break outside daylight time.
 */
export function tzOffsetMinutes(at: Date, tz = "America/Denver"): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(
    f.formatToParts(at).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((asIfUtc - at.getTime()) / 60000);
}

/** The UTC instant for a given local wall-clock hour in `tz`. */
export function localHourToUtc(
  y: number, m: number, d: number, hour: number, tz = "America/Denver",
): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hour));
  const off = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - off * 60000);
}
