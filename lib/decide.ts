import { distanceMiles } from "./geo";
import type { Observation, Site } from "./airnow";
import {
  ACTION_SEVERITY, type Action, type Band, type IntensityId, type Policy, type Rule,
} from "./policy";

export type Confidence = "firm" | "advisory" | "insufficient";

/**
 * Why the hour has no readings, decided by the caller because it needs a clock.
 * Kept separate from "no monitor nearby" on purpose: a missing file is a timing
 * fact about the feed, and reporting it as a gap in the monitor network would
 * misstate the one thing this tool is built to show.
 */
export type FeedStatus = "ok" | "not_yet_observed" | "not_published";

export type MonitorEvidence = {
  siteName: string;
  distanceMiles: number;
  value: number;
  ageMinutes: number;
  used: boolean;
  /** Prose for the audit trail, which has to stand on its own. */
  excluded?: string;
  /** The same fact as a code, for callers that already show distance and age. */
  excludedCode?: "future" | "stale" | "distance";
};

export type Decision = {
  /** null when the evidence cannot support any recommendation. */
  action: Action | null;
  confidence: Confidence;
  /** Range across the monitors actually used. */
  estimate: { value: number; low: number; high: number } | null;
  /** The conservative end of the range, which the band is read from. */
  decidedOnPm25: number | null;
  band: Band | null;
  rule: Rule | null;
  reasons: string[];
  monitors: MonitorEvidence[];
  policyVersion: string;
  at: Date;
};

export type DecideInput = {
  policy: Policy;
  place: { name: string; lat: number; lon: number };
  sites: Site[];
  observations: Observation[];
  at: Date;
  feed: FeedStatus;
  intensity: IntensityId;
  sensitiveAthletes: boolean;
};

function bandFor(policy: Policy, pm25: number): Band {
  for (const b of policy.bands) {
    if (b.maxPm25 === null || pm25 <= b.maxPm25) return b;
  }
  return policy.bands[policy.bands.length - 1];
}

function ruleFor(
  policy: Policy, band: Band, intensity: IntensityId, sensitive: boolean,
): Rule | null {
  for (const r of policy.rules) {
    const bands = Array.isArray(r.band) ? r.band : [r.band];
    if (!bands.includes(band.id)) continue;
    if (r.intensity !== "any" && !r.intensity.includes(intensity)) continue;
    if (r.sensitive !== "any" && r.sensitive !== sensitive) continue;
    return r;
  }
  return null;
}

/**
 * Turns monitor readings into a recommendation, and declines when the readings
 * cannot support one. Pure: no clock, no network.
 *
 * Two deliberate choices:
 *  - The band is read from the HIGH end of the observed range, so the call errs toward caution.
 *  - Distance, reading age and monitor disagreement gate confidence rather than being
 *    reported as footnotes. Colorado has ~32 active PM2.5 monitors, so for much of the
 *    state the honest answer is "we don't know", and the engine says so.
 */
