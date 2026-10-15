import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aqiFromPm25, nowcastPm25, truncatePm25, PM25_BREAKPOINTS } from "../lib/aqi";

const FX = join(__dirname, "fixtures");
const pad = (n: number) => String(n).padStart(2, "0");

describe("EPA PM2.5 breakpoints, May 2024 revision", () => {
  it("puts the Good/Moderate boundary at 9.0, not the pre-2024 12.0", () => {
    expect(aqiFromPm25(9.0)).toBe(50);
    expect(aqiFromPm25(9.1)).toBe(51);
    // Under the old table 12.0 was still Good. It is Moderate now.
    expect(PM25_BREAKPOINTS[0].concentrationHigh).toBe(9.0);
    expect(aqiFromPm25(12.0)).toBeGreaterThan(50);
  });

  it("matches the published AQI at every category boundary", () => {
    const boundaries: [number, number][] = [
      [0.0, 0], [9.0, 50], [9.1, 51], [35.4, 100], [35.5, 101],
      [55.4, 150], [55.5, 151], [125.4, 200], [125.5, 201],
      [225.4, 300], [225.5, 301], [325.4, 500],
    ];
    for (const [c, aqi] of boundaries) expect(aqiFromPm25(c)).toBe(aqi);
  });

  it("truncates to 0.1 ug/m3 before the lookup, as EPA specifies", () => {
    expect(truncatePm25(9.09)).toBe(9.0);
    expect(aqiFromPm25(9.09)).toBe(50); // still Good, because it truncates to 9.0
    expect(aqiFromPm25(35.49)).toBe(100);
  });

  it("caps at 500 above the top of the table", () => {
    expect(aqiFromPm25(400)).toBe(500);
  });
});

describe("EPA NowCast", () => {
  it("refuses when fewer than two of the last three hours are present", () => {
    expect(nowcastPm25([50, null, null, 10, 10, 10])).toBeNull();
    expect(nowcastPm25([null, null, null])).toBeNull();
    expect(nowcastPm25([50, 40, null])).not.toBeNull();
  });

  it("returns the flat value when conditions are steady", () => {
    const steady = Array(12).fill(20);
    expect(nowcastPm25(steady)!.concentration).toBeCloseTo(20, 1);
    expect(nowcastPm25(steady)!.weight).toBe(1);
  });

  it("leans on the most recent hour when a plume arrives", () => {
    // Eleven clean hours then a spike: a plain 12-hour mean would hide it.
    const arriving = [120, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    const nc = nowcastPm25(arriving)!;
    const flatMean = arriving.reduce((a, b) => a + b, 0) / arriving.length;
    expect(nc.weight).toBe(0.5); // changing fast, so the floor applies
    expect(nc.concentration).toBeGreaterThan(flatMean);
    expect(nc.concentration).toBeGreaterThan(55); // crosses into Unhealthy
  });

  it("still lags a spike, which is why the engine reads the high end of the range", () => {
    const nc = nowcastPm25([120, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5])!;
    expect(nc.concentration).toBeLessThan(120);
  });
});

/**
 * The real check: this implementation is EPA's algorithm, so it has to
 * reproduce the AQI AirNow itself publishes. Raw hourly concentrations come
 * from HourlyData files and the published AQI from the matching HourlyAQObs
 * files, for every Colorado monitor across ten archived hours.
 */
describe("validated against AirNow's own published AQI", () => {
  type Hourly = Map<string, Map<string, number>>;

  const raw: Hourly = new Map();
  for (const f of readdirSync(FX).filter((f) => f.startsWith("hourly-2024"))) {
    const perStation = new Map<string, number>();
    for (const line of readFileSync(join(FX, f), "utf8").split("\n")) {
      const p = line.split("|");
      if (p.length < 8 || p[5] !== "PM2.5") continue;
      const v = Number(p[7]);
      if (Number.isFinite(v)) perStation.set(p[2], v);
    }
    raw.set(f.slice(7, 17), perStation);
  }

  /** The 12 hourly values ending at `stamp`, most recent first. */
  function seriesFor(station: string, stamp: string): (number | null)[] {
    const y = +stamp.slice(0, 4), mo = +stamp.slice(4, 6);
    const d = +stamp.slice(6, 8), h = +stamp.slice(8, 10);
    return Array.from({ length: 12 }, (_, back) => {
      const t = new Date(Date.UTC(y, mo - 1, d, h - back));
      const s = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}${pad(t.getUTCHours())}`;
      const v = raw.get(s)?.get(station);
      return v === undefined ? null : v;
    });
  }

  const cases: { site: string; station: string; stamp: string; published: number }[] = [];
  for (const f of readdirSync(FX).filter((f) => f.startsWith("aqobs-"))) {
    const stamp = f.slice(6, 16);
    const lines = readFileSync(join(FX, f), "utf8").trim().split("\n").slice(1);
    for (const line of lines) {
      const c = line.split('","').map((s) => s.replace(/^"|"$/g, ""));
      cases.push({ station: c[0], site: c[1], stamp, published: Number(c[4]) });
    }
  }

  it("has a substantial validation set", () => {
    expect(cases.length).toBeGreaterThan(150);
  });

  it("reproduces AirNow's AQI exactly for every monitor and hour", () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const c of cases) {
      const series = seriesFor(c.station, c.stamp);
      if (series.every((v) => v === null)) continue;
      const nc = nowcastPm25(series);
      if (!nc) continue;
      compared++;
      const mine = aqiFromPm25(nc.concentration);
      if (mine !== c.published) {
        mismatches.push(`${c.site} @${c.stamp}: got ${mine}, AirNow published ${c.published}`);
      }
    }
    expect(compared).toBeGreaterThan(150);
    expect(mismatches).toEqual([]);
  });

  it("disagrees with reading the raw hourly value instead, which is the point", () => {
    // Boulder CU at 15:00 UTC on 2024-08-01: raw 75.5, NowCast AQI 152.
    // Treating the raw hour as if it were an AQI concentration gives a different
    // number from the one the state's map shows a coach.
    const series = seriesFor("080131001", "2024080115");
    const nc = nowcastPm25(series)!;
    expect(raw.get("2024080115")!.get("080131001")).toBeCloseTo(75.5, 1);
    expect(aqiFromPm25(nc.concentration)).toBe(152);
    expect(aqiFromPm25(75.5)).not.toBe(152);
  });
});
