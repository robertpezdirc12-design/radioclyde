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

# Install prefix: every spawned helper (deadair/recordEvent.js,
# plex/scrobbleTrack.js) and the config.json read live under this root.
# RADIOCLYDE_HOME lets a deploy point the engine at its own install (e.g.
# /opt/radioclyde) WITHOUT editing this file; unset, it keeps the original
# dev-box path so the reference install resolves the same paths as before.
#
# environment.get(name) -- NOT bare getenv(): the 2026-10-27
# run of scripts/fetch-liquidsoap.mjs against the official 2.4.6 image
# caught this line failing to PARSE there ("Missing arguments in function
# application: string") -- bare getenv is a deprecated alias whose shape
# differs per build: 2.2.x takes (name) and returns "" when unset, while
# 2.4.6's deprecations.liq defines getenv(default="", v) with the default
# FIRST and POSITIONAL, so the old call becomes a partial application.
# environment.get is byte-identical in both stdlibs (libs/utils.liq:5 in the
# 2.4.6 image, src/libs/utils.liq in the v2.2.4 tar) and its ~default=""
# is a LABELED optional, safely omittable at the call site -- the ONE form
# that parses on both engines, and the only non-deprecated spelling on 2.4.x
# anyway. (Call-site labels take no tilde: environment.get(default=..., name)
# per the stdlib's own call in deprecations.liq.)
let home = if environment.get("RADIOCLYDE_HOME") == "" then "/home/ai/radioclyde" else environment.get("RADIOCLYDE_HOME") end

let json.parse (config : {
  dataDir: string,
  icecast: {sourceHost: string, port: int, mount: string, sourcePassword: string, bitrate: int},
  liquidsoap: {telnetHost: string, telnetPort: int}
}) = file.contents(home ^ "/config.json")

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

# DJ transition effects (P3 #11, liquidsoap/dj_transitions.liq). The file is
# self-gated: its entire body sits behind %ifversion >= 2.4.6, so on this
# 2.2.4 build the preprocessor strips it before parsing and this script is
# byte-identical to the pre-#11 behavior (hard cuts + per-track liq_fade_in
# shaping). Including it UNCONDITIONALLY (not nested inside another
# %ifversion here) keeps the preprocessor picture simple -- both builds
# handle %ifversion and %include in the same pass, verified in both tars'
# tests/language/pp.liq. After the box upgrade the gate opens, the
# cross() wiring block below activates, and transitions ride the flags
# documented in dj_transitions.liq.
%include "dj_transitions.liq"

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

# Off-air filler: a big pool from the whole music library
# (scheduler/generateFillerPlaylist.js, regenerated on the scheduler's filler
# cadence -- default every 6h, config.filler.regenerateIntervalMinutes),
# no DJ talk. mode="normal" (Paket A1, docs/programming-research.md §5): the
# file's WRITTEN order plays exactly as written. Two honest behaviors:
#   - With config.filler.clockwheel configured (P2 #10,
#     docs/ready-made-scripts-analysis.md §4.5) the Node scheduler writes
#     THIS file in strict wheel order (steps -> named pools, N tracks per
#     step, dayparts), and that daypart sequence is finally AUDIBLE on air.
#   - Without a clockwheel block it is the plain weighted-shuffle pool --
#     also played in written order.
# Variety comes from REGENERATION, not from the mode: every regeneration
# reshuffles the plain pool / re-walks the wheel, and the swap lands at the
# next track boundary via reload_mode="watch". Honest caveat: looping before
# the next regeneration replays the same written sequence -- default
# poolSize 200 (~13h of music) vs the 6h cadence means a full loop rarely
# completes, but a small library loops audibly sooner (the backfill keeps
# the pool full -- see generateFillerPlaylist.js). Verified against this
# build's src/libs/playlist.liq: "randomize" shuffles at load, on every
# watch reload AND on every loop, so it must not return here -- it would
# scramble the wheel sequence before air; random picking stays CORRECT for
# the short-clip pools below (stingers, hour ID), and the emergency bed
# stays mode="normal" because it loops. Same fade-up-only annotate as
# show_source's tracks.
filler_source = playlist(reload_mode="watch", mode="normal", config.dataDir ^ "/filler.m3u")
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
# retune. loop=true (Val 31, same starvation fix as id_source): with
# loop=false the pool played each entry once and nothing refilled it in
# steady state, so the layer went silent after N intervals (measured on
# both official binaries, 2026-10-27). delay() itself gates the cadence,
# so loop=true still airs exactly ONE stinger per interval -- measured on
# 2.2.4: stingers at 0 s/36 s/72 s, one each, no chaining.
stinger_source = playlist(id="imaging_stingers", reload_mode="watch", mode="randomize", loop=true,
  config.dataDir ^ "/imaging/stingers.m3u")
stinger_timed = delay(1800., stinger_source)

