# Show Script Format

Rules for authoring a `.script.md` file — the deliverable of a **producer** session. A
**director** consumes this file mechanically to turn it into a broadcast-ready show: it
does not make creative decisions, pick tracks, write DJ lines, or research facts.
Everything is already decided by the time this file is finished, with one exception —
live weather/time/next-show segments — see `type: live` below.

## File structure

```
# 📻 <show title>

**Duration:** <30 | 60> min

---

## <segment 1>
...

## <segment 2>
...
```

- Title (`#`) and `**Duration:**` are required. Duration must be 30 or 60 minutes.
- Segments are ordered top to bottom — that ordering *is* the running order, exactly as
  it will air. There is no separate scheduling/sequencing metadata.

## Segment grammar

Every segment is a `##` heading, then a small block of `key: value` fields (one per
line), then — for `dj` segments only — free body text.

```
## <Human label — free text, for readers only>
type: dj | track | live
persona: <persona key>          (required for dj, live)
...type-specific fields...

<body text — dj only>
```

Rules:
- `type:` is **required** and must be the first field. It is the *only* thing the
  director uses to decide behavior — the heading text is for human readers and can say
  anything (it is never parsed).
- Fields are read until the first blank line; everything after that blank line is body
  text, used only when `type: dj`.
- `persona:` must exactly match a key under `personas` in `config.json`.

### `type: dj`

A fully-authored, literal line (or a few short paragraphs) spoken by one persona. This
is the workhorse type — DJ banter, news roundups, quiz questions *and* answers, intros,
outros, and handoffs between personas are all just this.

```
## DJ — Ryan
type: dj
persona: ryan
slot: intro                      (optional — auto-radio metadata, never authored by hand)
seed: myshow|2026-10-24|12345|intro   (optional — auto-radio only, see below)
segment: listener_mailbag        (optional — see "Segment taxonomy" below)

Alright everyone, kicking off Friday drivetime!
```

The director does nothing but synthesize this text verbatim in `ryan`'s voice. Write it
exactly as it should be spoken — no stage directions, no meta-commentary.

`slot:` and `seed:` are auto-radio machinery, stamped by `src/auto/scriptBuilder.js`
and never written by hand: `slot` names the broadcast moment (open/intro/recap/...) so
clips-mode voice files can be keyed by it, and `seed` is the exact variant-draw seed
the template render used — the no-model voice layer (`src/auto/voice.js`) hashes the
same string to pick numbered takes, keeping the transcript line and the aired clip in
sync. Both round-trip through parse/render untouched; LLM-produced scripts simply
carry neither.

Chatterbox-Turbo (the TTS engine this station runs) understands a handful of inline
paralinguistic tags and renders them as the actual sound rather than speaking the word:
`[laugh]`, `[chuckle]`, `[sigh]`, `[gasp]`, `[cough]`, `[clear throat]`, `[sniff]`,
`[groan]`, `[shush]`. Sparingly, e.g. `Honestly [chuckle] I still don't get that lyric.`
Use at most one per line, and only where a real DJ would actually make that sound —
most lines should have none.

### `type: track`

One specific, already-chosen song. Put no commentary here — write DJ lines around it as
separate `dj` segments before/after.

```
## Track
type: track
artist: Fleetwood Mac
title: Don't Stop
ratingKey: 12345
```

`ratingKey` (the Plex library ID) is required, not optional — it's what lets the
director resolve the exact file with zero ambiguity, instead of re-searching Plex by
name at production time.

### `type: live`

The only segment the director doesn't just play back verbatim. Used for anything that
would be stale if written ahead of air — currently: current time, current weather, and
the next show on the schedule. At production time the director fetches real data and
generates the actual line, using `brief` as tone/length direction — nothing here is
spoken as literally written.

```
## Weather Check — Elena
type: live
persona: elena
kind: time | weather | time-weather | nextShow
brief: <free text: tone, length, angle — direction, not content>
```

- `kind: time` — current local time only. No network call; sourced from the server
  clock against `config.json` → `weather.timezone`.
- `kind: weather` — current conditions for the station's fixed location
  (`config.json` → `weather.latitude`/`longitude`), via Open-Meteo.
- `kind: time-weather` — both, in one line.
- `kind: nextShow` — the closing "what's next" announcement: the next show on
  `station.json`'s schedule after this one (name, host, day, start time).
