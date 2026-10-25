# MCP strežnik (Model Context Protocol)

Standalone stdio proces, prek katerega lahko odjemalec z umetno inteligenco
(Claude Desktop, generični odjemalec MCP) **pregleduje in upravlja Radio
Markec** — enako, kot bi to delal operater prek spletnega vmesnika ali CLI.
Komunikacija poteka po JSON-RPC 2.0, eno sporočilo na vrstico: odjemalec
zapiše zahtevek na stdin, strežnik odgovori na stdout.

```bash
npm run mcp        # oz. neposredno: node src/mcp/server.js
```

Nič novih odvisnosti; strežnik uvaža obstoječe module postaje (store /
service plast) in nikoli Fastify registrirnih modulov, `src/server/index.js`
ali zanke urnika.

## Zakaj to ni »proti načelu brez AI«

Analiza `docs/subwave-deep-analysis.md` (razdelek »Ne povzemati«) je MCP
strežnik izvrgla z utemeljitvijo »proti ›brez AI‹ načelu«. Ta ugovor velja
za **AI-generated vsebino** (scenariji, glasovi, glasba) — ne za
kontrolno-pregledno površino za operaterja. Ta strežnik ne generira ničesar:
vsako orodje je bodisi čisto branje obstoječih datotek bodisi klic obstoječe
funkcije, ki jo že poganjajo HTTP poti (npr. `POST /studio/api/on-air/skip`).
Odločitev ostaja zapisana tukaj, ker je bila odkrita v pregledu.

## Orodja (29: 17 bralnih, 12 pisalnih)

| Orodje | B/P | Ena vrstica |
|---|---|---|
| `now_playing` | B | Kaj je v etru: oddaja, skladba, DJ, ocenjen konec. |
| `play_history` | B | Zadnje predvajane skladbe (najnovejše prve), stvarni scrobble dnevnik. |
| `upcoming_shows` | B | Naslednje oddaje po urniku. |
| `weekly_schedule` | B | Tedenska mreža; oznake »on air«/»next« so po PREDLOGI, ne po resničnem predvajanju. |
| `list_shows` | B | Vse oddaje v knjižnici (isti seznam kot `GET /api/shows`). |
| `show_detail` | B | En povzetek oddaje v celoti (isti pogled kot studio urejevalnik). |
| `requests_list` | B | Želje in posvetila poslušalcev s statusi — modalnostna vrsta. |
| `request_get` | B | Ena želja po ID-ju. |
| `polls_active` | B | Aktivna anketa s poštenim števcem (`null`, če ni odprte). |
| `polls_history` | B | Zgodovina zaprtih anket (zamrznjeni števci). |
| `listener_stats` | B | Živo število poslušalcev LE, če Icecast odgovori + vrh 24 h iz vzorčevalnega dnevnika. |
| `library_search` | B | Iskanje po knjižnici (izvajalec/naslov/album), 60 s predpomnilnik pregleda. |
| `track_metadata` | B | Metapodatki skladbe po `rating_key` ali `local_path`. |
| `imaging_inventory` | B | Inventura imaging posnetkov (ID-ji, stingerji, sili postelja); samo branje. |
| `voice_drops` | B | Stanje govornega podsistema + ojačenje DJ dropov. |
| `station_identity` | B | Ime postaje, vsi objavljeni URL-ji tokov, `listen.m3u`/`listen.pls`. |
| `component_health` | B | Sonda Icecast, stanje predvajalnih list, dead-air, ponovitve, repki dnevnikov. |
| `request_add` | P | Vnese željo/posvetilo v imenu lastnika (zapisano z izvornim »mcp«); brez omejitve poslušalcev na IP. |
| `request_moderate` | P | Odobri ali zavrne željo (+ opomba poslušalcu). |
| `request_queue` | P | Postavi ODOBRENO željo v Liquidsoapovo vrsto (dotakne se omrežja). |
| `poll_create` | P | Odpre novo anketo (s tem zapre prejšnjo). |
| `poll_vote` | P | Odda glas na aktivno anketo (ID se razreši strežniško). |
| `poll_close` | P | Zapre aktivno anketo in zamrzne števec v zgodovino. |
| `skip_track` | P | Preskoči skladbo, ki se dejansko predvaja na izhodu. |
| `force_next_show` | P | Naloži naslednjo usmerjeno oddajo in takoj prekine trenutni file. |
| `schedule_add_occurrence` | P | Doda oddajo v dnevni urnik; dan se preuredi brez lukenj (oglas oddaje mora obstajati). |
| `schedule_update_occurrence` | P | Premakne/prevelja/predi obstoječi termin (zamenjava na mestu ali preureditev dneva). |
| `schedule_remove_occurrence` | P | Odstrani termin iz urnika in zapre nastalo luknjo. |
| `update_station_meta` | P | Ime postaje, izvzete ključnice/izvajalce (neverPlay) in okno mirovanja. |

