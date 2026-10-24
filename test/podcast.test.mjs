// Tests for P4 #25 podcast export (src/auto/podcast.js + CLI):
//   A. XML escaping + duration formatting (the two classic feed bugs),
//   B. feed validity: parses with fast-xml-parser, carries guid/itunes tags,
//      and a REAL enclosure (size+mime from the file) when audio exists,
//   C. chapter list: DJ rundown in air order, consecutive dedup,
//   D. end-to-end runPodcastExport over a rendered show dir.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { XMLParser } from 'fast-xml-parser';

import { setupTestConfig, repoRoot, writeWav } from './fixtures.mjs';

setupTestConfig('podcast', {});

const podcast = await import('../src/auto/podcast.js');
const { renderScript } = await import('../src/script/format.js');

const mkSegments = () => [
  { type: 'dj', persona: 'elena', slot: 'open', body: 'Poslušate Test Station.' },
  { type: 'dj', persona: 'elena', slot: 'weatherNow', body: 'Vreme: Test Station -- jasno, 12 stopinj.' },
  { type: 'dj', persona: 'elena', slot: 'teaseQuiz', body: 'Kasneje tudi kviz -- in slišite še Artist 4.' },
  { type: 'track', artist: 'A1', title: 'T1', ratingKey: 'rk1' },
  { type: 'dj', persona: 'elena', slot: 'intro', body: 'Zdaj sledi A1.' },
  { type: 'track', artist: 'A2', title: 'T2', ratingKey: 'rk2' },
  { type: 'dj', persona: 'elena', slot: 'recap', body: 'To je bil A2.' },
  { type: 'dj', persona: 'elena', slot: 'close', body: 'To je bilo vse za tokrat.' },
];

