package com.radioclyde.mobile.model;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class Station {
    public final String name; // nullable
    public final String streamUrl; // display-only, never used as the actual playback URI

    /**
     * Every mount the station currently publishes, MP3 first (the server's
     * streamEntries() in src/server/streamUrls.js) -- PlaybackService picks
     * the preferred codec out of this. Empty (never null) when the payload
     * predates station.streams or the array is absent. Entry URLs are
     * ABSOLUTE, built from the server's own notion of its public host --
     * not necessarily a host this device can reach; see
     * PlaybackService.updatePreferredStreamUrl() for the re-basing rule
     * that makes them usable.
     */
    public final List<StreamEntry> streams;

    /** One entry of {@link #streams}: a mount URL and its format, both nullable. */
    public static final class StreamEntry {
        public final String url; // nullable
        public final String format; // nullable, "mp3"/"opus"/"flac" from the server

        private StreamEntry(String url, String format) {
            this.url = url;
            this.format = format;
        }
    }

    private Station(String name, String streamUrl, List<StreamEntry> streams) {
        this.name = name;
        this.streamUrl = streamUrl;
        this.streams = streams;
    }

    public static Station fromJson(JSONObject json) {
        if (json == null) return new Station(null, null, Collections.emptyList());
        return new Station(
                JsonUtil.optNullableString(json, "name"),
                JsonUtil.optNullableString(json, "streamUrl"),
                parseStreams(json.optJSONArray("streams")));
    }

    private static List<StreamEntry> parseStreams(JSONArray array) {
        if (array == null) return Collections.emptyList();
        List<StreamEntry> result = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject entry = array.optJSONObject(i);
            if (entry == null) continue;
            result.add(new StreamEntry(
                    JsonUtil.optNullableString(entry, "url"),
                    JsonUtil.optNullableString(entry, "format")));
        }
        return Collections.unmodifiableList(result);
    }
}
