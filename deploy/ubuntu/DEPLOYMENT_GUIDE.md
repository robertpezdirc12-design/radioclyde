# Radio Markec — Ubuntu Server 24.04 Deployment Guide

## Pregled

Namestitev Radio Markec na brezplačnem Linuxovem strežniku (Ubuntu Server 24.04 ARM64). Radio oddaja 24/7 z naravnim slovenskim glasom (Piper TTS, pred-generirani posnetki), glasbo in vremenskimi napovedmi.

## Arhitektura

```
Internet → Nginx (80/443) → ┌─ /stream → Icecast2 (127.0.0.1:8000) ← Liquidsoap
                             └─ /     → Node.js (0.0.0.0:3000, javno ščiti ufw) [web + scheduler]
```

- **Nginx**: javni reverse proxy (port 80/443), SSL prek Let's Encrypt
- **Node.js**: web API + scheduler v enem procesu (port 3000; veže na `0.0.0.0` — javnega dostopa ne zavaruje vezava, ampak požarni zid/ufw)
- **Icecast2**: zvočni tok (port 8000, samo localhost)
- **Liquidsoap**: playout (glasba + govor)
- **Piper TTS**: slovenski govor (pred-generirani posnetki, brez izvajanja med oddajanjem) prek piper1-gpl runtime-a (`pip install piper-tts`; glas `sl_SI-artur-medium` se prenese med namestitvijo — `install.sh`, ~63 MB, enkrat)

## Komponente

| Komponenta | Namen | Port | Javno? |
|------------|-------|------|--------|
| Nginx | Reverse proxy, SSL | 80, 443 | ✅ |
| Node.js (web+scheduler) | API, admin, urnik | 3000 | ❌ (veže 0.0.0.0; ufw blokira) |
| Icecast2 | Zvočni tok | 8000 | ❌ (samo localhost) |
| Liquidsoap | Playout | — | ❌ |
| Piper TTS | Slovenski govor | — | ❌ |

## Varnostna pravila

- Icecast2 veže se samo na `127.0.0.1:8000`
- Node.js se veže na `0.0.0.0:3000` (vse vmesnike) — port 3000 pred javnim dostopom ščiti izključno požarni zid: `install.sh` prek ufw odpre samo 22/80/443, a le, če je ufw nameščen (sicer glasno opozori; brez ufw je port 3000 javno odprt, vsebino pa ščiti Basic auth)
- Javni dostop samo prek Nginx (port 80/443)
- Gesla v `/etc/icecast2/icecast.xml` (chmod 640)
- `config.json` ni v Gitu
- Admin vmesnik Icecasta ni javno dostopen

## Korak 1: Ustvari strežnik v oblaku

### Oracle Cloud (priporočeno — brezplačno, ARM64)
1. https://cloud.oracle.com → Compute → Instances → Create Instance
2. Image: **Ubuntu 24.04 (aarch64)**
3. Shape: **VM.Standard.A1.Flex** (2 OCPU, 12 GB RAM — brezplačno)
4. Networking: VCN z javnim IP-jem
5. SSH key: naloži svoj javni ključ
6. Create

**Opomba**: Oracle Cloud zahteva kreditno kartico za preverjanje identitete, vendar ne zaračunava za brezplačni tier (Always Free). Omejitve: 4 OCPU in 24 GB RAM skupaj, priporočamo 2 OCPU in 12 GB RAM za Radio Markec.

### Alternative
- Google Cloud: e2-micro (1 vCPU, 1 GB) — brezplačno 12 mesecev
- AWS: t2.micro (1 vCPU, 1 GB) — brezplačno 12 mesecev

## Korak 2: Poveži se na strežnik

```bash
ssh -i ~/.ssh/your_key ubuntu@YOUR_SERVER_IP
```

## Korak 3: Namesti Radio Markec

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
sudo nano /opt/radioclyde/app/config.json
sudo nano /etc/icecast2/icecast.xml
sudo nano /opt/radioclyde/config/radio.liq
```

**Opozorilo — pred prvim zagonom dodajte gesla:** izposojeni `config.linux.json` namerno ne vsebuje blokov `web.listeners` (gesla za dostop poslušalcev do web UI/API) in `studio.users` (gesla za dostop do studia). Po kopiranju v `/opt/radioclyde/app/config.json` dodajte oba bloka ročno — obliko glejte v `config.example.json`. Brez njih web UI in studio po prijavnem oknu nista dosegljiva (401 — ni enega veljavnega uporabnika), medtem ko nginx `/stream` že oddaja javno. Basic auth geslo potuje v vsaki zahtevi (Base64, ne zgoščeno), zato izberite močno geslo.

**Opozorilo — javni naslov toka (nastavite dve stvari v `config.json`):** privzeta izpeljava javnega URL-ja toka je `http://<icecast.publicHost>:<web.port><mount>` — v nginx obliki je to pokvarjeno (port 3000 ni javen, javna pot pa je `/stream`, ne `/stream.mp3`). Zato v `/opt/radioclyde/app/config.json` nastavite:
- `icecast.publicHost`: `"yourdomain.com"` — gostitelj, iz katerega se URL izpelje (nadomesti `CHANGE_ME_PUBLIC_HOST_OR_IP`), in
- `broadcast.publicStreamUrl`: `"https://yourdomain.com/stream"` — ta nastavitev ima prednost pred izpeljavo in je pravi javni URL toka za `/listen.m3u`, `/listen.pls` in push povezave.

