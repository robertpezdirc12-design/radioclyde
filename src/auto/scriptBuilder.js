// The deterministic boundary walk -- since Val 28 ("samo skripte brez AI
// modelov") the ONLY script builder (its former AI counterpart,
// producer/boundaryWalk.js + producer/moves.js + reviewScript.js, is
// removed; review is unnecessary here anyway: templates cannot repeat each
// other's phrasing the way free generation does). The code walks the
// tracklist classically -- open, per-track intro/recap, mid-show quiz, the
// two-thirds weather handoff, close -- and every spoken line is rendered
// from config templates (auto/templates.js) with the track's real library
// metadata, not generated.
//
// Segment shape matches parseScript's expectations, with one addition: dj
// segments carry a `slot` field (open/intro/recap/quizIntro/quizReveal/
// handoff/close). script/format.js persists it, and the no-model voice
// layer (auto/voice.js, clips mode) uses it to pick which pre-recorded clip
// plays -- the clip and the transcript line stay in sync by construction.
import { renderSlot, trackValues, currentValues, showName } from './templates.js';
import { timeBlockKey } from './rules.js';
import { decideFenceposts } from '../producer/fenceposts.js';

// Every dj segment carries the EXACT seed its template variant was drawn
// with (script/format.js persists it as a `seed:` field; director/index.js
// threads it into the no-model voice layer). This is what makes the clips
// mode's documented promise true: auto/voice.js picks numbered takes with
// the same FNV-1a hash over this same string, so when a persona has one
// recorded take per template variant, take index and variant index coincide
// and "what the transcript says" is "what the clip says". Without it the
// director passed a made-up `${title}|${i}` seed that had nothing to do with
// the variant draw -- text and audio rotated independently.
function seedFor({ showId, date, track, slot }) {
  return [showId, date, track?.ratingKey ?? 'none', slot].join('|');
}

