// The deterministic boundary walk -- the no-AI counterpart to
// producer/boundaryWalk.js + producer/moves.js (+ reviewScript.js, which is
// simply unnecessary here: templates cannot repeat each other's phrasing the
// way free generation does). The code walks the tracklist exactly like
// boundaryWalk.js does -- open, per-track intro/recap, mid-show quiz, the
// two-thirds weather handoff, close -- but every spoken line is rendered
// from config templates (auto/templates.js) with the track's real library
// metadata, not generated.
//
// Segment shape matches parseScript's expectations, with one addition: dj
// segments carry a `slot` field (open/intro/recap/quizIntro/quizReveal/
// handoff/close). script/format.js persists it, and the no-model voice
// layer (auto/voice.js, clips mode) uses it to pick which pre-recorded clip
// plays -- the clip and the transcript line stay in sync by construction.
import { renderSlot, trackValues, currentValues, showName } from './templates.js';

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
  if (weather) {
    segments.push({
      type: 'dj',
      persona,
      slot: 'weatherNow',
      body: renderSlot('weatherNow', {
        values: {
          ...commonValues(),
          station: weather.station,
          condition: weather.condition,
          temp: weather.temp,
        },
        seed: seedFor({ showId, date, slot: 'weatherNow' }),
      }),
    });
  }

  const news = rubricData.news;
  if (news?.headlines) {
    segments.push({
      type: 'dj',
      persona,
      slot: 'newsHeadlines',
      body: renderSlot('newsHeadlines', {
        values: { ...commonValues(), headlines: news.headlines },
        seed: seedFor({ showId, date, slot: 'newsHeadlines' }),
      }),
    });
  }

  const sport = rubricData.sport;
  if (sport?.headlines) {
    segments.push({
      type: 'dj',
      persona,
      slot: 'sportHeadlines',
      body: renderSlot('sportHeadlines', {
        values: { ...commonValues(), headlines: sport.headlines },
        seed: seedFor({ showId, date, slot: 'sportHeadlines' }),
      }),
    });
  }

  for (const [index, event] of (rubricData.onThisDay?.events ?? []).entries()) {
    const female = event.sex === 'female';
    const kindKey = event.kind === 'death' ? (female ? 'deathF' : 'death') : female ? 'birthF' : 'birth';
    segments.push({
      type: 'dj',
      persona,
      slot: 'obzorje',
      body: renderSlot('obzorje', {
        values: { ...commonValues(), year: event.year, name: event.name, kindKey },
        seed: seedFor({ showId, date, slot: `obzorje:${index}` }),
      }),
    });
  }

  // P4 #19: "Na današnji dan v glasbi" -- musician-filtered variant of the
  // obzorje loop, same data shape (year/name/sex/kind), its own slot so the
  // two rubrics stay independently recordable in clips mode.
  for (const [index, event] of (rubricData.onThisDayMusic?.events ?? []).entries()) {
    const female = event.sex === 'female';
    const kindKey = event.kind === 'death' ? (female ? 'deathF' : 'death') : female ? 'birthF' : 'birth';
    segments.push({
      type: 'dj',
      persona,
      slot: 'obzorjeGlasba',
      body: renderSlot('obzorjeGlasba', {
        values: { ...commonValues(), year: event.year, name: event.name, kindKey },
        seed: seedFor({ showId, date, slot: `obzorjeGlasba:${index}` }),
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
    segments.push({
      type: 'dj',
      persona,
      slot: hasVotes ? 'pollResults' : 'pollRunning',
      body: hasVotes
        ? renderSlot('pollResults', {
            values: {
              ...commonValues(),
              question: poll.question,
              leader: poll.leader,
              leaderVotes: poll.leaderVotes,
              total: poll.total,
            },
            seed: seedFor({ showId, date, slot: 'pollResults' }),
          })
        : renderSlot('pollRunning', {
            values: { ...commonValues(), question: poll.question },
            seed: seedFor({ showId, date, slot: 'pollRunning' }),
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
    segments.push({
      type: 'dj',
      persona,
      slot: 'triviaArtist',
      body: renderSlot('triviaArtist', {
        values: { ...commonValues(), fact: artistFact.text },
        seed: `${trackSeed}|triviaArtist:${index}`,
      }),
    });
    return segments;
  }
  const generalFact = state.generalFactQueue.shift();
  if (generalFact) {
    segments.push({
      type: 'dj',
      persona,
      slot: 'triviaGeneral',
      body: renderSlot('triviaGeneral', {
        values: { ...commonValues(), fact: generalFact.text },
        seed: `${trackSeed}|triviaGeneral:${index}`,
      }),
    });
  }
  return segments;
}

export function buildSegmentsAuto({ tracks, brief, showId, date, rubricData = null }) {
  const segments = [];
  const n = tracks.length;

  const quizIndex = brief.hasQuiz ? Math.floor(n / 2) : -1;
  const weatherAfterIndex = brief.hasWeather ? Math.floor((n * 2) / 3) : -1;

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

  segments.push({
    type: 'dj',
    persona: primaryPersona,
    slot: 'open',
    body: renderSlot('open', {
      values: commonValues(),
      block: undefined, // resolved inside renderSlot from the wall clock
      seed: seedFor({ showId, date, slot: 'open' }),
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
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: teaseSlot,
        body: renderSlot(teaseSlot, {
          values: { ...commonValues(), artist: teaseArtist },
          seed: seedFor({ showId, date, slot: 'tease' }),
        }),
      });
    }
  }

  for (let i = 0; i < n; i++) {
    const track = tracks[i];
    const trackSeed = seedFor({ showId, date, track, slot: 'x' });

    // P4 #17: "Zanimivosti" land right before the intro of every 3rd track
    // -- a fact about THAT track's artist, or a general rock fact when the
    // artist has none.
    segments.push(
      ...triviaSegments({ trivia, track, index: i, persona: primaryPersona, commonValues, showId, date, trackSeed, state: triviaState })
    );

    // P4 #22: at the quiz position consume ONE question from the queue (null
    // when the rubric is off / corpus empty -> legacy year-guess below).
    const quizItem = i === quizIndex ? quizQueue.shift() ?? null : null;

    if (i === quizIndex) {
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'quizIntro',
        body: quizItem
          ? renderSlot('quizQuestion', {
              values: { ...commonValues(), question: quizItem.prompt },
              seed: `${trackSeed}|quizIntro`,
            })
          : renderSlot('quizIntro', { values: { ...commonValues(), ...trackValues(track) }, seed: `${trackSeed}|quizIntro` }),
      });
    } else {
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'intro',
        body: renderSlot('intro', { values: { ...commonValues(), ...trackValues(track) }, seed: `${trackSeed}|intro` }),
      });
    }

    segments.push({ type: 'track', artist: track.artist, title: track.title, ratingKey: track.ratingKey });

    if (i === quizIndex) {
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'quizReveal',
        body: quizItem
          ? renderSlot('quizAnswer', {
              values: { ...commonValues(), answer: quizItem.answer },
              seed: `${trackSeed}|quizReveal`,
            })
          : renderSlot('quizReveal', { values: { ...commonValues(), ...trackValues(track) }, seed: `${trackSeed}|quizReveal` }),
      });
    } else {
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'recap',
        body: renderSlot('recap', {
          values: { ...commonValues(), ...trackValues(track), track },
          seed: `${trackSeed}|recap`,
        }),
      });
    }

    if (i === weatherAfterIndex && weatherAfterIndex !== n - 1) {
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'handoff',
        body: renderSlot('handoff', { values: commonValues(), seed: `${trackSeed}|handoff` }),
      });
      segments.push({
        type: 'live',
        persona: weatherPersona,
        kind: 'weather',
        brief: 'short, template-based check-in',
      });
    }
  }

  segments.push({
    type: 'dj',
    persona: primaryPersona,
    slot: 'close',
    body: renderSlot('close', {
      values: commonValues(),
      block: undefined,
      seed: seedFor({ showId, date, slot: 'close' }),
    }),
  });

  return { segments };
}
