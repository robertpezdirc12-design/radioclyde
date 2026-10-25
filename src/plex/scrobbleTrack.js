#!/usr/bin/env node
// Invoked once per track start by radio.liq's on_track hook, as a detached
// OS process (Liquidsoap's on_track callback runs in the main streaming
// thread and must stay fast, so it can't make the Plex HTTP call itself --
// see liquidsoap/radio.liq). Fires optimistically at track start rather than
// waiting for playback to complete; that tradeoff is fine here since the
// goal is just keeping Plex's counts/history roughly in sync with what
// airs, not a verified play confirmation.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { toLocalISOString } from '../lib/time.js';
import { scrobbleTrack } from './scrobble.js';
import { lookupRatingKey } from './ratingKeyIndex.js';
import { getTrackByRatingKey } from './tracks.js';
import { readNowPlayingState, confirmOccurrenceStart, updateNowPlaying } from '../scheduler/updateNowPlaying.js';
import { recordFillerPlays } from '../scheduler/fillerRotation.js';
import { occurrenceDir } from '../scheduler/scheduleUtil.js';
import { getListenerCount } from '../icecast/listeners.js';
import { pushNowPlaying } from '../broadcast/nowPlayingPush.js';
import { submitScrobbles } from '../broadcast/scrobble.js';

const log = createLogger('station');
const filePath = process.argv[2];
const djName = process.argv[3]; // director/playlist.js's annotate: "dj" field -- "" for track entries and the jingle

// Real-time counterpart to producer/history.js's played.jsonl: that file is
// written at production time (up to scriptLeadTimeMinutes ahead of air), so
// it can't answer "what's airing right now" for the web page. This fires
// exactly when a track actually starts, so it's the accurate source for
// both now_playing_track.json (src/server/nowPlaying.js) and the web
// history API (src/server/historyApi.js).
function recordNowPlaying(track) {
  const state = readNowPlayingState();
  const entry = {
    ratingKey: track.ratingKey,
    artist: track.artist,
    title: track.title,
    album: track.album,
    art: track.art,
    durationMs: track.durationMs,
    showId: state?.id ?? null,
    playedAt: toLocalISOString(),
  };
  fs.writeFileSync(config.paths.nowPlayingTrackPath, JSON.stringify(entry));
  fs.mkdirSync(path.dirname(config.paths.airedHistoryFile), { recursive: true });
  fs.appendFileSync(config.paths.airedHistoryFile, JSON.stringify(entry) + '\n');
}

// DJ speech isn't a "play" (no aired.jsonl entry, no Plex scrobble) -- just
// overwrites now_playing_track.json so the web page can show "<persona>
// talking" instead of freezing on whatever track played last.
function recordDjTalking(persona) {
  fs.writeFileSync(config.paths.nowPlayingTrackPath, JSON.stringify({ dj: persona, startedAt: toLocalISOString() }));
}

// The track that was on air BEFORE this segment started -- the OUTGOING half
// of the external-scrobble transition (broadcast/scrobble.js, SUB/WAVE's
// model: now-playing on the incoming, submit on the outgoing). Must be read
// from now_playing_track.json before anything in this run overwrites it
// (recordDjTalking below for speech, recordNowPlaying for music), which is
// why the caller snapshots it at the very top of main(). Only music entries
// count: a {dj:...} entry means the previous segment was speech, and speech
// is not a scrobblable play. Tolerant by design -- a missing or torn file
// (first track after boot) just means "no outgoing".
function readOutgoingTrack() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.paths.nowPlayingTrackPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.artist && parsed.title && parsed.playedAt) {
      return {
        artist: parsed.artist,
        title: parsed.title,
        album: parsed.album ?? null,
        durationMs: parsed.durationMs,
        playedAt: parsed.playedAt,
      };
    }
  } catch {
    // Missing/unreadable/corrupt -- nothing was on air as far as we know.
  }
  return null;
}

