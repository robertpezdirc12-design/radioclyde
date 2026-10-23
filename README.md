# Radio Clyde

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

## Two operating modes

| | **AI mode** (classic Radio Clyde) | **Auto mode** (`autoRadio`) |
|---|---|---|
| Track selection | Local LLM resolves the brief into a Plex query | Deterministic rule parser + rule-based queue |
| DJ script | LLM writes every line against Wikipedia-researched facts | Fixed Slovenian templates filled from library metadata |
| Voice | Chatterbox (neural TTS) | **Edge neural TTS** / pre-recorded clips / Windows SAPI / espeak-ng / none |
| Service segments | LLM-composed live lines | **Live data rubriques**: ARSO weather, RTV Slovenija sport headlines, Wikidata "on this day" |
| Hardware needed | GPU/CPU heavy LLM + TTS model | Any box — even a Raspberry Pi |
| Offline capable | No | Yes (`--offline` dry-run, music-only fallback) |

Both modes share the same scheduler, director, Liquidsoap/Icecast playout,
web pages and mobile apps. Switch with one flag — `"autoRadio": { "enabled":
true }` — with no other wiring, and every part downstream works unchanged.

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
- **Auto mode: rule-based selection you can audit**: artist cooldown against
  real play history (`history/played.jsonl`), a popularity mix (~70% well
  known / 30% deep cuts) split at the library's popularity median, decade
  spread, and time-of-day mood blocks (morning/daytime/evening/night, with
  cross-midnight windows) — every decision deterministic and reproducible.
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
  Slovenian voices `sl-SI-PetraNeural` / `sl-SI-RokNeural` with zero setup.
- **Live segments resolved fresh**: time/weather call-ins are generated at
  air time from real data, not baked into yesterday's recording.
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
- **Listeners everywhere**: Icecast stream, web now-playing page, JSON API,
  authenticated stream proxy, studio admin UI, native Android TV/Google TV
  and Android mobile apps.

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
| **LM Studio** (AI mode only) | Local LLM: track-query resolution, script writing, script editing, live-segment lines |
| **Chatterbox** (AI mode only) | Neural text-to-speech for the classic mode's DJ audio |
| **Liquidsoap** | Playout engine: plays the directed playlist or falls back to filler, feeds Icecast |
| **Icecast** | The actual stream server listeners connect to |
| **Fastify** | Web server: now-playing page, JSON API, authenticated stream proxy, password-protected studio admin, and the scheduling daemon (one merged process) |
| **Android TV / Google TV app** (`android-tv/`) | Native Java/Leanback client, independent Gradle project |
| **Android mobile app** (`android-mobile/`) | Native Java/Material phone-tablet client, independent Gradle project |

## Setup

1. `npm install`
2. Copy `config.example.json` to `config.json` and fill in real values
   (Plex token, Icecast credentials, studio admin password; for AI mode also
   LM Studio/Chatterbox URLs, for auto mode the `autoRadio` block)
3. Put your show briefs in `<dataDir>/show-descriptions/` and your weekly
   lineup in `<dataDir>/station.json`
4. `npm run runweb` — the scheduler + web server in one process

For a station without a language model, set `"autoRadio": { "enabled": true,
"voice": { "mode": "edge" } }` — see
[docs/auto-radio.md](docs/auto-radio.md) for the complete Slovenian
reference. Try one show end-to-end without touching Plex or the network:

```
npm run preview-auto-show -- <show-name> --offline
npm run direct-show -- --id=<show-name> --weekday=<weekday> --date=<yyyy-mm-dd> --time=<HH:MM>
```

## Writing a show's Track Selection brief

Briefs are plain markdown. `**Personas:**`, `**Duration:**` and a
`## Track Selection` section are all the pipeline needs; everything else is
prose for humans. The selection section supports:

- `genre:`, `decade:`, `artist:`, `artists:`, `album:`, `folder:`,
  `exclude:`, `prefer:` lines (AI mode also understands free themes)
- English or Slovenian rule sentences: *Don't repeat the same artist in a
  single show* (artist cooldown, 3 h station-wide by default), *No track
  longer than 5 minutes*, *Favor well-known tracks* (popularity mix)
