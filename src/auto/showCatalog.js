// P4 #18 -- the themed show generator: a curated catalog of themed auto-mode
// shows ("Zgodovina rocka", "Zgodovina kitare", "Veliki nastopi", decade
// portraits, ...) that renders REAL show-descriptions/*.md briefs the
// existing auto pipeline executes unchanged. No LLM anywhere: each theme is
// a frozen operator decision (selection lines the deterministic brief parser
// understands + Slovenian prose), and the "weekly special slot" rotates
// through the catalog by ISO week number.
//
// Why briefs and not a parallel code path: the auto pipeline (briefQuery ->
// buildTrackQueue -> scriptBuilder -> voice) already knows how to turn a
// brief into an aired show, including rubrics and trivia. A themed show is
// just a brief the operator didn't have to write by hand -- so the generator
// only ever PRODUCES a brief file; everything downstream stays untouched.
//
// Library dependence, stated honestly: genre/decade themes work on any
// library with a rock-ish genre tag (briefQuery's fuzzy genre resolution
// maps "Rock" onto "Pop/Rock" and friends). artistList themes (guitar
// legends, ex-Yugoslav rock, punk/new wave) and the albumGenre "Live" theme
// need those artists/album tags to actually exist in the library -- when
// they don't, production fails with the queue's honest "resolved zero
// tracks" error and the slot falls to filler, exactly like a hand-written
// brief would.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

// Selection rules every themed show shares -- the same lines hand-written
// auto briefs use (see briefQuery.js's prose parser; negation-aware).
const NO_REPEAT_ARTIST = "- Don't repeat the same artist in a single show.";
const FAVOR_WELL_KNOWN = '- Favor well-known tracks.';

