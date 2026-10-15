# Clear to Play

Smoke-day practice calls for Boulder Valley schools. Reads EPA AirNow monitor data for a
school and a practice window, applies a published smoke policy, and returns a call with the
evidence behind it — or declines when the nearest monitor is too far away to support one.

## Why it declines

Colorado has roughly 32 active PM2.5 monitors statewide, and coverage is inverted relative to
risk: Centennial HS in Fort Collins sits 0.1 mi from a monitor, while Estes Park HS is 26 mi
and Middle Park HS in Granby is 36 mi from the nearest one. The engine treats distance,
reading age, and disagreement between monitors as gates on whether a recommendation can be
issued at all.

## Why the answer has to be hourly and local

On Saturday 7 August 2021, the worst recent Front Range smoke day:

| local hour | Boulder CU | Ft. Collins CSU |
|---|---|---|
| 07:00 | 25.5 | 74.8 |
| 16:00 | 78.0 | 27.3 |

Two towns 40 mi apart, same smoke event, opposite correct answers. "Move practice earlier" is
right in Boulder and wrong in Fort Collins. Boulder also stayed between 44 and 78 µg/m³ from
10:00 until midnight, so "wait until evening" fails in both. Neither heuristic works, which is
the reason this tool reads the data instead of applying a rule of thumb.

## Data

`https://files.airnowtech.org/airnow/<YYYY>/<YYYYMMDD>/HourlyData_<YYYYMMDDHH>.dat`
`https://files.airnowtech.org/airnow/today/Monitoring_Site_Locations_V2.dat`

No API key, no rate limit, archive back several years. The keyed `airnowapi.org` service is the
usual choice and returned a 504 on first contact, so this uses the files. Both feeds are
UTC-stamped and pipe-delimited. No CORS headers, so fetching happens server-side.

## Policy as data

`policy/boulder-default.json` holds the thresholds, the exercise-intensity multipliers, and the
evidence gates, each row citing its source. A district can fork the file and change any row
without touching code. Every decision names the policy version and the rule id that produced it.

Two sources are marked `"verified": false`. The thresholds must be transcribed from the official
EPA AQI table and CDPHE guidance before this is relied on.

## Layout

    lib/airnow.ts    pure parsers for both AirNow feeds, plus timezone handling
    lib/decide.ts    pure decision engine — no clock, no network
    lib/data.ts      server-side fetching and caching
    policy/          the policy file
    test/fixtures/   24 h of real Colorado observations, 7 Aug 2021
    test/            12 tests, including the Boulder/Fort Collins inversion

## Running it

    npm install
    npm test
    npm run dev
