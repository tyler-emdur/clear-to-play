import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import policyJson from "../policy/chsaa-colorado.json";
import { localHourToUtc, parseHourly, parseSites, type Observation } from "../lib/airnow";
import { decide, suggestAlternative, type Decision } from "../lib/decide";
import { ACTION_SEVERITY, type IntensityId, type Policy } from "../lib/policy";

const policy = policyJson as unknown as Policy;
const FX = join(__dirname, "fixtures");
const pad = (n: number) => String(n).padStart(2, "0");

const sites = parseSites(readFileSync(join(FX, "sites-co.dat"), "utf8"));

const stampFor = (at: Date) =>
  `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}`;

function hourlyAt(at: Date): Observation[] | null {
  try {
    return parseHourly(readFileSync(join(FX, `hourly-${stampFor(at)}.dat`), "utf8"));
  } catch {
    return null;
  }
}

/** Observations for the UTC hour that contains the given Boulder-local hour. */
function obsForLocalHour(
  hour: number, y = 2021, m = 8, d = 7,
): { at: Date; observations: Observation[] } {
  const at = localHourToUtc(y, m, d, hour);
  return { at, observations: hourlyAt(at) ?? [] };
}

/**
 * The 12 hourly concentrations per station ending at `at`, newest first, which
 * is what EPA's NowCast needs. Hours with no fixture come back as null, exactly
 * as a gap in the live feed would.
 */
function historyAt(at: Date): Map<string, (number | null)[]> {
  const slots = Array.from({ length: 12 }, (_, back) =>
    hourlyAt(new Date(at.getTime() - back * 3600_000)));
  const stations = new Set<string>();
  for (const slot of slots) for (const o of slot ?? []) stations.add(o.stationKey);
  const out = new Map<string, (number | null)[]>();
  for (const key of stations) {
    out.set(key, slots.map((slot) => slot?.find((o) => o.stationKey === key)?.value ?? null));
  }
  return out;
}

function callAt(
  place: { name: string; lat: number; lon: number },
  at: Date, observations: Observation[],
  intensity: IntensityId, sensitiveAthletes: boolean,
  visibilityBandId: string | null = null,
): Decision {
  return decide({
    policy, place, sites, observations, history: historyAt(at), at,
    feed: "ok", intensity, sensitiveAthletes, visibilityBandId,
  });
}

function call(
  place: { name: string; lat: number; lon: number }, hour: number,
  intensity: IntensityId = "vigorous", sensitiveAthletes = false,
): Decision {
  const { at, observations } = obsForLocalHour(hour);
  return callAt(place, at, observations, intensity, sensitiveAthletes);
}

/** The day the app replays: Thu Aug 1 2024, the Front Range's worst recent smoke morning. */
function aug2024(
  place: { name: string; lat: number; lon: number }, hour: number,
  intensity: IntensityId = "vigorous", sensitiveAthletes = false,
  visibilityBandId: string | null = null,
): Decision {
  const { at, observations } = obsForLocalHour(hour, 2024, 8, 1);
  return callAt(place, at, observations, intensity, sensitiveAthletes, visibilityBandId);
}

const BOULDER_HIGH = { name: "Boulder High School", lat: 40.0150, lon: -105.2797 };
const CENTENNIAL_FC = { name: "Centennial HS (Fort Collins)", lat: 40.5721, lon: -105.0783 };
const NEDERLAND = { name: "Nederland Middle/Senior High", lat: 39.9614, lon: -105.5108 };

describe("fixtures", () => {
  it("loads Colorado sites and a full local day of observations", () => {
    expect(sites.length).toBeGreaterThan(30);
    expect(sites.some((s) => s.siteName.includes("Boulder - CU"))).toBe(true);
    for (let h = 0; h < 24; h++) {
      expect(obsForLocalHour(h).observations.length).toBeGreaterThan(10);
    }
  });
});

