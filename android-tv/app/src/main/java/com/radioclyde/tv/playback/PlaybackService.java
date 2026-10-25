package com.radioclyde.tv.playback;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import com.radioclyde.tv.R;
import com.radioclyde.tv.model.NowPlaying;
import com.radioclyde.tv.model.Station;
import com.radioclyde.tv.model.Track;
import com.radioclyde.tv.net.ApiClient;
import com.radioclyde.tv.settings.SettingsRepository;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.Locale;

/**
 * Foreground MediaSessionService hosting the single live ExoPlayer stream.
 * Keeps audio playing in the background and wires the TV remote's
 * transport keys / the lock-screen media controls to the same Player via
 * the platform's MediaSession routing -- no custom key handling needed.
 *
 * Reacts to Settings saves (SettingsRepository.Listener, the TV-side
 * counterpart of the mobile app's ActiveProfileResolver.Listener): when the
 * configured host/port change while the service is alive, the live
 * MediaItem is rebuilt so ExoPlayer reconnects at the new server. See
 * onServerConfigChanged().
 */
@UnstableApi
public class PlaybackService extends MediaSessionService implements SettingsRepository.Listener {

    private static final String LIVE_MEDIA_ID = "live-stream";

    /**
     * MediaMetadata.extras key for the current show's name -- neither
     * title nor artist maps cleanly to "show name" (title/artist carry the
     * track or the "DJ talking" line), so it rides in extras instead of
     * overloading an existing field. Read via player.getMediaMetadata()
     * .extras on the client (see PlaybackActivity).
     */
    public static final String EXTRA_SHOW_NAME = "showName";

    /**
     * MediaMetadata.extras keys for the current track's progress -- epoch
     * millis the track started, and its total duration. The client ticks
     * elapsed/remaining locally from these every second (mirrors
     * public/app.js's tickTrackProgress) rather than polling every second.
     * Absent (or -1) when a DJ is talking instead of a track playing.
     */
    public static final String EXTRA_PLAYED_AT_EPOCH_MS = "playedAtEpochMs";

    public static final String EXTRA_DURATION_MS = "durationMs";

    private ExoPlayer player;
    private MediaSession mediaSession;
    private MetadataPoller metadataPoller;
    private AuthArtBitmapLoader artLoader;
    private SettingsRepository settings;

    // The Opus sibling mount the station last advertised in
    // station.streams, re-based onto OUR base URL -- see
    // updatePreferredStreamUrl(). Null (the MP3 floor) until a poll
    // surfaces one, and again whenever the base it was re-based onto no
    // longer matches the configured server.
    private String preferredStreamUrl;
    private String preferredStreamBaseUrl;