- `Rubrike: vreme, šport, obzorje` — opt the show into the live-data
  service segments (see [docs/auto-radio.md](docs/auto-radio.md))
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

Preview/dry-run tools, for iterating on a show while designing it (no
station.json entry required):

- `npm run preview-auto-show -- <show-name> [--duration=<minutes>] [--offline]`:
  the full auto-mode dry run: deterministic brief parse, track queue (with
  cooldown/popularity/decade stats), rubrique resolution, the complete
  rendered script and validation. `--offline` forces the local library and
  skips every network source. Writes the same `script.md`/`tracks.json` the
  scheduler would, so the output can be directed as-is.
- `npm run preview-tracks -- <show-name>`: the fast one. Resolves
  `show-descriptions/<show-name>.md`, pulls its `## Track Selection` text
  and `**Duration:**`, and prints the AI-produced Plex query plus the
  resulting tracklist. Also accepts a full/relative path, or
  `--text="<brief>" --duration=<minutes>` for a brief with no file at all.
  (`preview-track-query-ai` is the same script, longer name.)
- `npm run preview-track-queue -- --duration=<minutes> [--artist=... --genre=... --decade=...]`: the deterministic track-selection step directly, bypassing the AI query-producing step entirely.
- `npm run preview-show-prep -- --file=<path> --duration=<minutes>`: the fuller show-prep dry run (track query + research), still short of full script writing.

## Auto Radio mode (no LLM, no Chatterbox)

The station can run **fully deterministically** — no language model, no
neural TTS model on your hardware:

- **Voice engines** (pick one per station, per-show personas map onto them):
  `edge` (Microsoft Edge neural TTS — real Slovenian voices
  `sl-SI-PetraNeural`/`sl-SI-RokNeural`, no API key, no model download),
  `clips` (your own recordings, one file per slot, numbered variants picked
  by the same hash as the text), `sapi` (Windows voices), `espeak-ng`,
  or `none` (music + jingles only). Every provider's output is normalized to
  one codec contract, so splicing stays lossless.
- **Rubriques from live Slovenian data**: ARSO current weather, RTV
  Slovenija news + sport headlines, Wikidata "on this day" — enabled per-show with
  one brief line, cached in-process, hard-timeout-guarded, and always
  skip-not-fail.
- **Everything else is the same station**: scheduling, prewarm, directing,
  the web page, the apps. Scripts, transcripts and playlists are identical
  in shape to AI mode's.

Full Slovenian reference with every config knob:
[docs/auto-radio.md](docs/auto-radio.md).

## Documentation

- [sample-data/](sample-data/): a working example `dataDir`, a full
  `station.json` and a real set of `show-descriptions/*.md` briefs,
  including the auto-mode `80s-rock-auto` show — plus
  **`station-auto.json`**, a ready-made 24/7 professional weekly schedule
  (five Slovenian shows from "Dobro jutro" at 05:00 to "No\u010dni express"
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
- [docs/android-tv-app.md](docs/android-tv-app.md): architecture of the
  native Android TV/Google TV client. Package layout, the backend API it
  consumes, key design decisions.
- [docs/android-mobile.md](docs/android-mobile.md): architecture of the
  native Android phone/tablet client. What's different from the TV app
  (touch UI, no clock/weather, the dual server-profile auto-reachability
  design), package layout, key design decisions.

## Credits & data sources

- Radio Clyde was originally built by [a1anw2](https://github.com/a1anw2/radioclyde);
  this fork adds the deterministic auto-radio mode and Slovenian voice/content
  layer.
- Weather data: [ARSO](https://meteo.arso.gov.si/) (Slovenian Environment
  Agency) and [Open-Meteo](https://open-models.open-meteo.com).
- News and sport headlines: [RTV Slovenija](https://www.rtvslo.si).
- "On this day" facts: [Wikidata](https://www.wikidata.org) (CC0).
- Neural Slovenian voices: Microsoft Edge read-aloud service (unofficial;
  no key required) — used via [msedge-tts](https://www.npmjs.com/package/msedge-tts).