describe("Boulder High, Saturday Aug 7 2021 — a real smoke day", () => {
  it("cancels a 4pm hard practice", () => {
    const d = call(BOULDER_HIGH, 16, "vigorous");
    expect(d.action).toBe("cancel");
    expect(d.confidence).toBe("firm");
    expect(d.decidedOnAqi).toBe(166);
    expect(d.decidedOnPm25).toBeCloseTo(76.5, 1);
    expect(d.band?.aqiCategory).toBe("Unhealthy");
    expect(d.rule?.id).toBe("unhealthy-all");
    expect(d.monitors[0].siteName).toContain("Boulder - CU");
    expect(d.monitors[0].distanceMiles).toBeLessThan(1);
  });

  it("allows the same practice at 7am, nine hours earlier", () => {
    const d = call(BOULDER_HIGH, 7, "vigorous");
    expect(d.decidedOnAqi).toBe(76);
    expect(d.band?.aqiCategory).toBe("Moderate");
    expect(d.action).toBe("proceed");
  });

  it("restricts an asthmatic athlete at 7am where a healthy one may proceed", () => {
    const healthy = call(BOULDER_HIGH, 7, "vigorous", false);
    const sensitive = call(BOULDER_HIGH, 7, "vigorous", true);
    expect(ACTION_SEVERITY[sensitive.action!]).toBeGreaterThan(ACTION_SEVERITY[healthy.action!]);
    // CHSAA's Moderate row only asks for watching and extra rest, so the
    // difference is precautions rather than a restriction.
    expect(healthy.action).toBe("proceed");
    expect(sensitive.action).toBe("proceed_with_precautions");
    expect(sensitive.rule?.id).toBe("moderate-sensitive");
  });

  it("separates hard from light work in the band where CHSAA does", () => {
    // Aug 1 2024, 8am: AQI 105, Unhealthy for Sensitive Groups. CHSAA limits
    // athletes to light outdoor activity here, so a session already at that
    // level continues while a hard one has to come down.
    const vigorous = aug2024(BOULDER_HIGH, 8, "vigorous");
    const light = aug2024(BOULDER_HIGH, 8, "light");
    expect(vigorous.band?.aqiCategory).toBe("Unhealthy for Sensitive Groups");
    expect(vigorous.action).toBe("reduce_intensity");
    expect(vigorous.rule?.id).toBe("usg-active");
    expect(light.action).toBe("proceed_with_precautions");
    expect(light.rule?.id).toBe("usg-light");
    expect(ACTION_SEVERITY[vigorous.action!]).toBeGreaterThan(ACTION_SEVERITY[light.action!]);
  });

  it("offers the best window of the day, not merely a less bad one", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, decision: call(BOULDER_HIGH, hour, "vigorous") }));
    const alt = suggestAlternative(hours, 16);
    expect(alt).not.toBeNull();
    // 8pm was less severe than 4pm but still Unhealthy-for-Sensitive-Groups. The morning
    // was genuinely clear, so the engine must reach past the closer, worse option.
    expect(alt!.decision.action).toBe("proceed");
    expect(alt!.hour).toBe(9);
    // Every hour from 11am to midnight stayed at or above the sensitive-groups band.
    const afternoonOnward = hours.filter((h) => h.hour >= 11);
    expect(afternoonOnward.every((h) => h.decision.decidedOnAqi! > 100)).toBe(true);
  });
});

describe("the same day 40 miles north, the right answer inverts", () => {
  it("is worse in the morning in Fort Collins and worse in the afternoon in Boulder", () => {
    const fcMorning = call(CENTENNIAL_FC, 7, "vigorous");
    const fcAfternoon = call(CENTENNIAL_FC, 16, "vigorous");
    const bMorning = call(BOULDER_HIGH, 7, "vigorous");
    const bAfternoon = call(BOULDER_HIGH, 16, "vigorous");

    expect(fcMorning.decidedOnAqi!).toBeGreaterThan(fcAfternoon.decidedOnAqi!);
    expect(bAfternoon.decidedOnAqi!).toBeGreaterThan(bMorning.decidedOnAqi!);

    // The naive heuristic "move practice earlier" is correct in Boulder and wrong in Fort Collins.
    expect(ACTION_SEVERITY[fcMorning.action!]).toBeGreaterThan(ACTION_SEVERITY[fcAfternoon.action!]);
    expect(ACTION_SEVERITY[bMorning.action!]).toBeLessThan(ACTION_SEVERITY[bAfternoon.action!]);
  });
});

