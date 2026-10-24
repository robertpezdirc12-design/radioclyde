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

Reproducirati je mogoče tako (brez roota): anonimen
`registry-1.docker.io` pull tagov `v2.2.4`/`v2.4.6` slike
`savonet/liquidsoap`, razpakirati sloje, pognati binarno z lastnim
loaderjem (`ld-linux-x86-64.so.2 --library-path ...`), za 2.4.6 z
`--stdlib <rootfs>/usr/share/liquidsoap/libs/stdlib.liq`, za 2.2.4 z
LD_PRELOAD shimom, ki preusmerja `/usr/share/liquidsoap` (trdo kodirana
pot) v rootfs. Podrobnosti v worklogu Task 26.

## Koraki na boxu

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
5. **Efekti po želji**: žigi prek
   `node src/liquidsoap/stampTransitionFlags.js data/filler.m3u --set sweep`
   (ali `washout --delay 0.45`, `dissolve`, `--only <podniz>`, `--clear all`,
   `--list`). Pred zrakom poslušaj vsak učinek vsaj enkrat:
   sweep = filtri izven, washout = slapback, dissolve = zgoščenost.
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
