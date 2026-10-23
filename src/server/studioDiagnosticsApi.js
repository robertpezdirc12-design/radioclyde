// Studio Diagnostics (issue #2 section B.6: readable logs and actionable
// errors for playback, schedule execution, stream connectivity, metadata,
// and script failures) + the Live overview data (B.1: stream/service status,
// current track, schedule block, recent errors, last successful metadata
// update). One endpoint, every number measured -- see diagnosticsUtil.js for
// the honest-failure rules.
import os from 'node:os';
import path from 'node:path';
import { config } from '../config/index.js';
import { recentErrors } from '../lib/errorRing.js';
import { composeNowPlaying } from './nowPlaying.js';
import { getUpcomingShows } from './upcoming.js';
import { loadDowntime, loadSchedule, mostRecentOccurrence, weekdayKey } from '../scheduler/scheduleUtil.js';
import { playlistStats, tailFile, repeatOffenders, probeIcecast } from './diagnosticsUtil.js';
import { readAiredEntries } from './historyApi.js';

const LOG_FILES = ['web.log', 'station.log', 'scheduler.log'];

export function registerStudioDiagnosticsApi(fastify) {
  fastify.get('/api/diagnostics', async () => {
    const mem = process.memoryUsage();

    const logs = {};
    for (const name of LOG_FILES) {
      const lines = tailFile(path.join(config.paths.logsDir, name), 40);
      if (lines.length) logs[name] = lines;
    }

    // Which schedule entry the template says is on air right now -- next to
    // what actually aired (nowPlaying), so a mismatch is visible instead of
    // hidden.
    const now = new Date();
    const templateCurrent = mostRecentOccurrence(loadSchedule(), now);

    const icecast = await probeIcecast(
      `http://${config.icecast.sourceHost}:${config.icecast.port}`
    );

    return {
      generatedAt: now.toISOString(),
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        uptimeSec: Math.round(process.uptime()),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        platform: `${os.platform()} ${os.arch()}`,
      },
      station: {
        name: config.autoRadio?.stationName ?? null,
        timezone: config.weather?.timezone ?? null,
        nowPlaying: composeNowPlaying(),
        templateCurrent: templateCurrent
          ? { id: templateCurrent.show.id, weekday: templateCurrent.weekday, startTime: templateCurrent.show.startTime }
          : null,
        downtime: loadDowntime(),
        playlists: {
          nowPlaying: playlistStats(config.paths.nowPlayingPath),
          filler: playlistStats(config.paths.fillerPath),
        },
        lastMetadataUpdate: playlistStats(config.paths.nowPlayingTrackPath).mtime,
      },
      stream: { icecast, mount: config.icecast.mount, publicPort: config.web.port },
      scheduler: { upcoming: getUpcomingShows(5) },
      repeats: {
        windowHours: config.filler?.rotationWindowHours ?? 24,
        offenders: repeatOffenders(readAiredEntries(), config.filler?.rotationWindowHours ?? 24),
      },
      errors: recentErrors(20),
      logs,
    };
  });
}
