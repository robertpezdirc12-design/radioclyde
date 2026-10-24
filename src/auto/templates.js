// Template-based DJ speech -- the no-AI replacement for producer/moves.js's
// per-move LLM completions and director/liveSegments.js's live-line
// completions. Each broadcast moment (open, track intro, post-track recap,
// quiz, weather handoff, close, live time/weather) is one of a small set of
// fixed sentence templates with {placeholders}, drawn from the show's real
// library metadata. Default templates are Slovenian; every slot can be
// overridden or extended via config.autoRadio.templates (see
// docs/auto-radio.md for the full reference).
//
// Variant selection is a hash of (showId|date|ratingKey|slot), so:
//   - the same occurrence always renders the same line (reproducible
//     transcripts, cacheable audio), and
//   - different days/tracks rotate through the variants without a model.
import { config } from '../config/index.js';
import { currentLocalTimeString, currentLocalDateString } from '../director/weather.js';

// ---------------------------------------------------------------------------
// defaults (Slovenian)
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATES = {
  open: {
    default: [
      'Poslu\u0161ate {station}. Prihaja oddaja {show}.',
      'Dobrodo\u0161li pri oddaji {show} na {station}.',
    ],
    morning: ['Dobro jutro! Poslu\u0161ate {station}. Prihaja oddaja {show}.'],
    daytime: ['Poslu\u0161ate {station} -- zdaj sledi oddaja {show}.'],
    evening: ['Dober ve\u010der! Na sporedu je oddaja {show} na {station}.'],
    night: ['Pozno v no\u010d -- poslu\u0161ate {station}. Prihaja {show}.'],
  },
  intro: [
    'Zdaj sledi {artist} s skladbo {title}.',
    'Naprej poslu\u0161amo {artist} -- {title}.',
    'Sledi {title} izvajalca {artist}.',
  ],
  recap: {
    withAlbumYear: [
      'To je bil {artist} s skladbo {title} iz albuma {album}, iz\u0161etega leta {year}.',
      '{artist} -- {title}. Najdemo ga na albumu {album} iz leta {year}.',
    ],
    withYear: [
      'Poslu\u0161ali ste {title} izvajalca {artist}, iz\u0161eto leta {year}.',
      'To je bil {artist} -- {title} ({year}).',
    ],
    generic: [
      'To je bila skladba {title} izvajalca {artist}.',
      '{artist} z naslovom {title}, tukaj na {station}.',
    ],
  },
  quizIntro: [
    'Uganite, v katerem letu je iz\u0161la naslednja skladba izvajalca {artist}. Odgovor razkrijemo takoj po njej.',
    'Kviz \u010das: skladba, ki sledi, je iz\u0161la v enem od let v tem desetletju -- uganite, kdaj. Odgovor sledi.',
  ],
  quizReveal: [
    'Pravilen odgovor: {title} je iz\u0161la leta {year}. \u010ce ste zadeli, \u010destitamo!',
    'Resitev kviza -- {year}. {artist} s skladbo {title}.',
  ],
  handoff: [
    'Poglejmo \u0161e, kak\u0161no vreme nas \u010daka. \u010cez mikrofon se oglasa {to}.',
    'Vremenska napoved sledi -- prijavlja {to}.',
  ],
  close: {
    default: [
      'To je bilo vse za tokrat. Hvala, ker poslu\u0161ate {station}.',
      'S tem je oddaja {show} zaklju\u010dena. Do naslednjega sre\u010danja!',
    ],
    morning: ['Lep za\u010detek dneva \u017eelim -- hvala, da poslu\u0161ate {station}.'],
    daytime: ['Prijetno nadaljevanje dneva -- tukaj je {station}.'],
    evening: ['Dober ve\u010der \u017eelim in hvala, ker ste bili z nami na {station}.'],
    night: ['Lahko no\u010d in hvala, da ste bili ob nas na {station}.'],
  },
  live: {
    time: ['Trenutno je {time}.'],
    weather: ['Zunaj je {condition}, temperatura {temp} \u00b0C, veter piha s hitrostjo {wind} km/h.'],
    'time-weather': ['Je {time}, zunaj je {condition} in {temp} \u00b0C.'],
  },

  // Rubrikes (service segments rendered from real data at produce time --
  // see auto/feeds.js). weatherNow/sportHeadlines/obzorje read the ARSO
  // observation, RTV Slovenija headlines and Wikidata "on this day"
  // respectively; every pool degrades to a shorter variant when data is
  // partial (e.g. ARSO reports a temperature but no condition).
  weatherNow: {
    withTemp: [
      'Vreme: {station} -- {condition}, {temp} stopinj Celzija.',
      'Trenutne razmere: {station}, {condition}, temperatura {temp} stopinj.',
    ],
    tempOnly: ['Vreme: {station}, trenutno {temp} stopinj Celzija.'],
    generic: [
      'Vreme: {station} -- {condition}.',
      'Trenutne razmere na {station}: {condition}.',
    ],
  },
  sportHeadlines: [
    '\u0160portne novice: {headlines}',
    'Poglejmo, kaj je novega v \u0161portu: {headlines}',
  ],
  newsHeadlines: [
    'Novice: {headlines}',
    'Iz Slovenije in sveta: {headlines}',
  ],
  obzorje: {
    birth: ['Na dana\u0161nji dan leta {year} se je rodil {name}.'],
    birthF: ['Na dana\u0161nji dan leta {year} se je rodila {name}.'],
    death: ['Na dana\u0161nji dan leta {year} je umrl {name}.'],
    deathF: ['Na dana\u0161nji dan leta {year} je umrla {name}.'],
  },

  // P4 #19: "Na dana\u0161nji dan v glasbi" -- same data shape as obzorje
  // (Wikidata births/deaths), but the people are musicians (P106/P279* ->
  // Q639669), so the sentences name the rubric. Same kindKey pools.
  obzorjeGlasba: {
    birth: ['Na dana\u0161nji dan v glasbi se je leta {year} rodil {name}.'],
    birthF: ['Na dana\u0161nji dan v glasbi se je leta {year} rodila {name}.'],
    death: ['Na dana\u0161nji dan v glasbi je leta {year} umrl {name}.'],
    deathF: ['Na dana\u0161nji dan v glasbi je leta {year} umrla {name}.'],
  },

  // P4 #17: "Zanimivosti" -- one deterministic fact before the track whose
  // artist it describes (triviaArtist, from auto/trivia.js), or a general
  // rock-history fact (triviaGeneral, from the local auto/rockFacts.js
  // corpus). Facts arrive as FULL sentences WITHOUT the final punctuation;
  // the template supplies it, so all three fact sources stay consistent.
  triviaArtist: [
    '\u010ce niste vedeli: {fact}. Zdaj pa nazaj k glasbi.',
    'Malo zanimivosti: {fact}. In nadaljujemo z glasbo.',
    'Malo zgodovine, preden sledi skladba: {fact}.',
  ],
  triviaGeneral: [
    'Ste to vedeli? {fact}. Zdaj pa nadaljujemo z glasbo.',
    'Zanimivost iz sveta rocka: {fact}. In nazaj k glasbi.',
    'Medtem, ko gre glasba naprej -- {fact}.',
  ],
};