describe('podcast feed primitives', () => {
  test('xmlEscape handles the XML special five', () => {
    assert.equal(podcast.xmlEscape('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });

  test('itunesDuration formats minutes as H:MM:SS', () => {
    assert.equal(podcast.itunesDuration(30), '0:30:00');
    assert.equal(podcast.itunesDuration(0), '0:00:00');
    assert.equal(podcast.itunesDuration(90), '1:30:00');
    assert.equal(podcast.itunesDuration(undefined), '0:00:00', 'garbage in -> zero length, not NaN');
  });

  test('feed parses as XML, carries itunes tags, no enclosure without audio', () => {
    const xml = podcast.buildPodcastFeed({
      title: 'Subotno jutro & prijatelji <>',
      description: 'Opis z "narekovaji" in šumniki čšž',
      link: 'https://primer.si',
      pubDate: '2026-10-24T12:00:00Z',
      durationMinutes: 60,
      audioPath: null,
    });
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    assert.equal(parsed.rss.channel.title, 'Subotno jutro & prijatelji <>');
    assert.equal(parsed.rss.channel.language, 'sl');
    assert.equal(parsed.rss.channel['itunes:type'], 'episodic', 'P4 #26: episodic show type');
    assert.equal(String(parsed.rss.channel['itunes:explicit']), 'false', 'P4 #26: explicit flag honest');
    assert.equal(parsed.rss.channel.item.guid['@_isPermaLink'], 'false');
    assert.match(String(parsed.rss.channel.item.guid['#text']), /^radioclyde-[0-9a-f]{40}$/);
    assert.equal(parsed.rss.channel.item['itunes:duration'], '1:00:00');
    assert.equal(parsed.rss.channel.item.enclosure, undefined, 'no audio -> no fake enclosure');
  });

  test('enclosure uses the REAL file size and a mime from the extension', () => {
    const audio = writeWav(path.join(repoRoot(), 'data', 'test-podcast', 'ep.wav'), 1);
    const size = fs.statSync(audio).size;
    const xml = podcast.buildPodcastFeed({
      title: 'T', description: 'd', link: 'https://primer.si',
      pubDate: '2026-10-24T12:00:00Z', durationMinutes: 30, audioPath: audio,
    });
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    const enclosure = parsed.rss.channel.item.enclosure;
    assert.equal(enclosure['@_length'], String(size), 'length from the actual file');
    assert.equal(enclosure['@_type'], 'audio/wav');
    assert.match(String(enclosure['@_url']), /ep\.wav$/);
  });

  test('chapter list follows air order, dedups consecutive repeats, skips tracks/live', () => {
    const chapters = podcast.chapterList([
      ...mkSegments(),
      { type: 'dj', persona: 'elena', slot: 'obzorje', body: 'Na današnji dan...' },
      { type: 'dj', persona: 'elena', slot: 'obzorje', body: 'Na današnji dan še enega...' },
      { type: 'live', kind: 'weather' },
    ]);
    assert.deepEqual(chapters, ['Otvoritev', 'Vreme', 'Naznanilo: sledi kasneje + kviz', 'Zaključek', 'Na današnji dan']);
  });
});

describe('podcast export end-to-end', () => {
  test('renders a show dir -> podcast.xml + show-notes.md, feed validates', () => {
    const dir = path.join(repoRoot(), 'data', 'test-podcast', 'show');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'script.md'), renderScript({ title: 'Subotno jutro', durationMinutes: 45, segments: mkSegments() }));
    fs.writeFileSync(path.join(dir, 'tracks.json'), JSON.stringify([
      { artist: 'A1', title: 'T1', album: 'Lp', year: 1981 },
      { artist: 'A2', title: 'T2', album: 'Lp', year: 1982 },
    ]));
    fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ date: '2026-10-24', durationMinutes: 45 }));

    const result = podcast.runPodcastExport({ dir, title: undefined, date: undefined });
    assert.ok(fs.existsSync(result.feedPath));
    assert.ok(fs.existsSync(result.notesPath));

    const parsed = new XMLParser({ ignoreAttributes: false }).parse(fs.readFileSync(result.feedPath, 'utf8'));
    assert.equal(parsed.rss.channel.title, 'Subotno jutro');
    assert.equal(parsed.rss.channel.item['itunes:duration'], '0:45:00');

    const notes = fs.readFileSync(result.notesPath, 'utf8');
    assert.match(notes, /## Chapters/);
    assert.match(notes, /## Skladbe/);
    assert.match(notes, /A1 -- T1 \(1981\)/);
    assert.match(notes, /Datum: 2026-10-24/);
    assert.ok(result.chapters.includes('Vreme'));
  });

  test('missing script.md fails loud with an operator-readable message', () => {
    assert.throws(() => podcast.runPodcastExport({ dir: path.join(repoRoot(), 'data', 'test-podcast', 'prazno') }), /No script\.md/);
  });
});

// ===========================================================================
// P5 #1: generator epizod (pick/build/render/write) + zajebant bazeni --
// drugi sloj istega modula (src/auto/podcast.js zdaj nosi export P4 #25 IN
// generator P5 #1). Isti config sandbox, ki ga postavi zgoraj.
// ===========================================================================
const { pickPodcastTracks, buildPodcastEpisode, renderPodcastScript, writePodcastEpisode, PODCAST_ID } = podcast;
const { pickGeneralRockFacts, GENERAL_ROCK_FACTS } = await import('../src/auto/rockFacts.js');
const { DEFAULT_TEMPLATES } = await import('../src/auto/templates.js');

const POOL = [
  { ratingKey: 'a1', artist: 'Queen', title: 'Bohemian Rhapsody', album: 'A Night at the Opera', year: 1975, durationMs: 354_000 },
  { ratingKey: 'a2', artist: 'Queen', title: 'Another One Bites the Dust', album: 'The Game', year: 1980, durationMs: 215_000 },
  { ratingKey: 'b1', artist: 'Pankrti', title: 'Lepi in be\u017eec', album: 'Pankrti', year: 1978, durationMs: 185_000 },
  { ratingKey: 'c1', artist: 'AC/DC', title: 'Highway to Hell', album: 'Highway to Hell', year: 1979, durationMs: 207_000 },
  { ratingKey: 'd1', artist: 'Nirvana', title: 'Smells Like Teen Spirit', album: 'Nevermind', year: 1991, durationMs: 301_000 },
  { ratingKey: 'e1', artist: 'Pankrti', title: 'Za\u0161to so vrtinci', album: 'Drskej', year: 1982, durationMs: 190_000 },
];

function shuffled(pool) {
  const copy = [...pool];
  // fixed permutation, not Math.random -- tests stay deterministic
  const order = [3, 0, 5, 2, 1, 4];
  return order.map((i) => copy[i]);
}

describe('podcast template pools (zajebant persona)', () => {
  const PODCAST_POOLS = ['podcastOpen', 'podcastChat', 'podcastLaugh', 'podcastOutro'];

  test('vsi podkast bazeni obstajajo in niso prazni', () => {
    for (const name of PODCAST_POOLS) {
      assert.ok(Array.isArray(DEFAULT_TEMPLATES[name]) && DEFAULT_TEMPLATES[name].length >= 3, `${name} mora imeti vsaj 3 variante`);
    }
  });

  test('chat bazen ima natanko en {fact} na varianto, ostali brez placeholderjev', () => {
    for (const variant of DEFAULT_TEMPLATES.podcastChat) {
      assert.equal(variant.match(/\{fact\}/g)?.length ?? 0, 1, 'podcastChat: natanko en {fact}');
      assert.equal(variant.match(/\{(?!\{?fact\})[a-zA-Z]+\}/g)?.length ?? 0, 0, 'podcastChat: brez drugih placeholderjev');
    }
    for (const name of ['podcastOpen', 'podcastLaugh', 'podcastOutro']) {
      for (const variant of DEFAULT_TEMPLATES[name]) {
        assert.equal(variant.match(/\{[a-zA-Z]+\}/g)?.length ?? 0, 0, `${name}: brez placeholderjev`);
      }
    }
  });

  test('TTS-prijaznost: brez oklepajev (razen legitimnega {fact}), kon\u010dna lo\u010dila urejena', () => {
    for (const name of PODCAST_POOLS) {
      for (const variant of DEFAULT_TEMPLATES[name]) {
        // {fact} je placeholder, ne oklepaj -- odstrani ga pred lintom
        const tts = variant.replace('{fact}', '');
        assert.ok(!/[(){}\[\]]/.test(tts), `${name} ne sme imeti oklepajev/oglatih: ${variant}`);
        assert.match(variant.trim(), /[.!?]$/, `${name} se mora končati s piko, klicajem ali vprašajem: ${variant}`);
      }
    }
  });

  test('zajebant priporo\u010dilo v dokumentaciji: variante so kratke povedi (najve\u010d 3 stavki)', () => {
    for (const name of PODCAST_POOLS) {
      for (const variant of DEFAULT_TEMPLATES[name]) {
        const sentences = variant.split(/[.!?]+/).filter((s) => s.trim()).length;
        assert.ok(sentences <= 3, `${name}: najve\u010d 3 stavki na varianto (t\u0161. ${sentences}): ${variant}`);
      }
    }
  });
});

describe('pickPodcastTracks', () => {
  test('deterministi\u010den: isti seed -> enak izbor ne glede na vrstni red vhoda', () => {
    const a = pickPodcastTracks(POOL, 2, 'markec-podkast|2026-10-25');
    const b = pickPodcastTracks(shuffled(POOL), 2, 'markec-podkast|2026-10-25');
    assert.deepEqual(a, b);
    assert.equal(a.length, 2);
  });

  test('razli\u010den datum rotira izbor', () => {
    const a = pickPodcastTracks(POOL, 2, 'markec-podkast|2026-10-25');
    const b = pickPodcastTracks(POOL, 2, 'markec-podkast|2026-10-26');
    assert.notDeepEqual(a.map((t) => t.ratingKey), b.map((t) => t.ratingKey));
  });

  test('izvajalec se znotraj epizode ne ponovi', () => {
    for (const seed of ['a', 'b', 'markec-podkast|2026-10-25', 'markec-podkast|2027-01-01']) {
      const picked = pickPodcastTracks(POOL, 3, seed);
      const artists = picked.map((t) => t.artist.toLowerCase());
      assert.equal(new Set(artists).size, artists.length, `seed ${seed}: podvojen izvajalec`);
    }
  });

  test('dol\u017einski filter: skladbe nad 240 s so izpadle', () => {
    const picked = pickPodcastTracks(POOL, 6, 'filter-test');
    for (const t of picked) assert.ok(t.durationMs <= 240_000, `${t.title} je predolg za 5-minutni format`);
    // Bohemian Rhapsody (354 s) in Nirvana (301 s) sta ven; uporabnih ostane 4,
    // a izvajalcev samo 3 (dva Pankrti) -- dedup izvajalca omeji izbor na 3
    assert.equal(picked.length, 3);
  });

  test('premalo kandidatov -> manj skladb, prazen bazen -> prazen seznam', () => {
    // kratka Queen skladba (215 s) -- samostojno pod dolžinskim filtrom
    const solo = POOL.filter((t) => t.ratingKey === 'a2');
    assert.equal(pickPodcastTracks(solo, 2, 'solo').length, 1);
    assert.deepEqual(pickPodcastTracks([], 2, 'prazno'), []);
    assert.deepEqual(pickPodcastTracks(POOL, 0, 'nič'), []);
  });
});

describe('buildPodcastEpisode', () => {
  test('struktura: pogovor-glasba-pogovor-glasba-pogovor', () => {
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    assert.deepEqual(ep.structure, ['pogovor', 'glasba', 'pogovor', 'glasba', 'pogovor']);
    assert.deepEqual(ep.lines.map((l) => l.kind), ['pogovor', 'glasba', 'pogovor', 'glasba', 'pogovor']);
    assert.equal(ep.lines.find((l) => l.slot === 'intro' && l.trackIndex === 0).trackIndex, 0);
    assert.equal(ep.lines.filter((l) => l.slot === 'intro').length, 2);
  });

  test('uvodne vrstice omenjata izvajalca in naslov', () => {
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    const [t1, t2] = ep.tracks;
    const intro1 = ep.lines.find((l) => l.trackIndex === 0).text;
    const intro2 = ep.lines.find((l) => l.trackIndex === 1).text;
    assert.ok(intro1.includes(t1.artist) && intro1.includes(t1.title), intro1);
    assert.ok(intro2.includes(t2.artist) && intro2.includes(t2.title), intro2);
  });

  test('klepet vsebuje korpusni fakt (brez kon\u010dne pike, predloga doda lo\u010dilo)', () => {
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    assert.ok(ep.fact, 'fakt iz korpusa je prisoten');
    assert.ok(GENERAL_ROCK_FACTS.some((f) => f.text === ep.fact), 'fakt prihaja iz korpusa');
    const chat = ep.lines.find((l) => l.slot === 'podcastChat');
    assert.ok(chat.text.includes(ep.fact), chat.text);
  });

  test('brez fakta -> klepet degradira v smeh (skip-not-fail)', () => {
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL, facts: [] });
    assert.equal(ep.fact, null);
    assert.equal(ep.lines.find((l) => l.kind === 'pogovor' && ep.lines.indexOf(l) === 2).slot, 'podcastLaugh');
  });

  test('determinizem: isti datum -> bajtno enak skript', () => {
    const a = buildPodcastEpisode({ date: '2026-10-25', tracks: shuffled(POOL) });
    const b = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    assert.deepEqual(a, b);
    assert.equal(renderPodcastScript(a), renderPodcastScript(b));
  });

  test('razli\u010dna datuma -> razli\u010dno zrno in druga\u010den skript', () => {
    const a = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    const b = buildPodcastEpisode({ date: '2026-10-26', tracks: POOL });
    assert.equal(a.seed, 'markec-podkast|2026-10-25');
    assert.equal(b.seed, 'markec-podkast|2026-10-26');
    assert.notEqual(renderPodcastScript(a), renderPodcastScript(b));
  });

  test('neveljaven datum -> slovenska napaka', () => {
    try {
      buildPodcastEpisode({ date: '25.10.2026', tracks: POOL });
      assert.fail('moral bi vreti');
    } catch (err) {
      assert.match(err.message, /Datum podkasta mora biti YYYY-MM-DD/);
    }
  });

  test('ocena trajanja je realna za 5-minutni format (3-8 min)', () => {
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    assert.ok(ep.estimatedSeconds >= 180 && ep.estimatedSeconds <= 480, `ocena ${ep.estimatedSeconds} s je izven okna`);
  });
});