# Promosi (Paket B2, docs/imaging-layer.md): the fourth imaging layer --
# schedule-driven station promos ("v torek ob 19:00 ...") auto-produced by
# scheduler/promoProducer.js via Edge TTS into imaging/promos/ (operator-
# placed clips are equally at home there; anything in promos.m3u airs).
# Same pattern as the stingers above: delay() gates one promo per interval
# at a track boundary, fallback(track_sensitive=true) keeps it off
# mid-track cuts. Interval 1200. (20 min) DELIBERATELY differs from the
# stingers' 1800. so the two gates don't always fire at the same boundary
# and stack a promo on every stinger seam; a literal for the same
# json.parse-untouched reason as the 1800. above. mode="randomize" is
# CORRECT here (short-clip pool family -- random picking is the right
# behavior for stingers/IDs/promos; only the music wheel is "normal").
# loop=true: the same Val 31 starvation fix as stingers/id above -- delay()
# gates one promo per interval, the pool never runs dry.
promo_source = playlist(id="imaging_promos", reload_mode="watch", mode="randomize", loop=true,
  config.dataDir ^ "/imaging/promos.m3u")
promo_timed = delay(1200., promo_source)

# Station ID at the top of the hour -- the official cookbook overlay recipe
# ("Mixing and switching": add([normal, switch([({0m0s}, jingle)])])). The
# switch has no default branch: before :00 it's unavailable and contributes
# nothing; at :00 it becomes available and starts the clip immediately (it
# has no current track to be track-sensitive about), mixing the ID OVER the
# program. Keep id clips SHORT (2-5 s). predicate.activates was evaluated
# and REJECTED for this: its false->true edge is only observable when
# something samples the predicate (predicate.liq, LS 2.2.5: ans = (not
# last()) and cur), so with boundary-only re-selection a track boundary can
# fall outside the 0m-5m window and the ID would silently skip whole hours.
#
# loop=true (Val 31): the pool must never run dry. With loop=false the
# playlist plays each entry once and exhausts, and nothing refills it in
# steady state -- scheduler/imagingPlaylists.js rewrites id.m3u ONLY when
# the clip SET changes (byte-identical skip), so the old "pool refilled by
# the next imaging rescan's rewrite" claim was wrong: after N clips
# the layer went silent for good. Measured live on BOTH official binaries
# (2026-10-27): a 2-clip pool fires two windows, the third is silent.
# loop=true keeps the pool endless; the one-clip-per-gate-opening cadence
# holds on BOTH builds -- on 2.2.4 the {0m0s} window closes ~1 s in, well
# before any clip ends, and the switch re-checks its predicate at the
# child's track end (the next request is prepared but never airs; measured:
# one 6 s clip per minute-window, three windows running); on 2.4.6 the
# speech gate below fires a one-shot latch instead. mode="randomize"
# reshuffles on every loop, so each hour draws afresh from the pool.
id_source = playlist(id="imaging_id", reload_mode="watch", mode="randomize", loop=true,
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

# --- Dead-air guard (P2 #9, docs/ready-made-scripts-analysis.md §3 recipe 5) --
#
# The emergency bed above catches sources that are UNAVAILABLE (empty m3u),
# but not a source that is AVAILABLE yet streaming digital silence -- a
# corrupt encode or a clipped-to-silence file decodes fine, keeps the playlist
# "ready", and the fallback happily plays its silence for the file's full
# duration. The official cookbook recipe closes exactly that gap with
# blank.strip(): strip makes the source unavailable WHILE it is blank, so the
# track_sensitive=false emergency fallback cuts in, and returns the air to the
# program the moment real sound comes back.
#
# Semantics verified against THIS build's src/core/operators/noblank.ml
# (2.2.4): silence is ACCUMULATED before the state flips -- max_blank=20.
# (the default, made explicit here) means up to 20 s of silence is tolerated
# before the source goes unavailable, so decode gaps at track boundaries and
# produced pauses inside speech never trigger it; recovery needs only
# min_noise=0. (default) of real sound; track_sensitive=true (the default)
# resets the counter at every track boundary, giving each new file a fresh
# chance. threshold=-40. dB is the default RMS silence threshold.
#
# The guard sits BEFORE amplify() on purpose: it judges the program as
# produced, so a per-track liq_amplify correction (typically a few dB) can
# never push a quiet master under the threshold; a master recorded quieter
# than -40 dB RMS is a production defect to fix at production time, not to
# paper over on air.
#
# Reporting: strip's reaction is silent (fallback just switches), so the same
# state machine is ALSO run once as blank.detect (passive observer, same
# verified params) at each layer, and the on_blank/on_noise edges are pinged
# to Node's dead-air ledger (src/deadair/recordEvent.js ->
# dataDir/history/deadair.jsonl, read by studio Diagnostics). blank.detect
# fires only on STATE TRANSITIONS of that same accumulator -- i.e. only after
# 20 s of continuous silence -- so the ledger records real dead-air episodes,
# not boundary micro-gaps (no Node-side debouncing needed). The callbacks run
# in the main streaming thread and must stay fast, so the actual work happens
# in thread.run(fast=false, ...) and process.run's command is itself
# backgrounded (trailing "&") -- the exact pattern of the scrobble handler
# below.
#
# Two layers, reported separately:
#   program_blank/program_sound -- the program chain (show+filler, requests,
#     stingers, ID) went silent for >=20 s; the strip guard covered it with
#     the emergency bed. This is "the guard worked" entries.
#   air_blank/air_sound -- the FINAL air (post-mksafe, so including the
#     emergency bed itself) is silent: mksafe's blank output is digital
#     silence and this detector sees it. Fires only when the guard is also
#     out of options (emergency playlist empty/dead too) -- the true total
#     failure the whole ladder exists to avoid. track_sensitive=false here:
#     mksafe's blank frames contain no track boundaries, so nothing would
#     ever reset the counter; measure the air absolutely.
#
# Param values are literals here on purpose (same reasoning as the imaging
# layers above): radio.liq's json.parse type stays untouched, so an older
# config.json without any dead-air block still boots.
def dead_air_program() =
  thread.run(fast=false, fun () ->
    ignore(process.run("node " ^ home ^ "/src/deadair/recordEvent.js program_blank > /dev/null 2>&1 &")))
end
def sound_program() =
  thread.run(fast=false, fun () ->
    ignore(process.run("node " ^ home ^ "/src/deadair/recordEvent.js program_sound > /dev/null 2>&1 &")))
end
def dead_air_total() =
  thread.run(fast=false, fun () ->
    ignore(process.run("node " ^ home ^ "/src/deadair/recordEvent.js air_blank > /dev/null 2>&1 &")))
end
def sound_total() =
  thread.run(fast=false, fun () ->
    ignore(process.run("node " ^ home ^ "/src/deadair/recordEvent.js air_sound > /dev/null 2>&1 &")))
end

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
#
# P3 #11: the requests fallback stays INSIDE the crossed chain on 2.4.6 -- a
# listener request is music and its seam gets the same crossfade as any
# other music seam. (An interim restructure had moved it outside the cross
# on a self-sync suspicion; the real 2.4.6 --check disproved it:
# request_dynamic.ml reports method self_sync = (`Static, None), which cross
# accepts -- the refusal pointed at the whole fallback VALUE and the dirty
# part was the fade.in-wrapped playlists, see the block below. The wrap
# normalizes the entire chain, requests included.)
requests_source = request.queue(id="requests")
radio = fallback(track_sensitive=true, [requests_source, radio])

# --- DJ transition cross (P3 #11, docs/ready-made-scripts-analysis.md row 11)
#
# On 2.4.6+ the music chain (show + filler + requests -- everything above
# this point) is wrapped in Liquidsoap's low-level cross(): the outgoing
# tail and incoming head are handed to dj_transition (dj_transitions.liq),
# which per seam either blends (plain equal-amplitude crossfade) or applies
# the sweep/washout/dissolve gesture stamped on the tracks, and hard-cuts
# every seam touching speech or a jingle (the 2026-07-28 lesson: the DJ is
# never faded, never overlapped) -- with ONE Val 32 exception: a
# ramp-stamped speech->music seam (liq_ramp="1" on both sides, stamped by
# resolveRampSeams only after the autocue vocal pass measured a talkable
# intro window) plays the speech OVER the track's intro (hit-the-post; see
# dj_transitions.liq's RAMPA block). On 2.2.4 the gate below stays closed and
# the chain keeps its hard cuts -- the two builds differ ONLY here and in
# the callback-form migrations gated further down.
#
# Why the low-level cross and not the crossfade() wrapper: crossfade() with
# a custom transition routes through its internal simple_transition and
# ignores the callback (SUB/WAVE-measured; their comment verbatim), so the
# wrapper cannot carry effects at all.
#
# Why duration=dj_transition_buffer (3.5, defined in dj_transitions.liq
# inside the same gate): it is the value the 2026-07-28 crossfade() attempt
# tuned by offline RMS-envelope testing; the number survived, the wrapper
# didn't. It is now also the DEFAULT every unstamped track gets from
# cross_stamps below (cold endings, speech, jingles, requests, old index
# entries), so the literal and the stamps can never disagree about the
# fallback. persist_override=true is SUB/WAVE's setting: with it unset, the
# override resets before it sizes the stamped track's own end-of-track
# buffer and a stamp lingers over later unstamped tracks (their
# fx-render-test.sh xdur: a stamped 12 renders 86 s without persist, 78 s
# with) -- and since cross_stamps rewrites explicit start/end keys onto
# EVERY track, the values are always fresh anyway.
#
# Everything NON-musical stays OUT of the blend by construction: the stinger
# fallback and the ID overlay attach BELOW this wiring (they wrap the
# crossed source), and the beds and emergency bed above that -- so
# stinger/ID/bed seams are never handed to dj_transition. A 3.5 s blend
# would eat most of a short stinger -- SUB/WAVE #1565's "a jingle is never
# blended", solved here by layering instead of a flag. The crossed source
# still emits a track mark at every crossing (cross fires on_track on every
# crossing, fixed upstream in 2.4.6, #5379), so the track-sensitive
# fallbacks below keep seeing music boundaries exactly as before.
#
# SELF-SYNC WRAP -- why source.dynamic sits in front of cross. cross
# requires every child to report EXACTLY (`Static, None) as its internal
# self_sync (child_support.ml). Our chain is HONESTLY not self-syncing
# (nothing here runs its own realtime loop -- the Lang-level self_sync()
# boolean is false for playlist, fade.in and fallback alike, measured on the
# real 2.4.6 binary), but the stdlib fade.in wrapper attaches RECORD
# METHODS to its source (fades.liq: .{fade_duration=..., fade_type=...}),
# and a method-extended source reports (`Dynamic, None) internally -- which
# cross refuses. Caught by our own --check/--describe-sources on the real
# 2.4.6 binary (docs/liquidsoap-upgrade.md): "This source may control its
# own latency" at the fallback line. The fix is SUB/WAVE's production
# pattern (their radio.liq ~line 401: "self_sync=false: a playlist never
# drives its own clock, and cross() below"): wrap the pre-cross chain in
# source.dynamic(self_sync=false, {..}), which normalizes the reported
# property for the whole chain. The thunk form {radio} is required by
# source.dynamic's signature.
%ifversion >= 2.4.6
radio = source.dynamic(self_sync=false, {radio})

# --- CROSS STAMPS (SUB/WAVE mechanism; Node half = autocue tail pass) ------
#
# director/playlist.js stamps liq_cross_duration="8.0".."12.0" on every
# measured fade-out tail (the offline ebur128 tail pass in autocue.js);
# unstamped tracks (cold endings, speech, jingles, requests, old index
# entries) fall back to dj_transition_buffer -- the literal above.
#
# cross() natively sizes the outgoing TAIL from liq_cross_end_duration and
# the incoming HEAD from liq_cross_start_duration -- but a single
# per-track stamp cannot keep the two in step: cross re-applies override
# keys it finds in its OWN output, and the transition replays the OUTGOING
# track's metadata, so each tail would be sized by the stamp of the track
# BEFORE the outgoing one (SUB/WAVE measured 3931 of 3997 logged
# transitions mis-sized that way before this rewrite). cross_stamps
# translates the one stamp into explicit start/end values per track
# (start = the PREVIOUS track's end) and clears the raw key so cross never
# reads it twice; strip_cross_stamps (dj_transitions.liq) keeps the keys
# off the transition's output frames.
#
# Replay dedup on rid+filename: a replayed metadata chunk (fallback
# metadata replay keeps the request id) must not advance cross_prev_end.
# 30 s stamp cap: the Node side stamps 8..12 s; anything past 30 is a
# corrupt or hand-edited index entry, never a buffer worth waiting on.
# No liq_clip_lead branch (SUB/WAVE's stem-blend cue leads): that needs
# stem analysis we deliberately don't run (no-AI architecture).
cross_prev_end = ref(dj_transition_buffer)
cross_last_file = ref("")
cross_last_rid = ref("")
cross_last_stamps = ref([])
def cross_stamps(m) =
  # `fname`, not `file`: a local `file` shadows the stdlib file.* module
  # (Liquidsoap Warning 6 at startup) -- SUB/WAVE's own wording.
  fname = m["filename"]
  rid = m["rid"]
  if fname != "" and fname == cross_last_file() and rid == cross_last_rid() then
    cross_last_stamps()
  else
    own = float_of_string(default=dj_transition_buffer, m["liq_cross_duration"])
    own = if own < 0. then dj_transition_buffer else own end
    own = if own > 30. then 30. else own end
    stamps = [
      ("liq_cross_start_duration", string(cross_prev_end())),
      ("liq_cross_end_duration", string(own)),
      ("liq_cross_duration", "")
    ]
    cross_prev_end := own
    cross_last_file := fname
    cross_last_rid := rid
    cross_last_stamps := stamps
    stamps
  end
end
radio = metadata.map(update=true, strip=true, cross_stamps, radio)
radio = cross(duration=dj_transition_buffer, persist_override=true, dj_transition, radio)
%endif

# --- Plex scrobble (moved here from below mksafe, P3 #11) --------------------
# Plex never sees these plays otherwise -- playback here reads straight off
# the filesystem, bypassing Plex entirely -- so this pings its scrobble
# endpoint on every track boundary to keep view counts/history in sync with
# what's actually broadcast. Fires optimistically at track start, not on
# completion (see conversation with Alan, 2026-07-27).
#
# Deliberately on_metadata, not on_track: fires on every new file's metadata
# regardless of whether a track mark accompanied it, so it's not sensitive to
# how any given source graph handles track marks at a transition -- one
# fewer thing to break if show_source's fade handling changes again.
#
# Registration position: AFTER the transition cross, BEFORE the stinger
# layer. That covers the crossed chain (show + filler + requests -- listener
# requests must scrobble: requestQueue.js side-indexes their paths for
# scrobbleTrack.js) and stays above the stinger layer so imaging never
# reaches it. That is BELOW the cross on 2.4.6 -- and that is fine:
# SUB/WAVE's "post-cross handlers fire twice per transition" warning
# predates the 2.4.6 deduplication fix (#5360: cross marks the outgoing
# track's replayed metadata, and the stdlib cross wrapper with the default
# deduplicate=true drops that replay when it repeats the last announcement).
# Verified LIVE on the real 2.4.6 binary (docs/liquidsoap-upgrade.md): a
# playlist of two annotated files through our exact transition shape fired
# the post-cross handler exactly once per track (META: AAA, META: BBB -- no
# replay events). Honest deltas vs the old post-mksafe position: the
# emergency bed's metadata no longer pings scrobbleTrack (those were always
# unknown-path noise -- the bed is not in the rating-key index), and on
# 2.4.6 a track that repeats the previous one is deduplicated by the cross
# wrapper, not double-scrobbled.
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
      ignore(process.run("node " ^ home ^ "/src/plex/scrobbleTrack.js " ^ process.quote(p) ^ " " ^ process.quote(dj) ^
        " > /dev/null 2>&1 &"))
    )
  end
