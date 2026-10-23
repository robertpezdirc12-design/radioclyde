# P1: izkušnja poslušalca — playlist datoteke, PWA, vrh poslušalcev, čipsi, embed

*Datum: 2026-10-24 · implementacija po `subwave-deep-analysis.md` (razdelek 7) in `ready-made-scripts-analysis.md` · main `763e9a3`*

Ta paket pokriva vseh pet P1 točk iz SUB/WAVE analize: `.m3u`/`.pls` za strojno opremo, MediaSession + PWA, vršni števec poslušalcev, priporočilne čipse in vgradi predvajalnik. Vse je deterministično, brez novih odvisnosti in brez AI. Vsaka številka ima iskreno pravilo o tem, kdaj se sploh pokaže.

---

## 1. `/listen.m3u` in `/listen.pls` — Sonos, VLC, avto, stari radio

Dve statični enovrstični playlisti (`src/server/listenFiles.js`): m3u z `#EXTM3U` + `#EXTINF:-1,<ime postaje>` in PLS v2 (`[playlist]`, `NumberOfEntries=1`, `Length1=-1`). Ime postaje pride iz `station.json` (padanje na »Radio Clyde«, če ga ni).

**Kateri URL je v datoteki?** Pravilo enakosti z ostalimi površinami: če je nastavljen `broadcast.publicStreamUrl` (isti ključ, ki ga že uporablja TuneIn/Discord push), gre ta — sicer pa se URL sestavi iz `icecast.publicHost` + `web.port` + `icecast.mount`, točno enako kot `station.streamUrl` v `/api/now-playing`. Tako zadaj tunel/prepesničevalnik ni treba ugibati.

**Varnost:** rute so za Basic Auth vrati kot vse ostalo — datoteko dobi samo nekdo, ki lahko doseže `/stream`. Ko postaja kasneje odpre posamezne poti (`web.publicPaths`, spodaj), playlista takoj deluje tudi za anonimne predvajalnike, brez spremembe kode.

## 2. MediaSession + manifest + service worker (PWA)

- `public/manifest.webmanifest`: ime, `lang: sl`, `display: standalone`, temna barva `#0a0c12` (ista kot `--bg` v `style.css`), ikoni `logo.png` + `favicon.svg`.
- `public/sw.js`: predpomni SAMo lupino aplikacije (stran, app.js, style.css, logo, favicon, manifest) v stale-while-revalidate strategiji — stran se odpre takoj in se v ozadju sama obnovi. **Tok (`/stream`), vsi `/api/*` in `/studio` se NIKOLI ne predpomnijo** — živi podatki imajo lastna eksplicitna odjemalska stanja, nekonecna zvočna povezava ni arhiv.
- MediaSession v `public/app.js`: naslov, izvajalec, album in naslovnica sledijo `/api/now-playing` (tudi govorjeni segment: ime oddaje + »DJ govori«). Nadzorne akcije: **samo play/pause/stop**. Naslednja/prejšnja/iskanje so namenoma NE povezani — dvojni tap na slušalkah ne sme zamenjati skladbe za celo sobo, ker je tok en in skupen (ista radijska semantika, ki jo SUB/WAVE izrecno dokumentira kot omejitev API-ja).

## 3. Vršni števec poslušalcev (peak)

Nova čista funkcija `peakListeners(samples, {from, to})` v `analytics/listenerImpact.js`: najvišji ne-prazen vzorec znotraj okna. Iskrena pravila (enaka kot povsod v analitiki): prazni vzorci (Icecast ni odgovoril) se prezrejo, NE štejejo kot 0; okno brez veljavnih vzorcev vrne `null` — in UI `null` skrije, namesto da bi si izmislil ničlo.