// The catalog itself. Deliberately small and curated: each entry is a show
// an operator would plausibly schedule weekly, not a combinatorial grid.
// tagline/note land in the brief's "## Description" section (never parsed
// for selection -- free prose is parser-safe there); trackSelection lines
// ARE parsed and must stay within briefQuery.js's structured-key/prose
// grammar.
export const THEMED_SHOWS = [
  {
    id: 'zgodovina-rocka',
    emoji: '🤘',
    title: 'Zgodovina rocka',
    tagline:
      'Pot od rock\'n\'rolla petdesetih do danes: mejniki, prelomnice in skladbe, ' +
      'ki so pisale zgodovino žanra. Med skladbami rubrika »zanimivosti« pove, ' +
      'kateri izvajalec je pred mikrofonom, »obzorje« in »glasba« pa dodata, kaj ' +
      'se je v glasbeni zgodovini godilo natanko na današnji dan.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- genre: Rock',
      '- No track longer than 5 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'zgodovina-kitare',
    emoji: '🎸',
    title: 'Zgodovina kitare',
    tagline:
      'Električna kitara od Flenda in Gibsonske lestvice do danes: virtuozi, ' +
      'riffovodje in zvoki, ki so definirali rock. Izbor je vezan na to, da so ' +
      'veliki kitaristi v knjižnici prisotni kot izvajalci -- kadar jih ni, ' +
      'tema ne zna sestaviti vrste in urnik pade na polnilo.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- artists: Jimi Hendrix, Eric Clapton, Jimmy Page, David Gilmour, Carlos Santana, Pete Townshend, Keith Richards, Jeff Beck, Brian May, Mark Knopfler',
      '- No track longer than 6 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'veliki-nastopi',
    emoji: '🎤',
    title: 'Veliki nastopi',
    tagline:
      'Koncerti, ki so zapisali zgodovino: festivali, stadioni in klubi, ob ' +
      'katerih se je spremenilo, kako se rock posluša. Izbor črpa iz živih ' +
      'posnetkov -- albumov z albumskega žanra »Live«; knjižnica brez takšnih ' +
      'teme ne more izpolniti.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- album genre: Live',
      '- No track longer than 7 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'rock-60s',
    emoji: '📺',
    title: 'Rock šestdesetih',
    tagline:
      'Beatlemania, hipijevska kontrakultura in prvi veliki festivali: v ' +
      'šestdesetih je rock prenehal biti le glasba in postal mladinski gib. ' +
      'Izbor sestavi iz rockovskih snemalcev desetletja iz knjižnice.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- genre: Rock',
      '- decade: 1960',
      '- No track longer than 5 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'rock-70s',
    emoji: '🎛️',
    title: 'Rock sedemdesetih',
    tagline:
      'Desetletje velikih albumov: progresivni rock in hard rock z ene strani, ' +
      'punk z druge -- med seboj tekmujejo za prostor na ozvočenjih po svetu. ' +
      'Izbor sestavi iz rockovskih snemalcev desetletja iz knjižnice.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- genre: Rock',
      '- decade: 1970',
      '- No track longer than 5 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'rock-80s',
    emoji: '📼',
    title: 'Rock osemdesetih',
    tagline:
      'Sintetizatorji, MTV in stadioni: rock osemdesetih je odkril videospot ' +
      'in z njim svetovno vrstnico ob televizorjih. Izbor sestavi iz ' +
      'rockovskih snemalcev desetletja iz knjižnice.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- genre: Rock',
      '- decade: 1980',
      '- No track longer than 5 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'rock-90s',
    emoji: '💿',
    title: 'Rock devetdesetih',
    tagline:
      'Grunge, britpop in alternativni val: devetdeseta so rock poslala nazaj ' +
      'iz stadionov v klube in hkrati prvič masovno na internet. Izbor sestavi ' +
      'iz rockovskih snemalcev desetletja iz knjižnice.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- genre: Rock',
      '- decade: 1990',
      '- No track longer than 5 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'rock-jugoslavije',
    emoji: '🎙️',
    title: 'Rock nekdanje Jugoslavije',
    tagline:
      'Od Pankrtov in Buldožerja do zagrebške in novosadske scene: kako je ' +
      'punk in novi val pometel po jugoslovanskem prostoru, v slovenščini in ' +
      'sosedskih jezikih. Korpus zanimivosti pozna tudi slovenske mejnike; ' +
      'izbor je vezan na to, da so ti izvajalci v knjižnici.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- artists: Pankrti, Buldožer, Lačni Franz, Prizma, Parni valjak, Azra, Film, Haustor, Aerodrom',
      '- No track longer than 5 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'punk-nova-val',
    emoji: '⚡',
    title: 'Punk in novi val',
    tagline:
      'Trije akordi in resnica: od Ramonesov in Clashov prek Talking Heads do ' +
      'Pankrtov -- kako je punk prestavil rock iz stadionov nazaj v klube in ' +
      'nadaljujem kot novi val. Izbor je vezan na to, da so ti izvajalci v ' +
      'knjižnici.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- artists: Ramones, The Clash, Sex Pistols, Talking Heads, Blondie, The Cure, The Jam, Buzzcocks, Siouxsie and the Banshees, Pankrti',
      '- No track longer than 4 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'blues-korenine',
    emoji: '🎺',
    title: 'Blues korenine',
    tagline:
      'Delta, Chicago in kralji kitare: blues je oblika, iz katere je rock ' +
      'izraščel -- od Muddyja Watersa in B.B. Kinga do Stevieja Raya Vaughana. ' +
      'Korpus zanimivosti pozna blues mejnike (Robert Johnson, Lucille, Sister ' +
      'Rosetta Tharpe); izbor je vezan na to, da so ti izvajalci v knjižnici.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- artists: Muddy Waters, B.B. King, Howlin Wolf, Robert Johnson, John Lee Hooker, Buddy Guy, Eric Clapton, Stevie Ray Vaughan, John Mayall, Canned Heat',
      '- No track longer than 6 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'trdi-rock-metal',
    emoji: '💀',
    title: 'Trdi rock in metal',
    tagline:
      'Od Led Zeppelinovih globočin do Metalličnih riffov: hard rock in heavy ' +
      'metal, ki ga je odkril Black Sabbath, po njem pa več generacij ' +
      'metalcev. Korpus zanimivosti pozna metal mejnike (preimenovanje iz ' +
      'Earth, Album štirih simbolov, Master of Puppets); izbor je vezan na ' +
      'to, da so te skupine v knjižnici.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- artists: Led Zeppelin, Deep Purple, Black Sabbath, AC/DC, Judas Priest, Iron Maiden, Motörhead, Metallica, Dio, Rainbow',
      '- No track longer than 7 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'progresivni-rock',
    emoji: '🔮',
    title: 'Progresivni rock',
    tagline:
      'Suite, koncepti in virtuoznost: kako so King Crimson, Yes, Genesis in ' +
      'Pink Floyd raztegnili rock čez okvire radijskega singla. Korpus ' +
      'zanimivosti pozna prog mejnike (rojstvo žanra leta 1969, Tubular ' +
      'Bells); izbor je vezan na to, da so te skupine v knjižnici.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- artists: Pink Floyd, King Crimson, Yes, Genesis, Rush, Emerson Lake & Palmer, Jethro Tull, Camel, Van der Graaf Generator, Mike Oldfield',
      '- No track longer than 9 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'zenske-v-rocku',
    emoji: '👩‍🎤',
    title: 'Ženske v rocku',
    tagline:
      'Od Sestre Rosette Tharpe do grungerskih kitariark: oddaja o ženskah, ki ' +
      'so rock pisale, igrale in prepevale vse od njegovih začetkov. Korpus ' +
      'zanimivosti pozna te mejnike (Kate Bush, The Runaways, Heart); izbor je ' +
      'vezan na to, da so ti izvajalci v knjižnici.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- artists: Heart, The Runaways, Hole, The Bangles, Sleater-Kinney, Joan Jett and the Blackhearts, The Pretenders, The Go-Gos',
      '- No track longer than 5 minutes.',
      NO_REPEAT_ARTIST,
      FAVOR_WELL_KNOWN,
    ],
  },
  {
    id: 'album-v-celoti',
    emoji: '💿',
    title: 'Album v celoti',
    tagline:
      'En album, od prve do zadnje skladbe, brez presledkov: način poslušanja, ' +
      'ki so ga singli in kasneje seznami predvajanja izrinili iz navade. Vsak ' +
      'teden izbral drug naključni rockovski album iz knjižnice, rubrika ' +
      '»zanimivosti« pa ob skladbah pove, kdo za njimi stoji.',
    rubrics: ['vreme', 'obzorje', 'zanimivosti', 'glasba', 'kviz'],
    trackSelection: [
      '- genre: Rock',
      '- Pick one whole random album.',
    ],
  },
];

