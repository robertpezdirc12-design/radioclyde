#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

ARCH=$(uname -m)
log "Architecture: $ARCH"
case "$ARCH" in aarch64|arm64|x86_64|amd64) ;; *) error "Unsupported: $ARCH" ;; esac

. /etc/os-release
[ "$ID" = "ubuntu" ] || error "Requires Ubuntu. Detected: $ID"
log "OS: $PRETTY_NAME"
[ "$EUID" -eq 0 ] || error "Run as root: sudo bash install.sh"

RADIO_USER="radioclyde"
RADIO_HOME="/opt/radioclyde"
DATA_DIR="$RADIO_HOME/data"
MUSIC_DIR="$RADIO_HOME/music"
VOICES_DIR="$RADIO_HOME/voices"
PREGEN_DIR="$RADIO_HOME/data/pre-generated"

log "Updating system..."
apt-get update -qq && apt-get upgrade -y -qq

log "Installing base dependencies..."
apt-get install -y -qq curl wget git build-essential python3 python3-pip python3-venv \
  ffmpeg sox unzip jq ca-certificates gnupg nginx

log "Installing Node.js 24 LTS..."
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -qq nodejs
fi
log "Node: $(node --version), npm: $(npm --version)"

log "Installing Liquidsoap..."
command -v liquidsoap &>/dev/null || apt-get install -y -qq liquidsoap

log "Installing Icecast2..."
command -v icecast2 &>/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq icecast2

log "Installing Piper TTS..."
python3 -c "import piper" 2>/dev/null || pip3 install --break-system-packages piper-tts 2>/dev/null || pip3 install piper-tts
python3 -c "import piper; print('Piper OK')"

log "Creating radio user..."
id "$RADIO_USER" &>/dev/null || useradd -r -m -d "$RADIO_HOME" -s /bin/bash "$RADIO_USER"
mkdir -p "$RADIO_HOME"; chown -R "$RADIO_USER:$RADIO_USER" "$RADIO_HOME"

log "Creating directories..."
sudo -u "$RADIO_USER" mkdir -p \
  "$DATA_DIR"/{show-descriptions,running,history,logs,cache/{wikipedia,art}} \
  "$MUSIC_DIR" "$VOICES_DIR" "$PREGEN_DIR" \
  "$RADIO_HOME"/{app,config}

# Pre-download the Slovenian piper1-gpl voice (sl_SI-artur-medium, ~63 MB,
# one-time) so the first pregeneration does not wait on a HuggingFace fetch.
# Best effort: on an offline box the first synthesis downloads on demand
# anyway (piperAutoDownload defaults to true in config.linux.json).
PIPER_DATA_DIR="$DATA_DIR/piper"
if ! sudo -u "$RADIO_USER" test -f "$PIPER_DATA_DIR/sl_SI-artur-medium.onnx" 2>/dev/null; then
  sudo -u "$RADIO_USER" mkdir -p "$PIPER_DATA_DIR"
  if sudo -u "$RADIO_USER" python3 -m piper.download_voices sl_SI-artur-medium --data-dir "$PIPER_DATA_DIR"; then
    log "Piper voice sl_SI-artur-medium downloaded to $PIPER_DATA_DIR"
  else
    warn "Piper voice download skipped -- first synthesis will download it on demand"
  fi
fi

