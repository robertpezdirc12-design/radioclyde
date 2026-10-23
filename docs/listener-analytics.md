# Listener analytics (audience ledger + track impact)

*Implementation report — 2026-10-24, deterministic stack, no AI dependencies.*

## Objective

Icecast knows how many connections are open **right now**, but nothing kept that number over
time. The studio Diagnostics view shows a live probe, and then the number is gone. Every serious
radio platform tracks audience over time (AzuraCast's listener statistics, Radio.co's reports,
per-song listener impact), and the competitive analysis done for this feature listed it as the
top gap. This feature closes it **without adding any dependency and without breaking the
station's no-AI rule**: a scheduler job samples Icecast once a minute, appends to a JSONL
ledger, and a studio view charts the series and joins it with the real aired history.

## What was built

| Piece | File | Role |
|---|---|---|
| Sampling ledger | `src/analytics/listenerSamples.js` | One Icecast `status-json.xsl` poll per tick → append `{ ts, listeners, showId? }` (or `{ ts, listeners: null, error }` on failure) to `history/listener-samples.jsonl`; opportunistic prune to `analytics.maxEntries` |
| Impact math | `src/analytics/listenerImpact.js` | Pure functions: `buildSeries()` (chart downsampling with explicit holes) and `trackImpact()` (per-track Δ start→end, aggregated across plays) |
| Studio endpoint | `src/server/studioAnalyticsApi.js` | `GET /studio/api/analytics?hours=24\|72\|168` — series + impact + ledger stats + live Icecast probe |
| Scheduler job | `src/scheduler/scheduler.js` | `listener_sample` job, `every(max(1, analytics.sampleIntervalMinutes ?? 1))` |
| Studio view | `public/studio/index.html`, `public/studio/js/analytics.js`, `js/app.js`, `style.css` | New **Analytics** nav entry: summary, measurement rules, hand-built SVG chart (zero new npm deps), track-impact table |

## Honesty rules (the same standard as the Diagnostics view)

1. **A failed poll is data, not noise.** A sample where Icecast didn't answer is stored as
   `{ ts, listeners: null, error: "<real error text>" }` and counted as a *gap* everywhere it is
   displayed. Gaps are never interpolated, never backfilled with averages.
2. **Counts only come from actual answers.** The live "Now" value renders
   `unknown (Icecast not answering)` unless the probe succeeded; the chart breaks the line at
   gap buckets instead of drawing across them.
3. **Unmeasurable plays are counted, never hidden.** `trackImpact` returns a `skipped` breakdown
   (`noDuration`, `noData`, `tooFewSamples`, `thinCoverage`) and the view prints it.
4. **Δ is a correlation label, not a causal claim.** The UI column is
   "Δ start→end (per play)"; the view hint states that one-minute sampling cannot see sub-minute
   blips and that a mid-track dip-and-recovery reads as ≈0.

## Impact methodology

For each entry in `history/aired.jsonl` (written at real track start by `scrobbleTrack.js`,
carrying `durationMs`):

1. Window = `[playedAt, playedAt + durationMs]`.
2. Keep samples inside the window whose `listeners` is a number; drop gap samples.
3. Require `kept ≥ analytics.impactMinSamples` (default 2) **and**
   `span(kept) ≥ analytics.impactMinCoverage × durationMs` (default 50 %).
4. Compute `listenersStart` (first kept), `listenersEnd` (last kept), `listenersAvg` (mean),
   `delta = end − start`.
5. Aggregate by `ratingKey` (fallback `artist — title` for entries without one): `plays`,
   `listenersAvg`, `avgDelta`, `lastMeasuredAt`. Sorted biggest losses first in the table.

## Data schema

`data/history/listener-samples.jsonl` — one JSON object per line, append-only:

```json
{"ts":"2026-10-24T21:14:02.123+02:00","listeners":4,"showId":"morning-show"}
{"ts":"2026-10-24T21:15:02.301+02:00","listeners":null,"error":"Icecast status request failed: 503 Service Unavailable"}
```

`showId` is joined from `now_playing_track.json` at sample time (null during spoken segments /
before the first track since boot) so per-show audience questions stay answerable without a
schema migration. Pruning keeps the newest `analytics.maxEntries` lines (default 43200 =
30 days at 1/min, ≈2.5 MB).

## Configuration (all read with defaults, so existing configs keep booting)

```json
"analytics": {
  "sampleIntervalMinutes": 1,
  "maxEntries": 43200,
  "impactWindowHours": 168,
  "impactMinSamples": 2,
  "impactMinCoverage": 0.5
}
```

Pinned in `test/deployConfig.test.mjs` so the shipped production config always carries it.

## A critical boot bug the smoke test caught (fixed in the same commit)

The live smoke test (real server, bare config) exposed a defect of exactly the audit's F2
class that the earlier config-pinning test missed: `scheduler.js` read
`config.chatterbox.restartIntervalMinutes` **without optional chaining** while the shipped
production config has no `chatterbox` block at all — `startScheduler()` threw TypeError
mid-registration, before `"Scheduler started."`, silently killing **every job registered
after the throwing line** (filler regeneration, backup, and this feature's own sampler).

Fix: `config.chatterbox?.restartIntervalMinutes ?? 1440`, plus a source-scan regression test
(`test/deployConfig.test.mjs`) that fails if any `config.<block>.<key>` read in
`scheduler.js` targets a block missing from `deploy/ubuntu/config.linux.json` without `?.`.

Executed smoke evidence (server started with a bare temp config, Icecast absent):
before the fix — no `"Scheduler started."` line, sampler never registered, ledger absent;
after the fix — `"Scheduler started."` logged, sampler tick appended
`{"ts":"...","listeners":null,"error":"fetch failed","showId":null}`, and
`GET /studio/api/analytics` reported `{"samples":1,"gapSamples":1}` with the series showing
one explicit gap bucket. (`/api/schedule` returning 500 in that bare env is pre-existing
behavior — no `schedule.json` seeded — unrelated to this feature.)

## Tests (executed)

```
$ npm test
ℹ tests 63   ℹ suites 16   ℹ pass 63   ℹ fail 0
```

New suite `test/listenerAnalytics.test.mjs` (12 tests, 3 suites):

- sampler: honest numeric entry; gap entry with real error text; non-numeric count → gap;
  `showId` correlation; torn-line tolerance + chronological read; prune keeps newest
- `buildSeries`: bucket averaging, per-bucket gap counts, explicit holes, out-of-window
  exclusion, all-gap bucket ≠ hole (outage, not absence)
- `trackImpact`: covered plays measured (5-sample window, Δ = −2), repeat aggregation across
  plays (Δ̄ = −0.5), biggest-losses-first sort, all four skip reasons counted exactly,
  outside-window entries invisible, `ratingKey`-less grouping by `artist — title`,
  empty ledger → explicit empty result

## Deployment steps

None beyond the usual pull + restart: the sampler is a scheduler job in the same process, the
ledger appears under `data/history/` on first tick, and the studio view fetches the new endpoint
on first visit. On an already-running station the chart starts filling one minute after
`systemctl restart radioclyde`.

## Known limitations (documented, not hidden)

1. One-minute sampling cannot see sub-minute listener blips; deltas are boundary-sensitive.
2. Δ compares first vs last kept sample — a mid-track dip-and-recovery reads as ≈0.
3. Correlation ≠ causation: a track can coincide with bedtime, a schedule boundary, or an
   outage; the gap counters make exactly that visible.
4. The metric measures the single configured mount (`icecast.mount`); relays/mounts are out of
   scope until they exist.