- `brief` is *instruction*, not content — write it like direction to a DJ, not like the
  line itself. Good: `"20s casual check-in, drivetime energy"`. Bad: `"It's sunny and
  75 degrees"` (you don't know that yet — that's the director's job).

`kind: nextShow` is stamped by the builders (`src/auto/scriptBuilder.js`,
`src/producer/boundaryWalk.js`) right before the closing `dj` segment — it is part of
the grammar so a script round-trips through parse/render, not something to author by
hand. Its data is resolved at **direct time** (about 15 minutes before air) from
`station.json`'s schedule, never at script time — same-day repeats share one
`script.md` and one dj-audio cache, so a script-time "next show" would name a show
that already aired on the re-run. When the next show can't be resolved (no occurrence
identity, the schedule was edited after direction, nothing programmed in the next 7
days), the segment degrades to an honest offline line that invents no day, time or
show name. In clips/pregenerated voice modes live segments are skipped by
construction: those providers key files by slot name (`src/auto/voice.js`'s
`resolveClipPath` and the pre-generated slot map), and a pre-recorded clip could
never know the direct-time answer — a `live:nextShow` slot can never honestly match
a file, same as live weather today.

## Segment taxonomy

Every `dj`/`live` segment carries a **content type** from a small closed set — the
WRIT-FM taxonomy (borrowed for integration-table item #7). The type is used by the
studio Diagnostics min-inventory view ("is the next slot's content ready?"); it never
changes playback.

You can tag it explicitly with an optional `segment:` field (must be exactly one of
the strings below; anything else is a parse error):

```
segment: listener_mailbag | deep_dive | story | music_essay | interview |
         panel | banter | show_intro | show_outro | track_intro | quiz |
         news_analysis | weather_check
```

Absent a tag, the type is **inferred** — every existing script classifies unchanged:

| Inferred from | Type |
|---|---|
| `slot: open` / first spoken segment | `show_intro` |
| `slot: close` / last spoken segment | `show_outro` |
| `slot: intro` / `slot: recap` | `track_intro` |
| `slot: quizIntro` / `slot: quizReveal` | `quiz` |
| `slot: newsHeadlines` / `sportHeadlines` / `obzorje` | `news_analysis` |
| `slot: weatherNow`, or any `type: live` segment | `weather_check` |
| anything else (incl. `slot: handoff`) | `banter` |

`listener_mailbag`, `deep_dive`, `story`, `music_essay`, `interview`, and `panel` are
**explicit-only** — nothing in today's structure implies them, so they are never
guessed; they become real the moment a script tags one. (A two-persona `interview` or
`panel` is mechanically just `dj` segments alternating — the tag records the intent.)

Station IDs are not a script segment: the imaging layer owns them
(`imaging/id.m3u`, on the hour).

### Min-inventory ("zdravstveno merilo zaloge")

Diagnostics reports, for each upcoming slot, whether its script meets the station's
minimums (WRIT-FM's health metric, adapted to this library's 3.5–5 min tracks):

- at least `shows.inventory.minSpeechSegments` (default 3) speech segments
  (`dj` + `live`) per show, and
- at least `shows.inventory.minTracksPer30Minutes` (default 6) tracks per 30 minutes
  of scheduled duration.

The metric **reports** — it never blocks a parse or a production. A shortfall shows up
in Diagnostics as a not-ready slot with the exact counts that missed.

## Rules of thumb when authoring

- **Resolve everything you can right now.** Pick real tracks (with `ratingKey`), write
  real DJ lines, write the actual news items and quiz Q&A. If it's knowable at
  authoring time, it does not belong in a `live` segment — `live` is reserved for data
  that would go stale between now and air time.
- **Multi-DJ shows are just multiple `persona:` values** used across `dj`/`live`
  segments in the order they should speak. There is no separate multi-DJ mechanism —
  the segment ordering *is* the conversation.
- **A handoff is an ordinary `dj` segment, not automatic.** If a `live` segment is a
  handoff between personas ("let's check in with Elena..."), write that toss yourself
  as a preceding `dj` segment — the director will not infer it.
- **A quiz is just three segments**: a `dj` segment with the question, a `track`
  segment (the song being guessed, or the next song while listeners think), and a `dj`
  segment with the reveal. No dedicated quiz type is needed.
