# radio.liq — Liquidsoap playout engine
# Reads shared settings from config.json (see plan.md "Configuration").
#
# Scheduled-show playout: fully pre-produced episodes only. No live
# generation happens here anymore -- scheduler/scheduler.js (systemd) is the
# sole writer of now_playing.m3u, and does so purely by checking wall-clock
# time against station.json's schedule plus which occurrences have been directed.
# When no show is in its scheduled window, or the scheduled show isn't
# directed yet, now_playing.m3u is left as-is (possibly empty) and this
# station falls back to a shuffled library playlist (filler.m3u) rather than
# going silent -- silence disconnects Icecast/Sonos clients. See
# conversation with Alan, 2026-07-27 (reversing the prior "goes silent"
# decision from 2026-07-26).

let json.parse (config : {
  dataDir: string,
  icecast: {sourceHost: string, port: int, mount: string, sourcePassword: string, bitrate: int},
  liquidsoap: {telnetHost: string, telnetPort: int}
}) = file.contents("/home/ai/radioclyde/config.json")

# Loopback-only, matching src/server/auth.js's trust model -- the studio
# admin's Skip / Force Next controls (src/liquidsoap/telnetClient.js) are
# the only client, running on this same box. Skip uses `/stream.skip` (the
# Icecast output -- whatever is actually decoding, show or filler), not
# show_source.skip: skipping the inner playlist is a no-op while fallback()
# is on filler, and does not interrupt fade.in's currently-decoding file.
# show_source still gets an explicit id so Force Next can `show_source.reload`
# the rewritten now_playing.m3u. Verified against this build's `help`.
settings.server.telnet.set(true)
settings.server.telnet.bind_addr.set(config.liquidsoap.telnetHost)
settings.server.telnet.port.set(config.liquidsoap.telnetPort)

# mode="normal" plays the file's entries in order (this is a produced show,
# not a shuffle playlist). loop=false: once an episode's segments are
# exhausted, stay empty for whatever remains of the scheduled window rather
# than restarting the episode from the top -- fallback() below then takes
# over. reload_mode="watch" picks up scheduler/scheduler.js's edits without a restart.
show_source = playlist(id="show_source", reload_mode="watch", mode="normal", loop=false, config.dataDir ^ "/now_playing.m3u")

# Tried crossfade() here (asymmetric fade_in=3.5/fade_out=1.0/duration=3.5,
# tuned via offline RMS-envelope testing against real DJ-audio + track
# assets) to soften the hard digital cut at every dj<->track boundary. Still
# audibly cut the DJ off live, 2026-07-28, even after that tuning pass --
# reverted to a plain hard cut rather than continuing to chase the params.
# If revisiting this, don't just re-tune crossfade()'s numbers again; the
# 2026-07-27/07-28 history (see git log on this file) is two rounds of that
# already.
#
# fade.in (below) is a different mechanism, not a re-tuned crossfade() --
# crossfade() overlapped two adjacent sources (that overlap is what clipped
# the DJ), while fade.in just shapes one track's own amplitude envelope in
# place, no overlap with its neighbour. Per-entry duration comes from each
# playlist entry's own liq_fade_in annotate metadata (director/playlist.js)
# -- tracks fade up, DJ speech gets explicit "0" (a hard cut, not a skip) so
# it's never faded (listener feedback, 2026-07-29). duration=0. here is the
# fallback for any entry that somehow arrives unannotated.
#
# Deliberately NOT wrapped in fade.out() too, unlike fade.in -- confirmed
# live 2026-07-29 that fade.out() at low (<~0.5s) durations doesn't no-op,
# it silences the *entire* track, not just the tail, in this Liquidsoap
# build (2.2.4-1+dev). A global fade.out(duration=0., ...) here silenced
# every entry without its own large override, i.e. everything except the
# jingle -- the whole station went silent. The jingle's fade-down is instead
# baked into a rendered copy of the file at production time (director/
# index.js, lib/audio.js's applyFadeOut), so no runtime fade.out() is needed
# at all. Do not re-add fade.out() here without re-verifying that bug is
# actually fixed upstream first.
show_source = fade.in(duration=0., show_source)

