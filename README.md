# Radio Markec

**A self-hosted internet radio station that runs itself** — a real, continuous
Icecast stream on a schedule you define, with a weekly lineup of shows, each
backed by its own tracklist, its own DJ script, and its own DJ voice. When
nothing is scheduled, it falls back to shuffled library filler instead of
going quiet.

Tune in however you like: the raw Icecast stream in any player, a clean web
now-playing page in the browser, a native Google TV app for the living room,
or a native Android app for listening on the go.

Nothing here is a hosted service or SaaS: it is orchestration code you run
against your own Plex server (or plain music folders), and your choice of
voice engine — including a **fully deterministic mode with no language model
and no neural TTS at all**.

<p align="center">
  <img src="docs/web.png" alt="Web now-playing page" width="49%">
  <img src="docs/GoogleTV.jpg" alt="Google TV app" width="49%">
</p>

## How it runs (one deterministic pipeline)

Since Val 28 the station is **script-only, with no AI models anywhere**
("samo skripte brez AI modelov"): the deterministic `autoRadio` pipeline is
THE pipeline. (The old dual-mode architecture — a classic LM Studio
LLM + Chatterbox TTS mode behind `autoRadio.enabled: false` — was removed
outright; see the commit message and docs/auto-radio.md for the history.)

| | The station |
|---|---|
| Track selection | Deterministic rule parser + rule-based queue (artist cooldown, popularity mix, decade spread, time-of-day steering) |
| DJ script | Relaxed Slovenian rock-register templates filled from library metadata (short sentences, sparse fillers, pooled variants, varied fenceposts) |
| Voice | **Edge neural TTS** / **local Piper** / pre-recorded clips / Windows SAPI / espeak-ng / none |
| Service segments | **Live data rubriques**: ARSO weather, RTV Slovenija sport headlines, Wikidata "on this day" |
| Hardware needed | Any box — even a Raspberry Pi |
| Offline capable | Yes (`--offline` dry-run, music-only fallback) |

The scheduler, director, Liquidsoap/Icecast playout, web pages and mobile
apps are all shared and unchanged. Configs that still carry the old
`lmStudio`/`chatterbox` blocks or `autoRadio.enabled` simply ignore them —
`npm run doctor` tells you they're deletable.

## What it does

A single long-running scheduler daemon watches the clock and, for every
upcoming show occurrence, runs two phases:

1. **Produce**: turns a show's prose brief (`show-descriptions/*.md`, see
   [sample-data/](sample-data/) for real examples) into a validated
   `.script.md`. In AI mode this resolves the brief into a real Plex query,
   picks tracks, researches facts, and writes every DJ line. In auto mode the
   brief is parsed by rules, tracks are picked by rules, and every line comes
   from a template.
2. **Direct**: turns that finished script into real broadcast assets.
   Synthesizes and caches the DJ audio, resolves any live segments (time,
   weather) fresh, and assembles the playlist Liquidsoap actually plays.

Everything ahead of air time can also be **prewarmed**: during a
configurable daily downtime window, the scheduler widens its horizon and
produces/directs the *whole* upcoming broadcast day at once, front-loading
the heavy work onto the hours nobody's listening rather than doing it
just-in-time.

See [docs/producer-pipeline.md](docs/producer-pipeline.md) for why this is
built as a multi-phase pipeline rather than one open-ended agent loop, and
[script-format.md](script-format.md) for the `.script.md` grammar the two
phases hand off through.

## Features

- **Scheduled shows, not a static playlist**: a weekly `station.json`
  lineup, each slot backed by a plain-prose brief (artist/genre/decade,
  exclusions, repeat rules, popularity weighting, max track length; details
  below) resolved against your actual library.
- **Date overrides and replays**: a whole calendar day can replace its weekly
  template (`schedule.dates["2026-12-25"]` — holidays, one-off events; an
  empty list is a deliberate dark day), and any slot can be a `replay` of a
  recent episode instead of a fresh production — see Paket C in
  [docs/auto-radio.md](docs/auto-radio.md).