end
# Callback FORMS, gated per build. 2.4.0 moved stream callbacks to source
# methods (doc/content/migrating.md) and REMOVED the source.on_metadata
# function form; synchronous=true keeps the old in-stream-thread timing
# (the handler itself only forks a background node process -- exactly what
# the 2.2.4 function form did).
%ifversion >= 2.4.0
radio.on_metadata(synchronous=true, scrobble_on_metadata)
%else
radio = source.on_metadata(radio, scrobble_on_metadata)
%endif

# Stingers slot in between show/filler tracks (their own fallback with
# track_sensitive=true re-selects at track starts; after the stinger ends,
# delay() blocks it again and the next boundary returns to the program).
# Sits ABOVE the transition cross (moved down from just above the requests
# fallback, P3 #11) so a stinger seam is never handed to dj_transition --
# a 3.5 s blend would eat most of a short stinger. The post-cross source
# still emits a track mark at every crossing (cross fires on_track on every
# crossing, fixed upstream in 2.4.6, #5379), so the track-sensitive
# re-selection here keeps seeing music boundaries exactly as before.
radio = fallback(track_sensitive=true, [stinger_timed, radio])
# Promo sibling of the stinger fallback above (Paket B2).
radio = fallback(track_sensitive=true, [promo_timed, radio])
# Hour ID overlay (see the long comment at id_source above). Val 31, B3:
# the ID must no longer stomp the DJ. On 2.2.4 the gate stays the
# cookbook's bare {0m0s} instant -- byte-identical to the pre-Val-31
# wiring. On 2.4.6 the window widens to the first 90 s of the hour and a
# speech gate holds the clip back while a source_tag="speech" track is on
# air; the ID then fires over the intro of whatever follows the speech
# (the classic ID-over-the-ramp), or at :00:00 when music is already
# playing, exactly as before. Semantics, all measured on the official
# 2.4.6 binary (2026-10-27, minute-cycled probes of this exact wiring):
#   * an unselected switch polls its function predicate continuously
#     (dozens of times per second), so a metadata flip opens the gate
#     within ~100 ms of the speech->music seam;
#   * a selected clip always plays to completion even when the window (or
#     the gate) closes mid-clip -- speech starting at :00:03 does not
#     truncate an ID already on air (the old behavior had no gate at all);
#   * at the child's track end the switch re-checks the predicate: with a
#     window wider than one clip the pool would otherwise chain a second
#     clip (measured: two back-to-back with a bare 8 s window), so id_fired
#     is a one-shot latch. It is set by the ID clip's own metadata, which
#     fires at request-PREPARE time -- possibly for a clip that then never
#     airs -- which is fine: the latch only ever needs to be MORE
#     conservative. It is reset by the predicate itself whenever the
#     window is closed (the unselected switch is polled continuously, so
#     the reset always lands long before the next :00). Exactly one ID
#     clip per hour-window, measured against a looping pool.
# id_speech_active starts TRUE (fail-closed): for the first frames after
# boot no program metadata has passed yet, and "unknown" must read as
# speech, not as a license to talk over it -- worst case the first
# top-of-hour after a restart defers the ID by ~1 s (measured boot race:
# a ref(false) default let the ID out 1.2 s before the first speech
# metadata arrived).
# Honest limit, documented: speech that runs past the 90th second of the
# hour skips that hour's ID entirely (a stomped DJ is worse than a skipped
# jingle; measured: a window fully covered by speech stays silent). This
# watch sees the chain BELOW the overlay -- stingers, promos, requests and
# the show's own music and speech tracks -- and the ID clips themselves
# never pass through it (the overlay's add() output is not fed back).
# Stingers, promos and beds keep today's ride-over behavior: their
# source_tags are "stinger"/"promo" and beds carry none -- this gate is
# exactly B3's scope, DJ speech.
#
# Val 32 (ramp talk): while a rampa plays, the incoming track's metadata
# arrives at the seam -- concurrent with the speech still sounding -- so
# keying the gate on source_tag alone would read "music" mid-talk and open
# the ID over the DJ (the exact B3 regression, through a new door). Both
# sides of a ramp seam carry liq_ramp="1" (the speech entry AND the track
# entry -- resolveRampSeams stamps the pair), so the watch also latches on
# the marker: whichever of the two metadata events arrives first, the gate
# stays closed for the whole ramp. It reopens at the NEXT metadata event,
# which by construction fires only after the speech has ended (the next
# seam) -- worst case the ID defers past the ramp exactly as it defers past
# any other speech, fail-closed like the rest of this block.
%ifversion >= 2.4.6
id_window = {0m0s-1m30s}
id_speech_active = ref(true)
id_fired = ref(false)
def id_speech_watch(m) =
  id_speech_active := (m["source_tag"] == "speech" or m["liq_ramp"] == "1")
