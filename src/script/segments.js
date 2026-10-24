// Segment taxonomy + min-inventory metric (integration-table item #7,
// borrowed from WRIT-FM's deterministic structure -- docs/ready-made-scripts-
// analysis.md §4.2). WRIT-FM's insight: whatever generates the content, the
// SHAPE of a show is a small, named, countable set of segment types
// (show_intro, listener_mailbag, news_analysis, deep_dive, show_outro, ...)
// and a station's health is visible in their counts (>=3 speech breaks per
// slot, >=20 tracks per show). Content generation here is already either
// authored (script.md) or template-rendered (auto/scriptBuilder.js); this
// module adds the missing VOCABULARY + the health metric, nothing else.
//
// Mapping WRIT-FM's types onto our reality (honest, closed set):
//   - show_intro / show_outro -> our `open`/`close` slots (auto scripts) or
//     first/last speech segment (manual scripts, no slot field).
//   - news_analysis -> our rubric slots (newsHeadlines / sportHeadlines /
//     obzorje) -- real data, template-rendered.
//   - WRIT has no weather/time check-in -> our `weatherNow` rubric and
//     `type: live` segments become weather_check (first-class here).
//   - our per-track chatter (intro/recap slots) -> track_intro (our highest-
//     volume type; WRIT speaks track intros too, just never named them).
//   - our quiz (quizIntro/quizReveal) -> quiz.
//   - listener_mailbag, deep_dive, story, music_essay, interview, panel ->
//     EXPLICIT ONLY: nothing in today's structure implies them, so they are
//     never guessed. They become real the moment a script tags one.
//   - free-form dj talk -> banter (inferred fallback).
//   - station_id -> NOT a script segment here: the imaging layer already
//     owns station IDs (imaging/id.m3u on top of the hour, P1 #1) -- the
//     taxonomy records that as a mapping, not a type scripts can tag.
//
// The type rides on scripts as an OPTIONAL `segment:` field on dj/live
// segments (script/format.js validates it against this set; absent = inferred
// from slot/position, so every existing script classifies unchanged). Nothing
// here changes playback: the director still just speaks dj bodies and
// resolves live kinds -- the taxonomy is DATA for the min-inventory metric
// and the studio Diagnostics readiness view.
//
// min-inventory ("zdravstveno merilo zaloge", WRIT-FM): >= minSpeechSegments
// speech segments (dj + live) per show, >= minTracksPer30Minutes * duration/30
// tracks. Defaults follow WRIT's >=3 speech breaks/slot and scale their
// >=20-tracks/hour to our library's 3.5-5 min tracks (6 per 30 min). The
// metric REPORTS -- it never blocks a parse or a production (parseScript's
// issues stay the only blocking contract); a shortfall shows up in
// Diagnostics as "content not ready for the next slot", where the operator
// can act on it.

// The closed set. Anything a script tags must be exactly one of these
// strings; anything inferred is one of these strings. Test pins both.
export const SEGMENT_TYPES = [
  'show_intro',
  'show_outro',
  'track_intro',
  'quiz',
  'news_analysis',
  'weather_check',
  'listener_mailbag',
  'deep_dive',
  'story',
  'music_essay',
  'interview',
  'panel',
  'banter',
];

const SEGMENT_TYPE_SET = new Set(SEGMENT_TYPES);

export function isSegmentType(value) {
  return typeof value === 'string' && SEGMENT_TYPE_SET.has(value);
}

