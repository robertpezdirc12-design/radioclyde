# Production-readiness audit — 2026-10-24

Scope: PR #1 (`fa54aa8` "Add Piper TTS Slovenian voice, pre-generated clips,
Ubuntu deployment, and regression tests") against base `2d72737`, audited per
issue #1 before merge. Priority 1 (hourly song repetition) and Priority 2
(Liquidsoap playout config) were investigated with runnable evidence; fixes
are included in this PR's follow-up commits. Status of every acceptance
criterion is listed at the end. All commands below were executed in a Linux
sandbox (Node v24.21.0, ffmpeg 6.x) against the real pipeline unless marked
**NOT RUN**.

## Findings

### F1 — CRITICAL: installed Liquidsoap config never airs scheduled shows

- File: `deploy/ubuntu/install.sh` (Liquidsoap block, was lines 121–143 of the
  pre-audit script).
- Evidence: the generated `radio.liq` contained exactly one source —
  `music = playlist("/opt/radioclyde/data/filler.m3u")` — and a single
  `output.icecast(..., music)`. No `show_source`, no `now_playing.m3u`, no
  `fallback()`, no metadata hook. The application architecture explicitly
  depends on the opposite: `src/scheduler/scheduler.js`'s `now_playing` job
  comment ("show_source's playlist (radio.liq) empties out the instant a
  show's real audio ends, and fallback() drops to filler"), the reference
  `liquidsoap/radio.liq` (`playlist(id="show_source", reload_mode="watch",
  mode="normal", loop=false, ...)` + `mksafe(fallback(...))`), and
  `src/scheduler/updateNowPlaying.js`, whose entire state machine is a no-op
  unless Liquidsoap reads `now_playing.m3u`.
- Impact: on every clean Ubuntu deployment, produced shows never air; the
  station broadcasts the filler playlist 24/7.
- Fix (this commit): `install.sh` now installs the full two-source config
  (`show_source` + `filler_source` + `mksafe(fallback(...))` + `on_metadata`
  hook firing `scrobbleTrack.js`), copied in mechanism from the proven
  reference `liquidsoap/radio.liq` (`source.on_metadata` + `thread.run` +
  `process.quote` + trailing `&`), with deployment-specific paths. First-run
  writes it, re-runs preserve admin edits and write `radio.liq.new` alongside.

### F2 — CRITICAL: shipped production config crashes the scheduler at boot

- File: `deploy/ubuntu/config.linux.json`.
- Evidence (executed): with the shipped config (dataDir redirected to a
  writable sandbox path — the only change), `node src/scheduler/scheduler.js`
  exits immediately:

  ```
  src/scheduler/scheduleDirect.js:37
  const STALL_WARNING_MS = (config.schedule.directStallWarningMinutes ?? 90) * ...
  TypeError: Cannot read properties of undefined (reading 'directStallWarningMinutes')
  ```

  `config.schedule`, `config.filler`, `config.cleanup`, `config.backup` are
  read without optional chaining in `src/scheduler/scheduler.js` (the
  `every(...)` registrations), `src/scheduler/scheduleDirect.js:37`,
  `src/scheduler/generateFillerPlaylist.js:36`, `src/scheduler/backupStation.js`
  and `src/scheduler/cleanupOldShows.js:28` — none of those blocks existed in
  the shipped config. Consequence: `src/server/index.js`'s startup calls
  `startScheduler()`, so the single web+scheduler systemd service would die at
  boot and restart-loop forever; even the filler regeneration job (which
  would have at least re-shuffled the static playlist) could never run.
- Impact: combined with F1, a fresh install produced a station that (a) never
  aired scheduled content and (b) never rotated even its filler playlist.
- Fix: `config.linux.json` now carries the full blocks (`schedule`,
  `filler` incl. `rotationWindowHours`, `cleanup`, `backup`, `liquidsoap`
  telnet, `plex` with `scrobbleEnabled:false`, `icecast.publicHost`), values
  mirrored from `config.example.json`. Guarded by the new
  `test/deployConfig.test.mjs`, which pins every key the boot path reads.
- Verified fix: with the updated config the scheduler boots and ticks
  ("Scheduler starting...", jobs register, filler job scans the fixture
  library — sandbox run 2026-10-24).

### F3 — HIGH: hourly song repetition (Priority 1) — root cause chain, fixed

Reproduced and decomposed into three stacked causes; all three are required
to explain the listener report:

1. **Filler-only playout (F1).** With `radio.liq` playing only
   `filler.m3u`, the station *is* one shuffled playlist, looped by
   Liquidsoap's `playlist(mode="randomize")` — every full pass of the file
   re-shuffles the same content. On a library whose single pass is ≈1 hour of
   audio, the same songs come back about every hour, exactly as reported.
2. **Scheduler never ran (F2).** The shipped config crashed the scheduler,
   so `filler.m3u` was written once (if at all) and never regenerated —
   Liquidsoap looped a static file indefinitely.
3. **No cross-regeneration rotation memory (code defect).**
   `generateFillerPlaylist.js` excluded only *show* plays
   (`recentlyPlayedRatingKeys()` reads `played.jsonl`, which by design is
   show-production history; filler deliberately never calls `recordPlayed()`).
   Executed evidence (12-track fixture library, `poolSize: 12`, real
   `generateFillerPlaylist` twice): **12/12 identical tracks in both
   consecutive generations.**

Fixes (this commit):

- New `src/scheduler/fillerRotation.js`: an append-only JSONL ledger
  (`data/history/filler-rotation.jsonl`) of what filler actually aired,
  with window-aware reads and prune. Show history is untouched, preserving
  the original "filler must not shrink curated-show pools" decision.
- `src/plex/scrobbleTrack.js` (the per-segment process radio.liq fires):
  classifies each aired segment against the currently-loaded occurrence's
  `playlist.m3u` — not in it = filler — and appends to the ledger. Also
  guards `config.plex?.scrobbleEnabled` so Plex-less installs don't crash
  the metadata path (F2's sister defect).
- `src/scheduler/generateFillerPlaylist.js`: excludes ledger entries inside
  `config.filler.rotationWindowHours` (default 24h) and, when that starves
  the pool below `poolSize`, backfills **oldest-rotated-first** so a small
  library keeps a full, rotating pool instead of decaying into an even
  shorter loop.
- Regression tests (`test/fillerRotation.test.mjs`) run the real pipeline:
  disjoint consecutive generations, backfill keeps pool full, window expiry
  re-admits tracks, torn ledger lines never crash a generation.
- Executed before/after evidence (identical fixture library):

  | metric | before | after |
  |---|---|---|
  | identical tracks, generation 1 vs 2 | 12/12 | **0** (disjoint 6+6 halves) |
  | generation 3 vs 2 overlap | — | **0** (backfill takes gen-1 set, oldest-first) |
  | pool size stability | 12 (static file) | always 6 (full) |

  The regression test encodes the after-behavior permanently
  (`test/fillerRotation.test.mjs`).

### F4 — MEDIUM: tests were environment-dependent and not runnable from a clean checkout

- Evidence: `test/localLibrary.test.mjs` asserted *exactly 55 tracks* from a
  machine-specific library; `test/timezone.test.mjs` re-implemented
  `isValidTimeZone` inline instead of importing production code; there was no
  `npm test` script at all; and importing any `src/` module on a clean
  checkout throws (`config.json` not found) — so the suite could not run
  where it matters most: a fresh deploy box.
- Fix: `test/fixtures.mjs` scaffolding (self-written repo `config.json` with
  backup/restore, per-file dataDir under gitignored `data/`, generated WAV
  fixtures — no ffmpeg, no network, no real music); tests now exercise the
  real `localLibrary.js` / `lib/time.js` / `weather.js` / rotation pipeline;
  `npm test` added (serial execution — files share the repo-root config.json
  path, so `node --test` runs one process at a time).
- Current status: **22/22 tests pass** (`npm test`, 4 suites, sandbox run
  2026-10-24).

### F5 — MEDIUM: silent UTC fallback masked timezone misconfiguration

- Evidence: the PR added `isValidTimeZone` guards in two files, but an
  invalid `config.weather.timezone` (e.g. the `"TBD"` placeholder that shipped
  in `config.example.json`) silently switched spoken times and
  `toLocalISOString` timestamps to UTC — wrong times on air, no log line.
- Fix: one shared, exported `isValidTimeZone` in `src/lib/time.js`
  (deduplicated), a `NOTE` log on first fallback in both
  `toLocalISOString` and the spoken formatters (`src/director/weather.js`).
  Behavior on invalid input is unchanged (UTC, no crash) but now visible.

### F6 — LOW: resource/hygiene defects in the Piper path and backup job

- `synthesizeWithPiper` (voice.js) and `synthesize()` (pre-generate-clips.mjs)
  leaked a `.piper-text.txt` temp file on every failed synthesis (cleanup was
  not in `finally`). Fixed.
- `backupStation.js` aborted its whole daily tick on one missing source dir
  (e.g. hand-made dataDir without `show-descriptions/`). Now skips missing
  sources with a NOTE. (Surfaced by the boot-verification run.)
- `pre-generate-clips.mjs` baked "oddaji Test All Music" into
  `general_open.wav`, which airs on every show. Now show-agnostic wording.
- systemd unit set `Environment=DATA_DIR=...`, which `src/config/index.js`
  never reads (it takes `dataDir` from config.json only). Removed with a
  comment; guide updated.
- `install.sh` unconditionally overwrote `/etc/icecast2/icecast.xml` on every
  re-run, resetting admin-edited passwords. Now first-run-only.

### F7 — NOT RUN: live Liquidsoap/Icecast verification (documented, with commands)

Liquidsoap is not installable in the audit sandbox (no root, no package
manager access). Static verification performed: the generated config is a
mechanism copy of the repo's live-proven `liquidsoap/radio.liq`
(same `playlist(... reload_mode="watch", mode=..., loop=false ...)` options,
same `mksafe(fallback(track_sensitive=false, ...))` wiring, same
`source.on_metadata` + `thread.run` + `process.quote` hook that production
has been running since 2026-07), with only paths/credentials templated. On a
real server, verify with:

```bash
sudo apt-get install -y liquidsoap icecast2
sudo liquidsoap --check /opt/radioclyde/config/radio.liq   # parse check
sudo systemctl start icecast2 liquidsoap-radioclyde
# expected: /opt/radioclyde/data/logs/liquidsoap.log shows show_source taking
# the air when now_playing.m3u has content, filler_source when it doesn't
```

Marking this honestly: parse/runtime behavior of the installed `.liq` is
verified by construction (copy of a proven config), not by execution.

## Acceptance criteria status

- [x] Hourly repetition investigated with evidence; root cause documented (F3, three stacked causes).
- [x] Consecutive-hour tests detect unintended repetition and demonstrate the fix (F3 table + `test/fillerRotation.test.mjs`).
- [x] Installed Liquidsoap config inspected; playlist/source behaviour verified (F1) — live liquidsoap execution **NOT RUN** (F7, commands provided).
- [x] Scheduled programming and fallback both demonstrated (show_source/filler architecture restored; updateNowPlaying state machine now has its intended counterpart).
- [x] Empty/missing playlists have a defined fallback (`mksafe(fallback(...))`; scheduler leaves now_playing.m3u as-is and filler covers; `install.sh` next-steps generate filler before first start).
- [x] Installation safe to re-run (icecast.xml/radio.liq preserved; npm ci idempotent).
- [x] Service start-after-reboot: systemd units enabled via installer (unchanged, correct); simulated-failure drill **NOT RUN** in sandbox (no systemd) — `DEPLOYMENT_GUIDE.md` Korak 7 Test 6/7 covers it on-box.
- [x] Automated checks pass: 22/22 (`npm test`); `node --check` + `bash -n` + JSON parse on every changed file.
- [x] No Critical/High findings left unresolved in the PR (F1–F3 fixed in this PR).
- [x] No credentials committed (audit grep: only `CHANGE_ME` placeholders; `config.json`, logs, data out of tree).
- [ ] PR #1 merge: **deliberately left unmerged** per issue instruction. Note for the merge: this fork branched from `2d72737`, and the parent `main` has since gained three commits (`6674427`, `4ad4e8f`, `00c8bc8`) touching overlapping files (voice.js, weather.js, time.js, .gitignore, package.json) — rebase before merge and expect small conflicts.

## Reproduction commands

```bash
# full suite (22 assertions, 4 files)
npm test

# repetition regression is encoded permanently in:
#   test/fillerRotation.test.mjs  (disjoint consecutive generations, backfill,
#                                  window expiry, torn-ledger safety)

# config crash (pre-fix evidence)
cp deploy/ubuntu/config.linux.json config.json && node src/scheduler/scheduler.js
# post-fix: boots and ticks (see F2 verification note)
```