describe("the engine declines when the evidence cannot carry a recommendation", () => {
  it("refuses for Nederland, 13 miles from the nearest monitor", () => {
    const d = call(NEDERLAND, 16, "vigorous");
    expect(d.action).toBeNull();
    expect(d.confidence).toBe("insufficient");
    expect(d.monitors[0].excluded).toMatch(/limit 10/);
    expect(d.reasons.join(" ")).toMatch(/will not issue a recommendation/);
  });

  it("refuses where there is no monitor at all", () => {
    const d = call({ name: "Middle Park HS", lat: 40.0869, lon: -105.9372 }, 16);
    expect(d.action).toBeNull();
    expect(d.monitors).toHaveLength(0);
    expect(d.reasons.join(" ")).toMatch(/No PM2.5 monitor within/);
  });

  it("refuses on stale readings", () => {
    const { observations } = obsForLocalHour(16);
    const fiveHoursLater = new Date(localHourToUtc(2021, 8, 7, 16).getTime() + 5 * 3600_000);
    const d = decide({
      policy, place: BOULDER_HIGH, sites, observations,
      history: historyAt(fiveHoursLater), at: fiveHoursLater, feed: "ok",
      intensity: "vigorous", sensitiveAthletes: false,
    });
    expect(d.action).toBeNull();
    expect(d.monitors[0].excluded).toMatch(/min old/);
  });

  it("drops to advisory and withholds a green light when monitors disagree", () => {
    const { at, observations } = obsForLocalHour(0); // Boulder CU 9.7 — a Moderate, proceed hour
    const clean = decide({ policy, place: BOULDER_HIGH, sites, observations, history: historyAt(at), at, feed: "ok", intensity: "light", sensitiveAthletes: false });
    expect(clean.action).toBe("proceed");

    const boulderCu = sites.find((s) => s.siteName.includes("Boulder - CU"))!;
    const disagreeing = [
      ...observations,
      { stationKey: "999999999", siteName: "Synthetic co-located sensor", value: 40.0, unit: "UG/M3", observedAt: at },
    ];
    const extraSites = [...sites, { ...boulderCu, stationKey: "999999999", siteName: "Synthetic co-located sensor" }];
    // The synthetic sensor has held a steady Unhealthy-for-sensitive-groups
    // concentration for twelve hours, so its NowCast is unambiguous.
    const disagreeingHistory = new Map(historyAt(at));
    disagreeingHistory.set("999999999", Array(12).fill(40.0));
    const d = decide({ policy, place: BOULDER_HIGH, sites: extraSites, observations: disagreeing, history: disagreeingHistory, at, feed: "ok", intensity: "light", sensitiveAthletes: false });
    expect(d.confidence).toBe("advisory");
    // CHSAA's instruction for conflicting assessments is to follow the worse one.
    expect(d.band?.aqiCategory).toBe("Unhealthy for Sensitive Groups");
    expect(d.action).toBe("proceed_with_precautions");
    expect(d.decidedOnAqi).toBeGreaterThan(100);
    expect(d.reasons.join(" ")).toMatch(/disagree/);
    expect(d.reasons.join(" ")).toMatch(/worse assessment/);
  });
});

