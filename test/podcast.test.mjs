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