    @Override
    public void onCreate() {
        super.onCreate();
        settings = new SettingsRepository(this);
        settings.addListener(this);

        AuthenticatedHttpDataSourceFactory dataSourceFactory = new AuthenticatedHttpDataSourceFactory(settings);
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory))
                .build();

        // Always have a MediaItem present (without starting playback) so
        // MetadataPoller can replaceMediaItem() as soon as the first poll
        // lands, regardless of whether the user has pressed play yet.
        player.setMediaItem(buildLiveMediaItem());

        artLoader = new AuthArtBitmapLoader(settings);
        mediaSession = new MediaSession.Builder(this, player)
                .setBitmapLoader(artLoader)
                .setCallback(new RestrictSkipCallback())
                .build();

        // Runs for the service's whole lifetime, not gated on isPlaying --
        // the default screen (PlaybackActivity) shows now-playing info as
        // soon as it's open, before the user presses Play, so metadata
        // can't wait for actual playback to start.
        metadataPoller = new MetadataPoller(new ApiClient(settings), this::onNowPlaying);
        metadataPoller.start();
    }

    private MediaItem buildLiveMediaItem() {
        return new MediaItem.Builder()
                .setMediaId(LIVE_MEDIA_ID)
                .setUri(Uri.parse(resolveStreamUrl()))
                .setMediaMetadata(new MediaMetadata.Builder()
                        .setTitle(getString(R.string.app_name))
                        .build())
                .build();
    }

    /**
     * The URI the live MediaItem should carry right now: the Opus mount the
     * station last advertised, re-based onto the configured host, or the
     * always-present MP3 mount when it hasn't. The base-URL check is what
     * keeps a cached preference honest across settings changes -- a URL
     * re-based onto the previous host is exactly as stale as that host.
     */
    private String resolveStreamUrl() {
        return preferredStreamUrl != null && settings.getBaseUrl().equals(preferredStreamBaseUrl)
                ? preferredStreamUrl
                : settings.getStreamUrl();
    }

    /**
     * Re-derives the preferred (Opus) stream URL from station.streams, once
     * per poll. The entries' URLs are absolute and built from the SERVER's
     * notion of its own public host (config.icecast.publicHost, or the
     * owner-declared broadcast.publicStreamUrl -- see src/server/
     * streamUrls.js), which is not necessarily a host this TV can reach:
     * the station may publish its public domain while the device talks to
     * a private host:port on the LAN. So only the PATH of the entry is
     * trusted, re-based onto the base URL this app is actually configured
     * with -- the sibling mounts are proxied on the same Fastify port as
     * /stream itself (src/server/streamProxy.js), so base + path is
     * reachable by exactly the route /stream already is. A missing array,
     * no opus entry, or an unparseable URL all fall back to the MP3 floor;
     * when the station later disables Opus the entry disappears and the
     * next poll drops back to MP3 on its own.
     */
    private void updatePreferredStreamUrl(Station station) {
        preferredStreamUrl = null;
        preferredStreamBaseUrl = null;
        if (station == null) return;
        for (Station.StreamEntry entry : station.streams) {
            if (!"opus".equals(entry.format) || entry.url == null) continue;
            String path = pathOf(entry.url);
            if (path != null) {
                preferredStreamBaseUrl = settings.getBaseUrl();
                preferredStreamUrl = preferredStreamBaseUrl + path;
            }
            break; // the server lists at most one opus mount (streamEntries())
        }
    }

    /** Path-only part of an absolute stream-entry URL, or null when unparseable/empty. */
    private static String pathOf(String url) {
        try {
            String path = new URL(url).getPath();
            return path.isEmpty() ? null : path;
        } catch (MalformedURLException e) {
            return null;
        }
    }

    /**
     * A settings save landed while the service is alive (every
     * SettingsRepository instance shares one prefs file, so the
     * notification reaches the service no matter which wizard step saved).
     * Mirrors the mobile app's onActiveProfileChanged(): when the resolved
     * stream URI actually changed -- host/port edited; a credentials-only
     * edit resolves to the same URI, and the Authorization header already
     * re-reads on every reconnect (AuthenticatedHttpDataSourceFactory) --
     * replaceMediaItem tears the old connection down so ExoPlayer
     * reconnects at the new server instead of retrying the stale URI
     * until force-stop. A brief audible gap is expected and correct:
     * there is no position to preserve across two different live servers.
     */
    @Override
    public void onServerConfigChanged() {
        String newUri = resolveStreamUrl();
        MediaItem current = player.getCurrentMediaItem();
        if (current != null && newUri.equals(current.localConfiguration != null ? current.localConfiguration.uri.toString() : null)) {
            return; // only credentials changed -- header refreshes on next reconnect, no rebuild needed
        }
        MediaItem updated = buildLiveMediaItem();
        if (current == null) {
            player.setMediaItem(updated);
        } else {
            player.replaceMediaItem(player.getCurrentMediaItemIndex(), updated);
        }
    }

    private void onNowPlaying(NowPlaying nowPlaying) {
        MediaItem current = player.getCurrentMediaItem();
        if (current == null) return;

        updatePreferredStreamUrl(nowPlaying.station);

        MediaMetadata.Builder metadata = new MediaMetadata.Builder();
        if (nowPlaying.dj != null) {
            metadata.setTitle(getString(R.string.dj_talking_format, nowPlaying.dj));
            if (nowPlaying.show != null && nowPlaying.show.name != null) {
                metadata.setArtist(nowPlaying.show.name);
            }
            // A handoff joins names with " & " (see server/showName.js);
            // only the first persona's photo is shown for that rare case.
            // Not every persona has a photo yet -- a missing one 404s and
            // both AuthArtBitmapLoader and PlaybackActivity's Glide.error()
            // already treat that as "nothing to show", no extra handling.
            String persona = nowPlaying.dj.split(" & ")[0].toLowerCase(Locale.US);
            metadata.setArtworkUri(Uri.parse(settings.getBaseUrl() + "/dj-photos/" + persona));
        } else if (nowPlaying.track != null) {
            Track track = nowPlaying.track;
            metadata.setTitle(track.title);
            metadata.setArtist(track.artist);
            metadata.setAlbumTitle(track.album);
            if (track.artUrl != null) {
                metadata.setArtworkUri(Uri.parse(settings.getBaseUrl() + track.artUrl));
            }
        }
        Bundle extras = new Bundle();
        if (nowPlaying.show != null && nowPlaying.show.name != null) {
            extras.putString(EXTRA_SHOW_NAME, nowPlaying.show.name);
        }
        if (nowPlaying.dj == null && nowPlaying.track != null && nowPlaying.track.durationMs != null) {
            long playedAtEpochMs = nowPlaying.track.playedAtEpochMs();
            if (playedAtEpochMs >= 0) {
                extras.putLong(EXTRA_PLAYED_AT_EPOCH_MS, playedAtEpochMs);
                extras.putLong(EXTRA_DURATION_MS, nowPlaying.track.durationMs);
            }
        }
        metadata.setExtras(extras);

        int index = player.getCurrentMediaItemIndex();
        // Same-URI replacement is free (this replaceMediaItem already runs
        // every poll); a CHANGED URI -- the Opus mount first advertised, or
        // dropped by a config flip -- is what makes the player reconnect
        // at the new mount on the spot.
        MediaItem updated = current.buildUpon()
                .setUri(Uri.parse(resolveStreamUrl()))
                .setMediaMetadata(metadata.build())
                .build();
        player.replaceMediaItem(index, updated);
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        // App swiped away from recents: keep the foreground service (and
        // audio) alive if actively playing, otherwise let it stop.
        if (player == null || !player.isPlaying()) {
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        if (settings != null) settings.removeListener(this);
        if (metadataPoller != null) metadataPoller.shutdown();
        if (mediaSession != null) {
            mediaSession.getPlayer().release();
            mediaSession.release();
        }
        // After the session is released nothing can still submit an art
        // fetch, so this is the safe point to retire the loader's thread.
        if (artLoader != null) artLoader.shutdown();
        super.onDestroy();
    }

    /** No queue -- hides skip-next/previous from the system notification. */
    private static class RestrictSkipCallback implements MediaSession.Callback {
        @Override
        public MediaSession.ConnectionResult onConnect(MediaSession session, MediaSession.ControllerInfo controller) {
            MediaSession.ConnectionResult defaultResult = MediaSession.Callback.super.onConnect(session, controller);
            Player.Commands availableCommands = defaultResult.availablePlayerCommands.buildUpon()
                    .remove(Player.COMMAND_SEEK_TO_NEXT)
                    .remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .remove(Player.COMMAND_SEEK_TO_PREVIOUS)
                    .remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                    .build();
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailablePlayerCommands(availableCommands)
                    .build();
        }
    }
}
