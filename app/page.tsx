"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PLACES } from "@/lib/places";
import { ACTION_LABEL, type Action, type IntensityId } from "@/lib/policy";

const INTENSITIES: { id: IntensityId; label: string }[] = [
  { id: "rest", label: "Standing or spectating" },
  { id: "light", label: "Walking, light drills, marching band" },
  { id: "moderate", label: "Easy run, skills practice" },
  { id: "vigorous", label: "Intervals, race pace, full scrimmage" },
];

const BAND_COLOR: Record<string, string> = {
  good: "var(--band-good)",
  moderate: "var(--band-moderate)",
  usg: "var(--band-usg)",
  unhealthy: "var(--band-unhealthy)",
  "very-unhealthy": "var(--band-very-unhealthy)",
  hazardous: "var(--band-hazardous)",
};

type HourCell = {
  hour: number;
  awaitingData: boolean;
  pm25: number | null;
  action: Action | null;
  confidence: string;
  band: string | null;
};

type Monitor = {
  siteName: string; distanceMiles: number; value: number;
  ageMinutes: number; used: boolean; excluded?: string;
  excludedCode?: "future" | "stale" | "distance";
};

// The table already carries distance and reading age in their own columns, so the
// status cell says which limit was broken rather than restating the number.
const EXCLUDED_SHORT: Record<string, string> = {
  distance: "too far",
  stale: "too old",
  future: "stamped after the window",
};

type Day = {
  place: { id: string; name: string; note?: string };
  date: string;
  isToday: boolean;
  hour: number;
  selected: {
    action: Action | null;
    confidence: "firm" | "advisory" | "insufficient";
    estimate: { value: number; low: number; high: number } | null;
    decidedOnPm25: number | null;
    band: { id: string; aqiCategory: string } | null;
    rule: { id: string; rationale: string; precautions: string[] } | null;
    reasons: string[];
    monitors: Monitor[];
    policyVersion: string;
  };
  latestWithReadings: number | null;
  strip: HourCell[];
  alternative: { hour: number; pm25: number | null; action: Action | null; band: string | null } | null;
  policy: {
    version: string; jurisdiction: string; disclaimer: string;
    sources: { id: string; title: string; url: string; verified: boolean; note: string }[];
  };
};

const denverToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());
const denverHour = () =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour12: false, hour: "2-digit" })
    .format(new Date())) % 24;

// Engine strings stay ASCII so a pasted decision record survives any mail client;
// on screen they match the units shown everywhere else.
const prettyUnits = (text: string) => text.replace(/ug\/m3/g, "\u00b5g/m\u00b3");

const hourLabel = (h: number) =>
  `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? " AM" : " PM"}`;

const prettyDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
};