end
radio.on_metadata(synchronous=true, id_speech_watch)
def id_fired_watch(m) =
  if m["source_tag"] == "id" then
    id_fired := true
  end
end
id_source.on_metadata(synchronous=true, id_fired_watch)
def id_ready() =
  if not id_window() then
    id_fired := false
  end
  id_window() and not id_speech_active() and not id_fired()
end
# Val 32 ODCKRITJE (2026-10-28, dvojni bisekt na uradnih binarkah 2.2.4
# in 2.4.6): privzeti normalize=true tega add() je kriv za DVE latentni
# napaki, ki sta obstajali na etru od uvedbe tega overlayja: (1) GLASNOST:
# normalize meša kot POVPREČJE -- radio + izklopljen switch (tišina) / 2 --
# torej je cela postaja pod tem overlayjem igrala na POL glasnosti
# (izmerjeno z Goertzel sondo na istem tonu: 206 proti 412, x2); (2)
# STRADANJE: v kombinaciji s blank.strip spodaj vir UMRE -- pesem utihne
# po 10 s na 2.2.4 in po ~22 s na 2.4.6 (kjer je med njima še cross);
# polna datoteka brez tega add() ALI z add(normalize=false) teče čisto na
# OBEH binarkah, z normalize=true pa strada na OBEH. Mehanizma (OCaml
# interne logike normalize) nismo razgrnili -- izid je dvojno izmerjen,
# bisekt ga drži. normalize=false = čista vsota: radio nedotaknjen, ID
# čezenj; beds add in rampa/blendi v dj_transitions.liq so že v tej
# obliki -- ta overlay je bil edino mesto s privzetim normalize.
# POSLEDICA za obstoječi 2.2.4 eter: glasnost se odmakne za +6 dB
# (odpravljena latentna tišina, ne novi okus) in stradanje izgine.
radio = add(normalize=false, [radio, switch([(id_ready, id_source)])])
%else
radio = add(normalize=false, [radio, switch([({0m0s}, id_source)])])
%endif