export function listThemedShows() {
  return THEMED_SHOWS;
}

export function getThemedShow(id) {
  return THEMED_SHOWS.find((t) => t.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// ISO-8601 week math -- the rotation clock
// ---------------------------------------------------------------------------

// ISO-8601 week-numbering key of a local Date, as year * 100 + week
// (2026-10-24 -> 202643). Week 1 is the week of the year's first Thursday;
// days before it belong to the previous year's last week (2027-01-01 ->
// 202653). All arithmetic happens on date-truncated local copies and ends
// in an integer week count, so DST shifts (at most ±1h inside the span)
// can't nudge the result: the division uses Math.round against an exact
// multiple of seven days.
export function isoWeekKey(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (d.getDay() + 6) % 7; // Monday=0 .. Sunday=6
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - weekday + 3); // this week's Thursday
  const isoYear = thursday.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const jan4Weekday = (jan4.getDay() + 6) % 7;
  const week1Monday = new Date(isoYear, 0, 4 - jan4Weekday);
  const weeks = Math.round((thursday - week1Monday) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return isoYear * 100 + weeks;
}

// ---------------------------------------------------------------------------
// special-slot resolution
// ---------------------------------------------------------------------------

// Validates a schedule entry's `special` block and resolves THIS week's
// theme. `special` shape:
//
//   "special": {
//     "themes": ["zgodovina-rocka", "zgodovina-kitare", "veliki-nastopi"],
//     "personas": ["elena"]          // optional; default = first prompts.json persona
//   }
//
// The theme is picked by isoWeekKey(date) % themes.length -- deterministic
// for every day of the same ISO week (a Sunday-night prewarm of a Monday
// slot and the Monday airing itself resolve identically when both key on
// the slot's AIR date, which generateScript.js guarantees by passing the
// occurrence date here), advances every week, and wraps around the catalog.
export function resolveSpecialTheme(special, date) {
  const themes = special?.themes;
  if (!Array.isArray(themes) || themes.length === 0 || themes.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new Error(
      'Special slot needs "special": { "themes": [...] } with a non-empty array of theme ids from the show catalog ' +
        `(see npm run themed-shows -- list). Received: ${JSON.stringify(special ?? null)}.`
    );
  }
  const unknown = themes.filter((id) => !getThemedShow(id.trim()));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown themed show(s): ${unknown.join(', ')}. Available themes: ${THEMED_SHOWS.map((t) => t.id).join(', ')}.`
    );
  }
  const themeId = themes[isoWeekKey(date) % themes.length].trim();
  return getThemedShow(themeId);
}

// Where a generated brief lives, in the same relative form station.json
// description fields use ("show-descriptions/themed/<id>.md", resolved
// against config.dataDir by every brief reader). The themed/ subfolder keeps
// generated files visually separate from operator-written briefs and out of
// the studio's top-level brief CRUD (its listing is non-recursive).
export function themedBriefRelPath(themeId) {
  return `show-descriptions/themed/${themeId}.md`;
}

// ---------------------------------------------------------------------------
// brief rendering + materialization
// ---------------------------------------------------------------------------

// Renders the full brief markdown for a theme -- same shape as the
// hand-written sample briefs (header block, ## Description, ## Hosts,
// ## Track Selection, ## Tone, ## Track moves, ## Weather), so parseShowBrief
// and the whole auto pipeline consume it unchanged. Pure: no fs, no config.
export function renderThemedBrief(theme, { durationMinutes = 60, personas = [] } = {}) {
  if (!theme || !getThemedShow(theme.id)) {
    throw new Error(`renderThemedBrief: not a catalog theme: ${JSON.stringify(theme?.id ?? theme ?? null)}.`);
  }
  const people = (personas ?? []).map((p) => String(p).trim()).filter(Boolean);
  if (people.length === 0) {
    throw new Error(
      `Themed show "${theme.id}" needs at least one persona -- set "personas" inside the schedule entry's ` +
        '"special" block or define personas in prompts.json.'
    );
  }
  const host = people[0].charAt(0).toUpperCase() + people[0].slice(1);
  const note = theme.note ? `\n${theme.note}\n` : '';
  return [
    `# 📻 ${theme.title} (tematska)`,
    '',
    `**Duration:** ${durationMinutes} min`,
    `**Personas:** ${people.join(', ')}`,
    '**Segments:** weather, quiz',
    '**Repeat window:** 7 days',
    `Rubrike: ${theme.rubrics.join(', ')}`,
    '',
    '---',
    '',
    '## Description',
    '',
    theme.tagline,
    note,
    '## Hosts',
    '',
    `- **${host}** -- vodi oddajo in predstavlja temo.`,
    '',
    '## Track Selection',
    '',
    ...theme.trackSelection,
    '',
    '## Tone',
    '',
    'Vedno po enakih predlogah -- oddaja je popolnoma deterministična (način `autoRadio`),',
    'brez jezikovnega modela. Vsaka poved je predloga iz `config.autoRadio.templates`,',
    'izpolnjena s podatki o skladbi iz knjižnice; rubrika »zanimivosti« pred vsako tretjo',
    'skladbo pove en fakt o njenem izvajalcu ali splošno o rocku.',
    '',
    '## Track moves',
    '',
    'Vsaka skladba dobi `intro` (kratka najava pred skladbo) in `recap` (povzetek po njej).',
    'Rubriki »obzorje« in »glasba« zazvenita po razporedu rubrik; pred sredinsko skladbo',
    'zazveni kviz vprašanje iz korpusa (rubrika »kviz«), odgovor pa razkrije takoj po njej.',
    '',
    '## Weather',
    '',
    'Predaja vremenske napovedi približno dve tretjini skozi oddajo (predloga `handoff` +',
    '`live` segment, sestavljen ob oddaji iz pravih podatkov Open-Meteo).',
    '',
  ].join('\n');
}