describe("Boulder High, Thursday Aug 1 2024 — the replay the app ships", () => {
  it("cancels a 9am practice at AQI 152, the number AirNow published that hour", () => {
    const d = aug2024(BOULDER_HIGH, 9, "vigorous");
    expect(d.decidedOnAqi).toBe(152);
    expect(d.band?.aqiCategory).toBe("Unhealthy");
    expect(d.action).toBe("cancel");
    expect(d.rule?.id).toBe("unhealthy-all");
    expect(d.confidence).toBe("firm");
    // The raw hourly reading was 75.5; the NowCast behind AQI 152 is lower.
    expect(d.monitors[0].rawPm25).toBeCloseTo(75.5, 1);
    expect(d.decidedOnPm25).toBeCloseTo(56.3, 1);
  });

  it("walks the call back down the CHSAA table as the smoke clears", () => {
    //  7am Moderate -> 8am sensitive-groups -> 9am Unhealthy -> 4pm Moderate again.
    const steps = [7, 8, 9, 12, 16].map((h) => aug2024(BOULDER_HIGH, h, "vigorous"));
    expect(steps.map((d) => d.band?.aqiCategory)).toEqual([
      "Moderate",
      "Unhealthy for Sensitive Groups",
      "Unhealthy",
      "Unhealthy for Sensitive Groups",
      "Moderate",
    ]);
    expect(steps.map((d) => d.action)).toEqual([
      "proceed", "reduce_intensity", "cancel", "reduce_intensity", "proceed",
    ]);
  });

  it("reaches the opposite call in Fort Collins at the same hour", () => {
    const boulder = aug2024(BOULDER_HIGH, 9, "vigorous");
    const fortCollins = aug2024(CENTENNIAL_FC, 9, "vigorous");
    expect(fortCollins.decidedOnAqi).toBe(78);
    expect(fortCollins.band?.aqiCategory).toBe("Moderate");
    expect(fortCollins.action).toBe("proceed");
    // Same state, same hour, same sport: one cancels and one goes ahead.
    expect(boulder.action).toBe("cancel");
    expect(ACTION_SEVERITY[boulder.action!])
      .toBeGreaterThan(ACTION_SEVERITY[fortCollins.action!]);
  });

  it("points a cancelled 9am session at the nearest clear window", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour, decision: aug2024(BOULDER_HIGH, hour, "vigorous"),
    }));
    const alt = suggestAlternative(hours, 9);
    expect(alt).not.toBeNull();
    expect(alt!.decision.action).toBe("proceed");
    // 7am, two hours before the smoke arrived, is the closest clear hour to 9am.
    // The ranking is best call first and nearest hour second, so it beats the
    // equally clear afternoon.
    expect(alt!.hour).toBe(7);
    expect(alt!.decision.decidedOnAqi).toBe(80);
  });

  it("keeps Longmont's 152.7 spike out of a Boulder call 14 mi away", () => {
    const d = aug2024(BOULDER_HIGH, 5, "vigorous");
    const longmont = d.monitors.find((m) => m.siteName.includes("Longmont"));
    expect(longmont?.rawPm25).toBeCloseTo(152.7, 1);
    expect(longmont?.aqi).toBe(183);          // Unhealthy, 14 miles away
    expect(longmont?.used).toBe(false);
    expect(longmont?.excludedCode).toBe("distance");
    // Boulder itself was Moderate that hour. Taking Longmont's worse reading, as
    // the worse-of-two rule does for monitors that ARE close enough, would have
    // cancelled a session Boulder's own air did not justify cancelling.
    expect(d.decidedOnAqi).toBe(81);
    expect(d.band?.aqiCategory).toBe("Moderate");
  });
});