B = branje, P = pisanje (spremeni skupno stanje).

## Varnostni model

- **Lokalno zaupanje:** proces teče prek stdija pod uporabnikom, ki ga
  zagoni odjemalec MCP — torej isti uporabnik, ki že ima checkout postaje.
  HTTP površine varujejo Basic auth (`web.listeners`) in studio realm
  (`studio.users`); MCP teh overitev **namerno NE preslikava** — enak
  argument kot pri `npm run doctor`, ki prav tako bere `config.json`
  neposredno.
- **Secretsi:** strežnik prebere isti `config.json` kot postaja (vključno z
  gesli in žetoni). Gesla nikamor ne pošilja; orodja jih ne izpisujejo.
- **Stikalo za pisanje:** `mcp.allowWriteTools: false` v `config.json`
  povsem skrije pisalna orodja iz `tools/list`, neposreden klic pa se odkloni
  s poštenim `isError`, ki poimenuje stikalo. Bralna orodja ostanejo.
- **Stikalo za zagon:** `mcp.enabled: false` — strežnik izpiše eno
  slovensko vrstico na stderr in izstopi s kodo 1, še preden začne brati stdin.
- **Odpri predmet:** če kdaj nastavi TRANSPORT prek omrežja (SSE/HTTP),
  se odločitev o lokalnem zaupanju MORA spet pregledati — takrat prek
  pisalnih orodij lahko upravlja kdor koli z dostopom do vtičnika.

## Konfiguracija

```json
"mcp": {
  "enabled": true,
  "allowWriteTools": true
}
```

Odsotnost bloka pomeni omogočeno (isti precedens kot `lyrics.enabled` in
`push.enabled`): odklon je le izrecna vrednost `false`. Obe zastavici se
prebereta ob zagonu; sprememba zahteva ponovni zagon strežnika MCP (to je
ločen proces od postaje — postaja sama ni treba ponovno zagnati).

## Nastavitev Claude Desktop

`claude_desktop_config.json` (npr.
`~/Library/Application Support/Claude/claude_desktop_config.json` na macOS,
`%APPDATA%\Claude\claude_desktop_config.json` na Windows):

```json
{
  "mcpServers": {
    "radioclyde": {
      "command": "node",
      "args": ["/opt/radioclyde/app/src/mcp/server.js"],
      "env": {}
    }
  }
}
```

Pomembno: `config.json` se razreši **glede na modul** (`src/config/…` gre v
koren check outa), zato mora pot v `args` kazati v pravi checkout repozitorija
— strežnik mora teči iz mape repozitorija, ne od drugod. Strežnik bere isti
`config.json` kot postaja; teči mora pod istim uporabnikom (npr.
`radioclyde`), sicer ne bo mogel brati `dataDir`.

Generični odjemalec MCP (vsak, ki podpira stdio transport): ukaz
`node src/mcp/server.js` v korenu check outa. Nič env spremenljivk ni
potrebnih.

## Odpravljanje težav

- **Pokvarjen ali manjkajoč `config.json`:** strežnik NE sesuje. Odgovori na
  `initialize`, `tools/list` in `ping` običajno; vsak `tools/call` pa vrne
  `isError: »config.json ni uporaben: …«` s pravim vzrokom. Popravi
  konfiguracijo in ponovno zaženi odjemalca.
- **Icecast ni dosegljiv:** `listener_stats` in `component_health` sta
  NAVADNA odgovora s besedilom napake (`reachable: false`, `listeners:
  null`) — ne napaka protokola. Enako poštenje kot pri `/api/listeners`.
- **Liquidsoap ni dosegljiv:** `skip_track` in `force_next_show` se odklonita
  z `isError` (»telnet ukaz ni uspel«); `request_queue` izid zapiše v
  opombo želje, želja ostane odobrena.
- **Sled revizije:** vsak klic pisalnega orodja se zapiše v
  `<dataDir>/logs/mcp.log` (isti dnevniški vzorec kot `web.log` /
  `station.log`). Stdio strežnik vse svoje izpise (vključno z izpisi globljih
  modulov) pošilja na stderr — stdout nosi IZKLJUČNO JSON-RPC odgovore.
- **Ni aktivne ankete:** `poll_vote` / `poll_close` odklonita pošteno
  (»Trenutno ni aktivne ankete.«).
- **Urejanje urnika:** `schedule_*` in `update_station_meta` poganjajo isto
  razveljavitev zastarele produkcije kot studio mreža (scheduleWatch): če je
  bil termin že produciran (skripta/usmerjen predvajalni seznam), se
  obstareli artefakti pobrišejo in nadgrajeni. Vsa validacija (ura HH:MM,
  trajanje, obstoj oglasa oddaje) je pisalne plasti — zavrnitve so poštene
  besedile napak, ne napake protokola.
