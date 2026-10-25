package com.radioclyde.tv.settings;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Wraps the only source of server configuration: host/port + Basic auth
 * username/password, entered by the user via the in-app guided-step
 * settings screen. No hardcoded fallback host -- an unconfigured app routes
 * straight to Settings (see PlaybackActivity).
 */
public class SettingsRepository {

    private static final String PREFS_NAME = "radio_prefs";
    private static final String KEY_HOST = "host";
    private static final String KEY_PORT = "port";
    private static final String KEY_USERNAME = "username";
    private static final String KEY_PASSWORD = "password";

    public static final String DEFAULT_PORT_HINT = "8000";

    /**
     * Notified on the main thread after any save lands in these prefs.
     * PlaybackService implements it so a host/port edit made while the
     * service is alive rebuilds the live MediaItem (ExoPlayer would
     * otherwise keep connecting to the OLD URI -- the Authorization header
     * alone re-reads per connection, see
     * playback/AuthenticatedHttpDataSourceFactory). A credentials-only
     * edit also fires it; the service's URI comparison turns that into a
     * no-op.
     */
    public interface Listener {
        void onServerConfigChanged();
    }

    // One SharedPreferences file backs every SettingsRepository instance
    // (the service and each settings fragment construct their own), so the
    // listener registry has to live at class level to reach across them --
    // an instance-level list would only ever see its own saves.
    private static final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final SharedPreferences prefs;

    public SettingsRepository(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public String getHost() {
        return prefs.getString(KEY_HOST, "");
    }

    public String getPort() {
        return prefs.getString(KEY_PORT, "");
    }

    public String getUsername() {
        return prefs.getString(KEY_USERNAME, "");
    }

    public String getPassword() {
        return prefs.getString(KEY_PASSWORD, "");
    }

    public void saveServerConfig(String host, String port) {
        prefs.edit().putString(KEY_HOST, host).putString(KEY_PORT, port).apply();
        notifyServerConfigChanged();
    }

    public void saveCredentials(String username, String password) {
        prefs.edit().putString(KEY_USERNAME, username).putString(KEY_PASSWORD, password).apply();
        notifyServerConfigChanged();
    }

    public boolean isConfigured() {
        return !getHost().isEmpty() && !getUsername().isEmpty();
    }

    public String getBaseUrl() {
        return "http://" + getHost() + ":" + getPort();
    }

    public String getStreamUrl() {
        return getBaseUrl() + "/stream";
    }

    public void addListener(Listener listener) {
        listeners.add(listener);
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    // apply() updates the in-memory prefs synchronously and posts this to
    // the main thread, so listeners re-read the saved values, never the
    // pre-save ones -- same notify shape as the mobile app's
    // ActiveProfileResolver.setActiveProfile().
    private static void notifyServerConfigChanged() {
        mainHandler.post(() -> {
            for (Listener listener : listeners) {
                listener.onServerConfigChanged();
            }
        });
    }
}