- **Auto mode: rule-based selection you can audit**: artist cooldown against
  real play history (`history/played.jsonl`), a popularity mix (~70% well
  known / 30% deep cuts) split at the library's popularity median, decade
  spread, and time-of-day mood blocks (morning/daytime/evening/night, with
  cross-midnight windows and optional per-block `preferredGenres` soft
  steering — the station brief's identity always wins) — every decision
  deterministic and reproducible.
- **Auto mode: Slovenian rubriques from live data**: today's weather from
  **ARSO** (official Slovenian Environment Agency), sport headlines from
  **RTV Slovenija**, and "na današnji dan" births/deaths from **Wikidata**
  (Slovenian labels only, grammatical gender handled) — each rendered
  through the same template system, each degrading gracefully to "skip the
  segment" if its source is unreachable. Music never stops.
- **AI mode: scripts with real research**: every DJ line is written against
  real track/artist facts pulled from Wikipedia, so the DJ can drop genuinely
  useful trivia, or turn it into a quiz before the track starts. A final
  editing pass catches repeated phrasing across a script no single writing
  step could see all at once.
- **Distinct DJ personas**: each show picks a persona (photo + voice); speech
  is synthesized and cached per persona. Auto mode maps personas onto neural
  Slovenian voices `sl-SI-PetraNeural` / `sl-SI-RokNeural` with zero setup —
  or onto the fully local Piper voice `sl_SI-artur-medium` (piper1-gpl): the
  model downloads once into `<dataDir>/piper` and synthesis is 100% offline
  and CPU-only afterwards, no GPU, no cloud. The studio Voice view reports
  the voice-key cache state honestly — what is downloaded, what is missing,
  and the exact command to fix it. Speech pacing follows the day (Val 33):
  an opt-in `voice.daypartProsody` profile per time-of-day block (the same
  blocks the greeting variants and genre steering already live by) lets the
  morning drive run brisker and the overnight hours speak slower and closer
  — one clock truth for the whole station, full Piper parity, and a doctor
  check that gives silently-mistyped profile keys a voice.
- **Live segments resolved fresh**: time/weather call-ins are generated at
  air time from real data, not baked into yesterday's recording.
- **The station announces what's next (Paket B1/A3)**: every directed show
  ends with a spoken handoff to the next show ("Kaj sledi po tej oddaji?
  jutri ob 01:18 vas čaka …"), resolved fresh at direction time so a late
  schedule edit lands in the announcement, and the listener page hero
  carries a matching "Naprej: <oddaja> — <dan> <ura>" line — both degrade
  honestly (plain goodbye / hidden line) when no next show exists.
- **Filler that never sleeps**: off-air gaps are filled by a generated
  filler playlist (music source-routed, so it works with Plex or local
  folders alike), with a rotation ledger that remembers what filler already
  aired — no "songs repeat every hour" on small libraries.
- **Listener analytics**: Icecast's listener count is sampled once a minute
  into an append-only ledger; the studio Analytics view charts the audience
  over time and joins it with the real aired history for per-track
  impact (Δ listeners start→end per play). Outages are stored as explicit
  gaps, never interpolated — [details](docs/listener-analytics.md).
- **Real listener count on the public page**: a topbar chip shows how many
  people are listening right now, with proper Slovenian pluralization;
  when Icecast doesn't answer, the chip hides itself instead of showing a
  stale number.
- **External now-playing (optional, off by default)**: every aired track
  updates TuneIn's metadata via the AIR API, and curated show tracks post
  to a Discord webhook — both configured in `config.json`'s `broadcast`
  block, both failure-safe (a dead webhook can never affect playout).
- **Listeners everywhere**: Icecast stream (announcing itself to players
  with `name`/`description`/`genre` icy metadata, Paket B3), web
  now-playing page, JSON API, authenticated stream proxy, studio admin UI,
  native Android TV/Google TV and Android mobile apps.
- **Playlist files for hardware players**: `GET /listen.m3u` and
  `/listen.pls` hand Sonos, VLC, car head units and old internet radios the
  stream URL (owner-declared `broadcast.publicStreamUrl` wins, otherwise
  derived exactly like the API reports it) — [details](docs/p1-listener-experience.md).
- **PWA + MediaSession**: installable web app (manifest + service worker
  caching only the app shell — the stream and APIs are never cached);
  lock-screen/headphone controls are play/pause/stop only, deliberately not
  next/previous, because one shared stream means one DJ.
- **Peak listeners**: the topbar chip also shows the sampling ledger's
  24-hour peak ("vrh 24 h"), and the studio Analytics view adds window and
  ledger-lifetime peaks — a peak is shown only when the ledger actually
  measured one, never invented (gaps are not zeros).
- **Deterministic request chips**: the request form suggests the currently
  playing artist/track and up to three recent-history artists, each filling
  the form from data the page already has — no randomness, no AI, no extra
  calls.
- **Optional embeddable player + public paths**: `web.publicPaths`
  (default `[]` = fully private, unchanged behavior) opens selected path
  prefixes to anonymous visitors; together with the self-contained
  `/embed.html` mini player it enables site embedding and anonymous player
  URLs when you decide the stream should be public — [decision guide](docs/p1-listener-experience.md).
- **Imaging layer**: station ID overlay at the top of the hour (official
  Liquidsoap overlay recipe with `normalize=false` — the recipe's default
  `normalize=true` had silently played the whole station at HALF volume
  since the layer's introduction, and in combination with the dead-air
  guard's `blank.strip()` starved the program on both official 2.2.4 and
  2.4.6 binaries; found and fixed by live bisection in Val 32, so an
  existing install gets its +6 dB back with a plain `git pull`), timed
  stingers (`delay()`-gated, track-boundary only), schedule-driven
  auto-produced promos (Paket B2) and an emergency bed below the program
  sources — all four degrade gracefully: an empty/missing clip directory
  simply drops that layer off air, never the program —
  [design & asset production](docs/imaging-layer.md),
  [fix history](docs/auto-radio.md).
- **Beds ("postelje", P3 #12/#13)**: announcements OVER the music — the
  program ducks to 20% while a pushed clip plays on top (`beds.push` over
  telnet, CLI `src/liquidsoap/bedQueue.js`). Since #13 a stdlib-native
  sidechain ducker (the same `rms.smooth` + `on_frame` + `amplify` getter
  mechanism this build's `normalize()` uses) ducks on the clip's ACTUAL
  loudness — attack ~20 ms, release ~0.5 s, hysteresis — so the music
  breathes back during speech pauses instead of staying ducked for the whole
  clip. No `sidechaincompress` exists in any Liquidsoap 2.x (it's an ffmpeg
  filter name, verified upstream); everything here runs on verified 2.2.4
  stdlib. Since Paket D1 (Val 23) the station also AUTO-PRODUCES beds on a
  format clock — weather at the `weatherMinutes` marks (:15/:45 by default)
  and the next-show handoff `nextShowLeadMinutes` before the switch — via
  `src/scheduler/formatClock.js` (OPT-IN `config.imaging.beds`, produced
  minutes ahead, pushed at the exact minute, no `radio.liq` change —
  [imaging-layer.md §5](docs/imaging-layer.md)). Since Val 25 the weather
  rubric can be dayparted (`imaging.beds.weatherDaypart` — a quiet night by
  one config line, clockwheel's window semantics) and the whole format clock
  is manually triggerable on demand: CLI `node src/scheduler/formatClock.js
  trigger weather|nextshow [showId]` or the MCP `beds_trigger` tool (fresh
  production + immediate push, honoring only the master OPT-IN gate).
- **DJ transition effects (P3 #11), live-verified on the real engine**: sweep
  / washout / dissolve seams between music tracks, borrowed from SUB/WAVE's
  production mixer and gated behind `%ifversion >= 2.4.6` — on the current
  2.2.4 build the file is stripped before parsing and the station boots
  byte-identically to pre-#11. The 2.4.6 path was exercised LIVE on real
  2.4.6 binaries (extracted from the official Docker image and run without
  root: `--check`, the full source graph, and an on-air run where washout
  and dissolve actually fired while speech seams hard-cut) — three defects
  only the real engine could reveal (a mandatory `synchronous` argument, the
  method-extension `self_sync` conflict with `cross()`, the pre-2.4.6
  post-cross metadata double-fire) were caught and fixed that way. Only the
  box's own runtime upgrade remains ([runbook](docs/liquidsoap-upgrade.md)).
  The music chain wraps in a low-level `cross()` whose per-seam transition
  hard-cuts every seam touching speech or a jingle (`source_tag` dispatch —
  the DJ is never faded) and applies the effect stamped on the track via
  `src/liquidsoap/stampTransitionFlags.js`. Imaging layers sit ABOVE the
  cross, so a stinger is never blended — [status](docs/subwave-deep-analysis.md).
- **R128 loudness alignment (autocue gain layer)**: a budgeted offline scan
  measures every library track's integrated loudness with one ffmpeg ebur128
  pass; playlist entries then carry `liq_amplify` and radio.liq's
  `amplify(override=)` applies the correction — no more loudness jumps
  between tracks. Derived at read time from a configurable target
  (−16 LUFS, the LS 2.2.5 default), positive gain clamped (no limiter in the
  chain), speech/imaging untouched, and everything degrades to today's
  behavior for any track without an analysis — [design](docs/autocue-loudness.md).
- **Ending-aware crossfades**: the same offline scan now measures how every
  track ENDS — one extra ffmpeg ebur128 pass over the last 20 s (`-sseof -20`)
  yields a momentary-loudness series; a fade-out tail (last 1.5 s mean more
  than 16.5 dB under the tail's p95, with a ≥ 3 s wind-down) earns a
  `liq_cross_duration` stamp of 8–12 s (SUB/WAVE's decision table, shaped by
  the body-to-tail loudness drop), and radio.liq's CROSS STAMPS rewrite feeds
  it to `cross()` as per-track buffer sizes — the fade rides out at its own
  length instead of being chopped at the 3.5 s station default. Cold endings,
  speech and jingles stay unstamped (byte-identical seams), and the
  hard-cut `sequence([a, b])` branch guarantees the DJ is never overlapped
  whatever a stamp says — [design](docs/autocue-loudness.md).
- **Hit-the-post DJ ramps (Val 32)**: the same offline scan also measures
  how every track OPENS — one extra ffmpeg pass over the first 32 s
  through a 250–3200 Hz formant-band presence series finds the moment the
  intro "fills up" (the post a ramping DJ must hit). When a speech→music
  seam can cover itself (speech ≤ window ≤ fill − 1.5 s margin, one intro
  clip), the director stamps both sides (`liq_ramp`) and
  `dj_transitions.liq` plays the DJ OVER the ducked song (floor 0.2, the
  same program floor as beds), lifting it back to full at the seam — the
  DJ is never stepped on, the song never loses anything. (The ramp branch
  is `%ifversion`-gated to 2.4.6 like the other transition effects — on
  the current 2.2.4 runtime the stamps are inert and every seam stays
  today's hard cut.) Songs loud from
  the very first second carry no window (the seam stays today's hard
  cut), and an unmeasured library is byte-identical to before.
  Live-verified on the official 2.4.6 binary with a Goertzel probe
  (speech at full level, song at exactly 0.2 during the talk, rise over
  ~0.3–0.5 s at the seam) — [details](docs/auto-radio.md).
- **Voice-chain compression + silent lead-in (SUB/WAVE's mixer borrowed)**:
  pushed beds are peak-tamed by a 5 ms-attack 4:1 compressor before they
  hit the ducked mix, and the whole bus passes a brick-wall limiter
  (20:1 at −1 dBFS) as the last operator before every encoder — the one
  thing the R128 gain layer cannot do, catching MP3 inter-sample peaks.
  Each bed push is also preceded by a 0.8 s calibrated lead-in clip, so the
  RMS ducker finishes ducking BEFORE the first word (adapted honestly:
  subwave's pure-silence trick would *release* our loudness-keyed ducker,
  so the lead-in is near-inaudible brown noise just over the duck
  threshold). Both compressors sit behind `%ifdef compress` — a Liquidsoap
  build without the extra operator library boots byte-identically to
  before.
- **Smart rotation rules**: the off-air filler pool is no longer plain
  shuffle — tracks aired more often in the last 7 days surface later
  (weighted by a merged show+filler play counter), tracks added to the
  library in the last 7 days get a novelty boost, and per-playlist caps
  (30 tracks/artist, 5 per artist+album) keep a compilation-heavy library
  from flooding the pool. Every knob lives in `filler.rotation` and zeroes
  itself off individually; a full pool always beats an enforced cap —
  [analysis §4.1](docs/ready-made-scripts-analysis.md).
- **Format ura (clockwheel)**: the filler hour can follow a named, operator-
  readable shape — steps pointing at pools ("1 chill, 4 from the general
  rotation, repeat"), N tracks per step, optional dayparts (first matching
  window wins). Pools are config-defined filters (artists, genres, keywords)
  over the library; tracks claimed by a pool never leak back into the general
  rotation. Borrowed from AzuraCast's Playlist Groups design — the shipped
  `radio.liq` already plays the wheel exactly as Node writes it
  (`mode="normal"`, Paket A1); see
  [analysis §4.5](docs/ready-made-scripts-analysis.md).
- **Segment taxonomy + min-inventory metric**: every show segment carries a
  content type from a small closed set (show_intro/outro, listener_mailbag,
  news_analysis, deep_dive, ...) — explicitly via an optional `segment:`
  field in `script.md`, inferred from slot/position otherwise. The studio
  Diagnostics view reports, per upcoming slot, whether the script is ready:
  it exists, it parses, and it meets the station's speech/track minimums
  (WRIT-FM's health metric) — see
  [analysis §4.2](docs/ready-made-scripts-analysis.md).
- **Listener requests reach the air**: the studio dashboard's Queue button
  pushes an approved request onto Liquidsoap's `request.queue` over telnet —
  it plays at the next track boundary with no competition from the playlist
  reload. Free-text (artist, title) is matched against the library
  diacritics-insensitively and never approximated; every outcome (queued,
  not in library, Liquidsoap unreachable) is written back into the request's
  note so the dashboard always shows the truth —
  [analysis §6](docs/ready-made-scripts-analysis.md).
- **Dead-air guard**: a file that decodes to silence no longer plays silence
  for its whole duration — `blank.strip()` (official cookbook recipe,
  semantics verified against this build's `noblank.ml`) makes the program
  unavailable after 20 s of continuous silence so the emergency bed covers
  it, while two `blank.detect` observers log every episode to a ledger the
  studio Diagnostics view reports ("the guard worked" vs "even the emergency
  bed is dead"). Boundary micro-gaps and produced speech pauses never
  trigger it — [analysis §3](docs/ready-made-scripts-analysis.md).
- **Deterministic Smart Blocks**: name a block once in `config.smartBlocks`
  (criteria + a count/minute limit + an order — LibreTime's model,
  semantics verified from their docs), then reference it from any show brief
  with one line (`- smart block: friday-night-jazz`) and the block expands
  deterministically into the exact tracks it will play. Blocks run through
  the same eligibility chain as everything else (recently-played, station
  bans, dedupe, durations), never overflow their limit unless asked, and
  report under-fill honestly; `previewSmartBlock.js <name>` shows exactly
  what a block would schedule right now, and the studio API exposes live
  previews — [analysis §4.4](docs/ready-made-scripts-analysis.md).

## Meet the DJs

Each persona has its own photo, shown alongside its voice in the web
now-playing page and the Google TV app.

<table>
<tr>
<td align="center"><img src="public/dj-photos/abigail.jpg" width="100"><br>Abigail</td>
<td align="center"><img src="public/dj-photos/adrian.jpg" width="100"><br>Adrian</td>
<td align="center"><img src="public/dj-photos/alexander.jpg" width="100"><br>Alexander</td>
<td align="center"><img src="public/dj-photos/alice.jpg" width="100"><br>Alice</td>
<td align="center"><img src="public/dj-photos/austin.jpg" width="100"><br>Austin</td>
<td align="center"><img src="public/dj-photos/axel.jpg" width="100"><br>Axel</td>
<td align="center"><img src="public/dj-photos/connor.jpg" width="100"><br>Connor</td>
</tr>
<tr>
<td align="center"><img src="public/dj-photos/cora.jpg" width="100"><br>Cora</td>
<td align="center"><img src="public/dj-photos/elena.jpg" width="100"><br>Elena</td>
<td align="center"><img src="public/dj-photos/eli.jpg" width="100"><br>Eli</td>
<td align="center"><img src="public/dj-photos/emily.jpg" width="100"><br>Emily</td>
<td align="center"><img src="public/dj-photos/everett.jpg" width="100"><br>Everett</td>
<td align="center"><img src="public/dj-photos/gabriel.jpg" width="100"><br>Gabriel</td>
<td align="center"><img src="public/dj-photos/gianna.jpg" width="100"><br>Gianna</td>
</tr>
<tr>
<td align="center"><img src="public/dj-photos/henry.jpg" width="100"><br>Henry</td>
<td align="center"><img src="public/dj-photos/ian.jpg" width="100"><br>Ian</td>
<td align="center"><img src="public/dj-photos/jade.jpg" width="100"><br>Jade</td>
<td align="center"><img src="public/dj-photos/jeremiah.jpg" width="100"><br>Jeremiah</td>
<td align="center"><img src="public/dj-photos/jordan.jpg" width="100"><br>Jordan</td>
<td align="center"><img src="public/dj-photos/julian.jpg" width="100"><br>Julian</td>
<td align="center"><img src="public/dj-photos/layla.jpg" width="100"><br>Layla</td>
</tr>
<tr>
<td align="center"><img src="public/dj-photos/leonardo.jpg" width="100"><br>Leonardo</td>
<td align="center"><img src="public/dj-photos/michael.jpg" width="100"><br>Michael</td>
<td align="center"><img src="public/dj-photos/miles.jpg" width="100"><br>Miles</td>
<td align="center"><img src="public/dj-photos/olivia.jpg" width="100"><br>Olivia</td>
<td align="center"><img src="public/dj-photos/ryan.jpg" width="100"><br>Ryan</td>
<td align="center"><img src="public/dj-photos/taylor.jpg" width="100"><br>Taylor</td>
<td align="center"><img src="public/dj-photos/thomas.jpg" width="100"><br>Thomas</td>
</tr>
</table>

## Components

| Component | Role |
|---|---|
| **Node.js** (this repo) | Orchestration: scheduling, script production, directing, the web server/API |
| **Plex Media Server** or local folders | Music library backend: track/artist/album metadata and search |
| **Piper** (optional) | Local neural text-to-speech (piper1-gpl): one Slovenian voice, ~60 MB model, fully offline after a one-time download |
| **Liquidsoap** | Playout engine: plays the directed playlist or falls back to filler, feeds Icecast |
| **Icecast** | The actual stream server listeners connect to |
| **Fastify** | Web server: now-playing page, JSON API, authenticated stream proxy, password-protected studio admin, and the scheduling daemon (one merged process) |
| **Android TV / Google TV app** (`android-tv/`) | Native Java/Leanback client, independent Gradle project |
| **Android mobile app** (`android-mobile/`) | Native Java/Material phone-tablet client, independent Gradle project |

## Setup

1. `npm install`
2. Copy `config.example.json` to `config.json` and fill in real values
   (Plex token, Icecast credentials, studio admin password, the
   `autoRadio` block for voice/rubrics/music rules)
3. Put your show briefs in `<dataDir>/show-descriptions/` and your weekly
   lineup in `<dataDir>/station.json` (date overrides for holidays and
   `replay` slots ride in the same file)
4. `npm run runweb` — the scheduler + web server in one process

For a station with zero speech hardware, set
`"autoRadio": { "voice": { "mode": "edge" } }` — see
[docs/auto-radio.md](docs/auto-radio.md) for the complete Slovenian
reference. Try one show end-to-end without touching Plex or the network:

```
npm run preview-auto-show -- <show-name> --offline
npm run direct-show -- --id=<show-name> --weekday=<weekday> --date=<yyyy-mm-dd> --time=<HH:MM>
```

### Rarely used config keys

A few `config.example.json` keys have no home in the feature docs; what they
actually do (verified against the consuming code):

- `scripts.defaultRepeatWindowDays` (number, default `7`) — the repeat
  window applied when a show brief carries no `**Repeat window:**` line of
  its own (`src/producer/showBrief.js`).
- `plex.librarySectionId` (string) — the Plex music library's section id;
  every `/library/sections/<id>/...` call in `src/plex/` (tracks, albums,
  artists, genres) bakes it in.
- `musicLibrary.plexPathPrefix` + `musicLibrary.localMountPath` (strings) —
  together they map a Plex-served file path to the same file on local disk
  (`toLocalPath()` in `src/plex/musicLibrary.js`), which is how the
  director, the filler generator and the request queue hand Liquidsoap a
  playable local path.
- `push.subject` (string, default `mailto:radio-markec@example.com`) — the
  VAPID `mailto:` contact carried in Web Push authorization headers
  (`src/push/dispatch.js`).

## Writing a show's Track Selection brief

Briefs are plain markdown. `**Personas:**`, `**Duration:**` and a
`## Track Selection` section are all the pipeline needs; everything else is
prose for humans. The selection section supports:

- `genre:`, `decade:`, `artist:`, `artists:`, `album:`, `folder:`,
  `exclude:`, `prefer:` lines (AI mode also understands free themes)
- English or Slovenian rule sentences: *Don't repeat the same artist in a
  single show* (artist cooldown, 3 h station-wide by default), *No track
  longer than 5 minutes*, *Favor well-known tracks* (popularity mix)
- `Rubrike: vreme, šport, obzorje, zanimivosti, glasba, kviz` — opt the show into the
  live-data service segments, deterministic per-artist + general rock trivia
  ("Zanimivosti": MusicBrainz / sl.wikipedia fact before the artist's track,
  plus an offline Slovenian rock-history corpus), the musician-filtered
  "Na današnji dan v glasbi" and the offline "Kviz" — a real rock question
  before the middle track, answer revealed right after it
  (see [docs/auto-radio.md](docs/auto-radio.md))
- **Doctor + cron vzorec**: `npm run doctor` (P4 #31) je predvečerna
  diagnostika; s `--cron` dodatno izpiše crontab vzorec, izpravljen iz
  station.json — vsak DISTINCT začetek termina dobi en predhodni pregled
  15 min pred začetkom (za polnočjo termini premaknejo dan-of-teden nazaj;
  glej [docs/auto-radio.md](docs/auto-radio.md)). Sedaj v SUB/WAVE-ovem
  Finding modelu: trinajst osnovnih preverjanj, opozorila nosijo »namig«
  (kje poglej) in »popravi« (kaj stori), novih šest pa pokriva oddajno verigo
  sam — icecast dosegljivost, liquidsoap telnet (`uptime`), stanje
  predvajalnih list (m3u), arhiv/prostor na disku (20 GB / 2 GB meji),
  obremenitev gostitelja (CPU/spomin) in število napak v dnevnikih zadnjih
  24 h. Val 26 (doktor dohiti postajo) dodaja PET preverjanj za površino,
  ki je zrasla naknadno in jo bralci namenoma tiho odpuščajo: **urnik**
  (station.json — pokvarjen JSON je NAPAKA, ne-seznam pod delovnim dnem
  prav tako, saj loadSchedule ob vsakem branju vrže; slabi datumski
  prepiši, neznani dnevni ključi in pojavitve brez veljavnega časa so
  poimenovana opozorila), **imaging plasti** (kipi v mapah IN etrne .m3u
  datoteke — kipi brez etrne liste pomenijo »tik ne teče«; prazna nujna
  rezerva je opozorilo o tišini ob padcu vseh virov), **formatno uro**
  (F2 gumbi postelj, pometanje generiranih kipov čez zadrževanje —
  operaterjeve datoteke niso nikoli preštete — in knjiga sprožitev;
  HH:MM slovnica je pravi `parseWheelTime`, pometanje šteje s pravim
  `GENERATED_BED_RE`), **kolo** (clockwheel drop-and-count števke, koraki
  v nedoločene bazene, rezervirano ime) in **rezervne kopije** (starost
  najnovejše datirane mape proti dvakratniku intervala — tiho ugasnjen
  scheduler ne piše ničesar, doktor pa pove). Val 28 doda **prehode**
  (merjena prehodna plast: koliko vnosov filler.m3u nosi izmerjene prehode
  in žige), Val 33 pa **tempo** (dnevni profili govora: ključi
  `voice.daypartProsody`, ki se ne izidejo z imeni dnevnih delov, in neznani
  gumbi v profilih so opozorilo, ne tiha napaka) — skupaj dvajset
  preverjanj. Vse pošteno preskoči, ko
  config ni berljiv, in nobeno preverjanje ne more sesati doctorja samega.
- **Markec Podkast generator (P5 #1)**: `npm run podcast-gen` builds a
  deterministic standalone five-minute episode — talk, music, talk, music,
  talk — from the real library + the offline rock-facts corpus, in the
  zajebant persona (rock attitude in the WORDS, never in the voice: Piper
  flattens shouting). Writes `<dataDir>/podcasts/<date>-markec-podkast.md`
  + `.json`; `npm run podcast-export` (P4 #25) turns a PRODUCED show into
  the RSS feed + show notes.
- **Podcast audio (P5 #2)**: `npm run podcast-audio` turns the same episode
  into a real MP3 -- Piper speaks every line (same voice as on-air), real
  library files are the music, ffmpeg stitches + embeds measured chapters;
  a line without audio skips honestly, the episode still assembles. The
  studio's Shows view has the "build today's episode" button driving the
  SAME pipeline (auto/podcastPipeline.js) as the CLI.
- **Public "most listened" (P5)**: `GET /api/top-listened` gives the
  listener an anonymized weekly top-10 straight from the real sampling
  ledger (same impact math as the studio view, same honesty thresholds) --
  aggregate per track only: no rating keys, no samples, no IPs. Rendered
  as a card on the listener page with an honest empty state.
- **Public podcast address (P5 #3)**: the listener finally SEES the
  podcast -- a "Podkast" tab with an episode player, measured chapters and
  a copyable RSS link; a channel-level RSS 2.0 feed at `/podcast/feed.xml`
  (enclosures ONLY for episodes with real audio on disk; lastBuildDate
  follows the archive, never the clock) and range-enabled audio serving at
  `/podcast/<file>.mp3` (traversal-proof, plans never public). Routes stay
  behind Basic Auth by default; open them with
  `web.publicPaths: ["/podcast", "/api/podcast"]`.
- **Show-start push notifications (P5 #4)**: the listener opts in on the
  "Zdaj" panel and the browser notifies right before a scheduled show
  starts. Zero new npm dependencies and zero third-party API keys: the VAPID
  P-256 pair is generated locally (RFC 8292 signed JWT), the payload is
  encrypted with the browser's own keys (RFC 8291 aes128gcm), the scheduler
  job `push_dispatch` fires once per minute and an append-only ledger makes
  it idempotent across restarts; dead endpoints (404/410) are pruned.
  Subscription routes live behind Basic Auth by default -- on a public
  station open the read side with `web.publicPaths: ["/api/push/vapid"]` and
  the (rate-limited, capped) subscribe/unsubscribe writes with
  `web.publicWritePaths: ["/api/push/subscribe", "/api/push/unsubscribe"]` --
  a separate lever so a broad publicPaths prefix can never expose anonymous
  writes elsewhere. `config.push.enabled: false` disables the layer honestly
  (no scheduler job, 503 on subscribe). The studio gets the subscriber count,
  the last-sent truth from the ledger and a test-send button.
- **Listener polls ("anketa")**: the listener page's "Zdaj" panel shows the
  active poll — question, options and an honest tally — and lets the
  audience vote. `GET /api/polls/active` is the public read;
  `POST /api/polls/vote` takes one vote per IP per 30 s (capped in-memory
  anti-flood map — restarts forget it: a mood gauge, not elections). The
  owner opens and closes polls over the API with studio credentials
  (`POST /api/polls {question, options[]}` — opening a new poll closes the
  previous one — and `POST /api/polls/close`, which freezes the tally and
  stops the on-air mentions); the studio's Ankete view drives them all
  (open, close, live tally, closed-poll history), and the
  on-air anketa rubric mentions the open poll automatically. Private
  stations need nothing — the browser rides the listener Basic auth. A
  public station must open `/api/polls/active` in `web.publicPaths` and
  `/api/polls/vote` in `web.publicWritePaths` (the separate
  anonymous-write lever, same as push subscribe) or anonymous listeners
  cannot vote.
- **Themed shows (P4 #18)**: a curated 10-show catalog (rock history, guitar
  history, legendary concerts, decade portraits, ex-Yugoslav rock, punk/new
  wave, whole-album night) renders real briefs on demand — no hand-writing.
  Add a weekly special slot to `station.json`:
  `{ "id": "special", "startTime": "20:00", "durationMinutes": 60,
  "special": { "themes": ["zgodovina-rocka", "zgodovina-kitare",
  "veliki-nastopi"] } }` — the theme rotates by ISO week, the brief is
  generated into `show-descriptions/themed/` (now with a real quiz question
  before the middle track, P4 #23), and the standard pipeline
  (rules + rubrics + trivia) runs it unchanged
- **Ogg-Opus and Ogg-FLAC mounts (optional)**: alongside the primary MP3
  output the station can open `/stream.opus` (%opus 96–320 kbps constrained
  VBR, SUB/WAVE's encoder shape) and `/stream.flac` (lossless Ogg-FLAC) —
  the Liquidsoap blocks live in a generated `liquidsoap/streams.liq`
  rewritten from `config.json` by the web server on boot
  (`src/liquidsoap/streamsLiqWriter.js`), so a config flip plus a Liquidsoap
  restart is the whole deployment. `/api/now-playing` carries `station.streams`,
  `/listen.m3u`+`/listen.pls` list every enabled mount, the web player
  upgrades itself to Opus when the browser really supports it (with the
  iOS-Safari/Firefox exclusions and an automatic session-level MP3 fallback
  SUB/WAVE measured), and the same-origin proxy serves all three paths.
  Default: off — a station that never touches the config boots exactly as
  before — [guide](docs/stream-mounts.md).
- **Hourly archive (optional)**: `output.file` with `reopen_when={0m0s}` and
  a strftime getter writes one MP3 per hour under `data/archive/YYYY-MM-DD/`,
  day-granular retention prunes it from the scheduler, and the studio can
  browse, download and delete days. Off by default (~1.4 GB/day at 128 kbps
  when on) — [guide](docs/stream-mounts.md).
- **Synced song lyrics (LRCLIB)**: every music track can get looked up on
  [lrclib.net](https://lrclib.net) (keyless, throttled to one request per
  second, 404 = a definitive miss), parsed from LRC into a line timeline,
  cached in `data/lyrics-cache.json` with a 30-day recheck, and served at
  `GET /api/lyrics/current`. Dual lookup triggers: the required lazy one
  starts when a listener first opens the "Besedila" panel, which then shows
  honest pending / no-lyrics / unsynced states while it resolves and follows
  the on-air track line by line (500 ms clock), with a per-device offset
  correction for imperfect syncs; the optional enqueue-time one
  (`lyrics.prefetch`) starts every owed lookup the moment
  a track is queued for airtime — the filler pool, a directed show's track
  list, an approved listener request — minutes-to-hours before it airs, on
  the same shared service (one throttle, one in-flight map) as the route.
  The flag is off by default in code, but the shipped `config.example.json`
  (and the Ubuntu deploy config) set `"prefetch": true`, so a fresh install
  that copies the example boots with the early trigger ON — `"prefetch":
  false` turns it off. Zero new dependencies; `lyrics.enabled: false`
  switches the layer off honestly — [design](docs/lyrics-lrclib.md).
- **Scrobbling to Last.fm + ListenBrainz (optional, off by default)**: every
  eligible aired track (Last.fm's own rule — longer than 30 s and at least
  half-played or 4 minutes) is submitted at the NEXT track's start with the
  correct start timestamp, plus a now-playing ping for the incoming track.
  Last.fm's auth is the headless mobile-session flow: username+password are
  used ONCE to mint a session key that is cached (0600, atomic) under
  `dataDir/`, after which the password can be removed from the config
  entirely. ListenBrainz just needs a user token. Both fail closed when the
  Icecast listener count is unknown or zero, never throw near the playout
  process, and have no retry queue — [guide (sl)](docs/scrobbling.md).
- **Rubrique cadence as SKILL.md files**: the auto-mode service segments'
  data freshness (cooldown) and, where the reader is a generic RSS consumer,
  the feed URL live in operator-editable `skills/<slug>/SKILL.md` files
  (SUB/WAVE's drop-in format, restricted to a flat frontmatter — no YAML
  dependency). The four shipped skills carry today's exact defaults, so
  behavior is byte-identical out of the box; edit a cooldown and the next
  fetch honors it without touching code or restarting anything. A malformed
  skill file is ignored and the code default silently takes over —
  [format (sl)](docs/skills.md).
- **Listener themes (Teme)**: the public page ships four looks — Klasika
  (today's dark default, unchanged), Jutro (warm light morning paper),
  Vinil (sepia receiver-dial dark) and Terminal (phosphor green) — picked
  per listener in a radiogroup picker in the topbar (T shortcut, Esc /
  outside-click close, focus returned to the trigger), persisted per
  device in localStorage next to the volume, applied flash-free by a
  constants-only pre-paint script in `<head>`, with a JS-synced
  `theme-color` meta and WCAG-AA-checked palettes (no blue/indigo hues in
  the new skins). Station-wide default: `themes.default` in `config.json`
  sets the look first-time visitors see — the server stamps it on the
  listener shell before the first paint (`Klasika` when unset or invalid,
  with an honest one-time warning in the log); a listener's saved choice
  always wins. The PWA shell is cached stale-while-revalidate (`sw.js`),
  so a changed default reaches returning visitors on their second load.
  `embed.html` stays self-contained and unthemed.
- **MCP server (stdio + remote HTTP)**: `npm run mcp` starts a standalone
  JSON-RPC process (`src/mcp/server.js`) that lets an AI client such as
  Claude Desktop inspect and control the station — 31 tools (now-playing,
  history, schedule editing, station meta, polls, request moderation, skip /
  force-next show, manual format-clock beds, ...) wired straight to the stores
  the routes use, with `mcp.enabled` and `mcp.allowWriteTools` kill-switches in
  `config.json` and zero new dependencies. For clients that can't launch a
  local process, the same 31 tools are also reachable over HTTP at `POST /studio/api/mcp`
  (studio Basic credentials — same auth and same power as the studio's own
  write routes; off by default, opt in with `mcp.remote.enabled` plus a
  station restart) — [guide (sl)](docs/mcp-server.md).
- `**Repeat window:** N days` keeps individual tracks out of rotation

## npm scripts

Pipeline (normally only invoked by the scheduler, not by hand):

- `npm run runweb`: the whole station -- web server (now-playing page,
  JSON API, stream proxy, studio admin) and the scheduling daemon, together
  in one process. This is what `radioclyde.service` runs in production.
- `npm run runstation`: the scheduling daemon alone (`src/scheduler/scheduler.js`
  is still independently runnable), for local debugging without the web
  server.
- `npm run generate-script -- --id=<showId>`: runs the producer for one show.
- `npm run direct-show -- --id=<showId> --weekday=<weekday> --date=<yyyy-mm-dd> --time=<HH:MM>`: runs the director for one occurrence.
- `npm run prewarm-show-audio -- --id=<showId> [--weekday=<weekday> --date=<yyyy-mm-dd>]`: warms a show's dj-audio cache ahead of time (the downtime job's own per-show step).
- `npm run update-now-playing`: points `now_playing.m3u` at whatever should be airing.
- `npm run generate-filler-playlist`: rewrites the off-air filler pool.
- `npm run backup`: the daily safety copy the scheduler's `backup` job already
  runs on its own cadence -- every irreplaceable piece of station state
  (station.json, show-descriptions/, prompts.json, listener
  requests/polls, `push/` including the VAPID private key, the history
  ledgers, show logos + imaging clips, the derived rating/autocue caches, and
  `config.json` itself) lands in `config.backup.dir`, one dated directory per
  day with `backup.retentionDays` rotation. That archive contains plaintext
  credentials, so protect the backup dir and ideally keep a copy off-box --
  see the backup/restore section of
  [deploy/ubuntu/DEPLOYMENT_GUIDE.md](deploy/ubuntu/DEPLOYMENT_GUIDE.md).

Preview/dry-run tools, for iterating on a show while designing it (no
station.json entry required):

- `npm run themed-shows -- list | brief <theme> | ensure <theme> [minutes] | resolve`:
  the themed-show catalog — list every theme with its selection lines, print
  a rendered brief to stdout, materialize one under `show-descriptions/themed/`,
  or show which theme each special slot resolves to this week.
- `npm run preview-auto-show -- <show-name> [--duration=<minutes>] [--offline]`:
  the full auto-mode dry run: deterministic brief parse, track queue (with
  cooldown/popularity/decade stats), rubrique resolution, the complete
  rendered script and validation. `--offline` forces the local library and
  skips every network source. Writes the same `script.md`/`tracks.json` the
  scheduler would, so the output can be directed as-is.
- `npm run preview-track-queue -- --duration=<minutes> [--artist=... --genre=... --decade=...]`: the deterministic track-selection step directly (the brief parser + queue builder).

Quality gate:

- `npm test`: the full offline suite (`node --test`, one file per
  subsystem — 1586 tests at Val 33: 1585 pass, 0 fail, 1 known skip for
  the live Piper round-trip that needs a real voice download). Every wave
  lands only with this suite green; nothing in it needs the network or a
  running station.

## Voice (no AI models)

The station speaks with **no self-hosted AI models** — the voice layer is:

- **Voice engines** (pick one per station, per-show personas map onto them):
  `edge` (Microsoft Edge neural TTS — real Slovenian voices
  `sl-SI-PetraNeural`/`sl-SI-RokNeural`, no API key, no model download),
  `piper` (fully local neural TTS via [piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)
  — Slovenian voice `sl_SI-artur-medium`, model downloaded once from
  HuggingFace into `<dataDir>/piper`, offline and CPU-only afterwards;
  per-persona `piperVoice` keys, and `piperAutoDownload: false` turns the
  one-time download into an actionable error instead),
  `clips` (your own recordings, one file per slot, numbered variants picked
  by the same hash as the text), `sapi` (Windows voices), `espeak-ng`,
  or `none` (music + jingles only). Every provider's output is normalized to
  one codec contract, so splicing stays lossless.
- **Rubriques from live Slovenian data**: ARSO current weather, RTV
  Slovenija news + sport headlines, Wikidata "on this day" — enabled per-show with
  one brief line, cached in-process, hard-timeout-guarded, and always
  skip-not-fail. Each rubrique's data-freshness cooldown (and the news/sport
  feed URLs) now lives in an editable `skills/<slug>/SKILL.md` — see
  [docs/skills.md](docs/skills.md) (Slovenian).
- **Everything else is the same station**: scheduling, prewarm, directing,
  the web page, the apps. Scripts, transcripts and playlists are identical
  in shape to AI mode's.

Full Slovenian reference with every config knob:
[docs/auto-radio.md](docs/auto-radio.md).

## Where the code lives

The canonical repository is
[github.com/robertpezdirc12-design/radioclyde](https://github.com/robertpezdirc12-design/radioclyde),
branch `main` — a fork of [a1anw2/radioclyde](https://github.com/a1anw2/radioclyde).
It is a single branch with no submodules, so mirroring it on another host
(GitLab included) is a plain push. The GitLab mirror is
[gitlab.com/robert.pezdirc12/radioclyde](https://gitlab.com/robert.pezdirc12/radioclyde),
kept at the same tip as GitHub; re-syncing it after new work lands is:

```
git remote add gitlab https://gitlab.com/robert.pezdirc12/radioclyde.git   # once
git push gitlab main
```

There is deliberately **no Vercel (or any serverless) deployment**: the
station is long-running processes by design — scheduler daemon, Fastify
web server, Liquidsoap playout and Icecast alive 24/7 on the same box,
with the listener and studio pages served by that same Fastify process
over same-origin APIs (now-playing, stream proxy, polls, push). A
serverless static host can run none of that. The real deployment is the
Ubuntu box: [deploy/ubuntu/DEPLOYMENT_GUIDE.md](deploy/ubuntu/DEPLOYMENT_GUIDE.md)
and the systemd unit shipped as `radioclyde.service`.

## Documentation

- [sample-data/](sample-data/): a working example `dataDir`, a full
  `station.json` and a real set of `show-descriptions/*.md` briefs,
  including the auto-mode `80s-rock-auto` show — plus
  **`station-auto.json`**, a ready-made 24/7 professional weekly schedule
  (five Slovenian shows from "Dobro jutro" at 05:00 to "Nočni express"
  overnight, hourly occurrences, all rubriques wired in).
- [docs/auto-radio.md](docs/auto-radio.md): complete Slovenian reference for
  auto mode — rules, templates, voice engines, rubriques, config.
- [script-format.md](script-format.md): the `.script.md` output grammar
  the director consumes mechanically to produce broadcast assets.
- [docs/producer-pipeline.md](docs/producer-pipeline.md): architecture of
  the track-selection + research + script-writing pipeline. What each stage
  does, why it's split the way it is, and what's still open.
- [docs/plex-library-notes.md](docs/plex-library-notes.md): empirical
  facts about Plex's API behavior, confirmed live rather than assumed from
  Plex's general docs.
- [docs/show-generation-research.md](docs/show-generation-research.md):
  research on auto-generating themed shows and inserting deterministic
  artist/general-rock trivia between tracks (GitHub survey + live-verified
  Wikipedia/MusicBrainz/Wikidata sources + P4 proposal; trivia rubric #17
  and music on-this-day #19 are implemented — #18 themed-show generator
  still open).
- [docs/android-tv-app.md](docs/android-tv-app.md): architecture of the
  native Android TV/Google TV client. Package layout, the backend API it
  consumes, key design decisions.
- [docs/android-mobile.md](docs/android-mobile.md): architecture of the
  native Android phone/tablet client. What's different from the TV app
  (touch UI, no clock/weather, the dual server-profile auto-reachability
  design), package layout, key design decisions.
- [docs/stream-mounts.md](docs/stream-mounts.md): the optional Opus/FLAC
  mounts and the hourly MP3 archive — config, restart semantics, bitrate
  ladders, published surfaces, and the player upgrade rules.
- [docs/lyrics-lrclib.md](docs/lyrics-lrclib.md): the LRCLIB synced-lyrics
  stack (Slovenian) — client constants, LRC parsing rules, cache/recheck
  semantics, the response contract and its honest-state table.
- [docs/scrobbling.md](docs/scrobbling.md): Last.fm + ListenBrainz
  scrobbling (Slovenian) — eligibility, the mobile-session auth flow, the
  privacy note and the honest limitations.
- [docs/skills.md](docs/skills.md): the SKILL.md rubrique format
  (Slovenian) — frontmatter grammar, precedence rules, honest degradation.

## Credits & data sources

- Radio Markec is named and operated by its own maintainer; the station was
  originally built by [a1anw2](https://github.com/a1anw2/radioclyde)
  (upstream project "Radio Clyde");
  this fork adds the deterministic auto-radio mode and Slovenian voice/content
  layer.
- Weather data: [ARSO](https://meteo.arso.gov.si/) (Slovenian Environment
  Agency) and [Open-Meteo](https://open-models.open-meteo.com).
- News and sport headlines: [RTV Slovenija](https://www.rtvslo.si).
- "On this day" facts: [Wikidata](https://www.wikidata.org) (CC0).
- Artist trivia: [MusicBrainz](https://musicbrainz.org) (search results,
  CC0-licensed metadata) and [sl.wikipedia.org](https://sl.wikipedia.org)
  page extracts (CC BY-SA) as the fallback; general rock-history trivia is
  a locally curated corpus ([src/auto/rockFacts.js](src/auto/rockFacts.js)).
- Neural Slovenian voices: Microsoft Edge read-aloud service (unofficial;
  no key required) — used via [msedge-tts](https://www.npmjs.com/package/msedge-tts).
- Local neural Slovenian voice: [Piper](https://github.com/OHF-Voice/piper1-gpl)
  (piper1-gpl, GPL-3.0-or-later) — voice `sl_SI-artur-medium`
  ([rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)).
