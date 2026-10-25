# Stream mounts and the hourly archive

Optional stream mounts (Opus, FLAC) and the hourly MP3 archive, ported from
SUB/WAVE's `make_stream_outputs` (liquidsoap/radio.liq in
perminder-klair/subwave, MIT) onto this station's Fastify + Liquidsoap stack.
Everything here is **off by default**; a station that never touches the new
config keys boots and behaves byte-identically to before the feature existed.

## Mounts

| Mount | Codec | Bitrate | Default | Notes |
|---|---|---|---|---|
| `/stream` (or `icecast.mount`) | MP3 | `icecast.bitrate` | always on | The universal floor; every player on earth decodes it. |
| `/stream.opus` | Opus in Ogg | clamped to 96/128/192/256/320 kbps, constrained VBR | off | 48 kHz (costs a 44.1→48 kHz resample); best quality-per-bit for music. |
| `/stream.flac` | FLAC in Ogg | none (lossless, ~800–900 kbps stereo) | off | 44.1 kHz / 16-bit / compression=5; no bitrate dial exists. |

Sibling mount names derive from the primary mount with its trailing `.mp3`
stripped: a primary of `/stream.mp3` or `/stream` both produce `/stream.opus`
and `/stream.flac`. Liquidsoap fans the single `radio` source to every
enabled encoder (each `output.icecast(...)` takes `radio` as its source), so
there is no crossfeed wiring — the mounts are always content-identical, only
the encoding differs.

## Configuration

`config.json`:

```json
{
  "icecast": {
    "mount": "/stream.mp3",
    "bitrate": 192,
    "opus": { "enabled": true, "bitrate": 96 },
    "flac": { "enabled": false }
  },
  "archive": { "enabled": false, "bitrate": 128, "retentionDays": 30 }
}
```

- `enabled` is read as **strict `=== true`** everywhere: a typo'd value
  (`"true"`, `1`, `"yes"`) reads as OFF, never as a surprise encoder.
- Bitrates are clamped to SUB/WAVE's rung sets — Opus
  `[96,128,192,256,320]`, archive `[64,96,128,160,192,320]` — because
  Liquidsoap's `%opus`/`%mp3` encoder bitrate arguments are parse-time
  literals (a runtime config read cannot feed them). A value below the
  ladder floors to the first rung, above it caps at the last; defaults are
  96 (Opus) and 128 (archive).

## Wiring and restart semantics

`liquidsoap/streams.liq` is **generated** — do not hand-edit it. At every
boot of the `radioclyde` unit, `src/liquidsoap/streamsLiqWriter.js`
rewrites it from `config.json` (atomically: tmp file + rename;
idempotently: byte-identical
content means no write at all, so the file's mtime stays stable).
`liquidsoap/radio.liq` `%include`s it right after the primary MP3 output,
where the `radio` variable is in scope.

To change anything: edit `config.json`, then

```sh
sudo systemctl restart radioclyde            # regenerates streams.liq
sudo systemctl restart liquidsoap-radioclyde  # the running process already parsed the old file
```

Unit names as installed by `deploy/ubuntu/install.sh`: `radioclyde` (web
server + scheduler in one process — the old separate `radioclyde-web` unit
no longer exists) and `liquidsoap-radioclyde`.

The `radioclyde` restart alone changes the *published surfaces* (playlists,
`/api/now-playing`, proxy routes); the Liquidsoap restart is what actually
builds or tears down encoders. With everything disabled the generated file is
comment-only, so fresh clones, configs without the new blocks, and pre-2.4.6
Liquidsoap builds all boot unchanged.

## Published surfaces

- `/api/now-playing` → `station.streams`: `[{url, format, bitrate}]`, MP3
  always first, Opus only when enabled (clamped bitrate), FLAC last (no
  `bitrate` key). The legacy `station.streamUrl` field is untouched and
  always names the MP3 mount.
- `/listen.m3u` and `/listen.pls` list **every enabled entry**. The
  Slovenian format suffixes ("MP3 192k", "Opus 96k", "FLAC (brezizgubno)")
  appear only when more than one entry is listed — with all optional mounts
  off, both files are byte-identical to the pre-feature output.
- Proxy routes on the public web port: `/stream` always; `/stream.opus` and
  `/stream.flac` only when the matching mount is enabled (a disabled mount
  404s — the route is absent — rather than 502ing).
- Studio: `GET /studio/api/archives` (index), `GET
  /studio/api/archives/file/:date/:hour` (download), `DELETE
  /studio/api/archives/:date` (drop a day).

### publicStreamUrl / tunnel note

If `broadcast.publicStreamUrl` is set (the owner-declared public URL behind
Cloudflare Tunnel / a reverse proxy / a custom domain), every surface
derives sibling URLs from it — `https://radio.example.com/live` produces
`https://radio.example.com/live.opus` and `.flac`. **The tunnel must route
those paths to the web port too**, or the published Opus/FLAC URLs will not
resolve. The proxy routes themselves live at the mount-derived paths
(`/stream.opus`, `/stream.flac`).

### send_icy_metadata

The optional mounts set `send_icy_metadata=false`: metadata travels in the
encoder's native chained-Ogg tags. External ICY updates are the legacy
compat mode (SUB/WAVE keeps it behind a toggle for old clients), and for
Ogg-FLAC Icecast cannot apply external ICY updates at all — native tags are
the only path that works there.

### FLAC is not in the web player

The web player deliberately offers MP3 (and, where the browser supports it,
Opus). FLAC at ~800–900 kbps is a bandwidth-heavy niche: it exists for
archival listening and audiophile clients that pick it out of the playlist
files, not for the default listening experience.

### Listener counting

The listener analytics (Icecast status polls, the studio Analytics view)
counts the **primary mount only**. Listeners on `/stream.opus` or
`/stream.flac` are real listeners but are not in that number — a deliberate
caveat inherited from the single-mount world, documented here so nobody
reads the number as total audience while optional mounts are on.

## Hourly archive

With `archive.enabled: true`, Liquidsoap writes
`<dataDir>/archive/YYYY-MM-DD/HH-00.mp3` — a second MP3 encoder reopens the
file at every hour boundary (`reopen_when={0m0s}`; the `{time.string(...)}`
path getter re-runs strftime at every reopen, which is what rolls the date
and hour). It follows the on-air lifecycle: off air stops the recording
instead of taping the emergency loop. That second 24/7 encoder is the
biggest CPU cost in the broadcast container, hence the opt-in flag.

- **Size:** roughly **1.4 GB/day at 128 kbps** — plan disk and retention
  accordingly. `archive.bitrate` is clamped to
  `[64,96,128,160,192,320]`; 64 kbps halves the footprint if speech-heavy
  programming makes that acceptable.
- **Retention:** the scheduler's `archive_prune` job (default sweep once a
  day, `archive.pruneIntervalMinutes` to tune) removes whole *day*
  directories older than `archive.retentionDays`. Day-granular on purpose:
  the prune compares date strings, never mtimes, so it can never unlink the
  current hour's still-open file — the newest thing it ever removes is
  yesterday. `retentionDays: 0` keeps everything forever. A missing
  `archive` block is a no-op, not a default-30 sweep.