// Rubrik segments (weatherNow / sportHeadlines / obzorje) rendered from the
// data collectRubricData() fetched -- a null rubric simply contributes no
// segments (skip-not-fail, the same contract as voice clips).
function rubricSegments({ rubricData, persona, commonValues, showId, date }) {
  const segments = [];
  if (!rubricData) return segments;

  const weather = rubricData.weather;
  if (weather?.source === 'fallback') {
    // P4 #29: ARSO unreachable (offline mode, dead router, station miss) --
    // the rubric airs an HONEST offline line instead of vanishing (the
    // handoff at the two-thirds position would otherwise promise weather
    // and deliver silence). The station name is config and always truthful;
    // the pool itself carries no fabricated condition/temperature.
    const seed = seedFor({ showId, date, slot: 'weatherOffline' });
    segments.push({
      type: 'dj',
      persona,
      slot: 'weatherOffline',
      seed,
      body: renderSlot('weatherOffline', {
        values: { ...commonValues(), station: weather.station },
        seed,
      }),
    });
  } else if (weather) {
    const seed = seedFor({ showId, date, slot: 'weatherNow' });
    segments.push({
      type: 'dj',
      persona,
      slot: 'weatherNow',
      seed,
      body: renderSlot('weatherNow', {
        values: {
          ...commonValues(),
          station: weather.station,
          condition: weather.condition,
          temp: weather.temp,
        },
        seed,
      }),
    });
  }

  const news = rubricData.news;
  if (news?.headlines) {
    const seed = seedFor({ showId, date, slot: 'newsHeadlines' });
    segments.push({
      type: 'dj',
      persona,
      slot: 'newsHeadlines',
      seed,
      body: renderSlot('newsHeadlines', {
        values: { ...commonValues(), headlines: news.headlines },
        seed,
      }),
    });
  } else if (news?.source === 'fallback') {
    // P4 #30: RTV unreachable or empty -- the rubric airs an HONEST offline
    // line instead of vanishing. No headlines exist to render, so the pool
    // carries none; the honesty rules live in templates.newsOffline and
    // their guards in test/honestOffline.test.mjs.
    const seed = seedFor({ showId, date, slot: 'newsOffline' });
    segments.push({
      type: 'dj',
      persona,
      slot: 'newsOffline',
      seed,
      body: renderSlot('newsOffline', {
        values: commonValues(),
        seed,
      }),
    });
  }

  const sport = rubricData.sport;
  if (sport?.headlines) {
    const seed = seedFor({ showId, date, slot: 'sportHeadlines' });
    segments.push({
      type: 'dj',
      persona,
      slot: 'sportHeadlines',
      seed,
      body: renderSlot('sportHeadlines', {
        values: { ...commonValues(), headlines: sport.headlines },
        seed,
      }),
    });
  } else if (sport?.source === 'fallback') {
    // P4 #30: same honest contract as novice -- see templates.sportOffline.
    const seed = seedFor({ showId, date, slot: 'sportOffline' });
    segments.push({
      type: 'dj',
      persona,
      slot: 'sportOffline',
      seed,
      body: renderSlot('sportOffline', {
        values: commonValues(),
        seed,
      }),
    });
  }

  for (const [index, event] of (rubricData.onThisDay?.events ?? []).entries()) {
    const female = event.sex === 'female';
    const kindKey = event.kind === 'death' ? (female ? 'deathF' : 'death') : female ? 'birthF' : 'birth';
    const seed = seedFor({ showId, date, slot: `obzorje:${index}` });
    segments.push({
      type: 'dj',
      persona,
      slot: 'obzorje',
      seed,
      body: renderSlot('obzorje', {
        values: { ...commonValues(), year: event.year, name: event.name, kindKey },
        seed,
      }),
    });
  }
  // P4 #30: Wikidata unreachable or a legitimately event-less answer -- ONE
  // honest line keeps the rubric on air without inventing a single name or
  // year. A healthy response with events keeps the per-event loop above.
  if ((rubricData.onThisDay?.events ?? []).length === 0 && rubricData.onThisDay?.source === 'fallback') {
    const seed = seedFor({ showId, date, slot: 'obzorjeOffline' });
    segments.push({
      type: 'dj',
      persona,
      slot: 'obzorjeOffline',
      seed,
      body: renderSlot('obzorjeOffline', {
        values: commonValues(),
        seed,
      }),
    });
  }

  // P4 #19: "Na današnji dan v glasbi" -- musician-filtered variant of the
  // obzorje loop, same data shape (year/name/sex/kind), its own slot so the
  // two rubrics stay independently recordable in clips mode.
  for (const [index, event] of (rubricData.onThisDayMusic?.events ?? []).entries()) {
    const female = event.sex === 'female';
    const kindKey = event.kind === 'death' ? (female ? 'deathF' : 'death') : female ? 'birthF' : 'birth';
    const seed = seedFor({ showId, date, slot: `obzorjeGlasba:${index}` });
    segments.push({
      type: 'dj',
      persona,
      slot: 'obzorjeGlasba',
      seed,
      body: renderSlot('obzorjeGlasba', {
        values: { ...commonValues(), year: event.year, name: event.name, kindKey },
        seed,
      }),
    });
  }

  // P4 #25: "Anketa" -- the active listener poll, read from the local polls
  // store (server/pollsStore.js). Local file, so it works offline exactly
  // like the quiz corpus; no active poll simply contributes no segment
  // (skip-not-fail). Fresh polls (zero votes) ask for votes; running ones
  // report the honest current tally, never a final winner claim.
  const poll = rubricData.poll;
  if (poll?.question) {
    const hasVotes = (poll.total ?? 0) > 0 && poll.leader != null;
    const seed = seedFor({ showId, date, slot: hasVotes ? 'pollResults' : 'pollRunning' });
    segments.push({
      type: 'dj',
      persona,
      slot: hasVotes ? 'pollResults' : 'pollRunning',
      seed,
      body: hasVotes
        ? renderSlot('pollResults', {
            values: {
              ...commonValues(),
              question: poll.question,
              leader: poll.leader,
              leaderVotes: poll.leaderVotes,
              total: poll.total,
            },
            seed,
          })
        : renderSlot('pollRunning', {
            values: { ...commonValues(), question: poll.question },
            seed,
          }),
    });
  }

  // P4 #26: "Poslusalci" -- freshly approved listener requests/dedications
  // (server/requestsStore.js via feeds.js collectListenerShout). Each shout
  // is its own segment so clips-mode users can record the line once; the
  // collector already windowed/truncated the data, the templates only
  // dress it. No fresh approvals -> no segments (skip-not-fail).
  for (const [index, shout] of (rubricData.listeners?.shouts ?? []).entries()) {
    const slot = shout.kind === 'dedication' ? 'dedicationShout' : 'requestShout';
    const seed = seedFor({ showId, date, slot: `${slot}:${index}` });
    segments.push({
      type: 'dj',
      persona,
      slot,
      seed,
      body:
        shout.kind === 'dedication'
          ? renderSlot('dedicationShout', {
              values: { ...commonValues(), message: shout.message, from: shout.from },
              seed,
            })
          : renderSlot('requestShout', {
              values: { ...commonValues(), artist: shout.artist, title: shout.title, from: shout.from },
              seed,
            }),
    });
  }

  return segments;
}

