# Clear to Play

Smoke-day practice calls for Boulder Valley schools. Reads EPA AirNow monitor data for a
school and a practice window, applies CHSAA's published guidance, and returns a call with the
evidence behind it — or declines when the nearest monitor is too far away to support one.

Live at <https://cac.tyleremdur.com>.

## The policy is not mine

CHSAA and CDPHE publish [*Guidance for School Athletic Activities During High Pollution/Smoke
Events*](https://chsaa-media.sfo3.cdn.digitaloceanspaces.com/wp-content/uploads/2026/03/25150421/Guidance_for_School_Athletic_Activities_During_High_Pollution_Smoke_Events.pdf),
an AQI table mapped to actions for 2–3 hour practices. `policy/chsaa-colorado.json` is that
table as data: every band, action and rationale is transcribed from it, and every decision the
app makes names the policy version and the rule id that produced it. A district can fork the
file and change any row without touching code.

The document also tells schools to compare the AQI against their own visual range check and
follow **the worse of the two assessments**. That is a control in the app, and the same
worse-of-two rule governs monitors that disagree with each other.

## The AQI has to be the NowCast

`HourlyData.dat` carries raw hourly concentrations. The AQI a coach actually looks up — on
Colorado's map, the one CHSAA's guidance names — is the **NowCast**, a 12-hour weighted
average, because the AQI breakpoints are defined on an average rather than a single hour.

On 2024-08-01 at 09:00 local, Boulder CU reported a raw 75.5 µg/m³ while AirNow published
**AQI 152**. Reading the raw value against the breakpoints lands in the same band by luck, not
by method. `lib/aqi.ts` implements EPA's NowCast and the May 2024 breakpoints, and the test
suite checks it against AirNow's own published `PM25_AQI` for every Colorado monitor across ten
archived hours: **180 of 180 site-hours match exactly.**

## Why it declines

Colorado has roughly 32 active regulatory PM2.5 monitors, and coverage is inverted relative to
risk: Centennial HS in Fort Collins sits 0.1 mi from one, while Estes Park HS is 26 mi and
Middle Park HS in Granby is 36 mi away. Distance, reading age, and whether a NowCast can be
computed at all are gates on whether a recommendation is issued, not footnotes under one.

A missing hour is reported as a missing hour, never as a missing monitor — the two are
different facts and conflating them would misstate the finding above.

## Why the answer has to be hourly and local

Thursday 1 August 2024, local Mountain time, at three monitors:

| local hour | Boulder CU | Longmont (14 mi) | Ft. Collins CSU (45 mi) |
|---|---|---|---|
| 05:00 | 25.2 | **152.7** | 25.6 |
| 09:00 | **75.5** | 59.5 | 19.4 |
| 14:00 | 30.4 | 29.9 | 11.4 |

At 09:00 Boulder is Unhealthy and Fort Collins is Moderate: the same hour, the same sport, and
opposite correct answers. At 05:00 Longmont is three AQI bands worse than Boulder, 14 miles
away — which is why a reading from 14 mi out is excluded rather than averaged in. And Boulder
recovers by the afternoon, so "wait until tomorrow" is wrong too. No rule of thumb survives
this day, which is the reason the tool reads the data.

## Data

    https://files.airnowtech.org/airnow/<YYYY>/<YYYYMMDD>/HourlyData_<YYYYMMDDHH>.dat
    https://files.airnowtech.org/airnow/<YYYY>/<YYYYMMDD>/HourlyAQObs_<YYYYMMDDHH>.dat
    https://files.airnowtech.org/airnow/today/Monitoring_Site_Locations_V2.dat

No API key, no rate limit, archive back several years. The keyed `airnowapi.org` service is the
usual choice and returned a 504 on first contact, so this uses the files. All are UTC-stamped;
the hourly files are pipe-delimited and `HourlyAQObs` is CSV. No CORS headers, so fetching
happens server-side. `HourlyAQObs` is used only to validate the NowCast implementation in tests.

## Layout

    lib/aqi.ts       EPA NowCast and the 2024 PM2.5 AQI breakpoints
    lib/airnow.ts    pure parsers for the AirNow feeds, plus timezone handling
    lib/decide.ts    pure decision engine — no clock, no network
    lib/data.ts      server-side fetching and caching
    policy/          CHSAA's table as data
    test/fixtures/   real Colorado observations for 1 Aug 2024 and 7 Aug 2021,
                     plus AirNow's published AQI for validation
    test/            35 tests, including the 180-site-hour AQI validation

## Running it

    npm install
    npm test
    npm run dev