- **Studio download/delete:** the studio archive browser lists days and
  hours (newest first, capped at 500 entries with an honest `truncated`
  flag), streams any hour as `audio/mpeg` with a download filename, and can
  delete a whole day. Deleting is **safe on air**: an unlink only detaches
  the name — Liquidsoap keeps appending to the already-open hour file and
  reopens at the next HH:00 under the same path, so the day fills back up.

### Liquidsoap version gate

The archive block is emitted behind `%ifversion >= 2.4.6` (the
`{time.string(...)}` getter form needs 2.4.6+). On an older Liquidsoap the
archive is skipped with a note in the generated file and the stream mounts
are unaffected. Opus and FLAC encoders exist on every supported build.

### Encoder availability caveat

Debian/Ubuntu ship Liquidsoap encoders as separate packages. Opus needs
`liquidsoap-plugin-opus` (often `liquidsoap-plugin-ogg` alongside), FLAC
needs `liquidsoap-plugin-flac` (Ogg wrapping: `liquidsoap-plugin-ogg`). If a
package is missing, Liquidsoap **fails loudly at script load** on the
`%opus(...)`/`%flac(...)` expression — which is the desired failure mode for
an explicitly opted-in flag: a silent no-mount would be worse. Both are
opt-in, so a default install never needs them.

## Verification

After enabling a mount and restarting both services, check the pieces —
the two ports below come from `config.web.port` vs `config.icecast.port`
(`/admin/stats.xml` is an Icecast endpoint, the proxy and the playlists
are the web server; the numbers are this repo's example values, your
install may differ):

```sh
# generated file carries the mount with the literal clamped bitrate
grep -n 'stream.opus' liquidsoap/streams.liq

# Icecast sees the source (source clients connected) -- ICECAST port
# (config.icecast.port; 8001 in config.example.json)
curl -s -u admin:ADMINPW http://127.0.0.1:8001/admin/stats.xml | grep -o 'mount-name>[^<]*'

# the public proxy answers (mount enabled => 200-family from Icecast, not 404)
# -- WEB port (config.web.port; 8000 in config.example.json)
curl -sI http://127.0.0.1:8000/stream.opus | head -1

# playlists list every enabled entry -- WEB port
curl -s http://127.0.0.1:8000/listen.pls

# archive hours land on disk at the hour boundary
ls data/archive/$(date +%F)/

# prune does the right thing (dry-check today survives)
ls data/archive/
```

The web log line `streams.liq: written (opus, flac, archive)` /
`streams.liq: unchanged` / `streams.liq: ERROR: …` at boot tells you which
branch the generator took on the last restart.