// P4 #17 helpers: trivia about the artist about to play (first occurrence
// only) or a general rock-history fact, placed before every 3rd track's
// intro (i % 3 === 1 -> tracks #2, #5, #8, ...) so the show stays music-
// first. Artist facts outrank the general corpus at a sprinkle slot; the
// corpus fills the rest (and covers shows whose artists carry no data).
// Deterministic end to end: same tracklist + same facts -> same segments.
function foldArtistKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function triviaSegments({ trivia, track, index, persona, commonValues, showId, date, trackSeed, state }) {
  if (!trivia || index % 3 !== 1) return [];
  const segments = [];
  const key = foldArtistKey(track.artist);
  const artistFact = state.artistFactsByFold.get(key);
  if (artistFact && !state.usedArtistFolds.has(key)) {
    state.usedArtistFolds.add(key);
    const seed = `${trackSeed}|triviaArtist:${index}`;
    segments.push({
      type: 'dj',
      persona,
      slot: 'triviaArtist',
      seed,
      body: renderSlot('triviaArtist', {
        values: { ...commonValues(), fact: artistFact.text },
        seed,
      }),
    });
    return segments;
  }
  const generalFact = state.generalFactQueue.shift();
  if (generalFact) {
    const seed = `${trackSeed}|triviaGeneral:${index}`;
    segments.push({
      type: 'dj',
      persona,
      slot: 'triviaGeneral',
      seed,
      body: renderSlot('triviaGeneral', {
        values: { ...commonValues(), fact: generalFact.text },
        seed,
      }),
    });
  }
  return segments;
}