# --- Postelje: sidechain ducker (P3 #13, docs/ready-made-scripts-analysis.md
# §2.6 row 13) ----------------------------------------------------------------
# An announcement OVER the music, ducking on the clip's ACTUAL loudness.
# Supersedes P3 #12's smooth_add wiring (that block lives in git history):
# smooth_add ducked the program to a fixed p=0.2 for the clip's WHOLE
# duration -- including every pause inside the speech. This block ducks only
# while the clip actually sounds and lets the music breathe back during
# pauses, which is what "more precise than #12" means on air.
#
# Why NOT an operator literally named sidechaincompress (the roadmap's
# radio-dj borrowing): no such operator exists in Liquidsoap 2.x -- verified
# against this build's full v2.2.4 source (zero "sidechain" hits under src/)
# and upstream raw trees (v2.3.0, v2.4.0, main: no sidechain operator file).
# "sidechaincompress" is an FFMPEG FILTER name; reaching it from 2.2.4 would
# need the optional ffmpeg-avfilter build plus a muxer() two-track graph
# feeding one ffmpeg.filter graph -- a new build dependency and a filter
# round-trip for something the stdlib already solves.
#
# The mechanism below is the one THIS build's own normalize() uses
# (src/libs/audio.liq, all verified in the v2.2.4 tar):
#   rms.smooth(duration=...)  -> source + .rms method: current smoothed RMS,
#                                linear scale, low-pass time constant
#                                `duration` seconds (rms_smooth.ml)
#   source.on_frame(s, fn)    -> fn runs every pulled frame (normalize's own
#                                gain-update loop is exactly this)
#   amplify({getter}, s)      -> gain re-evaluated EVERY frame
#                                (amplify.ml: `coeff ()` inside get_frame)
#   add(normalize=false, ...) -> plain summation, same as smooth_add itself
#
# State machine (duck_update): level >= 0.02 (-34 dB RMS) ducks the program
# to 0.2 with a ~20 ms attack time constant; level < 0.008 (-42 dB) releases
# toward 1.0 over a ~0.5 s time constant; between the two the gain HOLDS.
# The hysteresis band is what keeps inter-word gaps (~100 ms, smoothed to
# ~0.013 at tau=0.05) from pumping the music, while real sentence pauses
# still let it breathe back. When the beds queue empties, source.is_ready
# flips false and level counts as 0 -- needed because rms.smooth stops being
# pulled then, and its .rms would otherwise freeze at the last spoken value,
# leaving the program ducked forever.
#
# Mix balance is #12's: bed clips ride at 0.8 (smooth_add's 1-p), the
# program floors at 0.2 (smooth_add's p), so the summed air stays ~1.0.
# Every parameter is a literal on purpose (same policy as the stingers
# interval and the blank guard params: radio.liq's json.parse type stays
# untouched, so an older config.json still boots). The two thresholds are
# calibrated for piper/ffmpeg-produced speech (RMS ~0.05-0.2); a much
# quieter clip may not fully duck -- retune the literals here, not config.
#
# override=null() on the duck amplifier is load-bearing: amplify.ml applies
# its `override` FIELD's metadata ("liq_amplify" by default) INSTEAD of the
# coefficient whenever a track carries it, so the default here would swallow
# every track's liq_amplify correction at track start AND freeze this
# amplifier's gain for that whole track; null() keeps this amplifier purely
# getter-driven and leaves the metadata intact for the R128 amplify below.
#
# Wiring position is #12's: ABOVE the hour-ID overlay and the requests
# fallback (an announcement outranks everything musical, including a
# listener's request), BELOW the program dead-air observers (they see the
# MIXED output -- a bed over a silent program is audible radio, not dead
# air; an episode is recorded only if silence survives the bed too). The
# telnet side is UNCHANGED from #12: beds.push/queue/skip via
# src/liquidsoap/bedQueue.js pushes a bare local path (no annotate), so the
# bed amplifier below stays a plain 0.8 and the bed is not scrobbled.
beds_source = request.queue(id="beds")
beds_rms = rms.smooth(duration=0.05, beds_source)
duck_gain = ref(1.)
duck_attack = 1. - exp(0. - frame.duration() / 0.02)
duck_release = 1. - exp(0. - frame.duration() / 0.5)
def duck_update() =
  level = if source.is_ready(beds_source) then beds_rms.rms() else 0. end
  duck_target =
    if level >= 0.02 then 0.2
    elsif level >= 0.008 then duck_gain()
    else 1. end
  duck_coef = if duck_target < duck_gain() then duck_attack else duck_release end
  duck_gain := duck_gain() + duck_coef * (duck_target - duck_gain())