// WMO weather interpretation codes (Open-Meteo), in Slovenian -- mirrors the
// English map in director/weather.js so live lines speak the same facts in
// the station's template language.
const WEATHER_SLOVENIAN = {
  0: 'jasno',
  1: 'prete\u017eno jasno',
  2: 'delno obla\u010dno',
  3: 'obla\u010dno',
  45: 'meglovno',
  48: 'meglovno',
  51: 'rahla rosulja',
  53: 'rosulja',
  55: 'mo\u010dna rosulja',
  61: 'rahel de\u017e',
  63: 'de\u017e',
  65: 'mo\u010dan de\u017e',
  71: 'rahel sneg',
  73: 'sneg',
  75: 'mo\u010dan sneg',
  80: 'plohe',
  81: 'plohe',
  82: 'hude plohe',
  95: 'nevihta',
  96: 'nevihta s to\u010do',
  99: 'nevihta s to\u010do',
};

export function slovenianWeatherDescription(code) {
  return WEATHER_SLOVENIAN[code] ?? 'nenavadne razmere';
}

// ---------------------------------------------------------------------------
// variant selection + substitution
// ---------------------------------------------------------------------------

// FNV-1a over the seed string -- stable across runs, no dependency.
function hash(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Config overrides deep-merge over the defaults: a config entry REPLACES the
// slot it names (so authors see exactly what they wrote run), while slots
// they leave untouched keep the Slovenian defaults.
function mergedTemplates() {
  const overrides = config.autoRadio?.templates ?? {};
  return { ...DEFAULT_TEMPLATES, ...overrides };
}

function variantFrom(pool, seed) {
  if (!pool?.length) return null;
  return pool[hash(seed) % pool.length];
}

function substitute(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const v = values[key];
    return v == null || v === '' ? '' : String(v);
  });
}

