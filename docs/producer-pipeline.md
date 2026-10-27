# Show Producer Pipeline

> **Status (Val 28, "samo skripte brez AI modelov"): the AI pipeline this
> document described is REMOVED.** The producer is now one deterministic
> pipeline — `src/auto/produce.js` (`runAutoProducerPipeline`, called by
> `src/producer/generateScript.js`): auto/briefQuery.js parses the brief,
> trackSelection/queue.js builds the queue with the auto rules, feeds.js +
> trivia.js collect the rubric data, scriptBuilder.js renders every line
> from the template pools. See [auto-radio.md](auto-radio.md) for the
> complete reference. What follows is the HISTORICAL RECORD of the AI
> design it replaced — kept because the lessons below are why the
> deterministic pipeline is shaped the way it is.

## Why the AI split existed (and why it died)

The first version of the producer was one big AI tool-calling session:
`search_tracks` + `wikipedia_lookup` + `web_search` + `finish_script`, all
in one open-ended loop, expected to research, pick tracks, budget the
show's runtime, and write the whole script in a single continuous
conversation.

Live-tested against real briefs, this repeatedly failed to converge:

- A 60-minute single-artist show (`late-night-queen`) never called
  `finish_script` even once across 60 iterations — it got stuck re-querying
  paraphrased variations of the same 2-3 research questions.
- A 60-minute Elvis retrospective (`elvis-lookback`) plateaued at ~40
  minutes of actual content against a 60-minute target, then resubmitted
  the *identical* draft 15 times in a row (including through a
  forced-finish window), before a retry attempt hit an outright LM Studio
  engine error.

The fix back then was splitting the job into narrow stages — track-query
resolution, deterministic queue building, per-move single-shot completions,
a review pass — with only two stages touching the LLM at all. That split is
exactly what made the eventual full removal possible: when the deterministic
doubles for every stage existed (built out over Val 20–27), the AI stages
were deleted one wiring change at a time, and nothing about the scheduler,
director or playout had to change.

Lessons that carried over into the deterministic pipeline:

- **Never one open-ended session** — the auto pipeline is the same narrow
  stages (brief parse → queue → rubric data → render → validate), each
  independently testable, each failing loudly and narrowly.
- **Real ground truth as the validator** — the queue builder's own errors
  were the AI's retry signal; today the same errors are the operator's
  signal (the transcript + error.json discipline).
- **Determinism where a judgment call isn't needed** — the duration
  fitting, artist cooldown and variety rules that the LLM kept getting
  wrong were pulled into plain code first (trackSelection/queue.js), and
  that code survived the AI removal untouched.

## What was removed in Val 28

- `src/llm/` (client + prompts) — the LM Studio chat-completions client
  (qwen3.6-35b-a3b) and every prompt it consumed.
- `src/producer/trackSelection/query.js` (LLM track-query resolution),
  `src/producer/research/trackResearch.js` (LLM fact research),
  `src/producer/moves.js` + `boundaryWalk.js` (LLM move writing),
  `src/producer/reviewScript.js` (LLM script review).
- `src/director/tts.js` + `src/scheduler/restartChatterbox.js` — the
  Chatterbox AI TTS voice and its systemd restart machinery; the no-model
  voice layer (`src/auto/voice.js`) is the only synthesizer.
- The `lmStudio`/`chatterbox` config blocks and the `autoRadio.enabled`
  mode flag — configs that still carry them simply ignore them
  (`npm run doctor` says so), and `test/noAiModels.test.mjs` keeps them
  from ever coming back.
- Historical LM Studio quirks worth remembering if anyone ever reintroduces
  an LLM: `tool_choice` on LM Studio only supports `none`/`auto`/`required`
  (not OpenAI's targeted form — that 400s); a hung request with no timeout
  froze the shared production queue for hours (the 2026-08-07/08 outages —
  every network call in the station now carries a hard timeout).
