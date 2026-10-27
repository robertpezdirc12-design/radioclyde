# Adding a new DJ persona

A "DJ" is just a `dataDir/prompts.json` `personas` roster entry plus a voice
setting in `config.json` (and a couple of optional cosmetic assets). No code
to write or build step to run -- every place that reads personas goes through
`src/scheduler/promptsUtil.js`'s `loadPersonas()`, which re-reads
`prompts.json` fresh on every call, so a new entry is picked up immediately,
no restart needed. Easiest done through the studio admin's Osebje page
(`/studio`); the steps below are for hand-editing the file directly.

> Val 28 ("samo skripte brez AI modelov"): the AI layer is gone, so a persona
> no longer carries an LLM `systemPrompt` (the writing voice is the station's
> template register, the same for everyone) or a Chatterbox `voiceFile` (the
> AI voice clone is gone with it). A persona is now a **roster identity** --
> the names show briefs and scripts are allowed to address -- and the VOICE
> per persona lives in `config.autoRadio.voice.personas` (Edge/Piper/espeak
> settings), not in `prompts.json`. Old files that still carry the dead
> fields keep loading unchanged (they're simply ignored).

## 1. Pick a persona id

Lowercase, single word, `^[a-z0-9_-]+$` (this exact pattern is enforced by
`src/server/djPhotoProxy.js` for the photo route, and matches every existing
key in `prompts.json`'s `personas`). e.g. `marcus`.

## 2. Add the persona to `dataDir/prompts.json`

Through the studio admin (`/studio` → Osebje) or by hand:

```json
"personas": {
  "marcus": {}
}
```

That's the whole entry -- the roster is a list of names. `prompts.json` lives
under `dataDir`, outside the repo (same as `station.json`) -- there's no
`config.example.json`-style template for it since it's real station data,
not operational config; a fresh deploy seeds it from scratch (or copies an
existing one, e.g. from [sample-data/](../sample-data/)).

## 3. Give the persona a voice (`config.json`)

Per-persona voice settings live in the `autoRadio.voice.personas` block
(see `docs/auto-radio.md` for the full knob list). What to set depends on
the station's `autoRadio.voice.mode`:

- `edge` -- a per-persona `edgeVoice` (e.g. `"sl-SI-PetraNeural"`) plus the
  usual prosody knobs (`edgeRate`/`edgePitch`/`edgeVolume`); the station
  defaults apply to personas with no block of their own.
- `piper` -- a per-persona `piperVoice` key (e.g. `"sl_SI-artur-medium"`).
- `clips` -- record `<dataDir>/<clipsDir>/<persona>/<slot>.wav` files for
  every speech slot the persona speaks (see `docs/auto-radio.md` for the
  numbered-variant sync contract); a missing clip skips that speech segment
  honestly, music keeps playing.
- `espeak`/`sapi` -- a per-persona voice code/name.

```json
"autoRadio": {
  "voice": {
    "mode": "edge",
    "personas": {
      "marcus": { "edgeVoice": "sl-SI-RokNeural" }
    }
  }
}
```

## 4. Optional: photo

Drop `<persona-id>.jpg` into `public/dj-photos/` (e.g. `marcus.jpg`) and add
a cell to the "Meet the DJs" table in `README.md`. Not required --
`djPhotoProxy.js` 404s gracefully on a missing photo and the web/Android
clients already treat that as "no artwork" with no special handling.

## 5. Give the persona a show

None of the above puts the persona on air by itself -- a show only speaks
in a given persona's voice if its brief says so. In
`radiodata/show-descriptions/<show>.md`:

```
**Personas:** marcus, elena
```

First name listed is the primary host (drives open/close/intro/recap/quiz
per `src/producer/showBrief.js`); any further names are available for
special segments like the weather desk. A show can only use personas
listed on this line.

## Gotchas

- **Typo'd or unknown persona names don't fail loudly where you'd expect.**
  `src/script/format.js`'s `parseScript` flags an unrecognized `persona:` as
  a warning, not a blocking error (`src/producer/generateScript.js` still
  writes `script.md` to disk either way) -- the mistake instead surfaces
  later at directing time, when the voice layer has no settings for that
  persona and the segment is skipped (clips mode) or spoken with the
  station-default voice (edge/piper). Double-check the id matches
  `prompts.json` exactly before a show airs on it.
- **No dry-run tool exists yet for "just synthesize one line and listen."**
  The closest thing is `node src/cli/prewarmShowAudio.js --id=<showId>`,
  which synthesizes every not-yet-cached `dj` segment of an already-produced
  show -- useful to warm the cache for a real show, but it needs a real
  script.md to exist first. For a quick smoke test of a brand new voice
  before wiring it into any show, the fastest path is a throwaway one-off:
  ```js
  import { synthesizeNoModelSpeech } from './src/auto/voice.js';
  import fs from 'node:fs';
  // Note the lowercase-first signature: resolves the persona's voice
  // settings itself; writes /tmp/test.wav and returns true on success.
  await synthesizeNoModelSpeech({ persona: 'marcus', slot: 'open', text: 'Pozdravljeni, to je test.', outPath: '/tmp/test.wav' });
  ```
