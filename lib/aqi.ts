/**
 * EPA's Air Quality Index for PM2.5, and the NowCast that feeds it.
 *
 * Why this file exists: CHSAA's guidance for school athletic activities is keyed
 * on AQI, and the AQI a coach looks up is computed from the NowCast, not from a
 * single raw hourly concentration. Reading raw hourly values against the AQI
 * breakpoints -- which are defined on a 24-hour average -- overstates a rising
 * hour and understates a falling one, and produces a number that disagrees with
 * the state's own map. So the engine converts to NowCast AQI first.
 *
 * Both algorithms are EPA's, not ours. The test suite checks this implementation
 * against AirNow's own published PM25_AQI for archived site-hours.
 */

/** Breakpoint table, EPA's May 2024 revision (the Good band moved 12.0 -> 9.0). */
export type Breakpoint = {
  concentrationLow: number;
  concentrationHigh: number;
  aqiLow: number;
  aqiHigh: number;
  category: string;
  /** Stable id used by the policy file to name a band. */
  id: string;
};

export const PM25_BREAKPOINTS: Breakpoint[] = [
  { id: "good", category: "Good", concentrationLow: 0.0, concentrationHigh: 9.0, aqiLow: 0, aqiHigh: 50 },
  { id: "moderate", category: "Moderate", concentrationLow: 9.1, concentrationHigh: 35.4, aqiLow: 51, aqiHigh: 100 },
  { id: "usg", category: "Unhealthy for Sensitive Groups", concentrationLow: 35.5, concentrationHigh: 55.4, aqiLow: 101, aqiHigh: 150 },
  { id: "unhealthy", category: "Unhealthy", concentrationLow: 55.5, concentrationHigh: 125.4, aqiLow: 151, aqiHigh: 200 },
  { id: "very-unhealthy", category: "Very Unhealthy", concentrationLow: 125.5, concentrationHigh: 225.4, aqiLow: 201, aqiHigh: 300 },
  { id: "hazardous", category: "Hazardous", concentrationLow: 225.5, concentrationHigh: 325.4, aqiLow: 301, aqiHigh: 500 },
];

/** PM2.5 concentrations are truncated to 0.1 ug/m3 before the AQI lookup. */
export function truncatePm25(value: number): number {
  return Math.floor(value * 10) / 10;
}

/**
 * AQI for a PM2.5 concentration, by EPA's piecewise linear formula. The input
 * should already be a NowCast concentration for a real-time reading.
 * Above the top of the table the AQI is reported as 500, EPA's ceiling.
 */
export function aqiFromPm25(concentration: number): number {
  const c = truncatePm25(Math.max(concentration, 0));
  const bp = PM25_BREAKPOINTS.find((b) => c <= b.concentrationHigh);
  if (!bp) return 500;
  const span = bp.concentrationHigh - bp.concentrationLow;
  if (span <= 0) return bp.aqiHigh;
  const ratio = (c - bp.concentrationLow) / span;
  return Math.round(bp.aqiLow + ratio * (bp.aqiHigh - bp.aqiLow));
}

/** The breakpoint row an AQI value falls in. */
export function breakpointForAqi(aqi: number): Breakpoint {
  return (
    PM25_BREAKPOINTS.find((b) => aqi <= b.aqiHigh) ??
    PM25_BREAKPOINTS[PM25_BREAKPOINTS.length - 1]
  );
}

export type NowcastResult = {
  /** NowCast concentration, truncated to 0.1 ug/m3 as EPA specifies. */
  concentration: number;
  /** Weight factor actually used; 0.5 means conditions were changing fast. */
  weight: number;
  /** How many of the 12 hourly slots held a reading. */
  hoursUsed: number;
};

/**
 * EPA's NowCast for PM2.5.
 *
 * `series[0]` is the hour being reported and `series[11]` is eleven hours
 * earlier; missing hours are null. EPA requires at least two of the three most
 * recent hours to be present, otherwise no NowCast is reported at all -- which
 * is a refusal this app already knows how to express.
 *
 * The weight factor is 1 minus the rate of change across the window, floored at
 * 0.5. A fast-changing window therefore leans hard on the most recent hour,
 * which is exactly the smoke case: when a plume arrives the NowCast climbs
 * quickly rather than being held down by eleven clean hours.
 */
export function nowcastPm25(series: (number | null)[]): NowcastResult | null {
  const window = series.slice(0, 12);
  const recentThree = window.slice(0, 3).filter((v) => v !== null);
  if (recentThree.length < 2) return null;

  const present = window.filter((v): v is number => v !== null).map((v) => Math.max(v, 0));
  if (present.length === 0) return null;

  const max = Math.max(...present);
  const min = Math.min(...present);
  // A flat window of zeros has no rate of change to measure.
  const rateOfChange = max > 0 ? (max - min) / max : 0;
  const weight = Math.max(1 - rateOfChange, 0.5);

  let weighted = 0;
  let weights = 0;
  let hoursUsed = 0;
  for (let i = 0; i < window.length; i++) {
    const v = window[i];
    if (v === null) continue;
    const w = weight ** i;
    weighted += Math.max(v, 0) * w;
    weights += w;
    hoursUsed++;
  }
  if (weights === 0) return null;

  return { concentration: truncatePm25(weighted / weights), weight, hoursUsed };
}