describe('writePodcastEpisode', () => {
  test('zapi\u0161e .md + .json, vsebina ima glavo in skripto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markec-podkast-'));
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    const { mdPath, jsonPath } = writePodcastEpisode(ep, dir);
    const md = fs.readFileSync(mdPath, 'utf8');
    assert.equal(path.basename(mdPath), `2026-10-25-${PODCAST_ID}.md`);
    assert.match(md, /^# Markec Podkast -- 2026-10-25/m);
    assert.match(md, /## Skladbi/);
    assert.match(md, /## Skripta/);
    const plan = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(plan.id, PODCAST_ID);
    assert.equal(plan.lines.length, 5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('idempotenca: ponovni zapis ne spremeni mtime (isti klic se ne prepi\u0161e)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markec-podkast-'));
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    const { mdPath } = writePodcastEpisode(ep, dir);
    const before = fs.statSync(mdPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    writePodcastEpisode(ep, dir);
    assert.equal(fs.statSync(mdPath).mtimeMs, before, 'idempotenten zapis ne sme dotakniti mtime');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('kreira izhodno mapo, \u010de ne obstaja', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markec-podkast-'));
    const dir = path.join(root, 'podcasts', '2026', '10');
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
    const { mdPath } = writePodcastEpisode(ep, dir);
    assert.ok(fs.existsSync(mdPath));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('fakti in predloge se dogovarjajo', () => {
  test('korpusni fakt brez kon\u010dne pike se v klepetu gladi z lo\u010dilom predloge', () => {
    const [fact] = pickGeneralRockFacts(1, 'markec-podkast|2026-10-25', new Set());
    assert.ok(!fact.text.endsWith('.'), 'korpus po\u0161ilja poved brez pike');
    const ep = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL, facts: [fact] });
    const chat = ep.lines.find((l) => l.slot === 'podcastChat');
    assert.ok(!chat.text.includes('..'), 'brez podvojenih pik');
    assert.match(chat.text, /[.!?]/, 'klepet ima kon\u010dno lo\u010dilo');
  });
});

// ---------------------------------------------------------------------------
// Regresija (studio gumb je bug pripeljal na plan): podcastDate BREZ --date
// je vrtel weather.currentLocalDateString, ki govorí "Saturday, October 24"
// (oblika za žive vrstice) -- buildPodcastEpisode ga je pošteno vrgel ven.
// Torej: lokalni YYYY-MM-DD iz edelne lib/time.js implementacije.
// ---------------------------------------------------------------------------
describe('podcastDate (CLI datumski dogovor)', () => {
  test('brez --date vrne LOKALNI YYYY-MM-DD, ne besedne oblike za žive vrstice', async () => {
    const { podcastDate } = await import('../src/cli/podcastCommon.js');
    const d = await podcastDate({}, 'Europe/Ljubljana');
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/, 'natančno YYYY-MM-DD');
    assert.ok(!/[a-zA-Z]/.test(d.replace(/^[\d-]+$/, '')), 'brez črk');
    const { toLocalISOString } = await import('../src/lib/time.js');
    assert.equal(d, toLocalISOString(new Date(), 'Europe/Ljubljana').slice(0, 10), 'enaka resnica kot edelna implementacija');
  });

  test('eksplicitni --date gre skozi nespremenjen', async () => {
    const { podcastDate } = await import('../src/cli/podcastCommon.js');
    assert.equal(await podcastDate({ date: '2026-10-25' }, 'UTC'), '2026-10-25');
  });

  test('cevovod brez datuma tudi sam po sebi dobi YYYY-MM-DD (studio gumb pot)', async () => {
    // producePodcastEpisode z genarrirano prazno knjižnico mora odnehati z
    // pošteno napako o knjižnici -- NE z "Datum podkasta mora biti...".
    // Tako je priklenjen pravi razred napake (knjižnica), ne datumski bug.
    const { producePodcastEpisode } = await import('../src/auto/podcastPipeline.js');
    await assert.rejects(
      () => producePodcastEpisode({ genre: 'neobstojeci-zanr-za-test' }),
      (err) => {
        assert.ok(!/Datum podkasta/.test(err.message), 'datumski bug nazaj?');
        assert.match(err.message, /knjižnici|žanrom/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Regresija (smoke P5 #3 jo je ujel živo): `--out <mapa>` v presledkovni
// obliky parseArgs razbere kot gol flag (out=true) + pozicijsko -- in je
// path.resolve("true") tiho pisal v <repo>/true/. Zdaj: poštena napaka.
// ---------------------------------------------------------------------------
describe('podcastOutDir (--out footgun)', () => {
  test('gol --out je poštena napaka', async () => {
    const { podcastOutDir } = await import('../src/cli/podcastCommon.js');
    assert.throws(() => podcastOutDir({ out: true }, { dataDir: '/d' }), /--out potrebuje vrednost/);
  });
  test('--out=<mapa> in privzeto dataDir/podcasts ostajata pravilna', async () => {
    const { podcastOutDir } = await import('../src/cli/podcastCommon.js');
    const path = await import('node:path');
    assert.equal(podcastOutDir({ out: '/tmp/podkasti' }, { dataDir: '/d' }), '/tmp/podkasti');
    assert.equal(podcastOutDir({}, { dataDir: '/d' }), path.join('/d', 'podcasts'));
  });
});
