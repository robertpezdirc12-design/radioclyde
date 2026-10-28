# Nadgradnja Liquidsoap: 2.2.4-1+dev → 2.4.6 (P3 #11)

*Datum: 2026-10-24 · pripravljeno ob implementaciji dj_transition efektov*

Ta vodič je boxov del P3 #11: koda prehodov (`liquidsoap/dj_transitions.liq`,
`%ifversion >= 2.4.6` vrata v `radio.liq`, `src/liquidsoap/stampTransitionFlags.js`)
je že v repozitoriju in testirana strukturno; ta dokument je tisto, kar ostane
za boxom — nadgradnja runtime-a, preverba in vklop. Vse trditve o 2.4.6 so
preverjene v primarnem viru (tar `savonet/liquidsoap` v2.4.6, `CHANGES.md`,
`doc/content/migrating.md`), ne po dokumentaciji na spletu.

## Zakaj 2.4.6 in ne prej

- **2.4.5 odvrne delni okvir po vsakem `cross`** in **2.4.4 ima O(n) pregled
  ure na vsak efekt prehod** — obe merjeni na SUB/WAVE-jevem zraku
  (docs/subwave-deep-analysis.md); 2.4.6 je njihov minimalni produkcijski
  runtime. Naši efekti tečejo na istem mehanizmu, torej velja isto spodnja
  meja.
- **2.4.6 popravi prav naš živi bug `fade.out`** (celotna skladba utišana,
  potrjeno 2026-07-29; gor: #5514 »fade.out muting the whole next track after
  a skip« + popravek »amplifying by infinity while a `liq_fade_*_delay` was
  pending«). Po nadgradnji je prepoved `fade.out` v produkcijskih
  komentarjih radio.liq zgodovina — a je ne odpravljajte načrtno brez nove
  žive preverbe.
