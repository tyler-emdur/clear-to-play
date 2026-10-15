import policyJson from "../policy/boulder-default.json";
import {
  hourlyUrl, localHourToUtc, parseHourly, parseSites, SITES_URL,
  type Observation, type Site,
} from "./airnow";
import { decide, suggestAlternative, type Decision, type FeedStatus } from "./decide";
import type { IntensityId, Policy } from "./policy";
import { PLACES } from "./places";

export const policy = policyJson as unknown as Policy;

const DAY = 86_400;

async function text(url: string, revalidate: number | false) {
  const res = await fetch(url, { next: { revalidate } });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

let sitesCache: { at: number; sites: Site[] } | null = null;

export async function loadSites(): Promise<Site[]> {
  if (sitesCache && Date.now() - sitesCache.at < 6 * 3600_000) return sitesCache.sites;
  const sites = parseSites(await text(SITES_URL, DAY));
  sitesCache = { at: Date.now(), sites };
  return sites;
}

/** Observations for one local Boulder hour. Past days never change, so cache them hard. */
async function loadHour(y: number, m: number, d: number, hour: number, live: boolean, now: number) {
  const at = localHourToUtc(y, m, d, hour);
  const empty = { at, observations: [] as Observation[] };
  // Hours that have not elapsed have no file to fetch, so don't ask for one.
  if (at.getTime() > now) return { ...empty, feed: "not_yet_observed" as FeedStatus };
  try {
    const observations = parseHourly(await text(hourlyUrl(at), live ? 900 : false));
    return { at, observations, feed: "ok" as FeedStatus };
  } catch {
    return { ...empty, feed: "not_published" as FeedStatus };
  }
}

export type DayRequest = {
  placeId: string;
  /** "YYYY-MM-DD" in Boulder local time. */
  date: string;
  hour: number;
  intensity: IntensityId;
  sensitive: boolean;
};

export type HourCell = {
  hour: number;
  /** True when the hour simply has no readings yet, rather than no usable ones. */
  awaitingData: boolean;
  pm25: number | null;
  action: Decision["action"];
  confidence: Decision["confidence"];
  band: string | null;
};

export async function buildDay(req: DayRequest) {
  const place = PLACES.find((p) => p.id === req.placeId) ?? PLACES[0];
  const [y, m, d] = req.date.split("-").map(Number);
  const today = new Date();
  const isToday =
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(today) === req.date;

  const sites = await loadSites();
  const now = today.getTime();
  const hours = await Promise.all(
    Array.from({ length: 24 }, (_, hour) => loadHour(y, m, d, hour, isToday, now)),
  );

  const decisions = hours.map(({ at, observations, feed }, hour) => ({
    hour,
    decision: decide({
      policy, place, sites, observations, at, feed,
      intensity: req.intensity, sensitiveAthletes: req.sensitive,
    }),
  }));

  const strip: HourCell[] = decisions.map(({ hour, decision }) => ({
    hour,
    awaitingData: hours[hour].feed !== "ok",
    pm25: decision.decidedOnPm25,
    action: decision.action,
    confidence: decision.confidence,
    band: decision.band?.id ?? null,
  }));

  const selected = decisions[req.hour]?.decision ?? decisions[0].decision;
  const alternative = suggestAlternative(decisions, req.hour);
  // The most recent hour the feed can actually answer for, so a refusal on an
  // hour that isn't out yet can point somewhere useful instead of dead-ending.
  const latestWithReadings =
    decisions.filter((d) => d.decision.action !== null).map((d) => d.hour).pop() ?? null;

  return {
    place,
    date: req.date,
    isToday,
    hour: req.hour,
    selected,
    latestWithReadings,
    strip,
    alternative: alternative
      ? {
          hour: alternative.hour,
          pm25: alternative.decision.decidedOnPm25,
          action: alternative.decision.action,
          band: alternative.decision.band?.aqiCategory ?? null,
        }
      : null,
    policy: {
      version: policy.policyVersion,
      jurisdiction: policy.jurisdiction,
      sources: policy.sources,
      disclaimer: policy.disclaimer,
    },
  };
}