- **Javno:** `/api/listeners` vrne `{ listeners, peak }`, kjer je `peak` vrh zadnjih 24 h iz obstoječega JSONL knjižnika vzorčenja (brez nove infrastrukture). Čip v zgornji vrstici pokaže »3 poslušalci · vrh 24 h: 7 poslušalcev«; če je vrh enak trenutnemu številu, se ne ponavlja. To je **zgodovina, ne živi prob** — ko je Icecast trenutno mrtev, `listeners` pade na `null`, `peak` pa ostane, ker je bil res izmerjen (smoke dokaz: `{"listeners":null,"peak":7}`).
- **Studio:** `/studio/api/analytics` vrne `peak` (okno grafa) in `peakAllTime` (celoten knjižnik, omejen z zadrževanjem `analytics.maxEntries` ≈ 30 dni). Pogled Analytics prikazuje obe vrednosti z eksplicitnim »no valid sample in window«, kadar jih ni.

Omejitev, zapisana namesto skrita: vzorčenje enkrat na minuto ne vidi kratkih blipov med vzorci — vrh je »najvišja izmerjena minuto«, ne »absolutna sekunda«.

## 4. Priporočilni čipsi v zahtevkih (deterministični)

Nad obrazcem za zahtevek (`#req-chips`) se iz podatkov, ki jih stran **že** polla (brez novih klicev), sestavijo čipsi:

1. **Posvetilo: <naslov>** (samo ko igra skladba) — nastavi vrsto na posvetilo in izpolni naslov + izvajalca,
2. **Še kaj od <izvajalec>** — nastavi vrsto na zahtevo in izpolni izvajalca,
3. do trije **nedavni izvajalci** iz zgodovine (unikatni, najnovejši naprej).

Nič naključnega, nič z LLM, nič brez podlage: čip obstaja samo, če obstaja podatek, iz katerega je sestavljen, in vsak klik samo izpolni polja obrazca (ostane odprt za urejanje). To je osnovna, 100 % deterministična različica SUB/WAVE-jevih čipov — v prihodnje se lahko razširi s knjižničnimi poizvedbami (desetletja, žanri), ko bo javna knjižnična končna točka sploh obstajala.

## 5. Vgradi (embed) predvajalnik in odločitev o javnem toku

Problem: `<iframe>` ne more prenesti Basic Auth poverznic lastnika na obiskovalca — zato vgradi predvajalnik na popolnoma zaščiteni postaji ni možen, ne glede na kodo.

Rešitev je **ena nastavitvena vzvratna ročica**: `web.publicPaths` (privzeto `[]` — postaja ostane povsem zasebna in se obnaša točno kot prej). Seznam predpon poti, ki se izjemo iz Basic Auth:

```json
"web": { "publicPaths": ["/embed.html", "/embed", "/stream", "/api/now-playing", "/listen.m3u", "/listen.pls"] }
```

- Predpono-matching je strog: `/embed` pokrije `/embed/...` in točno `/embed`, NE pa `/embed.html` ali `/embedX` (regresijsko testirano).
- `public/embed.html` je samozadosten mini predvajalnik (logo, ZDAJ igra iz `/api/now-playing`, play/pause, `/stream`) z lastnim vgrajenim CSS/JS — ne lovi ničesar drugega, ne kliče studio površin.
- **Priporočena kombinacija za javni vgradi:** `/embed.html` + `/api/now-playing` + `/stream`. `/listen.*` po želji (radijske appliance jih rade pulled). `/studio`, `/api/requests` (POST) in vse druge pisne API-je **nikoli** ne sodijo na ta seznam.

## Testi in dokazi

- `test/listenFiles.test.mjs`: vsebina in content-type obeh playlist, pravila `peakListeners` (praznine ≠ 0, okna, strgani časi → `null`), manifest/SW/embed kot static route, `/api/listeners` vrh iz knjižnika tudi ob mrtvem Icecastu, brez knjižnika → `peak: null`.
- `test/listenFilesPublic.test.mjs`: `publicStreamUrl` prednost, javne poti brez poverznic, strog predpono-matching, 401 z `WWW-Authenticate` za nedovoljene poti (prek simuliranega zunanje IP-ja — loopback je po zasnovi vedno zaupan, `lib/ipRange.js`).
- `scripts/smoke_p1.sh`: živi dokaz nad pravim strežnikom (zgoraj opisani rezultati).
- Suita po spremembi: **89/89 PASS** (prej 72), brez novih odvisnosti.
