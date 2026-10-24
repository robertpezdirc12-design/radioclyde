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
