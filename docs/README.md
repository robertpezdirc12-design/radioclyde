# Documentation

Design rationale and hard-won empirical facts for the radioclyde show-producer
pipeline redesign (started 2026-07-26), kept here so a future session doesn't
have to re-derive them from scratch. The shelf has since grown to cover the
whole station — architecture docs are in English, operational and analysis
docs mostly in Slovenian.

- [producer-pipeline.md](producer-pipeline.md) — architecture of the new
  track-selection + research pipeline: what each stage does, why it's built
  the way it is, and what's still open/not yet built.
- [auto-radio.md](auto-radio.md) — the deterministic `autoRadio` mode: a
  station with no LM and no neural TTS (rule-based track selection, template
  speech, pre-recorded/SAPI/espeak voice), stage-by-stage against the AI
  path, and how to switch it on.
- [imaging-layer.md](imaging-layer.md) — the Liquidsoap imaging layers:
  top-of-hour station IDs, periodic stingers, auto-produced promos, emergency
  bed, dead-air guard and telnet-pushed talk-over beds (the Val 23 format
  clock auto-produces the weather/next-show beds on top), with every
  operator's semantics verified against the Liquidsoap sources.
- [liquidsoap-upgrade.md](liquidsoap-upgrade.md) — the runtime upgrade
  runbook 2.2.4-1+dev → 2.4.6 (P3 #11): why exactly that version, what the
  `%ifversion` gates change on the box, and the post-upgrade verification.
  Since Val 30 it also carries `scripts/fetch-liquidsoap.mjs` — running the
  OFFICIAL Liquidsoap binaries userspace (anonymous registry pull, no root,
  no docker) for a pre-flight `--check` before any opam build; its 2026-10-27
  run caught and fixed a real 2.4.6 parse regression in radio.liq.
- [android-tv-app.md](android-tv-app.md) — architecture of the native
  Android TV/Google TV client (`android-tv/`, a separate Gradle project in
  this repo): package layout, the backend API it consumes, key design
  decisions, and gotchas already hit (don't reintroduce them).
- [android-mobile.md](android-mobile.md) — architecture of the native
  Android phone/tablet client (`android-mobile/`, another separate Gradle
  project): what's different from the TV app (touch UI, no clock/weather,
  the dual internal/external server-profile auto-reachability design),
  package layout, key design decisions.
- [adding-a-dj.md](adding-a-dj.md) — end-to-end walkthrough for introducing
  a new DJ persona: the `prompts.json` roster entry, the per-persona voice
  settings in `config.json`, optional photo, and wiring a show's brief to
  actually use it.
- [subwave-deep-analysis.md](subwave-deep-analysis.md) — deep analysis of
  SUB/WAVE, the reference agentic-AI-DJ station project: what it actually
  is, where it beats us, where we win, and which deterministic ideas were
  borrowed for issue #2.
- [ready-made-scripts-analysis.md](ready-made-scripts-analysis.md) — survey
  of ready-made broadcasting scripts on GitHub (auto show generation,
  speech↔music transitions, imaging/announcing), hypothesis-first and
  verified against primary sources, ending in a comparison matrix and the
  P1–P3 borrowing list.
- [show-generation-research.md](show-generation-research.md) — research for
  auto-generated shows and between-song trivia (GitHub + deterministic
  sources); trivia slots #17/#19 from it are implemented
  (`src/auto/trivia.js`, `src/auto/rockFacts.js`).
- [issue-2-implementation-report.md](issue-2-implementation-report.md) —
  implementation report for issue #2, the SUB/WAVE-inspired listener & owner
  interfaces: new schedule/requests/diagnostics/library endpoints, all
  honest-data, executed against a real running instance.
- [p1-listener-experience.md](p1-listener-experience.md) — implementation
  report for the five P1 listener-experience items from the SUB/WAVE
  analysis: `.m3u`/`.pls` playlist files, PWA/MediaSession, peak-listener
  counter, request chips, and the embed player.
- [listener-analytics.md](listener-analytics.md) — implementation report
  for the audience ledger: a scheduler job samples Icecast every minute
  into a JSONL ledger, and a studio Analytics view charts the series plus
  per-track listener impact.
- [ui-admin-vs-poslusalec.md](ui-admin-vs-poslusalec.md) — inventory of
  the two web interfaces, admin Studio (nine views, Basic Auth) vs. the
  listener site, compared against best-in-class platforms with the real
  gaps ranked (P5 #2).
- [autocue-loudness.md](autocue-loudness.md) — EBU R128 loudness alignment
  via a narrowly-scoped slice of the autocue pattern: only `liq_amplify`,
  the one field our Liquidsoap 2.2.4 build actually reads. Now also the
  ending-aware crossfade tail pass (the extra `-sseof -20` ebur128
  measurement and the 8–12 s `liq_cross_duration` decision table).
- [stream-mounts.md](stream-mounts.md) — the optional Ogg-Opus/Ogg-FLAC
  mounts and the hourly MP3 archive: generated `streams.liq`, restart
  semantics, bitrate ladders, every published surface, and the player
  upgrade rules.
- [lyrics-lrclib.md](lyrics-lrclib.md) — the LRCLIB synced-lyrics stack
  (Slovenian): client constants, LRC parsing rules, cache/recheck semantics,
  the `GET /api/lyrics/current` contract and its honest-state table.
- [scrobbling.md](scrobbling.md) — Last.fm + ListenBrainz scrobbling
  (Slovenian): the eligibility rule, the headless mobile-session auth flow,
  the privacy note, and the honest limitations.
- [skills.md](skills.md) — the SKILL.md rubrique format (Slovenian):
  frontmatter grammar, cooldown precedence, feed wiring, and why the
  SUB/WAVE trust gate is deliberately not ported.
- [plex-library-notes.md](plex-library-notes.md) — empirical facts about this
  specific Plex library and its API behavior, confirmed live against the
  real server (not assumptions from Plex's general documentation).
- [plex-album-shopping-list.md](plex-album-shopping-list.md) — prioritized
  album shopping list: gap analysis of the Plex library against the
  best-selling / Rolling Stone canon; work top to bottom.
- [audit/2026-10-24-production-readiness-audit.md](audit/2026-10-24-production-readiness-audit.md)
  — pre-merge production-readiness audit of PR #1 (Piper Slovenian voice,
  pre-generated clips, Ubuntu deployment, regression tests), with runnable
  evidence for the hourly-repetition and playout findings.

Related docs at the repo root (not moved here):
- [`../README.md`](../README.md) — project overview, setup, and the npm
  scripts reference (pipeline + preview/dry-run tools).
- `script-format.md` — the `.script.md` *output* grammar a future "director"
  will mechanically consume to produce broadcast assets. Still current.
- `sample-data/show-descriptions/*.md` — older, loosely-specified prose show
  briefs. Being superseded by the new structured Track Selection format
  described in `producer-pipeline.md`.