**Omejitev — želje poslušalcev ne gredo v eter na tej predlogi:** `radio.liq`, ki ga zapiše `install.sh`, nima vira `request.queue`, zato odobrena želja ostane odobrena, a ne zaigra (gumb »V vrsto« v studiu poroča, da Liquidsoap ni sprejel zahtevka). Predvajanje želj podpira referenčni `liquidsoap/radio.liq` iz repozitorija — vir `request.queue(id="requests")` in `fallback(track_sensitive=true, [requests_source, radio])` (~vrstice 243–269); če želite želje na etru, preberite ta blok in ga prenesite v `/opt/radioclyde/config/radio.liq` (Nodeova stran pričakuje ravno id `requests`, glej `src/liquidsoap/requestQueue.js`).

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

## Varnostne kopije in obnova

Razporejevalnik enkrat na `backup.intervalMinutes` (privzeto 1440 = dnevno) zapiše **vse stanje postaje, ki ga ni mogoče rekonstruirati** v `backup.dir` — vsak dan svoj datumski imenik (`/opt/radioclyde/backups/2026-10-25/`), tako da se slaba sprememba ali izguba podatkov da povrniti do kateregakoli dneva znotraj retencije. Naloga: `src/scheduler/backupStation.js`; ročni zagon: `cd /opt/radioclyde/app && sudo -u radioclyde npm run backup`.

### Kaj dnevna kopija pokriva

| vir | zakaj je v kopiji |
|---|---|
| `station.json`, `show-descriptions/`, `prompts.json` | ročno avtorstvo (urnik, osebnost, briefi) — edini izvod; datumski prenosi (`schedule.dates`) in replay vnosi živijo v isti datoteki, zato jih dnevna kopija pokriva brez dodatnega dela |
| `requests.jsonl`, `polls.json` | poslušalčevi podatki (želje, posvetila, ankete) — nastanejo sami od poslušalcev, iz etra se ne da rekonstruirati |
| `push/` (vapid.json, subscriptions.json, sent.jsonl) | poverilnice obvestil: izguba `vapid.json` razveljavi VSE obstoječe naročnine brskalnikov |
| `history/*.jsonl` (played, aired, listener-samples, filler-rotation, deadair) | dokaz o etru: analitika, »najbolj poslušano«, rotacija fillerja, epizode mrtvega etra |
| `show-logos/`, `imaging/id/`, `imaging/stingers/`, `imaging/emergency/` | operaterski medij: logotipi oddaj in produkirani posnetki nimajo drugega izvoda |
| `track_ratingkeys.json`, `autocue_index.json` | dragi izpeljani predpomnilniki: obnovljiva, a po ponovnem skenu traja ure/dneve |
| `config.json` (iz korena repozitorija) | edini izvod poverilnic postaje (studio, icecast, plex, lastfm); kopija v arhivu dobi mode `0600` |

### Kaj je zavestno izven

Tranzientno in izpeljano stanje se NE kopira, ker ga tikovi sami znova zapišejo: `.station_hash`, `now_playing*`, `filler.m3u`, `imaging/*.m3u`, `running/`, `cache/`, `logs/`, `archive/`, `podcasts/`, `piper/`, `asrun/`, `lyrics-cache.json`, `lastfm-session.json`.

Odgovornost OPERATERJA (po namenu izven te naloge):

- **glasba** (`/opt/radioclyde/music`) in **jingli/glasovi izven dataDir** (`/opt/radioclyde/voices`) — velike zbirke z lastnim virom (Plex, izvorni disk); niso postajina tvorba;
- `data/voice-clips/` in `data/pre-generated/` — TTS posnetki, ki ste jih prinesli z namestitvenim tarbalom (korak 3.3); obnova = ponovni prenos istega tarbala, regeneracija iz pisal je mogoča, a počasna;
- `data/piper/` — govor model (~63 MB), obnovljiv z enkratnim prenosom ob namestitvi;
- `data/podcasts/` — izdelki podcasta, regenerirajo se iz zgodovine + knjižnice (`npm run podcast-gen`).

### Obnova po vrstah