export function buildSegmentsAuto({ tracks, brief, showId, date, rubricData = null, block: blockParam }) {
  // The time-of-day block, resolved ONCE per show build. The wall-clock truth
  // lives at PRODUCE time: produce.js resolves it before Phase A and passes it
  // in, so the genre steering and the open/close greeting variants share one
  // resolution and can never disagree about what part of the day it is.
  // renderSlot itself does NO block resolution -- it only reads the block it
  // is handed (or values.block) -- so a caller that skips the parameter would
  // silently fall back to the default greeting pools. The timeBlockKey()
  // fallback below keeps such standalone callers (tests, preview tooling)
  // honest instead: the block is still the caller's wall clock, just resolved
  // here rather than earlier. Production-time, not airtime: prewarm runs in
  // the downtime window before the slot (see rules.js's blockGenrePreference
  // for the same caveat).
  const block = blockParam ?? timeBlockKey();

  const segments = [];
  const n = tracks.length;

  const quizIndex = brief.hasQuiz ? Math.floor(n / 2) : -1;
  const weatherAfterIndex = brief.hasWeather ? Math.floor((n * 2) / 3) : -1;

  // Val 28 C1: the deterministic talk map (producer/fenceposts.js) -- same
  // seed discipline as every renderSlot draw, so a regenerated script and
  // its own cached audio never disagree about which boundaries talk.
  const fenceposts = decideFenceposts({
    seed: seedFor({ showId, date, slot: 'fenceposts' }),
    trackCount: n,
    hasQuiz: brief.hasQuiz,
    hasWeather: brief.hasWeather,
  });
  // Boundary i silent => the recap of track i and the intro of track i+1
  // are BOTH dropped (a genuine back-to-back pair). silentBefore(i) is the
  // read the intro/trivia side needs.
  const silentBefore = (i) => i >= 1 && fenceposts.silentBoundaries.has(i - 1);

  const primaryPersona = brief.primaryPersona;
  const weatherPersona = brief.weatherPersona ?? primaryPersona;

  const base = currentValues();
  const showTitle = brief.title || showId;
  const commonValues = () => ({
    ...base,
    show: showName(showTitle),
    to: weatherPersona,
  });

  // P4 #17 trivia state: artist facts keyed by folded artist name, the
  // general corpus facts as a queue (consumed only at sprinkle slots), and
  // the set of artists already told (one fact per artist per show).
  const trivia = rubricData?.trivia ?? null;
  const triviaState = {
    artistFactsByFold: new Map((trivia?.artistFacts ?? []).map((fact) => [foldArtistKey(fact.artist), fact])),
    usedArtistFolds: new Set(),
    generalFactQueue: [...(trivia?.generalFacts ?? [])],
  };

  // P4 #22 quiz state: real question/answer pairs from the "Kviz" rubric
  // (auto/quizFacts.js via feeds.js). Consumed FIFO at the quiz position;
  // when the queue is empty the legacy year-guess quizIntro/quizReveal
  // templates render instead -- same slots, no brief change needed.
  const quizQueue = [...(rubricData?.quiz?.questions ?? [])];

  const openSeed = seedFor({ showId, date, slot: 'open' });
  segments.push({
    type: 'dj',
    persona: primaryPersona,
    slot: 'open',
    seed: openSeed,
    body: renderSlot('open', {
      values: commonValues(),
      // Production-time block, resolved once at the top of this build -- the
      // only source a block-pooled slot (open/close) ever gets its block from.
      block,
      seed: openSeed,
    }),
  });

  // Rubrikes come right after the opening -- real data (ARSO / RTV /
  // Wikidata), rendered through the same template machinery as everything
  // else. Each one is its own slot so clips-mode users can record exactly
  // those intros and nothing else.
  segments.push(
    ...rubricSegments({ rubricData, persona: primaryPersona, commonValues, showId, date })
  );

  // P4 #25: "Sledi kasneje" tease -- after the rubrics, before the first
  // track. The professional-radios move of teasing what the show holds
  // later. Names an artist from the resolved queue's back half (the LAST
  // track, so the promise is true by construction) and, when the brief
  // opens the quiz position, the quiz itself. Needs a real show length
  // (>= 3 tracks) to promise anything; shorter shows skip it silently.
  if (n >= 3) {
    const teaseArtist = tracks[n - 1]?.artist;
    if (teaseArtist) {
      const teaseSlot = brief.hasQuiz ? 'teaseQuiz' : 'tease';
      const teaseSeed = seedFor({ showId, date, slot: 'tease' });
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: teaseSlot,
        seed: teaseSeed,
        body: renderSlot(teaseSlot, {
          values: { ...commonValues(), artist: teaseArtist },
          seed: teaseSeed,
        }),
      });
    }
  }

  for (let i = 0; i < n; i++) {
    const track = tracks[i];
    const trackSeed = seedFor({ showId, date, track, slot: 'x' });

    // Val 28 C1: the MID-show tease -- one talk break with a task ("keep
    // them through the back half") at the fenceposts module's midTeaseIndex.
    // Names an artist still ahead in the queue (second-to-last track, so it
    // differs from the top tease's last-track promise), true by construction.
    if (i === fenceposts.midTeaseIndex && i >= 1) {
      const teaseMidArtist = tracks[Math.max(1, n - 2)]?.artist ?? tracks[n - 1]?.artist;
      if (teaseMidArtist) {
        const teaseMidSeed = seedFor({ showId, date, slot: 'teaseMid' });
        segments.push({
          type: 'dj',
          persona: primaryPersona,
          slot: 'teaseMid',
          seed: teaseMidSeed,
          body: renderSlot('teaseMid', {
            values: { ...commonValues(), artist: teaseMidArtist },
            seed: teaseMidSeed,
          }),
        });
      }
    }

    // P4 #17: "Zanimivosti" land right before the intro of every 3rd track
    // -- a fact about THAT track's artist, or a general rock fact when the
    // artist has none. Val 28 C1: trivia is deliberately NOT gated on silent
    // boundaries -- a fact about the artist straight into the song is a
    // natural break in its own right (the boundary drops only the
    // intro/recap pair, and the P4 #17 cadence stays intact).
    segments.push(
      ...triviaSegments({ trivia, track, index: i, persona: primaryPersona, commonValues, showId, date, trackSeed, state: triviaState })
    );

    // P4 #22: at the quiz position consume ONE question from the queue (null
    // when the rubric is off / corpus empty -> legacy year-guess below).
    const quizItem = i === quizIndex ? quizQueue.shift() ?? null : null;

    if (i === quizIndex) {
      const quizIntroSeed = `${trackSeed}|quizIntro`;
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'quizIntro',
        seed: quizIntroSeed,
        body: quizItem
          ? renderSlot('quizQuestion', {
              values: { ...commonValues(), question: quizItem.prompt },
              seed: quizIntroSeed,
            })
          : renderSlot('quizIntro', { values: { ...commonValues(), ...trackValues(track) }, seed: quizIntroSeed }),
      });
    } else if (!silentBefore(i)) {
      // Val 28 C1: a silent boundary drops this intro -- the previous track
      // runs straight into this one (the recap before it was dropped too).
      const introSeed = `${trackSeed}|intro`;
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'intro',
        seed: introSeed,
        body: renderSlot('intro', { values: { ...commonValues(), ...trackValues(track) }, seed: introSeed }),
      });
    }

    segments.push({ type: 'track', artist: track.artist, title: track.title, ratingKey: track.ratingKey });

    if (i === quizIndex) {
      const quizRevealSeed = `${trackSeed}|quizReveal`;
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'quizReveal',
        seed: quizRevealSeed,
        body: quizItem
          ? renderSlot('quizAnswer', {
              values: { ...commonValues(), answer: quizItem.answer },
              seed: quizRevealSeed,
            })
          : renderSlot('quizReveal', { values: { ...commonValues(), ...trackValues(track) }, seed: quizRevealSeed }),
      });
    } else if (!fenceposts.silentBoundaries.has(i)) {
      // Val 28 C1: a silent boundary drops this recap -- the next track runs
      // straight on (protected boundaries -- quiz reveal, weather handoff --
      // are never silent by construction in the fenceposts module).
      const recapSeed = `${trackSeed}|recap`;
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'recap',
        seed: recapSeed,
        body: renderSlot('recap', {
          values: { ...commonValues(), ...trackValues(track), track },
          seed: recapSeed,
        }),
      });
    }

    if (i === weatherAfterIndex && weatherAfterIndex !== n - 1) {
      const handoffSeed = `${trackSeed}|handoff`;
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'handoff',
        seed: handoffSeed,
        body: renderSlot('handoff', { values: commonValues(), seed: handoffSeed }),
      });
      segments.push({
        type: 'live',
        persona: weatherPersona,
        kind: 'weather',
        brief: 'short, template-based check-in',
      });
    }
  }

  // Paket B1 (docs/programming-research.md §5): the closing "what's next"
  // announcement. This segment is DATA-FREE on purpose -- ALL resolution
  // (next show name/host/time/day word) happens at DIRECT time in
  // auto/liveLines.js, never at script time, because a same-day repeat
  // shares one script.md AND one dj-audio cache, so a script-time "next
  // show" would name a show that already aired on the re-run. It lands
  // immediately BEFORE the close dj segment, so the announcement and the
  // goodbye are consecutive speech segments -- the director's
  // flushPendingSpeech concat-splices them into one physical file
  // (director/index.js:114-148), announcement first, sign-off second, no
  // crossfade between them.
  segments.push({
    type: 'live',
    persona: primaryPersona,
    kind: 'nextShow',
    brief: 'announce the next show on the schedule, then hand to the close',
  });

  const closeSeed = seedFor({ showId, date, slot: 'close' });
  segments.push({
    type: 'dj',
    persona: primaryPersona,
    slot: 'close',
    seed: closeSeed,
    body: renderSlot('close', {
      values: commonValues(),
      // Same single production-time resolution as the open slot above --
      // open and close bookend ONE show, so they must speak the same part of
      // the day even if the show is produced long before it airs.
      block,
      seed: closeSeed,
    }),
  });

  return { segments };
}