describe("a missing hour is not a missing monitor", () => {
  it("says the hour has not happened yet, and does not blame the monitor network", () => {
    const at = localHourToUtc(2021, 8, 7, 16);
    const d = decide({
      policy, place: BOULDER_HIGH, sites, observations: [], history: new Map(),
      at, feed: "not_yet_observed", intensity: "vigorous", sensitiveAthletes: false,
    });
    expect(d.action).toBeNull();
    expect(d.confidence).toBe("insufficient");
    expect(d.reasons.join(" ")).toMatch(/has not happened yet/);
    expect(d.reasons.join(" ")).not.toMatch(/No PM2.5 monitor within/);
  });

  it("says the hour is unpublished when AirNow has not posted the file", () => {
    const at = localHourToUtc(2021, 8, 7, 16);
    const d = decide({
      policy, place: BOULDER_HIGH, sites, observations: [], history: new Map(),
      at, feed: "not_published", intensity: "vigorous", sensitiveAthletes: false,
    });
    expect(d.action).toBeNull();
    expect(d.reasons.join(" ")).toMatch(/has not published this hour yet/);
    expect(d.reasons.join(" ")).not.toMatch(/No PM2.5 monitor within/);
  });

  it("still blames the monitor network when the hour is published and nothing is near", () => {
    const { at, observations } = obsForLocalHour(16);
    const d = decide({
      policy, place: { name: "Middle Park HS", lat: 40.0869, lon: -105.9372 }, sites,
      observations, history: historyAt(at), at, feed: "ok", intensity: "vigorous", sensitiveAthletes: false,
    });
    expect(d.reasons.join(" ")).toMatch(/No PM2.5 monitor within/);
  });
});

describe("the visual range check, which CHSAA requires alongside the AQI", () => {
  it("follows the coach's observation when it is worse than the monitors", () => {
    // Aug 1 2024, 4pm: monitors say Moderate. A coach who can only see 2 miles
    // is reporting Unhealthy, and CHSAA says to act on the worse assessment.
    const monitorsOnly = aug2024(BOULDER_HIGH, 16, "vigorous");
    expect(monitorsOnly.band?.aqiCategory).toBe("Moderate");
    expect(monitorsOnly.action).toBe("proceed");

    const withEyes = aug2024(BOULDER_HIGH, 16, "vigorous", false, "unhealthy");
    expect(withEyes.band?.aqiCategory).toBe("Unhealthy");
    expect(withEyes.action).toBe("cancel");
    expect(withEyes.confidence).toBe("advisory");
    expect(withEyes.reasons.join(" ")).toMatch(/worse of the two/);
    // No AQI is invented for the visual check: the reported number stays the
    // one the monitors actually measured, and the band says where it came from.
    expect(withEyes.decidedBy).toBe("visual_range");
    expect(withEyes.decidedOnAqi).toBe(monitorsOnly.decidedOnAqi);
  });

  it("leaves the monitors in charge when the view agrees or is better", () => {
    const clearView = aug2024(BOULDER_HIGH, 9, "vigorous", false, "good");
    // 9am was Unhealthy on the monitors. A clear view does not overrule that.
    expect(clearView.band?.aqiCategory).toBe("Unhealthy");
    expect(clearView.action).toBe("cancel");
    expect(clearView.reasons.join(" ")).toMatch(/monitor reading stands/i);
  });

  it("is optional: no observation leaves the call untouched", () => {
    const without = aug2024(BOULDER_HIGH, 16, "vigorous", false, null);
    expect(without.action).toBe("proceed");
    expect(without.reasons.join(" ")).not.toMatch(/visual range/);
  });
});

describe("every decision is auditable", () => {
  it("names the policy version, the rule and the monitors behind the call", () => {
    const d = call(BOULDER_HIGH, 16, "vigorous");
    expect(d.policyVersion).toBe("chsaa-colorado-1.0.0");
    expect(d.rule?.id).toBe("unhealthy-all");
    // Every rationale cites CHSAA rather than asserting a threshold of our own.
    expect(d.rule?.rationale).toMatch(/^CHSAA/);
    expect(d.reasons.length).toBeGreaterThan(2);
    expect(d.reasons.join(" ")).toMatch(/NowCast/);
    expect(d.monitors.every((m) => m.siteName && Number.isFinite(m.rawPm25))).toBe(true);
  });

  it("cites a verified source for every threshold it applies", () => {
    expect(policy.sources.length).toBeGreaterThan(0);
    expect(policy.sources.every((src) => src.verified)).toBe(true);
    expect(policy.sources.some((src) => src.url.includes("chsaa"))).toBe(true);
    expect(policy.rules.every((r) => r.rationale.startsWith("CHSAA"))).toBe(true);
  });
});
