# Issue #2 implementation report — SUB/WAVE-inspired listener & owner interfaces

Issue: robertpezdirc12-design/radioclyde#2 — "Build a SUB/WAVE-inspired listener and owner interface without AI dependencies"

Everything below was executed against a real running instance of the merged code (`node src/server/index.js` on Node v24.21.0, Linux x64), using a self-contained demo data directory (`scripts/demo-setup.mjs` regenerates it deterministically). No AI model, LLM API, paid API, or new dependency was added — `package.json` dependencies are unchanged.

## 1. Files and features changed

### New backend (all honest-data endpoints)

| File | Purpose |
|---|---|
| `src/server/scheduleApi.js` | Public `GET /api/schedule` — full 7-day weekly grid from the same `loadSchedule()` the scheduler runs on, with date-scoped `on-air` / `next` marks, explicit timezone, downtime window. |
| `src/server/scheduleGrid.js` | Pure grid builder (unit-tested). Marks are **date-scoped** (`dateKey@timeKey`), so an overnight show spilling past midnight can never light up next week's same-weekday cell. |
| `src/server/requestsApi.js` | Public `POST /api/requests` (song requests + dedications) and `GET /api/requests/:id` (listener status check). A successful POST returns exactly `{id, status: "pending"}` — nothing else. Per-IP flood control (10 min cooldown, max 3 pending) that **fails closed**. |
| `src/server/requestsStore.js` | JSONL store (`<dataDir>/requests.jsonl`), Slovenian validation messages, atomic tmp+rename moderation writes, public projection that strips the submitter IP. |
| `src/server/studioRequestsApi.js` | `GET /studio/api/requests` (list/filter), `POST /studio/api/requests/:id/status` (approve/reject + note). Inside the `/studio` Basic-Auth + JSON-only-CSRF scope. |
| `src/server/diagnosticsUtil.js` | Real diagnostics primitives: playlist file stats (entries/mtime/size), log tails, repeat-offender detection over the real aired history, Icecast `/status-json.xsl` probe with hard timeout. |
| `src/server/studioDiagnosticsApi.js` | `GET /studio/api/diagnostics` — process (uptime/memory/Node), stream truth (Icecast reachable/healthy/listeners **only when Icecast actually answers**), playlist + metadata freshness, template-vs-real now playing, upcoming shows, repeat offenders, process error ring, web/station log tails. |
| `src/server/studioLibraryApi.js` | `GET /studio/api/library` (real local-library scan, 60 s cache, search) and `GET /studio/api/rotation` (window, pool, recently played, repeat offenders). In Plex-only mode it says exactly that instead of showing an empty library. |
| `src/server/voiceStatus.js` | Filesystem-true voice status: active mode, persona clip inventory, pregenerated slot inventory (`general_open/close/handoff_weather` + per-track), Piper python/model paths resolved exactly like `voice.js` does, per-persona overrides. |
| `src/server/studioVoiceApi.js` | `GET /studio/api/voice` — the above, read-only. |
| `src/lib/errorRing.js` | In-memory ring (100 entries) fed by `index.js`'s `uncaughtException`/`unhandledRejection` handlers — the "recent errors" surface is real, never fabricated. |

### New public schedule + requests support

- `src/config/index.js` — added `paths.requestsFile`.
- `src/server/api.js` — registers the schedule + requests routes.
- `src/server/historyApi.js` — exports `readAiredEntries()` for server-side repeat analysis (listener projection unchanged).
- `src/scheduler/scheduleUtil.js` — `mostRecentOccurrence()` now also returns `start` (minute-of-day, offset-aware). Additive; the grid needs it to know whether an occurrence is still inside its nominal slot.

### Listener interface (rebuilt, `public/`)

`index.html` / `app.js` / `style.css` — Slovenian by default (`lang="sl"`), dark gradient design in the spirit of modern streaming-radio interfaces (SUB/WAVE-inspired layout concepts: bold hero, tabbed panels, week grid). **No code or assets from the reference project are used** — an independent implementation (the reference repo has no license file, so nothing was copied).