# Off-air filler: a big shuffled pool from the whole music library
# (scheduler/generateFillerPlaylist.js, regenerated periodically by scheduler/scheduler.js),
# no DJ talk. mode="randomize" so it doesn't play the same order every time
# it loops back around. Same fade-up-only annotate as show_source's tracks.
#
# Clockwheel (P2 #10, docs/ready-made-scripts-analysis.md §4.5): when
# config.json defines filler.clockwheel, the Node scheduler writes THIS file
# in strict wheel order (steps -> named pools, N tracks per step, dayparts).
# A wheel is only audible with mode="normal" here -- verified against this
# build's src/libs/playlist.liq: "randomize" shuffles at load, on every
# watch reload AND on every loop, so it would scramble the wheel sequence
# before air (generateFillerPlaylist logs a standing reminder while a wheel
# is configured). To enable, flip ONE word on the next line:
# filler_source = playlist(reload_mode="watch", mode="normal", config.dataDir ^ "/filler.m3u")
# With mode="normal" the written order plays as written; each regeneration
# swaps in the new file's order at the next track boundary, and looping
# before the next regeneration replays the same written sequence (Node
# reshuffles every regeneration, which is where the variety comes from).
filler_source = playlist(reload_mode="watch", mode="randomize", config.dataDir ^ "/filler.m3u")
filler_source = fade.in(duration=0., filler_source)

# fallback() plays show_source whenever it has queued content and drops to
# filler_source the instant it's empty/exhausted -- this is what makes a
# scheduling gap (or a show that isn't directed yet) fall back to music
# instead of silence. mksafe stays as the last-resort safety net in case
# filler_source is itself briefly empty (e.g. mid-regeneration).
#
# --- Imaging layer (docs/imaging-layer.md) -----------------------------------
# Three optional layers on top of the show/filler core, in "outside-in" order:
# stingers join at track boundaries, the hour ID rides OVER the mix, and the
# emergency bed sits below everything but above mksafe's blank. Every source
# here is a playlist() (fallible): an empty or missing .m3u (which is what
# scheduler/imagingPlaylists.js writes when a clip directory is empty/absent)
# makes that layer simply unavailable, so a station with no imaging assets
# behaves exactly as it did before this block existed -- the degradation
# ladder is "skip the layer", never "skip the program".
#
# Stingeri -- delay() semantics verified against Liquidsoap 2.2.5's
# src/core/operators/delay.ml: after a track of the wrapped source ends, the
# source stays unavailable until <interval> seconds have passed; at startup
# "last" is 0., so exactly ONE stinger plays at the first track boundary
# after boot, then at most one per interval afterwards. The outer
# fallback(track_sensitive=true) is what keeps this on track boundaries --
# with track_sensitive=false it would cut music mid-track the moment the
# interval elapsed. Interval is a literal here on purpose (like {0m0s}
# below): radio.liq's json.parse type stays untouched, so an older
# config.json without an imaging block still boots. Edit 1800. (seconds) to
# retune.
stinger_source = playlist(id="imaging_stingers", reload_mode="watch", mode="randomize", loop=false,
  config.dataDir ^ "/imaging/stingers.m3u")
stinger_timed = delay(1800., stinger_source)

# Station ID at the top of the hour -- the official cookbook overlay recipe
# ("Mixing and switching": add([normal, switch([({0m0s}, jingle)])])). The
# switch has no default branch: before :00 it's unavailable and contributes
# nothing; at :00 it becomes available and starts the clip immediately (it
# has no current track to be track-sensitive about), mixing the ID OVER the
# program. Keep id clips SHORT (2-5 s) -- they can ride over a show's intro
# speech if a show starts exactly on the hour; that overlap is how real
# stations sound. predicate.activates was evaluated and REJECTED for this:
# its false->true edge is only observable when something samples the
# predicate (predicate.liq, LS 2.2.5: ans = (not last()) and cur), so with
# boundary-only re-selection a track boundary can fall outside the 0m-5m
# window and the ID would silently skip whole hours. mode="randomize" +
# loop=false: one clip per hour from the pool, pool refilled by the next
# imaging rescan's rewrite (watch reload).
id_source = playlist(id="imaging_id", reload_mode="watch", mode="randomize", loop=false,
  config.dataDir ^ "/imaging/id.m3u")

# Emergency bed: the last playlist below show+filler, above mksafe's blank --
# if both program sources die (e.g. both m3u files unreadable mid-write),
# this plays a recognizable "we know it's broken" clip on loop instead of
# pure silence that would still keep Icecast/Sonos clients connected
# (SUB/WAVE's dead-air guard idea, minimal form). playlist() with loop=true,
# NOT single(): a fallible source that is unavailable while its playlist is
# empty keeps the degradation ladder honest, while single() with a missing
# file has murkier availability semantics on this build.
emergency_source = playlist(id="imaging_emergency", reload_mode="watch", mode="normal", loop=true,
  config.dataDir ^ "/imaging/emergency.m3u")