- `playlist` z `reload_mode="watch"` čaka na umirjenje nakopičenih dogodkov
  (#3343) — manj tekmujočih reloadov ob prepisu now_playing.m3u.
- `cross` odpoji `on_track` na vsakem prehodu (#5379) in označi replay
  odhajajočih metapodatkov (#5360) — stingerji nad crossom še vedno vidijo
  meje skladb, scrobble pa je zato registriran NAD crossom (pre-prehod).

## Kaj se spremeni na boxu (in kaj ne)

`radio.liq` je napisan dvoversijsko s preprocesorskimi vrati `%ifversion`
(sintaksa preverjena v testih obeh buildov, `tests/language/pp.liq`):

| Blok | 2.2.4-1+dev (danes) | 2.4.6 (po nadgradnji) |
|---|---|---|
| `dj_transitions.liq` (celotna vsebina) | odtrgan pred parsanjem | aktiven |
| scrobble registracija | `source.on_metadata(radio, …)` | `radio.on_metadata(synchronous=true, …)` — NAD crossom |
| ducker `on_frame` | funkcija | metoda `radio.on_frame(duck_update)` |
| `blank.detect` (2 sloja) | pozicijski handler + `on_noise=` | metodi `on_blank`/`on_noise` (2.4.6 je staro obliko odstranil, `migrating.md`) |
| cross prehodov | odsoten (trdi rezi) | `cross(duration=dj_transition_buffer, persist_override=true, dj_transition, radio)` |
| urni ID overlay | `switch([({0m0s}, id_source)])` — cookbookov trenutek | govorna vrata: okno `{0m0s-1m30s}` + `id_fired` zaklepka, ID ne more čez DJ govor (Val 31 B3; bazen `loop=true` na obeh buildih) |

Na 2.2.4 se torej NIČ ne spremeni (vrata so zaprta, novo koda se ne parsuje);
pre-#11 stanje je bajtno-identično. Na 2.4.6 se odprejo vrata in:
efekti so možni, seam z govorom/jinglom ostane trd rez (pogodba `source_tag`),
stingerji/ID/postelje/nujna podlaga ostanejo NAD crossom (nikoli mešani).

Pričakovano, neškodljivo: opozorjenja `lang.deprecated` ob zagonu 2.4.6 za
`null()` v duckerju (`override=null()`) — gole oblike `null` 2.2.4 ne
parsira, zato vrstica ostane skupna; in za morebitne ostanke stare funkcije
`source.on_frame`, če kdo ročno razpiše `%else` vejo na 2.4.6.

## Lokalna validacija na pravih binarkah (2026-10-24) — ZELO NAJBRŽ

Skripta je bila preverjena na **uradnih Docker binarkah obeh verzij**,
izvlečenih v userspace (anonimen registry pull + lasten loader), brez
boxa:

| Preverba | 2.2.4-1 (vrata ZAPRTA) | 2.4.6 (vrata ODPRTA) |
|---|---|---|
| `--check` | EXIT 0, 0 napak | EXIT 0, 0 napak |
| `--describe-sources` (celoten graf) | (2.2.4 zastave nima) | EXIT 0, 0 napak |
| živ zagon 12–75 s | teče, 0 napak | teče, 0 napak |
| efekti na zraku | — (odrezani) | washout 2× (`tap=0.45s (d=2.5s)`), dissolve 1× (`d=3.48s`), speech seam trd rez ✓ |

Iz teh živih preverb so nastala TRI resnična odkritja, vsa že popravljena
v skripti:

1. **`synchronous` je OBVEZEN argument metod** (`on_frame`/`on_metadata`) —
   tipni preverjevalnik 2.4.6: »Missing arguments in function application:
   synchronous«. Vsi klici nosijo `synchronous=true`.
2. **cross zavrača method-razširjene vire**: stdlib `fade.in` obesi RECORD
   METODE na vir (`.{fade_duration=...}`), tak vir poroča notranji
   `self_sync = (Dynamic, None)`, cross pa zahteva točno `(Static, None)`
   (child_support.ml) — kljub temu, da je jezikovni `self_sync()` bool
   `false` (nič v verigi ne poganja svoje realtime zanke). Rešitev je
   SUB/WAVE-jev produkcijski vzorec: `source.dynamic(self_sync=false,
   {radio})` tik pred crossom (thunk oblika `{..}` je obvezna). Postopki
   `request.dynamic` poročajo `(Static, None)` in so nedolžni — zahtevki
   ostanejo znotraj prekrižane verige.
3. **post-cross `on_metadata` se ne sproži dvakrat**: opozorilo SUB/WAVE
   je starejše od popravka #5360 + stdlib cross ovojnika z
   `deduplicate=true` (privzeto), ki odstrani označen replay odhajajoče
   meta. Živo merjeno: točno EN dogodek na skladbo (`META: AAA`, `META:
   BBB`). Scrobble je torej registriran pod crossom (pokrije zahtevke).

Opazka za živi zagon: `track_sensitive=false` preklop show↔filler ustvari
tudi kratke dodatne prehode (d = 0.02–0.5 s, prihajajoča meta včasih še
prazna) — to so takojšnji mehki preklopi, slušno neopazni; na boxu
pričakuj v dnevniku več `dj_transition` klicev kot je glasbenih meja.

Reproducirati je mogoče BREZ roota in brez dockerja z enim ukazom —
postopek je od vala 30 (2026-10-27) V REPOZITORIJU in razmnožljiv:

```
node scripts/fetch-liquidsoap.mjs              # pridobi obe uradni binarki (anonimno)
cd liquidsoap
RADIOCLYDE_HOME=<dom-s-config.json> ../.liq-bin/v2.2.4/run.sh --check radio.liq
RADIOCLYDE_HOME=<dom-s-config.json> ../.liq-bin/v2.4.6/run.sh --check radio.liq
```

Orodje (0 novih odvisnosti — Node ≥ 24 globalni fetch) pridobi anonimne
manifeste in plasti slika `savonet/liquidsoap`, jih razširi v `.liq-bin/`
(gitignored) z pravilnim OCI whiteout vrstnim redom, najde binarko + NJEN
lastni ld-linux nalagalnik in prave lib mape (vključno z zasebnimi Debianovimi
dir-ji, ki jih slike navajajo le z ABSOLUTNIM DT_RUNPATH — npr.
`usr/lib/x86_64-linux-gnu/pulseaudio` za libpulsecommon; LD_PRELOAD jih NE
more prestreči, ker ld.so razrešuje svoje odvisnosti z internimi sysklici),
za 2.2.x prevede `scripts/ldshim.c` (LD_PRELOAD preusmeritev trdo kodirane
poti `/usr/share/liquidsoap` v rootfs; open/stat/access/mkdir + at/64/xstat
različice, `struct stat64` za 64-bitne wrapperje), za 2.3+ pa podá
`--stdlib <rootfs>/usr/share/liquidsoap/libs/stdlib.liq` (FILE, ne mapa).
Samo-preverba orodja je `run.sh --version`. Podrobnosti prvotnega ročnega
postopka (2026-10-24) so zgodovina — njegov worklog je padel v svedru;
ORODJE je zdaj nosilec resnice. Izbere se lahko katero koli oznako
(`--tags v2.4.6`) in platformo (`--platform linux/arm64`).

## Ponovitev v peskovniku na TEKOČI skripti (2026-10-27, Val 30) — OBVEZNO PREBRATI

Matrika zgoraj je bila merjena 2026-10-24 — potem pa sta se SPREMENILA OBa
preverjena artefakta (radio.liq: RADIOCLYDE_HOME, A1 `mode="normal"`, B2
promo plast, B3 icy identiteta; dj_transitions.liq: CROSS STAMPS strip).
Trditev »skripta je 2.4.6-ready« je bila za tekoče drevo NEVELJAVNA in
orodje jo je takoj ujelo: **radio.liq se na uradni 2.4.6 NI PARSAO**
(`Error 15: Missing arguments in function application: string` na vrstici
z `getenv("RADIOCLYDE_HOME")`). Gol `getenv` je zastareli alias, katerega
oblika se razlikuje po buildih: 2.2.x jemlje `(ime)` in vrne `""` za
nenastavljeno, 2.4.6-ova `deprecations.liq` pa definira
`getenv(default="", v)` z defaultom NAJPREJ in POZICIJSKO — stari klic je
postal delna aplikacija. Popravek (v radio.liq, pripeto s testom):
`environment.get("RADIOCLYDE_HOME")` — byte-identična v obeh stdlibih
(`libs/utils.liq` v 2.4.6 sliki in v2.2.4 tarju), označeni `~default=""`
je na klicnem mestu izpustljiv, na 2.4.x pa je to edino nezastarelo
črkovanje. BREZ te preverbe bi lastnikov korak 3 spodaj padel šele ob
nadgradnji — zdaj gre skozi že pred buildom.

Sveža matrika na tekočem drevesu (2026-10-27, uradni binarki, isti
uporabniški postopek kot zgoraj):

| Preverba | 2.2.4-1 (vrata ZAPRTA) | 2.4.6 (vrata ODPRTA) |
|---|---|---|
| `--check` | EXIT 0, TIHO (0 opozoril) | EXIT 0, točno 1 znano opozorilo (`null()` → `null`, spodaj) |
| `--describe-sources` | (2.2.4 zastave nima) | EXIT 0; graf vsebuje `cross` + `source.dynamic` |
| živ zagon | 15 s čisto (shim dela v RUNTIME-u; decoder dejansko predvaja WAV) | 40 s čisto; VSI TRIje učinki na etru: `dissolve (d=8.98s)` (velikost iz žiga liq_cross_duration=9.0 prek CROSS STAMPS bloka — prvič kdaj binarno preverjen), `sweep`, `washout tap=0.45s` (žig prebran) |

Opombe k živemu zagonu: edine napake v dnevniku so `ECONNREFUSED` do
icecasta (v peskovniku ga ni — pričakovano); `d` v dnevnikih učinkov je
`min(remaining(a), remaining(b))` — DEJANSKO zvočno polje, žig je le rezerva
(14-sekundni preskusni WAV-i puščajo 5 s repov po 9 s prekrivanjih; prava
glasba s 8–12 s žigi pusti minute); `playlist.parser` opozorila ob praznih
imaging m3u so znana benigna šumovja (enako na boxu).

## Val 31 (2026-10-27 zvečer): urni ID ne more čez DJ govor (B3)

Zadnja odložena točka vala 28 je zdaj v skripti — vrata so odprta samo na
2.4.6 (na 2.2.4 `%else` veja ohranja cookbookov `{0m0s}` overlay
bajtno-identično). Vsa semantika je bila NAJPREJ izmerjena na uradni 2.4.6
binarki z minute-cikličnimi sondami (`{0s-30s}` okna, enako ožičenje):
nedosegljivi switch anketa svoj funkcijski predikat ~desetkrat na sekundo
(preklop vrat v ~100 ms od šiva); izbrani klip se vedno predvaja do konca
tudi, če se okna/zaklepka zapreta sredi; ob meji posnetka stikalo PONOVNO
pregleda predikat (pripravljen-a-ne-predvajan zahtevek ne zazveni), zato
enkratna zaklepka `id_fired` drži NATANČNO EN klip na okno; startup
privzetek je fail-closed (neznan program ≙ govor, izmerjena boot-dirka pri
`ref(false)`). Ob istem preizkusu je padla še skrita napaka STRADANJA:
`loop=false` bazen po N klipih utihne za vedno (prepis m3u se ob
byte-identični vsebini preskoči) — vsi trije kratek-klip bazeni
(id/stingerji/promosi) so zdaj `loop=true`, kadenca pa je izmerjena na obeh
binarkah (ID: en na okno; stingerji: po en na interval, 0 s/36 s/72 s, brez
veriženja).

Nato ŽIVA preverba na PRAVEM radio.liq čez pravo mejo ure (23:00:00, tri
sočasne noge, izdelani programi s/source_tag govornimi in glasbenimi WAV-i,
ujet MP3 analiziran po prisotnosti 880 Hz):

| Noga | Binarka | Program čez :00:00 | Dejstvo (dnevnik + zvok) |
|---|---|---|---|
| a | 2.4.6 | govor 22:59:45→23:00:55 | **BREZ ID 23:00:00–55**; strel 23:00:55, točno na šivu govor→glasba (čez intro), EN klip; fantomska priprava ob 23:01:01 ne zazveni |
| b | 2.2.4 | isto | **ID točno ob 23:00:00 sredi govora** — staro vedenje, bajtno-identično (`%else`) |
| c | 2.4.6 | glasba | **ID točno ob 23:00:00 čez glasbo** — nespremenjena pot |

Iskrena meja (napisana v docs/auto-radio.md): govor, ki teče čez 90. sekundo
ure, to uro ID preskoči — poteptan DJ je hujši od izpuščenega žingla.

## Val 32 (2026-10-28): rampa + POPRAVEK POL GLASNOSTI IN STRADANJA

Dve ugotovki, obe živo preverjeni na uradnih binarkah:

1. **LATENTNA NAPAKA NA OBEH BUILDIH, POPRAVLJENA**: urni ID overlay
   `add([radio, switch(...)])` je igral s privzetim `normalize=true` —
   to meša kot POVPREČJE, torej je postaja od uvedbe overlayja igrala na
   POL glasnosti (Goertzel 206 proti 412 na istem tonu), in v kombinaciji
   s `blank.strip` je STRADAL program: pesem utihne po 10 s (2.2.4) oziroma
   po ~22 s (2.4.6). Dvojni bisekt: brez tega add() ali z
   `add(normalize=false)` teče polna skripta čisto na OBEH binarkah;
   z normalize=true strada na obeh. Popravek: `add(normalize=false, ...)`
   na obeh vejah overlayja. POSLEDICA za obstoječi 2.2.4 eter: +6 dB
   glasnosti (odpravljena latentna tišina) in konec stradanja. Brez tega
   popravka bi korak 4 spodaj (hladni zagon) na 2.4.6 slišal krajše
   pesmi — zdaj sliši cele.
2. **RAMPA (hit-the-post) ŽIVO PREVERJENA na 2.4.6**: govor čez intro
   pesmi (liq_ramp žig na obeh straneh šiva, duck 0.2, dvig ~0.3–0.5 s
   na šivu, pesem nedotaknjena). Iskrena meja: prekrivanje je dolgo kot
   crossovo okno sprožitve (~dj_transition_buffer + ~1 s, izmerjeno
   4,6 s na 8-s govoru) — rampa pokrije zadnji del govora, ne vsega.
   Podrobnosti v docs/auto-radio.md, razdelek »Rampa (Val 32)«.

Sveža matrika na TEKOČEM drevesu (2026-10-28, uradni binarki, isti
uporabniški postopek kot zgoraj, 55-s živi zagoni z Goertzel analizo
ujetega MP3):

| Preverba | 2.2.4-1 (vrata ZAPRTA) | 2.4.6 (vrata ODPRTA) |
|---|---|---|
| `--check` | EXIT 0, TIHO | EXIT 0, točno 1 znano opozorilo (`null()` → `null`, spodaj) |
| živ zagon 55 s | vsi segmenti vseh 3 sledov, polna amplituda | vsi segmenti + VSI blendi (3,5 s na vsakem šivu) + rampa |

## Koraki na boxu

**PRED korakom 1 (novo, Val 30): pred-poletna preverba z uradno binarko,
brez builda.** `node scripts/fetch-liquidsoap.mjs` pridobi uradni 2.4.6
binary v `.liq-bin/` in njegov `run.sh --check radio.liq` (korak 3 spodaj)
poganja ŠE PRED opam buildom — če gre skozi tukaj, gre skozi tudi po buildu;
če NE gre skozi, si prihranil cel build. Enako orodje teče na vsakem
Linuxu z node+tar (+gcc le za 2.2.x žig), tudi brez roota in brez dockerja,
zato je uporabno tudi kot CI-preverba po vsakem valu, ki se pride do
radio.liq (matrika zgoraj je nastala tako).

**Namestitvena pot**: `radio.liq` vse pomožne procese (`deadair/recordEvent.js`,
`plex/scrobbleTrack.js`) in branje `config.json` izpelje iz spremenljivke
okolja `RADIOCLYDE_HOME` (ne nastavljena = izvirna pot `/home/ai/radioclyde`,
torej referenčni box deluje nespremenjeno). Namestitev na drugi poti (npr.
`/opt/radioclyde`) v systemd enoto doda `Environment=RADIOCLYDE_HOME=/opt/radioclyde`
— brez ročnega prestavljanja poti po datoteki.

1. **Varnostna kopija trenutnega stanja**: `liquidsoap --check radio.liq`
   (mora biti čisto), zapiši verzijo (`liquidsoap --version`), shrani
   delujočo binarno (npr. `which liquidsoap` + kopija) za povratni korak.
2. **Build 2.4.6 iz vira** (opam, kot doslej):
   - `opam update && opam upgrade`
   - odvisnosti po `doc/content/build.md` v tarju 2.4.6 (isti nabor kot
     2.2.4 + morebitne nove opombe tam)
   - `wget https://github.com/savonet/liquidsoap/archive/refs/tags/v2.4.6.tar.gz`
   - `tar xzf v2.4.6.tar.gz && cd liquidsoap-2.4.6`
   - `dune build` (ali `opam install .`), nato preveri
     `./radio.liq` poti — binarna naj pride na isto mesto kot stara
     (ali zamenjaj symlink, da je povratek = preklop symlinka).
3. **Preverba skripta ŠE brez preklopa**: `liquidsoap --check radio.liq`
   z NOVO binarno. Pričakovano: `%ifversion >= 2.4.6` se odpre, tako da
   --check že valja dj_transitions.liq in cross ožičenje. Vsaka napaka
   tukaj je blokator — ne zaženi produkcije.
4. **Hladni zagon ob času brez Oddaje**: zaženi s produkcijo in poslušaj
   vsaj dve meji skladb: pričakovan zvok = enak kot prej (brez žigov so vsi
   seam-i ravninski crossfade 3,5 s namesto trdega reza — to je edina
   razlika brez žigov; govor/jingli ostanejo trdi rezi).
5. **Efekti so že oboroženi SAMODEJNO (Val 28 D1)**: pisci seznamov
   (`director/playlist.js` annotateTrackEntry) žigajo `liq_washout` /
   `liq_dissolve` / `liq_sweep` deterministično iz avtocue meritev glave in
   repa (epsko izumrtje → washout, globoka ambientna zgradba → dissolve,
   glasen hladen začetek → sweep; podrobnosti v docs/auto-radio.md, razdelek
   Prehodi). Ročni žigos je še vedno možen za popravke po okusu:
   `node src/liquidsoap/stampTransitionFlags.js data/filler.m3u --set sweep`
   (ali `washout --delay 0.45`, `dissolve`, `--only <podniz>`, `--clear all`,
   `--list`) — a pozor: pisec seznama žige postavlja znova ob vsakem
   prepisu, torej ročni žig zdrži le do naslednjega tika. Pred zrakom
   poslušaj vsak učinek vsaj enkrat: sweep = filtri izven, washout =
   slapback, dissolve = zgoščenost. Doktorjevo preverjanje `prehodi` pove
   pokritost.
6. **Po-preskus P2 oprtih točk na novem buildu** (isti postopek kot vedno):
   tih WAV v now_playing.m3u → prehod na nujno podlago ob ~20 s + vpis v
   `dataDir/history/deadair.jsonl`; beds push → utiha na začetku govora,
   dihanje med pavzami; zahtevek prek requestQueue CLI.
7. **Povratni korak**: preklop nazaj na staro binarno (symlink) — skripta
   ostane ista, vrata se sama zaprejo.

## Kaj ostaja odprto po nadgradnji

- `%ifversion >= 2.4.6` vrata ostanejo za vedno (niso začasna): skripta mora
  ostati zagnljiva na 2.2.4, dokler boxni build ni potrjen.
- `crossfade()` ostaja prepovedan (ne glede na verzijo): njen
  simple_transition ignorira callback po meri — brez nje ni efektov.
- Sledenje SUB/WAVE: chop/exit-loop/blend/stem prehodi so namenoma ven
  (potrebujejo BPM/beat-fazo/stem analizo — proti arhitekturi brez AI).
