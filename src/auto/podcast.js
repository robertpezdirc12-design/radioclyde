// Podcast export (P4 #25) -- the research pass ranked "multiformat export"
// second among what the best autonomous radios do (Futuri POST turns the
// on-air content into podcasts; Markec already WRITES the raw material:
// script.md, tracks.json, transcript.json). This module renders that
// material into the two artifacts a podcast needs:
//
//   podcast.xml     -- RSS 2.0 + itunes feed (valid XML, escaped values);
//                      with --audio it carries a real enclosure (size/type
//                      from the actual file, so validators accept it),
//                      without one the feed stays an honest skeleton the
//                      operator fills after recording
//   show-notes.md   -- human notes: episode card, rubric rundown, chapters
//                      list, tracklist
//
// Deterministic: same inputs -> byte-identical outputs (guid derives from
// title+date by SHA-1, not from wall-clock randomness).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseScript } from '../script/format.js';
import { renderSlot } from './templates.js';
import { pickGeneralRockFacts } from './rockFacts.js';

export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

// HH:MM:SS from minutes -- itunes:duration wants seconds (or H:MM:SS).
export function itunesDuration(minutes) {
  const total = Math.max(0, Math.round((Number(minutes) || 0) * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function mimeFor(audioPath) {
  return /\.mp3$/i.test(audioPath) ? 'audio/mpeg' : /\.m4a$/i.test(audioPath) ? 'audio/x-m4a' : /\.ogg$/i.test(audioPath) ? 'audio/ogg' : 'audio/wav';
}

// Chapters: the DJ-slot sequence in air order, deduplicated consecutive
// repeats (obzorje can fire twice), so the notes read like a rundown.
export function chapterList(segments) {
  const labels = {
    open: 'Otvoritev',
    tease: 'Naznanilo: sledi kasneje',
    teaseQuiz: 'Naznanilo: sledi kasneje + kviz',
    weatherNow: 'Vreme',
    weatherOffline: 'Vreme -- poštena vrstica',
    newsHeadlines: 'Novice',
    newsOffline: 'Novice -- poštena vrstica',
    sportHeadlines: 'Šport',
    sportOffline: 'Šport -- poštena vrstica',
    obzorje: 'Na današnji dan',
    obzorjeOffline: 'Na današnji dan -- poštena vrstica',
    obzorjeGlasba: 'Na današnji dan v glasbi',
    triviaArtist: 'Zanimivost o izvajalcu',
    triviaGeneral: 'Zanimivost iz zgodovine rocka',
    pollRunning: 'Anketa',
    pollResults: 'Anketa -- vmesna rezultata',
    quizIntro: 'Kviz -- vprašanje',
    quizReveal: 'Kviz -- odgovor',
    handoff: 'Vremenski prehod',
    close: 'Zaključek',
  };
  const chapters = [];
  for (const seg of segments) {
    if (seg.type !== 'dj' || seg.slot == null) continue;
    const label = labels[seg.slot];
    if (label && chapters[chapters.length - 1] !== label) chapters.push(label);
  }
  return chapters;
}

export function buildPodcastFeed({ title, description, link, pubDate, durationMinutes, audioPath, episodesRoot = 'episodes', author }) {
  const safeTitle = xmlEscape(title);
  const safeDesc = xmlEscape(description);
  const safeLink = xmlEscape(link ?? '');
  const safeAuthor = xmlEscape(author ?? '');
  const dt = pubDate ? new Date(pubDate) : new Date();
  const rfc2822 = Number.isNaN(dt.getTime()) ? new Date().toUTCString() : dt.toUTCString();
  const guid = `radioclyde-${sha1(`${title}|${pubDate ?? ''}`)}`;

  const enclosure = audioPath && fs.existsSync(audioPath)
    ? (() => {
        const size = fs.statSync(audioPath).size;
        const mime = mimeFor(audioPath);
        const file = xmlEscape(path.basename(audioPath));
        return `    <enclosure url="${safeLink ? `${safeLink}/${episodesRoot}/${file}` : file}" length="${size}" type="${mime}"/>\n`;
      })()
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${safeTitle}</title>
    <link>${safeLink}</link>
    <language>sl</language>
    <itunes:type>episodic</itunes:type>
    <itunes:explicit>false</itunes:explicit>
${safeAuthor ? `    <itunes:author>${safeAuthor}</itunes:author>\n` : ''}    <description>${safeDesc}</description>
    <item>
      <title>${safeTitle}</title>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${rfc2822}</pubDate>
      <itunes:duration>${itunesDuration(durationMinutes)}</itunes:duration>
      <description>${safeDesc}</description>
${enclosure}    </item>
  </channel>
</rss>
`;
}

// -- H:MM:SS straight from SECONDS (the audio plan carries measured seconds,
// not minutes; itunesDuration() rounds from minutes and would lie by up to
// 30 s on a 5-minute episode -- honesty rule, same math, no invention).
export function itunesDurationSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// P5 #3: JAVNI KANALSKI RSS -- en kanal, VEČ epizod. buildPodcastFeed() zgoraj
// je posameznepizodni XML (P4 #25 dogovor, ostaja kot je); podcast aplikacije
// pa naročajo KANAL: en <channel>, več <item>. Čist gradnik: nič ne bere diska
// ali ure -- vsak vnos pride iz skeniranih načrtov (podcastApi.js), zato so
// bajti za isti vhod vedno enaki. lastBuildDate je iz najnovejše epizode, ne
// Date.now() -- feed se spremeni natanko takrat, ko se spremeni arhiv.
// ---------------------------------------------------------------------------
export function buildPodcastChannelFeed({ station = 'Radio Markec', title = 'Markec Podkast', description, link, imageUrl, author, episodes = [] } = {}) {
  const sorted = [...episodes].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const newest = sorted[0];
  const safeTitle = xmlEscape(title);
  const safeLink = xmlEscape(link ?? '');
  const safeAuthor = xmlEscape(author ?? station);
  const safeSummary = xmlEscape(description ?? `Podkast radijske postaje ${station}.`);
  const lastBuild = newest
    ? `    <lastBuildDate>${new Date(`${newest.date}T12:00:00Z`).toUTCString()}</lastBuildDate>\n`
    : '';
  const image = imageUrl ? `    <itunes:image href="${xmlEscape(imageUrl)}"/>\n` : '';

  const items = sorted.map((ep) => {
    const pubDate = new Date(`${ep.date}T12:00:00Z`).toUTCString();
    const encUrl = xmlEscape(ep.audioUrl ?? '');
    const size = Math.max(0, Math.round(Number(ep.sizeBytes) || 0));
    const enc = encUrl && size > 0 ? `      <enclosure url="${encUrl}" length="${size}" type="audio/mpeg"/>\n` : '';
    return `    <item>
      <title>${xmlEscape(ep.title ?? `Epizoda ${ep.date}`)}</title>
      <guid isPermaLink="false">${xmlEscape(ep.guid ?? `markec-podkast-${ep.date}`)}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:duration>${itunesDurationSeconds(ep.seconds)}</itunes:duration>
      <description>${xmlEscape(ep.description ?? '')}</description>
${enc}    </item>
`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${safeTitle}</title>
    <link>${safeLink}</link>
    <language>sl</language>
    <itunes:type>episodic</itunes:type>
    <itunes:explicit>false</itunes:explicit>
    <itunes:author>${safeAuthor}</itunes:author>
    <itunes:summary>${safeSummary}</itunes:summary>
${image}${lastBuild}    <generator>radioclyde (deterministično, brez modelov)</generator>
    <description>${safeSummary}</description>
${items}  </channel>
</rss>
`;
}

export function buildShowNotes({ title, date, durationMinutes, station, chapters, tracks, rubricLines }) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- Datum: ${date}`);
  lines.push(`- Trajanje: ${durationMinutes} min`);
  lines.push(`- Postaja: ${station}`);
  if (chapters?.length) {
    lines.push('');
    lines.push('## Chapters (rundown)');
    for (const [index, chapter] of chapters.entries()) lines.push(`${index + 1}. ${chapter}`);
  }
  if (rubricLines?.length) {
    lines.push('');
    lines.push('## O čem je bilo govora');
    for (const line of rubricLines) lines.push(`- ${line}`);
  }
  if (tracks?.length) {
    lines.push('');
    lines.push('## Skladbe');
    for (const track of tracks) {
      const year = track.year ? ` (${track.year})` : '';
      lines.push(`- ${track.artist} -- ${track.title}${year}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// One call the CLI (and tests) use: read a produced show dir, emit the two
// artifacts into outDir (default <dir>/podcast). Throws on missing inputs --
// the CLI is an operator tool, not an on-air path, so fail-loud is right.
export function runPodcastExport({ dir, audio, title, date, link, out, station = 'Radio Markec' } = {}) {
  const scriptPath = path.join(dir, 'script.md');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`No script.md in ${dir} -- run the producer (or preview-auto-show) first.`);
  }
  const markdown = fs.readFileSync(scriptPath, 'utf8');
  const { segments, title: parsedTitle } = parseScript(markdown);

  let tracks = [];
  const tracksPath = path.join(dir, 'tracks.json');
  if (fs.existsSync(tracksPath)) {
    try { tracks = JSON.parse(fs.readFileSync(tracksPath, 'utf8')); } catch { tracks = []; }
  }

  // context.json (written by preview-auto-show) carries the episode meta the
  // CLI args may override.
  let context = {};
  const contextPath = path.join(dir, 'context.json');
  if (fs.existsSync(contextPath)) {
    try { context = JSON.parse(fs.readFileSync(contextPath, 'utf8')); } catch { context = {}; }
  }

  const episodeTitle = title ?? parsedTitle ?? path.basename(dir);
  const episodeDate = date ?? context.date ?? new Date().toISOString().slice(0, 10);
  const durationMinutes = context.durationMinutes ?? 30;

  const outDir = out ?? path.join(dir, 'podcast');
  fs.mkdirSync(outDir, { recursive: true });

  const feed = buildPodcastFeed({
    title: episodeTitle,
    description: `Radijska oddaja ${episodeTitle} na ${station} -- rundown, skladbe in rubrike.`,
    link,
    pubDate: new Date(`${episodeDate}T12:00:00Z`).toISOString(),
    durationMinutes,
    audioPath: audio && fs.existsSync(audio) ? audio : null,
  });
  const feedPath = path.join(outDir, 'podcast.xml');
  fs.writeFileSync(feedPath, feed);

  const notes = buildShowNotes({
    title: episodeTitle,
    date: episodeDate,
    durationMinutes,
    station,
    chapters: chapterList(segments),
    tracks,
    rubricLines: segments
      .filter((s) => s.type === 'dj' && ['weatherNow', 'weatherOffline', 'newsHeadlines', 'newsOffline', 'sportHeadlines', 'sportOffline', 'obzorje', 'obzorjeOffline', 'obzorjeGlasba', 'triviaArtist', 'triviaGeneral', 'quizIntro'].includes(s.slot))
      .map((s) => s.body),
  });
  const notesPath = path.join(outDir, 'show-notes.md');
  fs.writeFileSync(notesPath, notes);

  return { feedPath, notesPath, chapters: chapterList(segments) };
}

// ===========================================================================
// P5 #1: MARKEC PODKAST -- generator epizod (drugi sloj istega modula).
// Deterministicna petminutna epizoda glasba-klepet-glasba-smeh: isti
// renderSlot bazeni kot ziva oddaja, fakt iz offline korpusa, brez modelov.
// Determinizem: epizoda za (datum, bazen, zrno) je bajtno enaka ob vsakem
// zagonu (FNV-1a + stabilna sortiranja, isto kodo izvajajo showCatalog /
// rockFacts). Razlicni datumi rotirajo skladbe in variante brez modela.
// ===========================================================================

export const PODCAST_ID = 'markec-podkast';
export const PODCAST_TITLE = 'Markec Podkast';

// Same FNV-1a as templates.js / rockFacts.js -- stable across runs, no
// dependency. (Each module keeps its own copy on purpose: these are
// self-contained leaf modules with no shared-runtime import requirements.)
function hash(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Picks `count` tracks from the candidate pool deterministically. The pool
// is whatever the caller fetched (Plex genre query, local library scan) --
// this function NEVER contacts the network itself. Rules:
//   - tracks longer than maxTrackDurationSeconds are dropped first (the
//     5-minute budget is the whole point of the format; two ~4 min tracks
//     plus talk land at ~5 min),
//   - the pool is sorted by (artist, title) so the pick does not depend on
//     the library's response order,
//   - the seed offsets the walk start (FNV over `${seed}`), so different
//     dates pick different songs while one date always picks the same ones,
//   - an artist never repeats within one episode (a one-person-podcast
//     sounds like a mistake),
//   - fewer candidates than requested -> fewer tracks, honestly returned;
//     an EMPTY pool -> empty list (the CLI turns that into a real error,
//     this module stays pure).
export function pickPodcastTracks(candidates, count, seed, { maxTrackDurationSeconds = 240 } = {}) {
  if (!Array.isArray(candidates) || count <= 0) return [];
  const usable = candidates
    .filter((t) => t?.artist && t?.title && (t.durationMs == null || t.durationMs <= maxTrackDurationSeconds * 1000))
    .sort(
      (a, b) =>
        a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title) || String(a.ratingKey ?? '').localeCompare(String(b.ratingKey ?? ''))
    );
  if (usable.length === 0) return [];
  const picked = [];
  const usedArtists = new Set();
  const start = hash(String(seed)) % usable.length;
  for (let offset = 0; offset < usable.length && picked.length < count; offset++) {
    const track = usable[(start + offset) % usable.length];
    const artistKey = track.artist.toLowerCase();
    if (usedArtists.has(artistKey)) continue;
    usedArtists.add(artistKey);
    picked.push(track);
  }
  return picked;
}

// The 5-minute episode plan: pogovor -> glasba -> pogovor -> glasba -> pogovor.
// Each spoken line is ONE renderSlot() call with its own seed, so the same
// persona pools the live station speaks are the exact text the podcast
// script carries (one source of truth, no script drift). `facts` is
// injectable for tests and future rubrics; the default is one fact from the
// offline rock-history corpus. skip-not-fail: no fact -> the mid talk
// degrades to the laugh pool, an episode never fails for missing trivia.
export function buildPodcastEpisode({
  date,
  tracks,
  count = 2,
  seed = `${PODCAST_ID}|${date}`,
  station = 'Radio Markec',
  facts,
  maxTrackDurationSeconds = 240,
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) {
    throw new Error(`Datum podkasta mora biti YYYY-MM-DD, dobljeno: "${date}".`);
  }
  const picked = pickPodcastTracks(tracks, count, seed, { maxTrackDurationSeconds });
  const factList = facts ?? pickGeneralRockFacts(1, seed, new Set());
  const fact = factList.length > 0 ? factList[0].text : null;

  const lines = [];
  // open
  lines.push({
    kind: 'pogovor',
    slot: 'podcastOpen',
    text: renderSlot('podcastOpen', { values: { station }, seed: `${seed}|open` }),
  });
  // track 1 + its spoken lead-in
  if (picked.length > 0) {
    lines.push({
      kind: 'glasba',
      slot: 'intro',
      trackIndex: 0,
      text: renderSlot('intro', {
        values: { artist: picked[0].artist, title: picked[0].title },
        seed: `${seed}|t1`,
      }),
    });
  }
  // mid talk: fact when available, laugh when not
  lines.push({
    kind: 'pogovor',
    slot: fact ? 'podcastChat' : 'podcastLaugh',
    text: fact
      ? renderSlot('podcastChat', { values: { fact }, seed: `${seed}|chat` })
      : renderSlot('podcastLaugh', { values: { station }, seed: `${seed}|chat` }),
  });
  // track 2 + lead-in
  if (picked.length > 1) {
    lines.push({
      kind: 'glasba',
      slot: 'intro',
      trackIndex: 1,
      text: renderSlot('intro', {
        values: { artist: picked[1].artist, title: picked[1].title },
        seed: `${seed}|t2`,
      }),
    });
  }
  // outro
  lines.push({
    kind: 'pogovor',
    slot: 'podcastOutro',
    text: renderSlot('podcastOutro', { values: { station }, seed: `${seed}|outro` }),
  });

  // Honest duration estimate: Slovenian TTS sits around 2.6 words per
  // second at the Artur voice's default rate -- close enough for a "~5 min"
  // label, never presented as a measured value.
  const talkWords = lines.reduce((acc, l) => acc + l.text.split(/\s+/).filter(Boolean).length, 0);
  const musicSeconds = picked.reduce((acc, t) => acc + (t.durationMs ?? 210_000) / 1000, 0);
  const estimatedSeconds = Math.round(talkWords / 2.6 + musicSeconds);

  return {
    id: PODCAST_ID,
    title: PODCAST_TITLE,
    date,
    station,
    seed,
    structure: ['pogovor', 'glasba', 'pogovor', 'glasba', 'pogovor'],
    tracks: picked,
    fact,
    lines,
    estimatedSeconds,
  };
}

// Readable script -- the operator-facing artifact (and the future TTS feed,
// one line per renderSlot output). Byte-stable for a given episode.
export function renderPodcastScript(episode) {
  const head = [
    `# ${episode.title} -- ${episode.date}`,
    '',
    `Postaja: ${episode.station}`,
    `Format: ${episode.structure.join(' -> ')} (~${Math.round(episode.estimatedSeconds / 60)} min)`,
    `Zrno: ${episode.seed}`,
    '',
    '## Skladbi',
    '',
  ];
  const trackLines = episode.tracks.map(
    (t, i) =>
      `${i + 1}. ${t.artist} -- ${t.title}${t.album ? ` (${t.album}${t.year ? `, ${t.year}` : ''})` : ''} [${Math.round((t.durationMs ?? 0) / 1000)} s]`
  );
  const scriptHead = ['', '## Skripta', ''];
  const scriptLines = episode.lines.map((l) => `[${l.kind}] ${l.text}`);
  return [...head, ...trackLines, ...scriptHead, ...scriptLines, ''].join('\n');
}

// Writes the episode's .md + .json next to each other, idempotently: a file
// is rewritten ONLY when its content differs (same rule as
// ensureThemedBrief) so cron-driven reruns never touch mtimes. outDir is
// created if missing. Returns the two absolute paths.
export function writePodcastEpisode(episode, outDir) {
  const base = `${episode.date}-${episode.id}`;
  const mdPath = `${outDir}/${base}.md`;
  const jsonPath = `${outDir}/${base}.json`;
  const md = renderPodcastScript(episode);
  const json = JSON.stringify(episode, null, 2) + '\n';
  fs.mkdirSync(outDir, { recursive: true });
  writeIfChanged(mdPath, md);
  writeIfChanged(jsonPath, json);
  return { mdPath, jsonPath };
}

// -- helper kept OUT of the exported surface: content-compare write
function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // missing or unreadable -> write
  }
  fs.writeFileSync(file, content);
}
