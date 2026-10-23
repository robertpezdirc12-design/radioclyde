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

  for (let i = 0; i < n; i++) {
    const track = tracks[i];
    const trackSeed = seedFor({ showId, date, track, slot: 'x' });

    if (i === quizIndex) {
      segments.push({
        type: 'dj',
        persona: primaryPersona,
        slot: 'quizIntro',
        body: renderSlot('quizIntro', { values: { ...commonValues(), ...trackValues(track) }, seed: `${trackSeed}|quizIntro` }),
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
        body: renderSlot('quizReveal', { values: { ...commonValues(), ...trackValues(track) }, seed: `${trackSeed}|quizReveal` }),
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
