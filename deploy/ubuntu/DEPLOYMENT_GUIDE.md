# Radio Clyde — Ubuntu Server 24.04 Deployment Guide

## Pregled

Namestitev Radio Clyde na brezplačnem Linuxovem strežniku (Ubuntu Server 24.04 ARM64). Radio oddaja 24/7 z naravnim slovenskim glasom (Piper TTS, pred-generirani posnetki), glasbo in vremenskimi napovedmi.

## Arhitektura

```
Internet → Nginx (80/443) → ┌─ /stream → Icecast2 (127.0.0.1:8000) ← Liquidsoap
                             └─ /     → Node.js (127.0.0.1:3000) [web + scheduler]
```

- **Nginx**: javni reverse proxy (port 80/443), SSL prek Let's Encrypt
- **Node.js**: web API + scheduler v enem procesu (port 3000, samo localhost)
- **Icecast2**: zvočni tok (port 8000, samo localhost)
- **Liquidsoap**: playout (glasba + govor)
- **Piper TTS**: slovenski govor (pred-generirani posnetki, brez izvajanja med oddajanjem)

## Komponente

| Komponenta | Namen | Port | Javno? |
|------------|-------|------|--------|
| Nginx | Reverse proxy, SSL | 80, 443 | ✅ |
| Node.js (web+scheduler) | API, admin, urnik | 3000 | ❌ (samo localhost) |
| Icecast2 | Zvočni tok | 8000 | ❌ (samo localhost) |
| Liquidsoap | Playout | — | ❌ |
| Piper TTS | Slovenski govor | — | ❌ |

## Varnostna pravila

- Icecast2 veže se samo na `127.0.0.1:8000`
- Node.js veže se samo na `127.0.0.1:3000`
- Javni dostop samo prek Nginx (port 80/443)
- Gesla v `/etc/icecast2/icecast.xml` (chmod 640)
- `.env` in `config.json` niso v Gitu
- Admin vmesnik Icecasta ni javno dostopen

## Korak 1: Ustvari strežnik v oblaku

### Oracle Cloud (priporočeno — brezplačno, ARM64)
1. https://cloud.oracle.com → Compute → Instances → Create Instance
2. Image: **Ubuntu 24.04 (aarch64)**
3. Shape: **VM.Standard.A1.Flex** (2 OCPU, 12 GB RAM — brezplačno)
4. Networking: VCN z javnim IP-jem
5. SSH key: naloži svoj javni ključ
6. Create

**Opomba**: Oracle Cloud zahteva kreditno kartico za preverjanje identitete, vendar ne zaračunava za brezplačni tier (Always Free). Omejitve: 4 OCPU in 24 GB RAM skupaj, priporočamo 2 OCPU in 12 GB RAM za Radio Clyde.

### Alternative
- Google Cloud: e2-micro (1 vCPU, 1 GB) — brezplačno 12 mesecev
- AWS: t2.micro (1 vCPU, 1 GB) — brezplačno 12 mesecev

## Korak 2: Poveži se na strežnik

```bash
ssh -i ~/.ssh/your_key ubuntu@YOUR_SERVER_IP
```

## Korak 3: Namesti Radio Clyde

### 3.1 Namestitveni skript
```bash
scp deploy/ubuntu/install.sh ubuntu@YOUR_SERVER_IP:/tmp/
ssh ubuntu@YOUR_SERVER_IP "sudo bash /tmp/install.sh"
```

### 3.2 Naloži aplikacijsko kodo
```bash
cd C:\Users\admin\Documents\radioclyde
tar --exclude='music' --exclude='voices' --exclude='data' --exclude='node_modules' \
  -czf radioclyde-code.tar.gz .
scp radioclyde-code.tar.gz ubuntu@YOUR_SERVER_IP:/tmp/
sudo mkdir -p /opt/radioclyde/app
sudo tar -xzf /tmp/radioclyde-code.tar.gz -C /opt/radioclyde/app
sudo chown -R radioclyde:radioclyde /opt/radioclyde/app
```

### 3.3 Naloži velike datoteke (ločeno)
```bash
tar -czf radioclyde-data.tar.gz music/ voices/ data/pre-generated/
scp radioclyde-data.tar.gz ubuntu@YOUR_SERVER_IP:/tmp/
cd /opt/radioclyde
sudo tar -xzf /tmp/radioclyde-data.tar.gz
sudo chown -R radioclyde:radioclyde /opt/radioclyde/music /opt/radioclyde/voices /opt/radioclyde/data
```

