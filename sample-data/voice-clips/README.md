# voice-clips

Pre-recorded DJ speech clips for the no-model voice mode
(`config.autoRadio.voice.mode: "clips"`). Copy this folder into your
`dataDir` (or point `voice.clipsDir` at it) and fill in your own recordings
-- one clip per speech slot, per persona.

## Layout

```
voice-clips/
  default/          <- used by ANY persona without its own folder
    open.wav
    intro.wav
    recap.wav
    quizIntro.wav
    quizReveal.wav
    handoff.wav
    close.wav
    live-time.wav
    live-weather.wav
    live-time-weather.wav
  elena/            <- persona-specific overrides (same slot names)
    open.wav
    ...
```

## Slot names

| slot (in script.md) | clip file | when it plays |
|---|---|---|
| `open` | `open.wav` | show opening line |
| `intro` | `intro.wav` | right before every track |
| `recap` | `recap.wav` | right after every track |
| `quizIntro` | `quizIntro.wav` | quiz question before the quiz track |
| `quizReveal` | `quizReveal.wav` | quiz answer after the quiz track |
| `handoff` | `handoff.wav` | toss to the weather desk |
| `close` | `close.wav` | show closing line |
| `live:time` | `live-time.wav` | resolved live time check-in |
| `live:weather` | `live-weather.wav` | resolved live weather check-in |
| `live:time-weather` | `live-time-weather.wav` | both together |

Any persona missing a clip falls back to `default/`; a missing clip in both
places SKIPS that speech segment (the show flows on without it) and logs a
NOTE -- music never stops because a clip is absent.

## Numbered variants

You can record several takes of a slot: `intro-1.wav`, `intro-2.wav`,
`intro-3.wav`... The director picks one deterministically per occurrence, so
the same airing always uses the same take, but different tracks/days rotate
through your takes. A plain `intro.wav` (no number) always works and wins if
no variants exist.

## Format

Any audio format ffmpeg can read (wav/mp3/flac/ogg/m4a). Files are
normalized to 24 kHz mono PCM on first use and cached next to the script, so
splicing into one continuous speech block stays lossless. Clips are NOT
gain-adjusted automatically (in contrast to sapi/espeak speech) -- level them
as you want them on air.

## What the text would have said

The rendered template text for every segment is always visible in the
generated `script.md` and `transcript.json` -- so you can record clips that
match what the station "says", or use `voice.mode: "sapi"` / `"espeak"` to
have the template text spoken by a classic (non-AI) system voice instead.
