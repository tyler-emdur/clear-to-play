import { distanceMiles } from "./geo";
import type { Observation, Site } from "./airnow";
import { aqiFromPm25, nowcastPm25 } from "./aqi";
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
  /** The raw hourly concentration this monitor reported for the decision hour. */
  rawPm25: number;
  /** EPA NowCast concentration over the preceding 12 hours, if computable. */
  nowcastPm25: number | null;
  /** AQI from the NowCast, which is the number CHSAA's guidance is keyed on. */
  aqi: number | null;
  bandId: string | null;
  ageMinutes: number;
  used: boolean;
  /** Prose for the audit trail, which has to stand on its own. */
  excluded?: string;
  /** The same fact as a code, for callers that already show distance and age. */
  excludedCode?: "future" | "stale" | "distance" | "no_nowcast";
};

export type Decision = {
  /** null when the evidence cannot support any recommendation. */
  action: Action | null;
  confidence: Confidence;
  /** The worst AQI the monitors actually measured. Never synthesised. */
  decidedOnAqi: number | null;
  /**
   * Which assessment set the band. A visual range check has no AQI number of
   * its own, so when it governs, the band is reported without inventing one.
   */
  decidedBy: "monitors" | "visual_range";
  /** NowCast concentration behind that AQI, for people who read ug/m3. */
  decidedOnPm25: number | null;
  /** Range of AQI across the monitors actually used. */
  estimate: { low: number; high: number } | null;
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
  /** Observations for the decision hour itself. */
  observations: Observation[];
  /**
   * The 12 hourly concentrations ending at the decision hour, per station key,
   * most recent first, with nulls for missing hours. EPA's NowCast needs the
   * history; without it the AQI cannot be computed the way CHSAA assumes.
   */
  history: Map<string, (number | null)[]>;
  at: Date;
  feed: FeedStatus;
  intensity: IntensityId;
  sensitiveAthletes: boolean;
  /**
   * The band a coach's own visual range check corresponds to, if they did one.
   * CHSAA directs schools to compare it against the AQI and act on the worse
   * of the two assessments.
   */
  visibilityBandId?: string | null;
};

function bandFor(policy: Policy, aqi: number): Band {
  for (const b of policy.bands) {
    if (b.maxAqi === null || aqi <= b.maxAqi) return b;
  }
  return policy.bands[policy.bands.length - 1];
}

