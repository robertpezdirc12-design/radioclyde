# streams.liq — optional mounts + hourly archive (GENERATED, do not edit)
#
# This file is REGENERATED at every radioclyde-web boot by
# src/liquidsoap/streamsLiqWriter.js from config.json's icecast.opus /
# icecast.flac / archive blocks, with LITERAL values (host, port, password,
# bitrate rungs) — parse-time constants on purpose: the encoders' bitrate
# arguments cannot come from a runtime config read, and radio.liq's typed
# json.parse of config.json stays untouched so older configs keep booting.
#
# The committed default below is the all-disabled shape: comment-only, so a
# fresh clone, a config.json without the new blocks, and the pre-2.4.6 box
# all boot byte-identically to the pre-streams state. Hand edits survive
# only until the next web restart overwrites the file — change config.json
# instead and restart radioclyde-web + liquidsoap (docs/stream-mounts.md).
#
# Provenance: SUB/WAVE's make_stream_outputs (liquidsoap/radio.liq,
# perminder-klair/subwave, MIT — analyzed in the SUB/WAVE portability
# review): %opus(samplerate=48000, vbr="constrained") bitrate ladders,
# %ogg(%flac) with send_icy_metadata=false, and the hourly archive's
# output.file(reopen_when={0m0s}) + {time.string(...)} path getter.
