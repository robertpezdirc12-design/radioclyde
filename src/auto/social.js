// Social export (P4 #25) -- the research pass's fourth finding: the
// headline sources (ARSO, RTV, Wikidata, quiz corpus) already produce
// Slovenian one-liners, so turning a produced show into ready-to-post
// updates is a MAPPING, not a model. This module reads a produced
// script.md and emits a deterministic set of posts:
//
//   01-karta.txt     -- the episode card (station, show, date, track count)
//   02-vreme.txt ... -- one post per rubric segment (weather, news, sport,
//                       obzorje, music on-this-day, trivia, quiz question)
//   NN-najave.txt    -- the first tracks of the show as a "na sporedu" card
//
// Every post ends with the station hashtag and stays under SOCIAL_LIMIT
// characters (truncated at a word boundary when a rubric runs long). Same
// input -> same files, byte for byte.
export const SOCIAL_LIMIT = 280;

export const HASHTAG = '#RadioMarkec';

const SLOT_FILES = {
  weatherNow: 'vreme',
  weatherOffline: 'vreme',
  newsHeadlines: 'novice',
  sportHeadlines: 'sport',
  obzorje: 'obzorje',
  obzorjeGlasba: 'obzorje-glasba',
  triviaArtist: 'zanimivost',
  triviaGeneral: 'zanimivost',
  quizIntro: 'kviz',
};

function cleanup(body) {
  return String(body ?? '').replace(/ -- /g, ' \u2013 ').trim();
}

function withHashtag(text) {
  return `${text}\n\n${HASHTAG}`;
}

// Truncates at the last word boundary that still fits the limit (leaving
// room for the ellipsis + hashtag), never mid-word.
export function fitToLimit(text, limit = SOCIAL_LIMIT) {
  const full = withHashtag(text);
  if (full.length <= limit) return full;
  const room = limit - HASHTAG.length - 2 - 1; // \n\n + ellipsis
  const cut = text.slice(0, room);
  const boundary = cut.lastIndexOf(' ');
  return withHashtag(`${boundary > 0 ? cut.slice(0, boundary) : cut}\u2026`);
}

export function socialPostsFromSegments({ segments, title, date, station = 'Radio Markec' }) {
  const posts = [];
  const djSegments = segments.filter((s) => s.type === 'dj');

  // 01 -- the episode card.
  const trackCount = segments.filter((s) => s.type === 'track').length;
  posts.push({
    file: '01-karta.txt',
    text: fitToLimit(
      `${station}, ${date}: ${title}. ${trackCount} skladb, rubrike, kviz -- vse po mizi, brez dolgčasanja.`,
    ),
  });

  // Rubric segments in air order, numbered after the card.
  let index = 2;
  for (const seg of djSegments) {
    const name = SLOT_FILES[seg.slot];
    if (!name) continue;
    posts.push({ file: `${String(index).padStart(2, '0')}-${name}.txt`, text: fitToLimit(cleanup(seg.body)) });
    index += 1;
  }

  // The first three tracks as the "na sporedu" card.
  const tracks = segments.filter((s) => s.type === 'track').slice(0, 3);
  if (tracks.length) {
    const list = tracks.map((t) => `${t.artist} \u2013 ${t.title}`).join(' \u2022 ');
    posts.push({ file: `${String(index).padStart(2, '0')}-najave.txt`, text: fitToLimit(`Na sporedu: ${list}`) });
  }

  return posts;
}