- **Skladi poslušalcev** (`requests.jsonl`, `polls.json`): kopiraj nazaj na svoje mesto v dataDir. Bralci odpovejo odprto (manjkajoča ali pokvarjena datoteka = prazno stanje, ne sesutje) in berejo sveže ob vsakem klicu — restart ni potreben.
- **Push**: kopiraj celo mapo `push/` nazaj; `vapid.json` mora obdržati mode `0600` in lastništvo uporabnika `radioclyde`. Če je bil `vapid.json` izgubljen, se bodo vsi brskalniki morali znova prijaviti na obvestila (stare naročnine razveljavi brskalnik sam, ko podpis ne ujema).
- **Dragi predpomnilniki** (`track_ratingkeys.json`, `autocue_index.json`): kopiraj nazaj; uporabita se ob naslednjem branju/skenu, brez restarta.
- **Zgodovina** (`history/*.jsonl`): kopiraj nazaj. JSONL zapis je odporen na prekinitve: če je zadnja vrstica raztrgana, je izguba ene vrstice, ne korupcija — bralci raztrgane vrstice preskočijo.
- **config.json**: kopiraj na koren repozitorija (`/opt/radioclyde/app/config.json`), popravi lastništvo (`sudo chown radioclyde:radioclyde /opt/radioclyde/app/config.json`) in **restartaj postajo** (`sudo systemctl restart radioclyde`) — konfiguracija je namreč zamrznjena ob zagonu procesa, žive spremembe ne prebere.
- **`.station_hash`**: ga ni v kopiji in ne rabi biti — prvi tik `checkScheduleChanged` po obnovi le zapiše novo osnovo in ničesar ne invalidira (`src/scheduler/scheduleWatch.js:158-165`).

### Varnost kopije

Arhiv vsebuje **PLAINTEXT gesla** (studio, icecast, plex, lastfm) **in VAPID zasebni ključ**:

- imenik `backup.dir` naj bo v lasti `radioclyde` in mode `700`: `sudo chown -R radioclyde:radioclyde /opt/radioclyde/backups && sudo chmod 700 /opt/radioclyde/backups`;
- kopija `config.json` v arhivu je zapisana z mode `0600` (poskrbi naloga sama) — to ščiti pred drugimi uporabniki na strežniku, ne pred odkodom;
- priporočilo: **off-box kopija**, npr. `rsync -a /opt/radioclyde/backups/ uporabnik@backup-streznik:/backup/radioclyde/` v cronu. `/opt/radioclyde/backups` na ISTEM disku kot `dataDir` varuje pred napako (slaba sprememba, brisanje), NE pred odpovedjo diska (nasvet tudi v `config.example.json`).

### Retencija

- `backup.retentionDays` (privzeto 30): datumski imeniki, starejši od toliko dni, se ob dnevni nalogi pobrišejo;
- `0` = večno (nič se ne briše);
- neveljavna vrednost (npr. `"trideset"`) se zavrne — vse kopije se obdržijo, v dnevnik pa se zapiše ena poštena vrstica, ker bi ugibanje pomenilo bodisi brisanje bodisi tiho ne-delovanje.

### Retencija dnevnika mrtvega etra

`history/deadair.jsonl` (dogodki mrtvega etra, ki jih zapisuje `radio.liq` ob vsakem prehodu tišine) ima od vala 18 lastno retencijo: naloga za čiščenje — isti tikt, ki poreže ostale glavne knjige — ohrani zadnjih **90 dni** dogodkov in pri tem nikoli ne poreže pod najnovejših **2000 vrstic** (zaščita pred napačno ali pretirano retencijo). Prag preklopite s `cleanup.deadairRetentionDays` v bloku `cleanup` (`config.linux.json`). Zgodovina, starejša od 90 dni, ostane dosegljiva v dnevni varnostni kopiji (glejte zgoraj).

## Arhitektura predvajanja (kaj prihaja v eter in kdaj)

`/opt/radioclyde/config/radio.liq` (ki ga namesti `install.sh`) mora imeti **dva vira**:

| vir | datoteka | način |
|---|---|---|
| `show_source` | `data/now_playing.m3u` | `mode="normal"`, `loop=false` — ena producirana oddaja; ko se izprazni, preide na filler |
| `filler_source` | `data/filler.m3u` | `mode="normal"` — glasba med oddajami v zapisanem vrstnem redu (nastavljeno kolo kvadrantov je tako slišno); razporejevalnik jo obnavlja in vsaka regeneracija vrstni red znova premeša |

`fallback([show_source, filler_source])` pomeni: **producirana oddaja gre v eter, takoj ko obstaja**; filler pokrije le vrzeli. Če vaš `radio.liq` ima *samo* `filler.m3u` (kot starejša različica `install.sh`), urnik nikoli ne pride v eter in poslušalci slišijo isto neskončno zankco — točno to je bil prijavljen problem ponavljanja.