function bandRank(policy: Policy, bandId: string): number {
  const i = policy.bands.findIndex((b) => b.id === bandId);
  return i < 0 ? 0 : i;
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
 * Turns monitor readings into a recommendation under CHSAA's published guidance,
 * and declines when the readings cannot support one. Pure: no clock, no network.
 *
 * Four deliberate choices:
 *  - The AQI comes from EPA's NowCast, not from the raw hourly concentration,
 *    because that is the number CHSAA tells schools to look up and the number
 *    the state's own map shows. lib/aqi.ts is checked against AirNow's
 *    published AQI in the test suite.
 *  - Where monitors disagree the call is made on the WORST of them, which is
 *    CHSAA's own instruction for conflicting assessments.
 *  - Distance, reading age and band disagreement gate confidence rather than
 *    being reported as footnotes. Colorado has ~32 regulatory PM2.5 monitors,
 *    so for much of the state the honest answer is "we don't know".
 *  - A visual range check, if the user did one, is a second assessment under
 *    that same worse-of-two rule.
 */
export function decide(input: DecideInput): Decision {
  const {
    policy, place, sites, observations, history, at, feed,
    intensity, sensitiveAthletes, visibilityBandId,
  } = input;
  const ev = policy.evidence;
  const byKey = new Map(sites.filter((s) => s.active).map((s) => [s.stationKey, s]));

  const monitors: MonitorEvidence[] = [];
  for (const o of observations) {
    const site = byKey.get(o.stationKey);
    if (!site) continue;
    const d = distanceMiles(place, site);
    if (d > ev.searchRadiusMiles) continue;
    const age = Math.round((at.getTime() - o.observedAt.getTime()) / 60000);

    const series = history.get(o.stationKey) ?? [o.value];
    const nc = nowcastPm25(series);
    const aqi = nc ? aqiFromPm25(nc.concentration) : null;

    const m: MonitorEvidence = {
      siteName: site.siteName,
      distanceMiles: Math.round(d * 10) / 10,
      rawPm25: o.value,
      nowcastPm25: nc ? nc.concentration : null,
      aqi,
      bandId: aqi === null ? null : bandFor(policy, aqi).id,
      ageMinutes: age,
      used: true,
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
    } else if (aqi === null) {
      m.used = false; m.excludedCode = "no_nowcast";
      m.excluded = "too few of the last 12 hours reported to compute a NowCast";
    }
    monitors.push(m);
  }
  monitors.sort((a, b) => a.distanceMiles - b.distanceMiles);

  const reasons: string[] = [];
  const used = monitors.filter((m) => m.used);
  const base: Omit<Decision, "action" | "confidence" | "estimate" | "decidedOnAqi" | "decidedOnPm25" | "band" | "rule" | "decidedBy"> = {
    reasons, monitors, policyVersion: policy.policyVersion, at,
  };
  const unavailable = {
    ...base, action: null, confidence: "insufficient" as const,
    estimate: null, decidedOnAqi: null, decidedOnPm25: null, band: null, rule: null,
    decidedBy: "monitors" as const,
  };

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

  const aqis = used.map((m) => m.aqi!);
  const low = Math.min(...aqis);
  const high = Math.max(...aqis);

  let confidence: Confidence = "firm";
  if (used.length === 1) {
    const m = used[0];
    reasons.push(`Single monitor: ${m.siteName}, ${m.distanceMiles} mi away, reading ${m.ageMinutes} min old. No second monitor nearby to cross-check against.`);
  } else {
    reasons.push(`${used.length} monitors within ${ev.maxTrustedDistanceMiles} mi, reading AQI ${low}-${high}.`);
  }
  reasons.push("AQI is EPA's NowCast over the last 12 hours, not the single raw hourly reading. That is the number CHSAA's guidance is keyed on and the number the state's map shows.");

  if (monitors.some((m) => !m.used)) {
    reasons.push(`Excluded: ${monitors.filter((m) => !m.used).map((m) => `${m.siteName} (${m.excluded})`).join("; ")}.`);
  }

  // CHSAA: where two assessments conflict, follow the worse one.
  const worst = used.reduce((a, b) => (b.aqi! > a.aqi! ? b : a));
  const decidedOnAqi = worst.aqi!;
  let band = bandFor(policy, decidedOnAqi);
  let decidedBy: "monitors" | "visual_range" = "monitors";

  if (used.length > 1 && band.id !== bandFor(policy, low).id) {
    confidence = "advisory";
    reasons.push(`Monitors disagree about which band applies (${bandFor(policy, low).aqiCategory} to ${band.aqiCategory}). CHSAA directs that the worse assessment is followed, so the call is made on AQI ${decidedOnAqi}.`);
  } else if (used.length > 1 && high !== low) {
    reasons.push(`Decided on AQI ${decidedOnAqi}, the worst of the monitors used, so the call errs toward caution.`);
  }

  // A visual range check is a second assessment under that same rule.
  if (visibilityBandId) {
    const visBand = policy.bands.find((b) => b.id === visibilityBandId);
    if (visBand && bandRank(policy, visBand.id) > bandRank(policy, band.id)) {
      reasons.push(`Your visual range check indicates ${visBand.aqiCategory}, worse than the ${band.aqiCategory} the monitors measured at AQI ${decidedOnAqi}. CHSAA directs you to follow the worse of the two, so the call uses your observation.`);
      band = visBand;
      decidedBy = "visual_range";
      confidence = "advisory";
    } else if (visBand) {
      reasons.push(`Your visual range check indicates ${visBand.aqiCategory}, which agrees with or is better than the monitors. The monitor reading stands.`);
    }
  }

  reasons.push(
    decidedBy === "visual_range"
      ? `The call is made on the ${band.aqiCategory} band, from your visual range check rather than a measured AQI.`
      : `AQI ${decidedOnAqi} falls in the ${band.aqiCategory} band.`,
  );

  const rule = ruleFor(policy, band, intensity, sensitiveAthletes);
  if (!rule) {
    reasons.push("No policy rule matched this combination, which is a gap in the policy file rather than a safe condition.");
    return { ...unavailable, estimate: { low, high }, decidedOnAqi, decidedOnPm25: worst.nowcastPm25, band, decidedBy };
  }

  let action = rule.action;
  reasons.push(`Rule ${rule.id}: ${rule.rationale}`);

  // Never hand back an unqualified green light on evidence we have flagged.
  if (confidence === "advisory" && action === "proceed") {
    action = "proceed_with_precautions";
    reasons.push("Upgraded from 'proceed' to 'proceed with precautions' because the evidence is advisory.");
  }

  return {
    ...base, action, confidence, estimate: { low, high },
    decidedOnAqi, decidedOnPm25: worst.nowcastPm25, band, rule, decidedBy,
  };
}

/**
 * Given decisions for each local hour, find the nearest hour to `targetHour` with a
 * materially better call. Returns null when no hour in the day is better, which is
 * itself the useful answer: on 2024-08-01 Boulder's clear window was behind it by 9am.
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