### 3.4 Nastavi konfiguracijo
```bash
sudo cp /opt/radioclyde/app/deploy/ubuntu/config.linux.json /opt/radioclyde/app/config.json
sudo nano /etc/icecast2/icecast.xml
sudo nano /opt/radioclyde/config/radio.liq
sudo cp /opt/radioclyde/.env.template /opt/radioclyde/.env
```

### 3.5 Namesti npm odvisnosti (že narejeno v install.sh)
```bash
cd /opt/radioclyde/app
sudo -u radioclyde npm ci --production
```

## Korak 4: Zaženi storitve

```bash
sudo systemctl start icecast2 radioclyde liquidsoap-radioclyde nginx
sudo systemctl status icecast2 radioclyde liquidsoap-radioclyde nginx
```

**Opomba**: Samo ENA storitev za web+scheduler (`radioclyde.service`), ker `src/server/index.js` že kliče `startScheduler()`. Ločena storitev `radioclyde-web.service` NE obstaja več.

## Korak 5: HTTPS (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

## Korak 6: Javni Icecast tok

### Priporočeno: Nginx reverse proxy (brezplačno)
Nginx že posreduje `/stream` na Icecast. Poslušalci dostopajo prek:
- `http://YOUR_SERVER_IP/stream`
- `https://yourdomain.com/stream` (z Let's Encrypt)

**Prednosti**: popoln nadzor, brez omejitev pasovne širine, brezplačno.

### Cloudflare Tunnel (samo za web vmesnik, opcijsko)
Cloudflare Tunnel je primeren za web vmesnik (HTML, API), vendar **ni priporočen** za neprekinjeno zvočno oddajanje (predpomnjenje, latence). Uporabite Nginx za zvočni tok.

## Korak 7: Preverjanje

### Test 1: Glasba
```bash
find /opt/radioclyde/music -type f \( -name "*.mp3" -o -name "*.ogg" -o -name "*.flac" \) | wc -l
# Pričakovano: 55
```

### Test 2: Slovenski govor (pred-generirani posnetki)
```bash
ls /opt/radioclyde/data/pre-generated/*.wav | wc -l
# Pričakovano: 119
ffprobe -v error -show_streams /opt/radioclyde/data/pre-generated/general_open.wav | grep codec_name
# Pričakovano: codec_name=pcm_s16le
```

### Test 3: Izbira glasbe (suhi preizkus)
```bash
cd /opt/radioclyde/app
sudo -u radioclyde npm run preview-auto-show -- test-all-music --offline
```

### Test 4: Dejanski govor (pregenerated mode)
```bash
sudo -u radioclyde node src/cli/directShow.js --id=test-all-music
# Preveri: 17 segmentov, 0ms TTS čas
```

### Test 5: Stream dosegljivost
```bash
curl -s http://localhost:8000/status.xsl | grep -q "stream.mp3" && echo "Icecast OK" || echo "Icecast FAIL"
curl -s http://localhost/stream -o /tmp/test-stream.mp3 -w "%{http_code}" --max-time 5
ls -la /tmp/test-stream.mp3
```

### Test 6: Ponovni zagon storitev
```bash
sudo systemctl restart radioclyde
sleep 5
sudo systemctl is-active radioclyde && echo "Restart OK" || echo "Restart FAIL"
```

### Test 7: Ponovni zagon strežnika
```bash
sudo reboot
# Po ponovnem zagonu:
sudo systemctl status radioclyde icecast2 liquidsoap-radioclyde nginx
```

## Monitoring

```bash
sudo journalctl -u radioclyde -f
sudo journalctl -u liquidsoap-radioclyde -f
sudo tail -f /var/log/icecast2/error.log
sudo tail -f /var/log/nginx/access.log
```

## .gitignore

```
config.json
.env
music/
voices/
data/
pre-generated/
node_modules/
```

## Povzetek stroškov

| Storitev | Cena |
|----------|------|
| Oracle Cloud (2 OCPU, 12 GB RAM) | **Brezplačno** |
| Nginx + Let's Encrypt | **Brezplačno** |
| Piper TTS (lokalno) | **Brezplačno** |
| Domena (opcijsko) | ~$10/leto |

**Skupaj: 0 €/mesec**