if [ -d "/tmp/radioclyde-app" ]; then
  # Loud on purpose: a stale /tmp/radioclyde-app leftover from an old upload
  # would otherwise silently overwrite (downgrade) the deployed code on
  # every re-run.
  if [ -f "$RADIO_HOME/app/package.json" ]; then
    warn "Re-copying app code from /tmp/radioclyde-app over the existing $RADIO_HOME/app -- delete /tmp/radioclyde-app if this is NOT a fresh upload."
  fi
  cp -r /tmp/radioclyde-app/* "$RADIO_HOME/app/"
  chown -R "$RADIO_USER:$RADIO_USER" "$RADIO_HOME/app"
  log "Code copied"
else
  warn "No code at /tmp/radioclyde-app"
fi

if [ -f "$RADIO_HOME/app/package.json" ]; then
  cd "$RADIO_HOME/app" && sudo -u "$RADIO_USER" npm ci --production
fi

log "Configuring Icecast2..."
ICECAST_CONF="/etc/icecast2/icecast.xml"
# Only on first install: a re-run must not clobber the passwords/hostname the
# admin edited after the first run (audit 2026-10-24: unconditional overwrite
# made every re-run reset them). Delete /etc/icecast2/icecast.xml yourself to
# force a fresh template.
if [ ! -f "$ICECAST_CONF" ]; then
  cat > "$ICECAST_CONF" << 'ICECAST_EOF'
<icecast>
    <location>Server</location>
    <admin>admin@localhost</admin>
    <limits>
        <clients>100</clients>
        <sources>2</sources>
        <queue-size>524288</queue-size>
        <client-timeout>30</client-timeout>
        <header-timeout>15</header-timeout>
        <source-timeout>10</source-timeout>
        <burst-on-connect>1</burst-on-connect>
        <burst-size>65535</burst-size>
    </limits>
    <authentication>
        <source-password>CHANGE_ME_SOURCE_PASSWORD</source-password>
        <relay-password>CHANGE_ME_RELAY_PASSWORD</relay-password>
        <admin-user>admin</admin-user>
        <admin-password>CHANGE_ME_ADMIN_PASSWORD</admin-password>
    </authentication>
    <hostname>localhost</hostname>
    <listen-socket>
        <port>8000</port>
        <bind-address>127.0.0.1</bind-address>
    </listen-socket>
    <fileserve>1</fileserve>
    <paths>
        <basedir>/usr/share/icecast2</basedir>
        <logdir>/var/log/icecast2</logdir>
        <webroot>/usr/share/icecast2/web</webroot>
        <adminroot>/usr/share/icecast2/admin</adminroot>
        <alias source="/" dest="/status.xsl"/>
    </paths>
    <logging>
        <accesslog>access.log</accesslog>
        <errorlog>error.log</errorlog>
        <loglevel>3</loglevel>
        <logsize>10000</logsize>
    </logging>
    <security>
        <chroot>0</chroot>
    </security>
</icecast>
ICECAST_EOF
  chown icecast2:icecast2 "$ICECAST_CONF"
  chmod 640 "$ICECAST_CONF"
else
  log "Icecast config already present -- keeping existing passwords/settings."
fi

log "Configuring Liquidsoap..."
mkdir -p "$RADIO_HOME/config"
LIQ_CONF="$RADIO_HOME/config/radio.liq"
# This is the station's playout core and MUST match what the scheduler expects
# (see src/scheduler/scheduler.js's now_playing comment and the reference
# liquidsoap/radio.liq in the repo):
#   show_source  -- now_playing.m3u, mode=normal, loop=false, watch-reload:
#                   one pre-produced occurrence, then empty; the scheduler is
#                   the only writer of that file.
#   filler_source-- filler.m3u, mode=randomize, watch-reload: off-air music
#                   pool regenerated by the scheduler's filler job.
#   fallback([show_source, filler_source]) -- scheduled programming airs when
#                   it exists, filler covers every gap. An earlier install.sh
#                   generated a filler-only config, which is exactly the
#                   "station plays the same songs forever, shows never air"
#                   production incident audited 2026-10-24.
#   on_track     -- fires scrobbleTrack.js per segment: keeps now-playing
#                   metadata, occurrence handoffs and the filler rotation
#                   ledger (no hourly repetition) in sync with real airtime.
#
# Only written on first install; on re-runs the edited file is preserved and
# the new template lands next to it as radio.liq.new for manual diffing.
write_radio_liq() {
  cat > "$1" << 'LIQ_EOF'
set("log.file", "/opt/radioclyde/data/logs/liquidsoap.log")
set("log.level", 3)
settings.server.telnet.set(true)
settings.server.telnet.bind_addr.set("127.0.0.1")
settings.server.telnet.port.set(1234)

# Scheduled programming: the scheduler's now_playing.m3u (one produced show,
# played in order, never looped -- when it empties, fallback() drops to filler
# and the scheduler loads the next occurrence by rewriting the same file,
# which reload_mode="watch" picks up at the next track boundary).
show_source = playlist(id="show_source", reload_mode="watch", mode="normal", loop=false, "/opt/radioclyde/data/now_playing.m3u")

# Off-air filler: the scheduler's filler.m3u (shuffled pool, regenerated
# periodically with a rotation ledger so the same songs don't come back every
# cycle -- see src/scheduler/fillerRotation.js).
filler_source = playlist(id="filler_source", reload_mode="watch", mode="randomize", "/opt/radioclyde/data/filler.m3u")

# Fire src/plex/scrobbleTrack.js as a detached process per aired segment:
# now-playing metadata, show-occurrence handoff confirmation, and the filler
# rotation ledger (no hourly repetition) all depend on this hook. Same proven
# pattern as the repo's reference liquidsoap/radio.liq: on_metadata (not
# on_track -- insensitive to track-mark handling), thread.run so the handler
# stays fast, trailing "&" so the shell forks and returns immediately.
# "filename" (not "initial_uri") is deliberate: annotate:-wrapped playlist
# entries resolve initial_uri to "annotate:...:/path", silently breaking the
# ratingKey lookup; "filename" is the real decoded path either way.
def scrobble_on_metadata(m) =
  p = m["filename"]
  dj = m["dj"]
  if p != "" then
    thread.run(fast=false, fun () ->
      ignore(process.run("node /opt/radioclyde/app/src/plex/scrobbleTrack.js " ^ process.quote(p) ^ " " ^ process.quote(dj) ^
        " > /dev/null 2>&1 &"))
    )
  end
end
show_source = source.on_metadata(show_source, scrobble_on_metadata)
filler_source = source.on_metadata(filler_source, scrobble_on_metadata)

# Scheduled programming wins; filler covers gaps instead of going silent
# (silence disconnects Icecast clients). mksafe: never emit an unplayable
# source to Icecast (mid-regeneration emptiness, missing files...).
radio = mksafe(fallback(track_sensitive=false, [show_source, filler_source]))

output.icecast(
  %mp3(bitrate=128),
  host="127.0.0.1",
  port=8000,
  password="CHANGE_ME_SOURCE_PASSWORD",
  mount="/stream.mp3",
  name="Radio Markec",
  description="Slovenian AI DJ Radio",
  url="https://your-domain.com",
  genre="Various",
  radio
)
LIQ_EOF
}
if [ -f "$LIQ_CONF" ]; then
  write_radio_liq "$LIQ_CONF.new"
  log "radio.liq already exists -- new template written to $LIQ_CONF.new (diff it manually; the old filler-only config never aired scheduled shows)."
else
  write_radio_liq "$LIQ_CONF"
  log "radio.liq written (show_source + filler fallback)."
fi
chown "$RADIO_USER:$RADIO_USER" "$RADIO_HOME"/config/radio.liq*

log "Configuring Nginx..."
NGINX_SITE="/etc/nginx/sites-available/radioclyde"
# Only on first install: certbot --nginx (step 9 below, guide Korak 5) edits
# this exact file to add the 443/ssl server block, so an unconditional
# overwrite on a re-run would silently revert the site to port-80-only and
# kill HTTPS (audit 13-b). On re-runs the certbot-edited file is preserved
# and the new template lands next to it as radioclyde.new for manual
# diffing -- the same guard radio.liq uses above.
write_nginx_site() {
  cat > "$1" << 'NGINX_EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /stream {
        proxy_pass http://127.0.0.1:8000/stream.mp3;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Access-Control-Allow-Origin "*";
    }

    location /status {
        proxy_pass http://127.0.0.1:8000/status.xsl;
        proxy_http_version 1.1;
    }
}
NGINX_EOF
}
if [ -f "$NGINX_SITE" ]; then
  write_nginx_site "$NGINX_SITE.new"
  log "preserved your existing $NGINX_SITE (new default written to $NGINX_SITE.new -- diff them if you want the update; certbot's HTTPS edits live in the kept file)."
else
  write_nginx_site "$NGINX_SITE"
fi
ln -sf /etc/nginx/sites-available/radioclyde /etc/nginx/sites-enabled/radioclyde
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

log "Creating systemd services..."
write_radioclyde_unit() {
  cat > "$1" << 'SVC_EOF'
[Unit]
Description=Radio Markec - Web Server + Scheduler
After=network.target icecast2.service
Wants=icecast2.service

[Service]
Type=simple
User=radioclyde
Group=radioclyde
WorkingDirectory=/opt/radioclyde/app
ExecStart=/usr/bin/node src/server/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
# NOTE: there is deliberately no DATA_DIR env var here -- src/config/index.js
# reads config.json (repo root) and takes dataDir from there, never from the
# environment. Edit /opt/radioclyde/app/config.json to change paths.

[Install]
WantedBy=multi-user.target
SVC_EOF
}

write_liquidsoap_unit() {
  cat > "$1" << 'SVC_EOF'
[Unit]
Description=Liquidsoap - Radio Markec Playout
After=network.target icecast2.service
Wants=icecast2.service

[Service]
Type=simple
User=radioclyde
Group=radioclyde
ExecStart=/usr/bin/liquidsoap /opt/radioclyde/config/radio.liq
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVC_EOF
}

# Same first-install-only guard as radio.liq and the nginx site above: a
# re-run must not clobber a unit the operator edited (or that systemd is
# currently running); the fresh template lands next to it as <name>.new for
# manual diffing.
RCLYDE_UNIT="/etc/systemd/system/radioclyde.service"
LIQ_UNIT="/etc/systemd/system/liquidsoap-radioclyde.service"
if [ -f "$RCLYDE_UNIT" ]; then
  write_radioclyde_unit "$RCLYDE_UNIT.new"
  log "preserved your existing $RCLYDE_UNIT (new default written to $RCLYDE_UNIT.new -- diff them if you want the update)."
else
  write_radioclyde_unit "$RCLYDE_UNIT"
fi
if [ -f "$LIQ_UNIT" ]; then
  write_liquidsoap_unit "$LIQ_UNIT.new"
  log "preserved your existing $LIQ_UNIT (new default written to $LIQ_UNIT.new -- diff them if you want the update)."
else
  write_liquidsoap_unit "$LIQ_UNIT"
fi

systemctl daemon-reload
systemctl enable icecast2.service
systemctl enable nginx.service
systemctl enable radioclyde.service
systemctl enable liquidsoap-radioclyde.service

log "Configuring firewall..."
if command -v ufw &>/dev/null; then
  ufw --force enable
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  log "Firewall: only 22, 80, 443 exposed."
else
  # Loud, not silent: Node binds 0.0.0.0:3000 (src/server/index.js), so the
  # firewall is the ONLY thing keeping port 3000 off the public interfaces.
  warn "POZOR: ufw ni nameščen -- Node posluša na 0.0.0.0:3000 (avtentikacija s Basic auth, a port je odprt na vseh vmesnikih)."
fi

chown -R "$RADIO_USER:$RADIO_USER" "$RADIO_HOME"
chmod 750 "$RADIO_HOME"

echo ""
echo "============================================="
echo "  Radio Markec Installation Complete!"
echo "============================================="
echo ""
echo "Next steps:"
echo "  1. Upload app code: scp code.tar.gz ubuntu@SERVER:/tmp/"
echo "  2. Extract: sudo tar -xzf /tmp/code.tar.gz -C /opt/radioclyde/app"
echo "  3. Re-run this installer so app dependencies get installed: sudo bash install.sh (safe to re-run; your icecast.xml, radio.liq, nginx site and systemd unit edits are kept -- new templates land as *.new next to them)"
echo "  4. Upload data: scp data.tar.gz ubuntu@SERVER:/tmp/ && sudo tar -xzf /tmp/data.tar.gz -C /opt/radioclyde/"
echo "  5. Copy config: sudo cp /opt/radioclyde/app/deploy/ubuntu/config.linux.json /opt/radioclyde/app/config.json"
echo "  6. Put music in /opt/radioclyde/music/, then generate the filler playlist once: cd /opt/radioclyde/app && sudo -u radioclyde npm run generate-filler-playlist"
echo "  7. Edit passwords: sudo nano /etc/icecast2/icecast.xml AND sudo nano /opt/radioclyde/config/radio.liq (both must use the same source password)"
echo "  8. Start: sudo systemctl start icecast2 radioclyde liquidsoap-radioclyde nginx"
echo "  9. For HTTPS: sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d yourdomain.com"
echo ""
echo "Smoke test after start (see deploy/ubuntu/DEPLOYMENT_GUIDE.md):"
echo "  sudo systemctl status liquidsoap-radioclyde --no-pager | head -20"
echo "  journalctl -u liquidsoap-radioclyde | grep -i 'show_source\|filler_source\|error' | tail -20"
echo ""
echo "Stream: http://YOUR_SERVER_IP/stream"
echo "Web:    http://YOUR_SERVER_IP/"
echo "Logs:   journalctl -u radioclyde -f"
echo ""