// Materializes the brief on disk (idempotently): renders it and rewrites
// show-descriptions/themed/<id>.md only when the file is missing or its
// content differs -- so a catalog update refreshes the file on the next
// production run, while every loadSchedule/read tick stays write-free.
// Returns the station.json-style relative path of the brief.
export function ensureThemedBrief(themeOrId, { durationMinutes = 60, personas } = {}) {
  const theme = typeof themeOrId === 'string' ? getThemedShow(themeOrId) : themeOrId;
  if (!theme) {
    throw new Error(
      `Unknown themed show "${String(themeOrId)}". Available themes: ${THEMED_SHOWS.map((t) => t.id).join(', ')}.`
    );
  }
  const people = (personas ?? []).map((p) => String(p).trim()).filter(Boolean);
  if (people.length === 0) {
    throw new Error(
      `Themed show "${theme.id}" needs at least one persona -- set "personas" inside the schedule entry's ` +
        '"special" block or define personas in prompts.json.'
    );
  }
  const dir = path.join(config.paths.showDescriptionsDir, 'themed');
  const file = path.join(dir, `${theme.id}.md`);
  const content = renderThemedBrief(theme, { durationMinutes, personas: people });
  let existing = null;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    // missing -- generated below
  }
  if (existing !== content) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content);
    log(`showCatalog: ${existing === null ? 'generated' : 'refreshed'} themed brief ${file}`);
  }
  return themedBriefRelPath(theme.id);
}