### Icy identiteta toka (Paket B3)

Predloga iz `install.sh` v svojem `output.icecast` nosi `name="Radio Markec"`, `description="Slovenian AI DJ Radio"`, `genre="Various"` in uredniško nastavljiv `url="https://your-domain.com"` — to so STATIČNI metapodatki mounta, ki jih predvajalniki in imeniki (TuneIn idr.) pokažejo kot identiteto postaje. Enake tri vrednosti (brez `url=`) nosi tudi referenčni `liquidsoap/radio.liq` iz repozitorija; obe kopiji sta pripeti skupaj v `test/radioLiqIcy.test.mjs`, da ne razideta. Vrednosti so namerno literali v `radio.liq` (tipizirani `json.parse` ostaja nedotaknjen, starejši `config.json` torej še vedno zažene) — preuredite jih neposredno v `/opt/radioclyde/config/radio.liq`. Namig za namestitve pred valom 21: `install.sh` piše `radio.liq` le ob prvi namestitvi — obstoječi stroji te identitete še nimajo, dokler ne prepišejo svojega izhodnega bloka.

### Zakaj se pesmi ne ponavljajo več vsako uro

Trije vzroki so bili odpravljeni (revizija 2026-10-24):

1. `radio.liq` je predvajal samo filler — urnik sploh ni prihajal v eter (popravljeno: prava fallback arhitektura zgoraj).
2. `config.linux.json` brez blokov `schedule`/`filler`/`cleanup`/`backup` — razporejevalnik je crknil ob zagonu (`TypeError`), zato se filler ni nikoli obnavljal (popravljeno: config ima vse bloke; test `test/deployConfig.test.mjs` to zagotavlja).
3. Filler ni imel spomina na to, kaj je že predvajal — vsaka regeneracija je ponovno izbrala iste skladbe (popravljeno: ledvica rotacije `data/history/filler-rotation.jsonl`; `scrobbleTrack.js` zapiše vsak filler segment, `generateFillerPlaylist.js` izključi vse iz okna `filler.rotationWindowHours`, manjkajoče dopolni od najdlje ne-predvajanih).

### Diagnostika ponavljanja po nasadu

```bash
# Ali je razporejevalnik sploh živ (crknil config = zamrznjen urnik)?
sudo systemctl is-active radioclyde && sudo journalctl -u radioclyde -n 50 --no-pager | grep -i "scheduler started\|ERROR"

# Ali liquidsoap preklaplja med show in filler (preberi logs)?
sudo grep -E "show_source|filler_source" /opt/radioclyde/data/logs/liquidsoap.log | tail -20

# Ali ledvica rotacije raste (vsak filler segment doda vrstico)?
sudo wc -l /opt/radioclyde/data/history/filler-rotation.jsonl

# Ročno preveri rotacijo: dve regeneracji naj imata (pri knjižnici >= 2x poolSize) prekrivanje 0
cd /opt/radioclyde/app && sudo -u radioclyde npm run generate-filler-playlist
sudo cp /opt/radioclyde/data/filler.m3u /tmp/gen1.m3u
cd /opt/radioclyde/app && sudo -u radioclyde node src/plex/scrobbleTrack.js $(head -1 /tmp/gen1.m3u | sed 's/.*://') ""
cd /opt/radioclyde/app && sudo -u radioclyde npm run generate-filler-playlist
sudo diff <(sort /tmp/gen1.m3u) <(sort /opt/radioclyde/data/filler.m3u) | grep -c "^[<>]"
# Pričakovano pri dovolj veliki knjižnici: vsi zapisi se spremenijo
```

Znano omejitev: če je knjižnica manjša od `poolSize` (ali manjša od ene urne rotacije), se skladbe neizogibno vrnejo prek najstarejše rotacije — takrat dodajte glasbo ali povečajte knjižnico; arhitektura ne more rotirati, česar ni.

**Opus/FLAC mounti:** prižiganje `icecast.opus`/`icecast.flac` v `config.linux.json` na tej VPS namestitvi ne bo delovalo — predloga `radio.liq` iz `install.sh` nima `%include "streams.liq"`, nginxova lokacija `/stream` bi `/stream.opus` preusmerila na `/stream.mp3`, izpeljani URL-ji pa spet kažejo na `publicHost:3000`; za delujoče mounte glejte referenčni `liquidsoap/radio.liq` in `docs/stream-mounts.md`. Isto velja za promo plast (Paket B2): namestniška predloga `radio.liq` nima `promo_source`, zato prižiganje `imaging.promos.enabled` tu pomeni produkcijo klipev, ki nikoli ne gredo na eter — plast živi samo v referenčnem `liquidsoap/radio.liq` (glejte `docs/imaging-layer.md`, razdelek o promosih).

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