end
# Callback form, gated per build (same migration as the scrobble handler
# above): the source.on_frame function form is a deprecated alias on 2.4.x
# and the method form doesn't exist on 2.2.4. before=true is the method's
# default and matches the old operator's timing (gain updated before the
# frame is produced, the normalize() pattern this ducker copies).
%ifversion >= 2.4.0
radio.on_frame(synchronous=true, duck_update)
%else
radio = source.on_frame(radio, duck_update)
%endif
radio = amplify(id="beds-duck", override=null(), {duck_gain()}, radio)
# Voice processing on the beds channel (SUB/WAVE mic_chain,
# radio.liq:1811-1827): fast attack (5 ms), gentle 4:1 ratio, soft knee --
# tames TTS/clip peaks BEFORE they hit the 0.8 add, so a bed peak summed
# with a program peak cannot clip the encoder. Gated on %ifdef compress:
# the operator lives in src/core/operators/compress.ml but only reaches
# scripts through src/libs/extra/audio.liq, which ships in the separate
# liquidsoap-libs-extra package and is %include_extra'd by stdlib.liq
# (silently skipped when absent, verified against the v2.2.4 tarball).
# DEVIATION from subwave, on purpose: their gain=7.0 + amplify(1.4) makeup
# is for a QUIET LIVE MIC; our beds are produced clips at proper level, and
# makeup gain into add() would clip the mix -- gain stays 0.0. attack and
# release are MILLISECONDS at the script boundary (compress.ml divides by
# 1000 internally), so 5.0/120.0 are subwave's "fast attack / slow release"
# verbatim. The ducker still keys on the UNCOMPRESSED beds_rms (conservative:
# it may over-duck slightly, never under-duck). track_sensitive keeps its
# default false, matching subwave's call.
%ifdef compress
beds_chain = compress(attack=5.0, release=120.0, threshold=-18.0, ratio=4.0, knee=2.0, gain=0.0, beds_rms)
radio = add(normalize=false, [radio, amplify(0.8, beds_chain)])
%else
radio = add(normalize=false, [radio, amplify(0.8, beds_rms)])
%endif
# Dead-air guard, program layer: detect observes, strip reacts. strip wraps
# detect so both see identical frames -- detect passes audio through
# untouched, and strip's synthetic breaks stay invisible to the observer.
# Callback forms, gated per build: 2.4.6 removed blank.detect's positional
# on_noise handler argument ("could not be updated in a backward-compatible
# way", migrating.md) -- the handlers became on_blank/on_noise source
# methods, whose shape is verified against this target build's
# src/core/base/operators/noblank.ml (~callbacks: arg_t=[], i.e. zero-arg
# handlers, synchronous labeled param, exactly the same in-thread timing as
# the old function form; src/libs/source.liq's own blank.skip registers its
# skip hook this way). Handlers stay zero-arg, params stay literals.
%ifversion >= 2.4.0
radio = blank.detect(threshold=-40., max_blank=20., track_sensitive=true, radio)
radio.on_blank(synchronous=true, dead_air_program)
radio.on_noise(synchronous=true, sound_program)
%else
radio = blank.detect(dead_air_program, on_noise=sound_program,
  threshold=-40., max_blank=20., track_sensitive=true, radio)
