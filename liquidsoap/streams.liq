# streams.liq -- optional mounts + hourly archive (GENERATED, do not edit)
#
# Regenerated at every radioclyde boot by src/liquidsoap/streamsLiqWriter.js
# from config.json's icecast.opus / icecast.flac / archive blocks, with LITERAL
# values (host, port, password, bitrate rungs): the encoders' bitrate
# arguments are parse-time constants in Liquidsoap, so they cannot come from a
# runtime config read, and radio.liq's typed json.parse of config.json stays
# untouched so older configs keep booting. radio.liq %includes this file right
# after the primary MP3 output -- the `radio` variable is in scope there, and
# every block below feeds it to one more encoder (SUB/WAVE's
# make_stream_outputs fans one source to N outputs; no crossfeed wiring).
#
# Provenance: SUB/WAVE's make_stream_outputs (liquidsoap/radio.liq in
# perminder-klair/subwave, MIT): %opus(samplerate=48000, channels=2,
# application="audio", vbr="constrained") on the [96,128,192,256,320] ladder,
# %ogg(%flac(samplerate=44100, channels=2, compression=5,
# bits_per_sample=16)) with send_icy_metadata=false, and the hourly archive's
# output.file(reopen_when={0m0s}) fed by the {time.string(...)} path getter
# (the GETTER re-runs strftime at every reopen; a bare string writes one
# literal "%Y-%m-%d/%H-00.mp3" file, truncated hourly). The archive block is
# gated %ifversion >= 2.4.6 because that getter form needs 2.4.6+; the
# opus/flac encoders exist on every supported build. Toggle by editing
# config.json, then restarting radioclyde and liquidsoap-radioclyde
# (docs/stream-mounts.md).

# All optional outputs are OFF (icecast.opus.enabled, icecast.flac.enabled,
# archive.enabled are not exactly true in config.json): this file is
# comment-only, the primary MP3 output in radio.liq stays the only encoder,
# and every supported Liquidsoap build parses it identically. Hand edits
# survive only until the next web restart -- change config.json instead.
