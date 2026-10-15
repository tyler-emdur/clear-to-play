import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import policyJson from "../policy/boulder-default.json";
import { localHourToUtc, parseHourly, parseSites, type Observation } from "../lib/airnow";
import { decide, suggestAlternative, type Decision } from "../lib/decide";
import { ACTION_SEVERITY, type IntensityId, type Policy } from "../lib/policy";

const policy = policyJson as unknown as Policy;
const FX = join(__dirname, "fixtures");
const pad = (n: number) => String(n).padStart(2, "0");

const sites = parseSites(readFileSync(join(FX, "sites-co.dat"), "utf8"));

/** Observations for the UTC hour that contains the given Boulder-local hour. */
function obsForLocalHour(
  hour: number, y = 2021, m = 8, d = 7,
): { at: Date; observations: Observation[] } {
  const at = localHourToUtc(y, m, d, hour);
  const stamp = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}`;
  const observations = parseHourly(readFileSync(join(FX, `hourly-${stamp}.dat`), "utf8"));
  return { at, observations };
}

/** The day the app replays: Thu Aug 1 2024, the Front Range's worst recent smoke morning. */
function aug2024(
  place: { name: string; lat: number; lon: number }, hour: number,
  intensity: IntensityId = "vigorous", sensitiveAthletes = false,
): Decision {
  const { at, observations } = obsForLocalHour(hour, 2024, 8, 1);
  return decide({ policy, place, sites, observations, at, feed: "ok", intensity, sensitiveAthletes });
}

const BOULDER_HIGH = { name: "Boulder High School", lat: 40.0150, lon: -105.2797 };
const CENTENNIAL_FC = { name: "Centennial HS (Fort Collins)", lat: 40.5721, lon: -105.0783 };
const NEDERLAND = { name: "Nederland Middle/Senior High", lat: 39.9614, lon: -105.5108 };

function call(
  place: typeof BOULDER_HIGH, hour: number,
  intensity: IntensityId = "vigorous", sensitiveAthletes = false,
): Decision {
  const { at, observations } = obsForLocalHour(hour);
  return decide({ policy, place, sites, observations, at, feed: "ok", intensity, sensitiveAthletes });
}

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
    expect(d.decidedOnPm25).toBeCloseTo(78.0, 1);
    expect(d.band?.aqiCategory).toBe("Unhealthy");
    expect(d.monitors[0].siteName).toContain("Boulder - CU");
    expect(d.monitors[0].distanceMiles).toBeLessThan(1);
  });

  it("allows the same practice at 7am, when it was 25.5", () => {
    const d = call(BOULDER_HIGH, 7, "vigorous");
    expect(d.decidedOnPm25).toBeCloseTo(25.5, 1);
    expect(d.band?.aqiCategory).toBe("Moderate");
    expect(d.action).toBe("proceed");
  });

  it("restricts an asthmatic athlete at 7am where a healthy one may proceed", () => {
    const healthy = call(BOULDER_HIGH, 7, "vigorous", false);
    const sensitive = call(BOULDER_HIGH, 7, "vigorous", true);
    expect(ACTION_SEVERITY[sensitive.action!]).toBeGreaterThan(ACTION_SEVERITY[healthy.action!]);
    expect(sensitive.action).toBe("reduce_intensity");
  });

  it("scales the call to exertion at a fixed concentration", () => {
    const hour = 10; // 52.2 ug/m3, Unhealthy for Sensitive Groups
    const vigorous = call(BOULDER_HIGH, hour, "vigorous");
    const moderate = call(BOULDER_HIGH, hour, "moderate");
    const rest = call(BOULDER_HIGH, hour, "rest");
    expect(ACTION_SEVERITY[vigorous.action!]).toBeGreaterThan(ACTION_SEVERITY[moderate.action!]);
    expect(ACTION_SEVERITY[moderate.action!]).toBeGreaterThan(ACTION_SEVERITY[rest.action!]);
  });

  it("offers the best window of the day, not merely a less bad one", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, decision: call(BOULDER_HIGH, hour, "vigorous") }));
    const alt = suggestAlternative(hours, 16);
    expect(alt).not.toBeNull();
    // 8pm was less severe than 4pm but still Unhealthy-for-Sensitive-Groups. The morning
    // was genuinely clear, so the engine must reach past the closer, worse option.
    expect(alt!.decision.action).toBe("proceed");
    expect(alt!.hour).toBe(9);
    expect(alt!.decision.decidedOnPm25).toBeCloseTo(29.4, 1);
    // Every hour from 10am to midnight stayed at or above the sensitive-groups band.
    const afternoonOnward = hours.filter((h) => h.hour >= 10);
    expect(afternoonOnward.every((h) => h.decision.decidedOnPm25! > 35.4)).toBe(true);
  });
});

describe("the same day 40 miles north, the right answer inverts", () => {
  it("is worse in the morning in Fort Collins and worse in the afternoon in Boulder", () => {
    const fcMorning = call(CENTENNIAL_FC, 7, "vigorous");
    const fcAfternoon = call(CENTENNIAL_FC, 16, "vigorous");
    const bMorning = call(BOULDER_HIGH, 7, "vigorous");
    const bAfternoon = call(BOULDER_HIGH, 16, "vigorous");

    expect(fcMorning.decidedOnPm25!).toBeGreaterThan(fcAfternoon.decidedOnPm25!);
    expect(bAfternoon.decidedOnPm25!).toBeGreaterThan(bMorning.decidedOnPm25!);

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
      at: fiveHoursLater, feed: "ok", intensity: "vigorous", sensitiveAthletes: false,
    });
    expect(d.action).toBeNull();
    expect(d.monitors[0].excluded).toMatch(/min old/);
  });

  it("drops to advisory and withholds a green light when monitors disagree", () => {
    const { at, observations } = obsForLocalHour(0); // Boulder CU 9.7 — a Moderate, proceed hour
    const clean = decide({ policy, place: BOULDER_HIGH, sites, observations, at, feed: "ok", intensity: "light", sensitiveAthletes: false });
    expect(clean.action).toBe("proceed");

    const boulderCu = sites.find((s) => s.siteName.includes("Boulder - CU"))!;
    const disagreeing = [
      ...observations,
      { stationKey: "999999999", siteName: "Synthetic co-located sensor", value: 34.0, unit: "UG/M3", observedAt: at },
    ];
    const extraSites = [...sites, { ...boulderCu, stationKey: "999999999", siteName: "Synthetic co-located sensor" }];
    const d = decide({ policy, place: BOULDER_HIGH, sites: extraSites, observations: disagreeing, at, feed: "ok", intensity: "light", sensitiveAthletes: false });
    expect(d.confidence).toBe("advisory");
    expect(d.action).toBe("proceed_with_precautions");
    expect(d.decidedOnPm25).toBe(34.0);
    expect(d.reasons.join(" ")).toMatch(/disagree/);
  });
});

describe("Boulder High, Thursday Aug 1 2024 — the replay the app ships", () => {
  it("cancels a 9am practice at 75.5 ug/m3", () => {
    const d = aug2024(BOULDER_HIGH, 9, "vigorous");
    expect(d.decidedOnPm25).toBeCloseTo(75.5, 1);
    expect(d.band?.aqiCategory).toBe("Unhealthy");
    expect(d.action).toBe("cancel");
    expect(d.confidence).toBe("firm");
  });

  it("clears the same practice by 2pm, five hours later", () => {
    const d = aug2024(BOULDER_HIGH, 14, "vigorous");
    expect(d.decidedOnPm25).toBeCloseTo(30.4, 1);
    expect(d.band?.aqiCategory).toBe("Moderate");
    expect(d.action).toBe("proceed");
  });

  it("reaches the opposite call in Fort Collins at the same hour", () => {
    const boulder = aug2024(BOULDER_HIGH, 9, "vigorous");
    const fortCollins = aug2024(CENTENNIAL_FC, 9, "vigorous");
    expect(fortCollins.decidedOnPm25).toBeCloseTo(19.4, 1);
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
    expect(alt!.decision.decidedOnPm25).toBeCloseTo(23.9, 1);
  });

  it("keeps Longmont's 152.7 spike out of a Boulder call 14 mi away", () => {
    const d = aug2024(BOULDER_HIGH, 5, "vigorous");
    const longmont = d.monitors.find((m) => m.siteName.includes("Longmont"));
    expect(longmont?.value).toBeCloseTo(152.7, 1);
    expect(longmont?.used).toBe(false);
    expect(longmont?.excludedCode).toBe("distance");
    // Boulder was Moderate that hour. Averaging Longmont in would have cancelled
    // a session that its own air did not justify cancelling.
    expect(d.decidedOnPm25).toBeCloseTo(25.2, 1);
    expect(d.band?.aqiCategory).toBe("Moderate");
  });
});

describe("a missing hour is not a missing monitor", () => {
  it("says the hour has not happened yet, and does not blame the monitor network", () => {
    const at = localHourToUtc(2021, 8, 7, 16);
    const d = decide({
      policy, place: BOULDER_HIGH, sites, observations: [],
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
      policy, place: BOULDER_HIGH, sites, observations: [],
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
      observations, at, feed: "ok", intensity: "vigorous", sensitiveAthletes: false,
    });
    expect(d.reasons.join(" ")).toMatch(/No PM2.5 monitor within/);
  });
});

describe("every decision is auditable", () => {
  it("names the policy version, the rule and the monitors behind the call", () => {
    const d = call(BOULDER_HIGH, 16, "vigorous");
    expect(d.policyVersion).toBe("boulder-default-0.1.0");
    expect(d.rule?.id).toBe("unhealthy-active");
    expect(d.rule?.rationale.length).toBeGreaterThan(20);
    expect(d.reasons.length).toBeGreaterThan(2);
    expect(d.monitors.every((m) => m.siteName && Number.isFinite(m.value))).toBe(true);
  });
});