// auto/scriptBuilder.js's slot vocabulary -> content type. `handoff` is a
// structural toss (free speech bridging two segments), so it lands in the
// banter fallback, not a content type of its own.
const SLOT_TYPES = {
  open: 'show_intro',
  close: 'show_outro',
  intro: 'track_intro',
  recap: 'track_intro',
  quizIntro: 'quiz',
  quizReveal: 'quiz',
  newsHeadlines: 'news_analysis',
  sportHeadlines: 'news_analysis',
  obzorje: 'news_analysis',
  obzorjeGlasba: 'news_analysis', // P4 #19: musician-filtered on-this-day
  triviaArtist: 'story',          // P4 #17: a fact about the playing artist
  triviaGeneral: 'music_essay',   // P4 #17: general rock-history fact
  weatherNow: 'weather_check',
  tease: 'banter',                // P4 #25: "sledi kasneje" tease (promo-flavored)
  teaseQuiz: 'banter',            // P4 #25: same, quiz-flavored variant
  pollRunning: 'listener_mailbag', // P4 #25: fresh poll, votes wanted
  pollResults: 'listener_mailbag', // P4 #25: poll tally mid-show
  requestShout: 'listener_mailbag',     // P4 #26: approved request on air
  dedicationShout: 'listener_mailbag',  // P4 #26: approved dedication on air
  handoff: 'banter',
};

// The imaging layer owns station IDs -- recorded here so the taxonomy's
// WRIT-FM mapping is complete and greppable, though no script can tag it.
export const STATION_ID_OWNER = 'imaging layer (imaging/id.m3u, on the hour)';

// One segment's content type. `seg` is a parsed script segment
// (script/format.js shape). Explicit `segment:` wins; slots map next;
// unslotted speech infers show_intro/show_outro from position (the first and
// last spoken segments of a show are its intro/outro -- WRIT-FM's point that
// these are first-class types, true here even when nobody tagged them);
// anything else is banter. Track segments are music, not speech content --
// null (the inventory counts them separately).
export function classifySegment(seg, { isFirstSpeech = false, isLastSpeech = false } = {}) {
  if (!seg || seg.type === 'track') return null;
  if (isSegmentType(seg.segment)) return seg.segment;
  if (seg.type === 'live') return 'weather_check';
  if (seg.slot != null) return SLOT_TYPES[seg.slot] ?? 'banter';
  if (isFirstSpeech) return 'show_intro';
  if (isLastSpeech) return 'show_outro';
  return 'banter';
}

// Counts one show's inventory and judges it against the min-inventory
// thresholds. Pure: thresholds arrive as arguments (the server layer reads
// them from config.shows.inventory, F2 pattern -- missing block = defaults).
// Tracks have no threshold when durationMinutes is unknown -- reporting what
// IS means not inventing a duration to fail against.
export function segmentInventory(
  segments,
  { durationMinutes = null, minSpeechSegments = 3, minTracksPer30Minutes = 6 } = {}
) {
  const speech = (segments ?? []).filter((s) => s.type === 'dj' || s.type === 'live');
  const firstSpeechIdx = speech.length ? 0 : -1;
  const lastSpeechIdx = speech.length - 1;
  const byType = new Map();
  speech.forEach((seg, i) => {
    const type = classifySegment(seg, { isFirstSpeech: i === firstSpeechIdx, isLastSpeech: i === lastSpeechIdx });
    byType.set(type, (byType.get(type) ?? 0) + 1);
  });

  const trackCount = (segments ?? []).filter((s) => s.type === 'track').length;
  const speechCount = speech.length;
  const minTracks =
    durationMinutes && durationMinutes > 0
      ? Math.ceil((minTracksPer30Minutes * durationMinutes) / 30)
      : null;

  const shortfalls = [];
  if (speechCount < minSpeechSegments) {
    shortfalls.push(
      `speech segments: ${speechCount} (minimum ${minSpeechSegments}) -- WRIT-FM's "at least 3 spoken breaks per slot"`
    );
  }
  if (minTracks != null && trackCount < minTracks) {
    shortfalls.push(`tracks: ${trackCount} (minimum ${minTracks} for ${durationMinutes} min)`);
  }

  return {
    speechCount,
    trackCount,
    types: [...byType.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, count]) => ({ type, count })),
    hasIntro: byType.has('show_intro'),
    hasOutro: byType.has('show_outro'),
    thresholds: { minSpeechSegments, minTracks },
    meets: shortfalls.length === 0,
    shortfalls,
  };
}