- **Hero**: live cover art (or gradient/logo fallback), show + host, track title/artist, real progress bar (only when `durationMs` is known — ticked client-side between polls), `aria-live` announcements.
- **Player controls**: play/pause with honest status line (`Povezujem …` / `V predvajanju` / `Tok ni dosegljiv …` on stream error), volume slider + mute persisted in localStorage.
- **Tabs**: `Zdaj` (up next + recently played + favourites), `Spored` (week grid with ZDAJ / NASLEDNJI chips, today highlighted, timezone note, downtime note), `Zahtevki` (request/dedication form + status checker).
- **Requests**: honest states only — `v čakanju / odobreno / zavrnjeno (+ opomba) / ne obstaja`; 429 rate-limit text is shown verbatim; the form explains that approval is the owner's action.
- **Favourites**: localStorage-only and labelled as such ("strežniku jih ne pošiljamo") — no fake server metric.
- **Every fetch** has an explicit empty/error state with retry buttons; no invented data anywhere.
- **Accessibility**: skip-link, `role=tablist` tabs, `aria-pressed` toggles, `aria-live` now-playing, focus-visible outlines, `prefers-reduced-motion` respected, AA contrast on the dark palette.

### Owner dashboard (extended, `public/studio/`)

Existing On Air / Shows / Schedule / Prompts views untouched and still working. Four new views:

- **Requests** (`js/requests.js`): moderation table (received, type, track, message, from, IP, status) with Approve/Reject + optional note; filter by status; refresh.
- **Library** (`js/library.js`): rotation health (window, pool size, repeat offenders with counts/last-played, warning block), recently played, searchable track table with genres/durations, Plex-mode note when no local dirs exist.
- **Voice** (`js/voice.js`): active mode, known modes, Edge/espeak config, Piper python+model file existence per persona, persona clip inventory, pregenerated slot checklist — **read-only**, with an explicit note that mode switching is a `config.json` change + service restart (no fake activate button).
- **Diagnostics** (`js/diagnostics.js`, 15 s self-refresh): process, stream (Icecast probe with real error text), playlist/metadata freshness, template-vs-real now playing, repeat check, process error ring, real log tails.
- `src/server/studioStatic.js` — the four new JS assets registered in the fixed asset list.
- `public/studio/style.css` — appended styles for the new views (kv rows, status pills, log tails, warn/ok blocks); existing styles untouched.

### Demo/verification harness

- `scripts/demo-setup.mjs` — deterministic demo instance (config.json + dataDir with station schedule anchored to "now", aired history incl. a planted repeat, voice clips, pregenerated slots, WAV library, logs). Original config.json backed up/restored automatically.

## 2. Screenshots

In `docs/screenshots/` (desktop 1440×900, mobile iPhone 14 emulation):

| File | Shows |
|---|---|
| `listener-desktop-home.png` | Hero player, now playing, up next, history, favourites |
| `listener-desktop-schedule.png` | Week grid with ZDAJ / NASLEDNJI marks, timezone note |
| `listener-desktop-requests.png` | Request/dedication form + status checker |
| `listener-mobile-home.png` | Responsive mobile layout |
| `studio-desktop-onair.png` | Live overview (existing view, real demo data) |
| `studio-desktop-requests.png` | Moderation table with pending request + actions |
| `studio-desktop-library.png` | Rotation health incl. repeat warning + library table |
| `studio-desktop-voice.png` | Voice mode, Piper status (honest missing-model state), clips inventory |
| `studio-desktop-diagnostics.png` | Process/stream/playlists/repeats/errors/log tails (honest Icecast-unreachable state) |

## 3. Test commands and actual results

```
$ npm test
ℹ tests 49
ℹ suites 13
ℹ pass 49
ℹ fail 0
```

New suites (run with `node --test --test-concurrency=1`):

