package com.radioclyde.tv.playback;

import android.os.Handler;
import android.os.Looper;

import com.radioclyde.tv.model.NowPlaying;
import com.radioclyde.tv.net.ApiClient;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Polls /api/now-playing every 12s (matching public/app.js's cadence) for
 * the whole lifetime of PlaybackService -- started unconditionally in the
 * service's onCreate() and only shut down in onDestroy(), never gated on
 * Player.Listener#onIsPlayingChanged. That gating existed once and was
 * deliberately removed: the app's screen shows what's on air before the
 * user presses Play (and the system notification/lock screen metadata
 * should be ready the moment they do), so polling must run while idle too
 * -- see docs/android-tv-app.md's "Always-on metadata polling". Do not
 * "restore" play-state gating here. stop() remains for a caller that
 * genuinely wants a pause; today the only caller is shutdown() itself.
 */
public class MetadataPoller {

    public interface Listener {
        void onNowPlaying(NowPlaying nowPlaying);
    }

    private static final long INTERVAL_MS = 12000;

    private final ApiClient apiClient;
    private final Listener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService backgroundExecutor = Executors.newSingleThreadExecutor();
    private final Runnable tick = this::tick;

    private volatile boolean running = false;

    public MetadataPoller(ApiClient apiClient, Listener listener) {
        this.apiClient = apiClient;
        this.listener = listener;
    }

    public void start() {
        if (running) return;
        running = true;
        mainHandler.removeCallbacks(tick);
        mainHandler.post(tick); // immediate first poll, then every INTERVAL_MS
    }

    public void stop() {
        running = false;
        mainHandler.removeCallbacks(tick);
    }

    public void shutdown() {
        stop();
        backgroundExecutor.shutdown();
    }

    private void tick() {
        if (!running) return;
        backgroundExecutor.execute(() -> {
            NowPlaying result = null;
            try {
                result = apiClient.fetchNowPlaying();
            } catch (IOException e) {
                // transient network hiccup -- next poll will retry (mirrors app.js's catch{})
            }
            NowPlaying finalResult = result;
            mainHandler.post(() -> {
                if (!running) return;
                if (finalResult != null) listener.onNowPlaying(finalResult);
                mainHandler.postDelayed(tick, INTERVAL_MS);
            });
        });
    }
}