export function decide(input: DecideInput): Decision {
  const { policy, place, sites, observations, at, feed, intensity, sensitiveAthletes } = input;
  const ev = policy.evidence;
  const byKey = new Map(sites.filter((s) => s.active).map((s) => [s.stationKey, s]));

  const monitors: MonitorEvidence[] = [];
  for (const o of observations) {
    const site = byKey.get(o.stationKey);
    if (!site) continue;
    const d = distanceMiles(place, site);
    if (d > ev.searchRadiusMiles) continue;
    const age = Math.round((at.getTime() - o.observedAt.getTime()) / 60000);
    const m: MonitorEvidence = {
      siteName: site.siteName, distanceMiles: Math.round(d * 10) / 10,
      value: o.value, ageMinutes: age, used: true,
    };
    if (age < 0) {
      m.used = false; m.excludedCode = "future";
      m.excluded = "reading is stamped after the decision time";
    } else if (age > ev.maxReadingAgeMinutes) {
      m.used = false; m.excludedCode = "stale";
      m.excluded = `reading is ${age} min old (limit ${ev.maxReadingAgeMinutes})`;
    } else if (d > ev.maxTrustedDistanceMiles) {
      m.used = false; m.excludedCode = "distance";
      m.excluded = `${m.distanceMiles} mi away (limit ${ev.maxTrustedDistanceMiles})`;
    }
    monitors.push(m);
  }
  monitors.sort((a, b) => a.distanceMiles - b.distanceMiles);

  const reasons: string[] = [];
  const used = monitors.filter((m) => m.used);
  const base: Omit<Decision, "action" | "confidence" | "estimate" | "decidedOnPm25" | "band" | "rule"> = {
    reasons, monitors, policyVersion: policy.policyVersion, at,
  };

  const unavailable = { ...base, action: null, confidence: "insufficient" as const, estimate: null, decidedOnPm25: null, band: null, rule: null };

  if (feed === "not_yet_observed") {
    reasons.push("That hour has not happened yet. This tool reports air that monitors have already measured, not a forecast.");
    reasons.push("Check back once the hour has passed, or pick an hour earlier in the day.");
    return unavailable;
  }
  if (feed === "not_published") {
    reasons.push("AirNow has not published this hour yet. Hourly files usually appear about an hour after the hour ends.");
    reasons.push("The monitors near here are reporting; this hour's readings are not out. Use the most recent hour that has them.");
    return unavailable;
  }

  if (used.length === 0) {
    const nearest = monitors[0];
    reasons.push(
      nearest
        ? `No monitor near ${place.name} meets the evidence standard. Nearest is ${nearest.siteName} at ${nearest.distanceMiles} mi — ${nearest.excluded}.`
        : `No PM2.5 monitor within ${ev.searchRadiusMiles} mi of ${place.name}.`,
    );
    reasons.push("This app will not issue a recommendation it cannot support. Treat conditions as unknown and use direct observation.");
    return unavailable;
  }

  // Inverse-distance weighting, floored so a monitor on the doorstep can't dominate absolutely.
  let wsum = 0, vsum = 0;
  for (const m of used) {
    const w = 1 / Math.max(m.distanceMiles, 0.5) ** 2;
    wsum += w; vsum += w * m.value;
  }
  const value = Math.round((vsum / wsum) * 10) / 10;
  const low = Math.min(...used.map((m) => m.value));
  const high = Math.max(...used.map((m) => m.value));
  const spread = high - low;

  let confidence: Confidence = "firm";
  if (used.length === 1) {
    reasons.push(`Single monitor: ${used[0].siteName}, ${used[0].distanceMiles} mi away, reading ${used[0].ageMinutes} min old. No second monitor nearby to cross-check against.`);
  } else {
    reasons.push(`${used.length} monitors within ${ev.maxTrustedDistanceMiles} mi, reading ${low}-${high} ug/m3 (spread ${Math.round(spread * 10) / 10}).`);
    if (spread > ev.maxMonitorSpreadUgM3) {
      confidence = "advisory";
      reasons.push(`Monitors disagree by more than ${ev.maxMonitorSpreadUgM3} ug/m3, so the local value is uncertain.`);
    }
  }
  if (monitors.some((m) => !m.used)) {
    reasons.push(`Excluded: ${monitors.filter((m) => !m.used).map((m) => `${m.siteName} (${m.excluded})`).join("; ")}.`);
  }

  const decidedOnPm25 = high;
  if (used.length > 1 && high !== value) {
    reasons.push(`Decided on ${decidedOnPm25} ug/m3, the high end of the range, so the recommendation errs toward caution.`);
  }

  const band = bandFor(policy, decidedOnPm25);
  const rule = ruleFor(policy, band, intensity, sensitiveAthletes);
  reasons.push(`${decidedOnPm25} ug/m3 falls in the ${band.aqiCategory} band.`);

  if (!rule) {
    reasons.push("No policy rule matched this combination, which is a gap in the policy file rather than a safe condition.");
    return { ...base, action: null, confidence: "insufficient", estimate: { value, low, high }, decidedOnPm25, band, rule: null };
  }

  let action = rule.action;
  reasons.push(`Rule ${rule.id}: ${rule.rationale}`);

  // Never hand back an unqualified green light on evidence we have flagged.
  if (confidence === "advisory" && action === "proceed") {
    action = "proceed_with_precautions";
    reasons.push("Upgraded from 'proceed' to 'proceed with precautions' because the evidence is advisory.");
  }

  return { ...base, action, confidence, estimate: { value, low, high }, decidedOnPm25, band, rule };
}

/**
 * Given decisions for each local hour, find the nearest hour to `targetHour` with a
 * materially better call. Returns null when no hour in the day is better, which is
 * itself the useful answer: on 2021-08-07 Boulder had no clean window after 9am.
 */
export function suggestAlternative(
  hours: { hour: number; decision: Decision }[], targetHour: number,
): { hour: number; decision: Decision } | null {
  const target = hours.find((h) => h.hour === targetHour);
  if (!target?.decision.action) return null;
  const targetSeverity = ACTION_SEVERITY[target.decision.action];
  // Best available call first, then the closest such hour to the one they asked about.
  // Ranking by proximity alone would offer a merely-less-bad hour over a genuinely safe one.
  const better = hours
    .filter((h) => h.decision.action && ACTION_SEVERITY[h.decision.action] < targetSeverity)
    .sort((a, b) =>
      ACTION_SEVERITY[a.decision.action!] - ACTION_SEVERITY[b.decision.action!] ||
      Math.abs(a.hour - targetHour) - Math.abs(b.hour - targetHour));
  return better[0] ?? null;
}