- `test/requestsStore.test.mjs` (11 tests) — validation rules, pending-only submission, IP-free public projection, moderation persistence, torn-JSONL tolerance, per-IP cooldown + pending cap failing closed.
- `test/scheduleGrid.test.mjs` (5 tests) — mid-slot on-air mark, slot-ended → no mark, **overnight spill never marks next week's cell** (date-scoped keys), empty schedule, timezone always reported.
- `test/diagnosticsUtil.test.mjs` (11 tests) — playlist stats, log tails, repeat detector (inside/outside window, ordering, clean history = zero offenders), honest Icecast unreachable probe, error-ring cap/order/never-throws.

Endpoint sweep on the running demo instance (all executed): public `now-playing/history/upcoming/schedule` → 200; `POST /api/requests` → 201 then 429 with the Slovenian cooldown message; studio `requests/diagnostics/library/rotation/voice` → 200 with Basic auth and **401 without**; approve flow → listener status check shows `approved` + note and never the IP.

## 4. Controls connected to real backend functionality

| Control | Backend |
|---|---|
| Play/pause, volume, mute | `/stream` proxy (Liquidsoap → Icecast) — unchanged |
| Now playing, progress | `/api/now-playing` (real `now_playing_track.json` written at segment boundaries) |
| Up next | `/api/upcoming` (real schedule + brief resolution) |
| Recently played | `/api/history` (real `history/aired.jsonl` written at track start) |
| Week grid | `/api/schedule` (real `station.json` schedule) |
| Request submission + status | `POST /api/requests`, `GET /api/requests/:id` (new, real store) |
| Favourites | localStorage (explicitly labelled local-only) |
| Studio moderation | `POST /studio/api/requests/:id/status` (real JSONL write) |
| Studio library/rotation | real local scan + real aired history |
| Studio voice | real filesystem/config facts (read-only) |
| Studio diagnostics | real probe/stats/ring/log tails |

Deliberately **not** implemented (documented gaps, per the issue's "honest unavailable state" rule): listener like-sending to server (no accounts exist), voice-mode activation from the studio (config+restart decision), listener counts anywhere except when Icecast's own stats answer.

## 5. Hourly-repeat root cause, fix, and evidence

Root cause was established and fixed in the issue #1/#2 audit work (see `docs/audit/2026-10-24-production-readiness-audit.md`): filler regenerations had no memory of what aired, so on a small library every regeneration re-picked the same tracks (measured pre-fix: 12/12 identical). The fix is the filler rotation ledger (`src/scheduler/fillerRotation.js`) + rotation-aware pool selection, guarded by `test/fillerRotation.test.mjs` (consecutive generations now 0 identical tracks on the same fixture).

Issue #2's interface side is covered by this work: Diagnostics exposes the repeat check over the **real aired history** inside the configured rotation window (screenshot shows the demo's planted 2× offenders), Library shows the same warning with counts and last-played timestamps, and the listener history displays true timestamps so consecutive-hour repetition is visible by eye. The demo's aired history contains a deliberate repeat — the UI flags it (red `2×` rows) rather than concealing it.

## 6. Remaining gaps and deployment/verification steps

Gaps:

1. Voice-mode switching from the studio is intentionally absent (read-only status view; switching = edit `config.json`, `sudo systemctl restart radioclyde`).
2. Listener favourites are device-local by design (no auth/accounts exist for listeners).
3. `/api/weather` returns 500 without outbound internet; the listener UI hides the weather chip in that case (verified).
4. Live `liquidsoap --check` + reboot drill still require the real server (same as issue #1's documented remaining risk) — commands are in `deploy/ubuntu/DEPLOYMENT_GUIDE.md`.
5. subwave reference repo has no license file detected via the GitHub API; consequently zero code/assets were reused — design inspiration only.

Verify on a real deployment:

```bash
sudo systemctl restart radioclyde
journalctl -u radioclyde -f            # web+scheduler process
curl -s localhost:8000/api/schedule | jq .timezone
curl -s -u <studio-user>:<pass> localhost:8000/studio/api/diagnostics | jq .stream
# listener: open http://<host>:8000/ (mobile + desktop), submit a request, check status,
# moderate it in /studio → Requests, watch Diagnostics → Repeat check.
```