radio = fallback(track_sensitive=false, [show_source, filler_source])
# Listener requests (P2 #8, integration table row 8): the studio queues an
# approved request with one telnet call (src/liquidsoap/requestQueue.js ->
# "requests.push <local-path>"), and this fallback plays it at the NEXT track
# boundary -- never mid-track, and with zero competition from the m3u reload
# (that reload race is exactly what this layer removes). Semantics verified
# against THIS build's source (v2.2.4 src/libs/request.liq): with
# interactive=true (default) request.queue registers the telnet commands
# requests.push/<id>.queue/skip under the source's id, replies to a push with
# the new request's numeric id, and its availability is
# available={not list.is_empty(queue())} -- i.e. available exactly while the
# queue holds something, which is what the track_sensitive fallback needs.
# Pushed URIs are BARE local paths (no annotate), so request tracks play with
# the station's hard-cut default -- same treatment as stingers/IDs; no
# liq_amplify metadata means amplify below stays a 1.0 pass-through for them.
# Wrapped ABOVE the stinger layer on purpose: at a boundary where both are
# ready, a listener's request outranks imaging.
requests_source = request.queue(id="requests")
radio = fallback(track_sensitive=true, [requests_source, radio])
# Stingers slot in between show/filler tracks (their own fallback with
# track_sensitive=true re-selects at track starts; after the stinger ends,
# delay() blocks it again and the next boundary returns to the program).
radio = fallback(track_sensitive=true, [stinger_timed, radio])
# Hour ID overlay (see comment above).
radio = add([radio, switch([({0m0s}, id_source)])])
# R128 loudness alignment (docs/autocue-loudness.md): entries carrying
# liq_amplify (written into the m3u by Node from the offline ebur128 index)
# get their measured correction applied; everything else -- unscanned
# tracks, speech, jingle, IDs, stingers -- has no such metadata and stays at
# the 1.0 pass-through coefficient. Semantics verified against amplify.ml in
# both 2.2.4 and 2.2.5 (byte-identical): " %f dB" is parsed off the frame
# metadata at track start, and the override resets at every track boundary,
# so no gain ever leaks between tracks. Placed BEFORE the emergency fallback
# on purpose: the emergency bed plays at its produced loudness, untouched.
radio = amplify(override="liq_amplify", 1., radio)
# Emergency below everything (immediately preempts when the program sources
# are both unavailable -- track_sensitive=false), then mksafe's blank stays
# as the final net if even the emergency playlist is empty.
radio = mksafe(fallback(track_sensitive=false, [radio, emergency_source]))

# Plex scrobble: Plex never sees these plays otherwise -- playback here reads
# straight off the filesystem, bypassing Plex entirely -- so this pings its
# scrobble endpoint on every track boundary to keep view counts/history in
# sync with what's actually broadcast. Fires optimistically at track start,
# not on completion (see conversation with Alan, 2026-07-27).
#
# Deliberately on_metadata, not on_track: fires on every new file's metadata
# regardless of whether a track mark accompanied it, so it's not sensitive to
# how any given source graph handles track marks at a transition -- one
# fewer thing to break if show_source's fade handling changes again.
#
# on_metadata handlers run in the main streaming thread and must stay fast,
# so the actual work happens in thread.run(fast=false, ...); process.run's
# command is itself backgrounded (trailing "&") so even that call returns as
# soon as the shell has forked plex/scrobbleTrack.js, not waiting on the Plex
# HTTP call. plex/scrobbleTrack.js resolves "filename" -- Liquidsoap's own
# resolved path for whatever it's actually decoding -- against dataDir's
# track_ratingkeys.json side index (written by director/index.js/
# scheduler/generateFillerPlaylist.js); DJ speech clips aren't in that index.
# Deliberately NOT "initial_uri": that's the raw playlist line as written,
# so once director/playlist.js started wrapping tracks in annotate:liq_fade_in=...,
# initial_uri became "annotate:liq_fade_in=...:/path" instead of a bare
# path, silently breaking every track's ratingKeyIndex lookup (confirmed
# live 2026-07-29 -- scrobbling, aired-history, and the web now-playing
# display all quietly stopped updating). "filename" is unaffected by
# annotate: wrapping either way -- confirmed live it resolves to the real
# decoded file path for both plain and annotate:-wrapped entries.
# `dj` is director/playlist.js's annotate: field naming who's speaking on a
# speech clip (empty string for track entries and the jingle, which have no
# such field) -- passed through so scrobbleTrack.js can tell "DJ talking"
# apart from a genuinely unknown path instead of treating both as skips.
def scrobble_on_metadata(m) =
  p = m["filename"]
  dj = m["dj"]
  if p != "" then
    thread.run(fast=false, fun () ->
      ignore(process.run("node /home/ai/radioclyde/src/plex/scrobbleTrack.js " ^ process.quote(p) ^ " " ^ process.quote(dj) ^
        " > /dev/null 2>&1 &"))
    )
  end
end
radio = source.on_metadata(radio, scrobble_on_metadata)

output.icecast(%mp3(bitrate=config.icecast.bitrate),
  host = config.icecast.sourceHost, port = config.icecast.port,
  password = config.icecast.sourcePassword,
  mount = config.icecast.mount,
  radio)