export default function Page() {
  const [placeId, setPlaceId] = useState("boulder-high");
  const [date, setDate] = useState(denverToday);
  const [hour, setHour] = useState(() => Math.max(0, denverHour() - 1));
  const [intensity, setIntensity] = useState<IntensityId>("vigorous");
  const [sensitive, setSensitive] = useState(false);
  const [day, setDay] = useState<Day | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const settled = useRef(false);

  useEffect(() => {
    const ctl = new AbortController();
    setPending(true);
    const q = new URLSearchParams({
      place: placeId, date, hour: String(hour), intensity, sensitive: sensitive ? "1" : "0",
    });
    fetch(`/api/day?${q}`, { signal: ctl.signal })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `request failed (${r.status})`);
        return json as Day;
      })
      .then((d) => {
        setDay(d); setError(null);
        // AirNow posts an hour roughly an hour after it ends, so the last elapsed
        // hour is often still missing. Land on the most recent hour that can
        // actually be answered, once, rather than opening on a refusal.
        if (!settled.current) {
          settled.current = true;
          if (!d.selected.action && d.latestWithReadings !== null) setHour(d.latestWithReadings);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "something went wrong");
      })
      .finally(() => setPending(false));
    return () => ctl.abort();
  }, [placeId, date, hour, intensity, sensitive]);

  const peak = useMemo(
    () => Math.max(60, ...(day?.strip ?? []).map((c) => c.pm25 ?? 0)),
    [day],
  );

  const replaying = date !== denverToday();
  const sel = day?.selected;
  const keyColor = sel?.band ? BAND_COLOR[sel.band.id] ?? "var(--band-unknown)" : "var(--band-unknown)";

  const copyRecord = useCallback(() => {
    if (!day || !sel) return;
    const lines = [
      `CLEAR TO PLAY — decision record`,
      `${day.place.name} · ${prettyDate(day.date)} · practice window ${hourLabel(day.hour)}`,
      `Activity: ${INTENSITIES.find((i) => i.id === intensity)?.label}`,
      `Athletes with asthma or a respiratory condition on the field: ${sensitive ? "yes" : "no"}`,
      ``,
      `CALL: ${sel.action ? ACTION_LABEL[sel.action].toUpperCase() : "NO CALL — EVIDENCE INSUFFICIENT"}`,
      sel.decidedOnPm25 !== null ? `PM2.5 used: ${sel.decidedOnPm25} ug/m3 (${sel.band?.aqiCategory})` : ``,
      `Confidence: ${sel.confidence}`,
      sel.rule ? `Policy rule: ${sel.rule.id} — ${sel.rule.rationale}` : ``,
      sel.rule?.precautions.length ? `Required: ${sel.rule.precautions.join("; ")}` : ``,
      ``,
      `Monitors consulted:`,
      ...sel.monitors.map(
        (m) => `  ${m.siteName} — ${m.distanceMiles} mi, ${m.value} ug/m3, ${m.ageMinutes} min old` +
          (m.used ? "" : ` [not used: ${m.excluded}]`),
      ),
      ``,
      `Reasoning:`,
      ...sel.reasons.map((r) => `  - ${r}`),
      ``,
      `Policy ${sel.policyVersion}. Observations from the EPA AirNow hourly file feed.`,
    ];
    navigator.clipboard?.writeText(lines.filter((l) => l !== "").join("\n"));
  }, [day, sel, intensity, sensitive]);

  return (
    <div className="shell" data-pending={pending ? 1 : 0}>
      <header className="masthead">
        <span className="wordmark">Clear to Play</span>
        <span className="where">Boulder Valley schools</span>
        <span className="stamp">
          {day
            ? day.isToday
              ? `live AirNow monitor data, ${prettyDate(day.date)}`
              : `historical replay of ${prettyDate(day.date)}`
            : "reading AirNow"}
        </span>
      </header>

      <div className="controls">
        <label className="field">
          <span>Location</span>
          <select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
            {PLACES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>

        <label className="field">
          <span>Activity</span>
          <select value={intensity} onChange={(e) => setIntensity(e.target.value as IntensityId)}>
            {INTENSITIES.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        </label>

        <label className="field">
          <span>Practice window</span>
          <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </select>
        </label>

        <div className="field toggle">
          <input id="sens" type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
          <label htmlFor="sens">Asthma on the field</label>
        </div>

        <button
          className="replay"
          onClick={() =>
            replaying
              ? (settled.current = false, setDate(denverToday()), setHour(Math.max(0, denverHour() - 1)))
              : (setDate("2021-08-07"), setHour(16))
          }
        >
          {replaying ? "Back to live conditions" : "Load Aug 7, 2021 smoke day"}
        </button>
      </div>

      {error && (
        <div className="error">
          Could not build a call: {error}. The AirNow feed may be unavailable for that hour.
        </div>
      )}

      {!day && pending && <p className="loading">Reading monitor data…</p>}

      {day && sel && (
        <>
          {pending && <p className="loading" role="status">Re-reading monitor data for this window…</p>}
          <section className="verdict" aria-busy={pending}>
            <div className="key" style={{ background: keyColor }} aria-hidden />
            <div className="body">
              <h1 className="call">
                {sel.action ? ACTION_LABEL[sel.action] : "No call"}
              </h1>
              {sel.action ? (
                <>
                  <div className="readout">
                    <span className="conc">
                      {sel.decidedOnPm25}<small>µg/m³ PM2.5</small>
                    </span>
                    <span className="bandname">{sel.band?.aqiCategory}</span>
                    <span className="chip" data-c={sel.confidence}>
                      {sel.confidence === "firm" ? "firm call" : "advisory only"}
                    </span>
                  </div>
                  {sel.rule?.precautions.length ? (
                    <p className="instead">Required: {sel.rule.precautions.join(" · ")}</p>
                  ) : null}
                  {day.alternative && (
                    <p className="instead">
                      Better window today: <b>{hourLabel(day.alternative.hour)}</b> at{" "}
                      {day.alternative.pm25} µg/m³, where the call becomes{" "}
                      <b>{day.alternative.action ? ACTION_LABEL[day.alternative.action].toLowerCase() : "unknown"}</b>.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="nocall">{sel.reasons[0]}</p>
                  {day.latestWithReadings !== null && day.latestWithReadings !== day.hour && (
                    <p className="instead">
                      Latest window with readings:{" "}
                      <button type="button" className="jump" onClick={() => setHour(day.latestWithReadings!)}>
                        {hourLabel(day.latestWithReadings)}
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="strip">
            <h2>Hour by hour at {day.place.name}, {prettyDate(day.date)}</h2>
            <div className="bars">
              {day.strip.map((c) => (
                <div
                  key={c.hour}
                  className="bar"
                  data-sel={c.hour === day.hour ? 1 : 0}
                  data-alt={day.alternative?.hour === c.hour ? 1 : 0}
                  title={
                    c.pm25 !== null
                      ? `${hourLabel(c.hour)} — ${c.pm25} µg/m³`
                      : c.awaitingData
                        ? `${hourLabel(c.hour)} — no readings yet`
                        : `${hourLabel(c.hour)} — no usable reading`
                  }
                >
                  <i
                    style={{
                      height: `${c.pm25 === null ? 3 : Math.max(3, Math.sqrt(c.pm25 / peak) * 100)}%`,
                      background: c.band ? BAND_COLOR[c.band] : "var(--band-unknown)",
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="hourlabels">
              {day.strip.map((c) => (
                <span key={c.hour}>{c.hour % 6 === 0 ? hourLabel(c.hour).replace(" ", "") : ""}</span>
              ))}
            </div>
            <p className="scalenote">
              Bars are square-root scaled to a {Math.round(peak)} µg/m³ peak. Grey bars are hours with no
              usable reading, or none published yet. The caret marks the better window.
            </p>
          </section>

          <section className="evidence">
            <h2>Monitors consulted</h2>
            <table>
              <thead>
                <tr>
                  <th>Station</th>
                  <th className="num">Distance</th>
                  <th className="num">PM2.5</th>
                  <th className="num">Reading age</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sel.monitors.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      {day.strip[day.hour]?.awaitingData
                        ? "This hour has no readings yet, so no monitor was consulted."
                        : "No PM2.5 monitor within range of this location."}
                    </td>
                  </tr>
                )}
                {sel.monitors.map((m) => (
                  <tr key={m.siteName} data-used={m.used ? 1 : 0}>
                    <td>{m.siteName}</td>
                    <td className="num">{m.distanceMiles} mi</td>
                    <td className="num">{m.value}</td>
                    <td className="num">{m.ageMinutes} min</td>
                    <td>
                      {m.used ? "used" : (
                        <span className="exc">
                          {(m.excludedCode && EXCLUDED_SHORT[m.excludedCode]) ?? m.excluded}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="why">
            <h2>{sel.action ? "How this call was reached" : "Why there is no call"}</h2>
            <ol>
              {sel.reasons.map((r, i) => <li key={i}>{prettyUnits(r)}</li>)}
            </ol>
            <button className="record" onClick={copyRecord}>Copy decision record</button>
          </section>

          <footer className="foot">
            <p>
              Policy {day.policy.version} for {day.policy.jurisdiction}. {day.policy.disclaimer}
            </p>
            {day.policy.sources.map((s) => (
              <p key={s.id}>
                <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                {!s.verified && <span className="unverified"> — thresholds not yet verified against this source</span>}
              </p>
            ))}
            <p>
              Observations come from the EPA AirNow hourly file feed. Colorado has roughly 32 active PM2.5
              monitors, so many locations have no monitor close enough to support a call.
            </p>
          </footer>
        </>
      )}
    </div>
  );
}