%endif
radio = blank.strip(threshold=-40., max_blank=20., track_sensitive=true, radio)
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
# Dead-air guard, air layer (see the block above): the FINAL chain including
# the emergency bed. Only total failure (program silent AND emergency bed
# dead) produces silence past mksafe, so these events mean "every layer of the
# ladder just failed" -- the one thing the operator must know about.
%ifversion >= 2.4.0
radio = blank.detect(threshold=-40., max_blank=20., track_sensitive=false, radio)
radio.on_blank(synchronous=true, dead_air_total)
radio.on_noise(synchronous=true, sound_total)
%else
radio = blank.detect(dead_air_total, on_noise=sound_total,
  threshold=-40., max_blank=20., track_sensitive=false, radio)
%endif

# (The Plex scrobble handler lives below the transition cross now, right
# after it -- see the P3 #11 block there: the 2.4.6 cross deduplication
# drops the outgoing replay, so post-cross registration fires exactly once
# per track, and the crossed chain including requests stays covered.)

# BROADCAST BUS -- brick-wall limiter (SUB/WAVE radio.liq:2082-2096): the
# ONLY bus processing, on purpose. Per-track levels are already aligned by
# the R128 amplify(override="liq_amplify") above; this 20:1 knee at -1 dBFS
# catches what that chain cannot: inter-sample peaks the MP3 encoder
# creates during coding (~0.5-1 dB over source, the reason subwave kept
# this one limiter after removing their normalizer/stereo widener). On
# normal program it does 0 dB of reduction. Position: AFTER the air-layer
# dead-air guard (its observers must see pre-limiter frames) and BEFORE
# output.icecast -- the last operator before every encoder, so the optional
# Opus/FLAC/archive outputs in streams.liq inherit it too (they include
# this same `radio` variable). mksafe's synthetic blank passes at unity:
# a limiter never amplifies below threshold. Gated on %ifdef compress for
# the same liquidsoap-libs-extra reason as the beds compressor above --
# a build without the extra libs boots byte-identically to pre-limiter.
%ifdef compress
radio = compress(attack=1.0, release=80.0, threshold=-1.0, ratio=20.0, knee=0.5, gain=0.0, radio)
%endif