async function main() {
  if (!filePath) {
    log('Called with no file path argument -- skipping.');
    return;
  }

  // Snapshot the outgoing track BEFORE any write in this run overwrites
  // now_playing_track.json (recordDjTalking/recordNowPlaying below) -- the
  // external-scrobble block at the bottom of main() submits it together
  // with this segment's incoming track.
  const outgoing = readOutgoingTrack();

  // Fires on every segment (jingle, speech, track, filler), not just the
  // ones handled below -- confirmOccurrenceStart itself is a no-op past the
  // currently-loaded occurrence's own first segment, see its comment in
  // scheduler/updateNowPlaying.js for why this needs to run here at all.
  confirmOccurrenceStart(filePath);

  // Reactive nudge, not a replacement for scheduler.js's own fixed-interval
  // call -- show_source (radio.liq) is loop=false, so the instant a show's
  // real audio runs out, Liquidsoap falls back to filler on its own, in real
  // time. If nothing swaps the next occurrence's playlist into
  // now_playing.m3u until scheduler.js's next nowPlayingCheckIntervalMinutes
  // tick (shipped configs run 0.1 min = 6 s), a clean back-to-back handoff (no gap in
  // station.json) still audibly plays filler-then-jingle-then-show instead
  // of cutting straight over. Calling this here means the very next segment
  // to start airing -- typically the first filler track, since fallback()
  // picks one up within a second or two of show_source emptying -- catches
  // the transition almost immediately instead of waiting out the poll. Cheap
  // and safe to call on every single segment: for any segment well before
  // the current occurrence's estimatedEndAt (the overwhelming majority),
  // updateNowPlaying() reads two small files and returns immediately.
  // Runs in its own detached process per segment (see this file's header),
  // separate from scheduler.js's daemon process -- both racing to write the
  // same state file/now_playing.m3u is safe here because the function is
  // idempotent (sameOccurrence() early-returns once either has applied the
  // switch) and a redundant duplicate write is harmless, so no cross-process
  // lock is needed for this.
  await updateNowPlaying();

  const ratingKey = lookupRatingKey(filePath);
  if (!ratingKey) {
    if (djName) {
      recordDjTalking(djName);
      log(`DJ speaking: "${djName}".`);
    } else {
      log(`No known ratingKey for "${filePath}" (jingle or unannotated speech) -- skipping.`);
    }
    return;
  }

  // Show segment or filler? The currently-loaded occurrence's playlist.m3u is
  // the authoritative list of what belongs to the show that is on air -- a
  // segment with a ratingKey that is NOT in it is filler (fallback() picked
  // it up). This is what feeds the filler rotation ledger (scheduler/
  // fillerRotation.js): without it, filler.m3u regenerations kept re-picking
  // the same pool forever (audited 2026-10-24: the reported hourly song
  // repetition). Airing history for show tracks is handled below via
  // recordNowPlaying(); filler needs its own ledger because played.jsonl is
  // intentionally reserved for show plays (see generateFillerPlaylist.js).
  const state = readNowPlayingState();
  let isFiller = true;
  if (state) {
    try {
      const occPlaylistPath = path.join(
        occurrenceDir(state.weekday, state.id, state.date, state.timeKey),
        'playlist.m3u'
      );
      // Occurrence playlists can be large-ish but are read once per aired
      // segment in an already-detached per-segment process -- fine.
      const occPlaylist = fs.readFileSync(occPlaylistPath, 'utf8');
      isFiller = !occPlaylist.includes(filePath);
    } catch {
      // No readable occurrence dir (e.g. state points at a cleaned-up show):
      // treat as filler only if the track's not plausibly part of anything we
      // know -- defaulting to filler keeps the rotation ledger conservative
      // (worst case a show track also lands in the ledger and filler skips it
      // for a day; the show itself is unaffected either way).
      isFiller = true;
    }
  }
  if (isFiller) {
    recordFillerPlays([{ ratingKey }]);
  }

  // scrobbleEnabled only gates the Plex ping -- now-playing/history are
  // local-only and should stay accurate regardless of whether Plex's own
  // view-count is being kept in sync. Optional chain: auto-radio installs
  // have no plex block at all (config.linux.json), and crashing here would
  // take out now-playing metadata + occurrence confirmation for every
  // segment, not just the Plex ping.
  // Fetched once here for the Plex gate and reused verbatim by the
  // external-scrobble block below, so Icecast is not asked twice per track.
  // Stays undefined when this whole block is skipped (no Plex configured) or
  // the fetch threw -- the scrobble block re-fetches tolerantly on its own.
  let listenerCount;
  if (config.plex?.scrobbleEnabled !== false && config.plex?.baseUrl) {
    try {
      listenerCount = await getListenerCount();
      if (listenerCount > 0) {
        await scrobbleTrack(ratingKey);
        log(`Scrobbled ratingKey ${ratingKey} ("${filePath}").`);
      } else {
        log(`No active Icecast listeners -- skipping Plex scrobble for ratingKey ${ratingKey}.`);
      }
    } catch (err) {
      log(`Plex scrobble skipped for ratingKey ${ratingKey}: ${err.message}`);
    }
  }

  const track = await getTrackByRatingKey(ratingKey);
  recordNowPlaying(track);

  // External scrobbling -- Last.fm + ListenBrainz (broadcast/scrobble.js,
  // docs/scrobbling.md), SUB/WAVE's transition model: now-playing goes out
  // for the INCOMING track (this one), and the eligibility-gated SUBMIT for
  // the OUTGOING track (snapshotted at the top of main(), before
  // recordNowPlaying overwrote it) is stamped with the outgoing's playedAt --
  // the moment it STARTED, which is exactly Last.fm's timestamp contract, so
  // submitting at the NEXT track's start is correct, not late. Off by
  // default (config.scrobble.*, every flag false), so this whole block is a
  // no-op for existing installs. submitScrobbles never throws; the try/catch
  // is the same belt-and-braces the Plex scrobble above uses, and like every
  // await in this detached process it only paces our exit -- playout moved on
  // the moment the segment started.
  if (config.scrobble?.lastfm?.enabled || config.scrobble?.listenbrainz?.enabled) {
    try {
      if (listenerCount === undefined) {
        try {
          listenerCount = await getListenerCount();
        } catch (err) {
          // Unknown listener count -- submitScrobbles fails closed on it.
          log(`Listener count unavailable for external scrobbling: ${err.message}`);
        }
      }
      await submitScrobbles({
        outgoing,
        outgoingStartedAt: outgoing?.playedAt ?? null,
        incoming: track
          ? {
              title: track.title,
              artist: track.artist,
              album: track.album ?? null,
              durationSec: Number(track.durationMs) > 0 ? track.durationMs / 1000 : null,
            }
          : null,
        lastfm: config.scrobble?.lastfm,
        listenbrainz: config.scrobble?.listenbrainz,
        listenerCount,
        nowMs: Date.now(),
        fetchImpl: fetch,
        log,
      });
    } catch (err) {
      log(`ERROR scrobbling external "${filePath}": ${err.stack || err.message}`);
    }
  }

  // External now-playing metadata (TuneIn AIR + Discord webhook) -- both are
  // config-gated no-ops by default and pushNowPlaying itself never throws
  // (every channel failure is caught inside and returned as a result object).
  // The await only paces this detached process's exit; a dead webhook can
  // never delay playout, because Liquidsoap moved on the moment the segment
  // started. TuneIn hears every aired track (filler included -- it displays
  // what is actually playing); Discord hears only curated show tracks, so
  // the community channel isn't spammed by the filler rotation itself.
  await pushNowPlaying({ track, isFiller });
}

main().catch((err) => {
  log(`ERROR scrobbling "${filePath}": ${err.stack || err.message}`);
  process.exitCode = 1;
});
