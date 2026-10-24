// "Na današnji dan v glasbi" local corpus (P4 #28) -- the OFFLINE fallback
// content for the "obzorjeGlasba" rubric. While the primary source is
// Wikidata SPARQL (auto/feeds.js onThisDayMusicSparql), that path dies
// without network -- and a rubric named "na današnji dan" is exactly the
// one a station wants to survive a dead router. Like quizFacts.js, this
// file is a frozen operator decision: zero network, zero model, real facts.
//
// Ground rules for entries (mirrors quizFacts.js):
//   - only widely documented, non-controversial facts (multiple encyclopedias
//     agree); no "allegedly", no tabloid lore, no horoscope fluff,
//   - `kind` is 'birth' or 'death' ONLY -- the obzorje/obzorjeGlasba template
//     pools render exactly those two kindKeys (plus the female variants),
//   - `sex` is 'male' or 'female' and MUST match the name's real person, the
//     Slovenian verb ending depends on it ("rodil/rodila", "umrl/umrla"),
//   - `name` is TTS-friendly: no accents-only-latin tricks, no titles,
//     no periods, no placeholders ({...} is reserved),
//   - entries are sorted by month, then day, then year -- so review walks
//     the calendar top to bottom, like the quiz corpus walks rock history.
export const ON_THIS_DAY_MUSIC = [
  { month: 1, day: 8, year: 1935, name: 'Elvis Presley', sex: 'male', kind: 'birth' },
  { month: 1, day: 8, year: 1947, name: 'David Bowie', sex: 'male', kind: 'birth' },
  { month: 1, day: 19, year: 1943, name: 'Janis Joplin', sex: 'female', kind: 'birth' },
  { month: 1, day: 19, year: 1946, name: 'Dolly Parton', sex: 'female', kind: 'birth' },
  { month: 2, day: 3, year: 1959, name: 'Buddy Holly', sex: 'male', kind: 'death' },
  { month: 2, day: 6, year: 1945, name: 'Bob Marley', sex: 'male', kind: 'birth' },
  { month: 2, day: 20, year: 1967, name: 'Kurt Cobain', sex: 'male', kind: 'birth' },
  { month: 2, day: 21, year: 1933, name: 'Nina Simone', sex: 'female', kind: 'birth' },
  { month: 3, day: 14, year: 1933, name: 'Quincy Jones', sex: 'male', kind: 'birth' },
  { month: 3, day: 25, year: 1942, name: 'Aretha Franklin', sex: 'female', kind: 'birth' },
  { month: 3, day: 25, year: 1947, name: 'Elton John', sex: 'male', kind: 'birth' },
  { month: 3, day: 30, year: 1968, name: 'Celine Dion', sex: 'female', kind: 'birth' },
  { month: 4, day: 5, year: 1994, name: 'Kurt Cobain', sex: 'male', kind: 'death' },
  { month: 5, day: 10, year: 1960, name: 'Bono', sex: 'male', kind: 'birth' },
  { month: 5, day: 11, year: 1981, name: 'Bob Marley', sex: 'male', kind: 'death' },
  { month: 5, day: 13, year: 1950, name: 'Stevie Wonder', sex: 'male', kind: 'birth' },
  { month: 5, day: 14, year: 1998, name: 'Frank Sinatra', sex: 'male', kind: 'death' },
  { month: 5, day: 24, year: 1941, name: 'Bob Dylan', sex: 'male', kind: 'birth' },
  { month: 5, day: 24, year: 2023, name: 'Tina Turner', sex: 'female', kind: 'death' },
  { month: 5, day: 26, year: 1948, name: 'Stevie Nicks', sex: 'female', kind: 'birth' },
  { month: 5, day: 31, year: 1948, name: 'John Bonham', sex: 'male', kind: 'birth' },
  { month: 6, day: 7, year: 1958, name: 'Prince', sex: 'male', kind: 'birth' },
  { month: 6, day: 18, year: 1942, name: 'Paul McCartney', sex: 'male', kind: 'birth' },
  { month: 7, day: 2, year: 2015, name: 'Slavko Avsenik', sex: 'male', kind: 'death' },
  { month: 7, day: 6, year: 1971, name: 'Louis Armstrong', sex: 'male', kind: 'death' },
  { month: 7, day: 20, year: 1947, name: 'Carlos Santana', sex: 'male', kind: 'birth' },
  { month: 7, day: 23, year: 2011, name: 'Amy Winehouse', sex: 'female', kind: 'death' },
  { month: 7, day: 26, year: 1943, name: 'Mick Jagger', sex: 'male', kind: 'birth' },
  { month: 7, day: 26, year: 2023, name: 'Sinead O\u2019Connor', sex: 'female', kind: 'death' },
  { month: 8, day: 4, year: 1901, name: 'Louis Armstrong', sex: 'male', kind: 'birth' },
  { month: 8, day: 9, year: 1963, name: 'Whitney Houston', sex: 'female', kind: 'birth' },
  { month: 8, day: 16, year: 1958, name: 'Madonna', sex: 'female', kind: 'birth' },
  { month: 8, day: 16, year: 1977, name: 'Elvis Presley', sex: 'male', kind: 'death' },
  { month: 8, day: 16, year: 2018, name: 'Aretha Franklin', sex: 'female', kind: 'death' },
  { month: 8, day: 29, year: 1958, name: 'Michael Jackson', sex: 'male', kind: 'birth' },
  { month: 9, day: 5, year: 1946, name: 'Freddie Mercury', sex: 'male', kind: 'birth' },
  { month: 9, day: 14, year: 1983, name: 'Amy Winehouse', sex: 'female', kind: 'birth' },
  { month: 9, day: 18, year: 1970, name: 'Jimi Hendrix', sex: 'male', kind: 'death' },
  { month: 9, day: 23, year: 1926, name: 'John Coltrane', sex: 'male', kind: 'birth' },
  { month: 9, day: 23, year: 1930, name: 'Ray Charles', sex: 'male', kind: 'birth' },
  { month: 10, day: 4, year: 1970, name: 'Janis Joplin', sex: 'female', kind: 'death' },
  { month: 10, day: 9, year: 1940, name: 'John Lennon', sex: 'male', kind: 'birth' },
  { month: 10, day: 13, year: 1941, name: 'Paul Simon', sex: 'male', kind: 'birth' },
  { month: 10, day: 24, year: 1936, name: 'Bill Wyman', sex: 'male', kind: 'birth' },
  { month: 11, day: 24, year: 1991, name: 'Freddie Mercury', sex: 'male', kind: 'death' },
  { month: 11, day: 26, year: 1939, name: 'Tina Turner', sex: 'female', kind: 'birth' },
  { month: 11, day: 27, year: 1942, name: 'Jimi Hendrix', sex: 'male', kind: 'birth' },
  { month: 11, day: 28, year: 1929, name: 'Slavko Avsenik', sex: 'male', kind: 'birth' },
  { month: 11, day: 29, year: 1953, name: 'Vlado Kreslin', sex: 'male', kind: 'birth' },
  { month: 12, day: 7, year: 1949, name: 'Tom Waits', sex: 'male', kind: 'birth' },
  { month: 12, day: 8, year: 1933, name: 'Jim Morrison', sex: 'male', kind: 'birth' },
  { month: 12, day: 8, year: 1980, name: 'John Lennon', sex: 'male', kind: 'death' },
  { month: 12, day: 12, year: 1915, name: 'Frank Sinatra', sex: 'male', kind: 'birth' },
  { month: 12, day: 18, year: 1943, name: 'Keith Richards', sex: 'male', kind: 'birth' },
  { month: 12, day: 19, year: 1915, name: 'Edith Piaf', sex: 'female', kind: 'birth' },
  { month: 12, day: 25, year: 2006, name: 'James Brown', sex: 'male', kind: 'death' },
];

// Same FNV-1a as templates.js / quizFacts.js / rockFacts.js -- stable across
// runs, no dependency.
function hash(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Picks today's music-calendar events from the local corpus, same event
// shape the Wikidata path returns ({year, name, sex, kind}) so scriptBuilder
// and the template pools cannot tell the sources apart. Deterministic:
// same date + same seed -> same events in the same order. No facts for the
// date -> null -> the rubric segment silently skips (skip-not-fail), exactly
// like an empty Wikidata response.
export function pickOnThisDayMusic({ month, day, limit = 2, seed = 'obzorjeGlasba' } = {}) {
  if (!Number.isFinite(month) || !Number.isFinite(day) || limit <= 0) return null;
  const todays = ON_THIS_DAY_MUSIC.filter((e) => e.month === month && e.day === day);
  if (todays.length === 0) return null;
  const start = hash(`${month}-${day}|${seed}`) % todays.length;
  const events = todays
    .slice(start)
    .concat(todays.slice(0, start))
    .slice(0, limit)
    .map(({ year, name, sex, kind }) => ({ year, name, sex, kind }));
  return { events, source: 'local' };
}