// Picks a recap template matching the metadata actually available on the
// track, so we never read "iz albuma ." when the album tag is missing.
function recapPool(templates, track) {
  const pools = templates.recap;
  if (track?.album && track?.year) return pools.withAlbumYear;
  if (track?.year) return pools.withYear;
  return pools.generic;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

// values: { station, show, artist, title, album, year, genre, to } plus
// internally-derived { block, time, date }.
export function renderSlot(slot, { values, seed, block }) {
  const templates = mergedTemplates();
  const blockValue = block ?? values.block ?? null;

  let pool;
  if (slot === 'open' || slot === 'close') {
    const slotPools = templates[slot];
    pool = (blockValue && slotPools[blockValue]) || slotPools.default;
  } else if (slot === 'recap') {
    pool = recapPool(templates, values.track ?? {});
  } else if (slot === 'intro' || slot === 'quizIntro' || slot === 'quizReveal' || slot === 'handoff') {
    pool = templates[slot];
  } else if (slot.startsWith('live:')) {
    pool = templates.live[slot.slice('live:'.length)];
  } else if (slot === 'weatherNow') {
    const pools = templates.weatherNow;
    pool = values.temp != null ? (values.condition ? pools.withTemp : pools.tempOnly) : pools.generic;
  } else if (slot === 'obzorje') {
    const pools = templates.obzorje;
    pool = pools[values.kindKey] ?? pools.birth;
  } else if (slot === 'obzorjeGlasba') {
    const pools = templates.obzorjeGlasba;
    pool = pools[values.kindKey] ?? pools.birth;
  } else {
    pool = templates[slot]; // unknown slots resolve straight from config
  }

  const template = variantFrom(pool, seed ?? slot);
  if (!template) {
    throw new Error(`No template configured for slot "${slot}" (block "${blockValue ?? '-'}").`);
  }
  return substitute(template, { ...values, block: blockValue });
}

// Context helpers shared by the auto producer and the auto live-line
// resolver -- one formatting for both, so script text and spoken text agree.

export function stationName() {
  return config.autoRadio?.stationName ?? 'Radio Markec';
}

export function showName(showTitle) {
  return showTitle ?? stationName();
}

export function currentValues() {
  const timezone = config.weather?.timezone ?? 'UTC';
  return {
    station: stationName(),
    time: currentLocalTimeString(timezone),
    date: currentLocalDateString(timezone),
  };
}

// Track context for intro/recap placeholders. decade derives from year when
// present; genre is the track's first tag (templates never enumerate).
export function trackValues(track) {
  const year = track?.year ?? null;
  return {
    artist: track?.artist ?? '',
    title: track?.title ?? '',
    album: track?.album ?? '',
    year: year ?? '',
    decade: year ? String(year - (year % 10)) + 's' : '',
    genre: track?.genre?.[0] ?? '',
  };
}
