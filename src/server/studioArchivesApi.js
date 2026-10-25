// Studio archive browser for the hourly MP3 archive (SUB/WAVE's admin
// routes, Node half -- see docs/stream-mounts.md). Sits behind the studio
// Basic Auth realm + JSON-content-type CSRF rule like every other studio
// API (studioAuth.js registers this under the /studio prefix):
//   GET    /studio/api/archives                  day/hour index, newest
//                                              first, capped at 500 entries
//   GET    /studio/api/archives/file/:date/:hour  download one hour, size
//                                              pinned, Content-Disposition
//   DELETE /studio/api/archives/:date            drop one whole day
//
// The disk is the source of truth: the index walks <dataDir>/archive/
// YYYY-MM-DD/ and only counts files shaped HH-00.mp3 (what Liquidsoap's
// output.file writes) -- anything else in there is left alone and not
// listed. A missing archive dir is an empty archive, not an error.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_FILE_RE = /^\d{2}-00\.mp3$/;
const HOUR_RE = /^\d{2}$/;
// Cap on the index response: SUB/WAVE's admin index limit. Bigger archives
// answer honestly with truncated: true instead of pretending to be complete.
const INDEX_CAP = 500;

// Path jail: resolves <root>/<date>/<file> and insists the result stays
// inside root. The regex validation above already makes traversal
// impossible; this is the belt-and-braces second layer (same triple defense
// as podcastApi's safeAudioPath).
function resolveInside(root, date, hourFile) {
  const resolved = path.resolve(root, date, hourFile);
  const base = path.resolve(root);
  if (resolved === base || !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

export function registerStudioArchivesApi(fastify, { archivesDir = path.join(config.dataDir, 'archive') } = {}) {
  fastify.get('/api/archives', () => {
    const archives = [];
    let truncated = false;
    let dayEntries;
    try {
      dayEntries = fs
        .readdirSync(archivesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && DATE_RE.test(e.name));
    } catch {
      return { archives: [], truncated: false }; // no archive dir = empty archive
    }
    dayEntries.sort((a, b) => b.name.localeCompare(a.name)); // newest day first
    outer: for (const day of dayEntries) {
      let hourFiles;
      try {
        hourFiles = fs
          .readdirSync(path.join(archivesDir, day.name))
          .filter((f) => HOUR_FILE_RE.test(f))
          .sort((a, b) => b.localeCompare(a)); // newest hour first
      } catch {
        continue; // day dir vanished mid-walk -- skip it, don't fail the index
      }
      for (const file of hourFiles) {
        if (archives.length >= INDEX_CAP) {
          truncated = true; // honest: there is more on disk than we listed
          break outer;
        }
        let bytes = 0;
        try {
          bytes = fs.statSync(path.join(archivesDir, day.name, file)).size;
        } catch {
          continue; // file vanished mid-walk
        }
        archives.push({ date: day.name, hour: file.slice(0, 2), file, bytes });
      }
    }
    return { archives, truncated };
  });

  fastify.get('/api/archives/file/:date/:hour', (request, reply) => {
    const { date, hour } = request.params;
    if (typeof date !== 'string' || !DATE_RE.test(date)) {
      return reply.code(400).send({ error: 'Invalid date (expected YYYY-MM-DD)' });
    }
    if (typeof hour !== 'string' || !HOUR_RE.test(hour)) {
      return reply.code(400).send({ error: 'Invalid hour (expected HH)' });
    }
    const resolved = resolveInside(archivesDir, date, `${hour}-00.mp3`);
    if (!resolved) return reply.code(400).send({ error: 'Invalid path' });
    let size;
    try {
      size = fs.statSync(resolved).size;
    } catch {
      return reply.code(404).send({ error: 'No such archive hour' });
    }
    if (size <= 0) return reply.code(404).send({ error: 'Empty archive hour' });

    // The CURRENT hour's file is still being appended to by Liquidsoap, so
    // the read is pinned to the size announced in Content-Length
    // (SUB/WAVE's rule: openStream(abs, {end: size-1})) -- the client gets
    // exactly the bytes the headers promised, never a short body.
    const stream = fs.createReadStream(resolved, { start: 0, end: size - 1 });
    // A stream error (file died mid-send) must not crash the process; let
    // Fastify terminate the response -- same guard podcastApi uses.
    stream.on('error', () => reply.request.raw.destroy());
    reply.header('content-type', 'audio/mpeg');
    reply.header('content-length', String(size));
    reply.header('content-disposition', `attachment; filename="${date}-${hour}-00.mp3"`);
    return reply.send(stream);
  });

  fastify.delete('/api/archives/:date', (request, reply) => {
    const { date } = request.params;
    if (typeof date !== 'string' || !DATE_RE.test(date)) {
      return reply.code(400).send({ error: 'Invalid date (expected YYYY-MM-DD)' });
    }
    const resolved = resolveInside(archivesDir, date, '');
    if (!resolved) return reply.code(400).send({ error: 'Invalid path' });
    if (!fs.existsSync(resolved)) return reply.code(404).send({ error: 'No such archive day' });
    // Safe to run on air (SUB/WAVE's rule): an unlink only detaches the
    // name -- Liquidsoap's output.file keeps appending to the already-open
    // hour file through its descriptor and reopens at the next HH:00 under
    // the same path, so the day dir simply fills back up as new hours land.
    fs.rmSync(resolved, { recursive: true, force: true });
    return { ok: true, removed: date };
  });
}