# Icy identity (Paket B3, docs/programming-research.md §5): mount-level STATIC
# metadata -- name/description/genre ride every icy handshake, so players and
# directories show the station's identity instead of Icecast defaults. These
# are literals on purpose (same policy as the 1800. above): radio.liq's
# json.parse type stays untouched, so an older config.json keeps booting;
# retune the literals here. name/description/genre deliberately MATCH the
# install.sh template's output.icecast (deploy/ubuntu/install.sh) -- the two
# copies are pinned together in test/radioLiqIcy.test.mjs so they cannot
# drift. The description is honest post-Val 28 ("samo skripte brez AI
# modelov"): the station runs no AI models, so the broadcast metadata must
# not claim "AI DJ Radio" to every player and directory -- this is the
# on-air twin of the comments-must-not-lie scrub (Val 28 removed the AI
# layer from the tree; Val 30 removed its last broadcast-facing claim).
# url= is deliberately OMITTED in this reference file: a placeholder
# URL would be a soft lie on the dev box (the install.sh template keeps its
# operator-editable url= for real deployments). Dynamic "Sedaj: X" updates of
# the mount description were evaluated and deferred -- the roadmap itself
# marks them optional and they need live Icecast admin-API verification.
output.icecast(%mp3(bitrate=config.icecast.bitrate),
  host = config.icecast.sourceHost, port = config.icecast.port,
  password = config.icecast.sourcePassword,
  mount = config.icecast.mount,
  name = "Radio Markec",
  description = "Slovenian script-driven radio",
  genre = "Various",
  radio)

# --- Optional mounts + hourly archive (SUB/WAVE mechanism) ------------------
# streams.liq is GENERATED at every radioclyde boot by
# src/liquidsoap/streamsLiqWriter.js from config.json's icecast.opus /
# icecast.flac / archive blocks, with literal values (host, port, password,
# bitrate ladders -- parse-time constants, which is the whole point: the
# encoders' bitrate arguments cannot come from runtime config reads). The
# committed default is comment-only (everything off), so a fresh clone, a
# config.json without the new blocks, and the old 2.2.4 box all boot
# byte-identically to the pre-streams state. Hand edits survive only until
# the next web restart overwrites the file -- change config.json instead
# (docs/stream-mounts.md).
%include "streams.liq"
