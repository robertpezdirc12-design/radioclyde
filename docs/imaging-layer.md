# Imaging sloj: ID ob polni uri, stingeri, emergency podlaga

*Datum: 2026-10-24 · Radio Clyde main, Liquidsoap 2.2.4-1+dev · del P1/seznama izposojenih vzorcev (docs/ready-made-scripts-analysis.md, točke #1, #3, #9)*

Imaging sloj doda tri radijske sloje, ki jih je programu do zdaj manjkalo: **ID postaje ob polni uri**, **periodne stingerje** in **emergency podlago**. Vse tri izvaja `liquidsoap/radio.liq`, Node pa vzdržuje njihove plejliste z isto pogodbo, ki jo že uporablja `now_playing.m3u`/`filler.m3u` (Node piše, Liquidsoap opazuje z `reload_mode="watch"`). Klipi so kratki proizvedeni posnetki (TTS/ffmpeg), ki jih operater polni v tri direktorije pod `dataDir/imaging/`.

## 1. Arhitektura treh slojev

```
show_source (preproduced)  ─┐
                            ├─ fallback(track_sensitive=false)  = jedro programa
filler_source (glasba)     ─┘
        │
        ├─ fallback(track_sensitive=true, [delay(1800., stingers), …])   ← stingeri
        ├─ add([…, switch([({0m0s}, id)])])                              ← ID overlay
        ├─ blank.detect + blank.strip (max_blank=20.)                    ← dead-air stražar (P2 #9)
        ├─ amplify(override="liq_amplify")
        └─ mksafe(fallback(track_sensitive=false, […, emergency]))       ← emergency
             └─ blank.detect (track_sensitive=false)                     ← opazovalec ZRAKA
```

Vrstni red je »od zunaj navznoter«: stingeri vstopajo na mejah skladb, ID se zmeša NAD mešanico, emergency leži pod vsem programom, šele pod njim je mksafe-ova tišina. Vsak vir je `playlist()` (fallible): **prazen ali manjkajoč .m3u pomeni, da sloj preprosto ni na voljo** — postaja z brez imaging sredstev se obnaša točno kot prej. Degradacijska lestvica je »izpusti sloj«, nikoli »izpusti program«.

**Dead-air stražar (P2 #9, popolnitev te lestvice, 2026-10-24):** emergency podlaga lovi samo vire, ki so *nedosegljivi* (prazna m3u) — ne vira, ki igra digitalno tišino (pokvarjen/tih encode ostane "available"). To zapre `blank.strip()` (uradni cookbook recept (5), semantika verificirana iz tega builda `noblank.ml`): po 20 s neprekinjene tišine postane program nedosegljiv, emergency zasede, ob zvoku program vrne. Dva opazovalca `blank.detect` (isti akumulator, pasivna) pišeta vsak prehod v `dataDir/history/deadair.jsonl` (`src/deadair/recordEvent.js`), Diagnostics pa parira epizode (`src/deadair/ledger.js`): `program_*` = "stražar je deloval", `air_*` = "odpovedal je tudi nujni vir". Parametri so literali v radio.liq (json.parse tip nedotaknjen); reverzibilno = izbriši tri vrstice + štiri handlerje. Live verifikacija: `liquidsoap --check` + nameravno tih WAV v now_playing.m3u.

| Sloj | Vir | Kdaj zazveni | Vedenje brez kliipov |
|---|---|---|---|
| ID postaje | `imaging/id.m3u` | overlay točno ob HH:00:00 (`{0m0s}`) | sloj ne obstaja |
| Stingeri | `imaging/stingers.m3u` | na prvi meji skladb po preteku intervala | sloj ne obstaja |
| Emergency | `imaging/emergency.m3u` | šele, ko sta show IN filler nedosegljiva | mksafe-ova tišina (kot prej) |

## 2. Verificirane semantike operatorjev (primarni viri)

Vsaka odločitev v bloku ima dobesedno preverjen vir — v2.2.5 izvorni kodi/dokumentaciji (najbližja verziji 2.2.4-1+dev):

- **`delay(1800., stinger_source)`** — `src/core/operators/delay.ml` (v2.2.5): »Avoids some source to play a new track before some delay elapses after the end of the previous track played.« Po koncu vsake stinger skladbe je vir nedosegljiv do preteka intervala; ob zagonu je `last = 0.`, torej ob zagonu zazveni **natančno en** stinger na prvi meji skladb, kasneje največ ena na interval. Zunanji `fallback(track_sensitive=true)` je tisto, kar stingerje drži na mejah skladb — s `track_sensitive=false` bi rezel glasbo sredi skladbe takoj, ko interval poteče.
- **ID overlay** — uradni cookbook 2.2.5, sekcija »Mixing and switching«: `add([normal, switch([({0m0s}, jingle)])])`. Switch **nima default veje**: pred :00 je nedosegljiv in ne prispeva ničesar; ob :00 postane na voljo in začne klip takoj (nima tekoče skladbe, zato `track_sensitive` ne zavira), klip pa se zmeša NAD programom.
- **Zakaj NE `predicate.activates`** — `src/libs/predicate.liq` (v2.2.5): `ans = (not last()) and cur` — rob false→true je opazljiv samo ob vzorčenju predikata. Pri `switch` z mejskim re-selectom lahko meja skladbe pade izven okna `0m-5m` in ID bi tiho izpustil cele ure. Cookbookov recept deluje zanesljivo ravno zato, ker overlay switch v stopnji »nedosegljiv → dosegljiv« ne čaka nobene meje.
- **Zakaj `playlist()` in ne `single()` za emergency** — fallible vir, ki je nedosegljiv, dokler je plejlist prazen, drži degradacijsko lestvico iskreno; `single()` z manjkajočo datoteko ima na tej verziji mutnejšo semantiko dostopnosti.
- **mksafe** — `src/libs/source.liq` (v2.2.5): `fallback(track_sensitive=false, [s, blank])` — ostaja zadnja mreža pod emergency.

## 3. Datoteke in poti

Node stran (src/config/index.js izvaja vse iz `dataDir`):

| Pot | Namen |
|---|---|
| `dataDir/imaging/id/` | ID klipi (priporočeno 2–5 s, s podlago) |
| `dataDir/imaging/stingers/` | stinger klipi (priporočeno 2–10 s) |
| `dataDir/imaging/emergency/` | emergency klip(i) — predvajani v zanki, dokler program ne pride nazaj |
| `dataDir/imaging/id.m3u` | piše `scheduler/imagingPlaylists.js` |
| `dataDir/imaging/stingers.m3u` | ″ |
| `dataDir/imaging/emergency.m3u` | ″ |

Vsak vnos nosi eksplicitno `annotate:liq_fade_in="0"` (trd rez — imaging klipi so govorna družina, točno kot DJ govor pri director/playlist.js). Direktorij se skenira ravno (brez rekurzije), samo pripon `.mp3 .flac .m4a .ogg .opus .wav` (neobčutljivo na velikost črk); izpis je sortiran, da se `watch` reload sproži le, ko se je *nabor* klipov res spremenil. Manjkajoč direktorij → **prazen .m3u** (iskrena degradacija, nič izmišljenih vnosov); povzetek z števci se vrne klicatelju in testirajo testi, ne log parsanja.

Job v schedulerju: `imaging` vsake `config.imaging?.checkIntervalMinutes ?? 30` minut (brez bloka se obnaša kot prej — lekcija F2 razreda napak z 2026-10-24). Ponovni zapis je hkrati tudi to, kar *nafila izčrpan bazen*: `id.m3u` z enim klipom in `loop=false` je po odigranem klipu prazen do naslednjega prepisa (največ interval kasneje), kar ID drži enkrat na uro.

Literáli v `liquidsoap/radio.liq` so namerno literáli (kot `{0m0s}`): `1800.` = stinger interval v sekundah. `radio.liq`-jev `json.parse` tip ostaja nespremenjen, zato starejši `config.json` brez imaging bloka zažene postajo brez sprememb. Reverzibilnost: odstrani imaging blok iz `radio.liq` in trije sloji izginejo; Node job piše .m3u datoteke, ki jih potem nihaje ne bere (neškodljivo).

## 4. Proizvodnja klipov (enkratna, izven repozitorija)

Klipi so stvar produkcije, ne runtime — deterministično, brez LLM:

- **ID postaje** (2–5 s, s podlago): TTS stavek (»Radio Clyde«) prek obstoječe Edge TTS poti (`src/auto/edgeTts.js`) ali `edge-tts --voice sl-SI-RokNeural`, nato zmešan s podlago in končan z vnaprej renderiranim fade-out (isti pristop kot jingle pri `lib/audio.js` — na runtime NI fade.out, znani bug 2.2.4). Glasnost poravnaj z glasbo (cilj okrog −16 do −18 LUFS), ker gre overlay čez program.
- **Stingeri**: enak postopek, krajši stavki (»Sledi Radio Clyde«, »Ob polnih urah Radio Clyde« …). Brez podlage, če bodo rezani med skladbe.
- **Emergency**: en klip, ki v zanki sporoči, da je postaja pokvarjena (TTS: »Trenutno imamo tehnične težave …«), ali 30 s rožnati šum:
  `ffmpeg -f lavfi -i anoisesrc=color=pink:amplitude=0.2:duration=30 -ar 44100 -ac 2 emergency.wav`
  Če je direktorij prazen, emergency sloj ne obstaja in mksafe-ova tišina ostane (obnašanje kot prej) — klip je izboljšava, ne pogoj.

Dodajanje klipov: copy v ustrezni direktorij; naslednji imaging tick (največ 30 min, ali ročno `node src/scheduler/imagingPlaylists.js`) prepiše .m3u in `watch` reload jih takoj upošteva — brez restarta Liquidsoapa.

## 5. Verifikacija

- **Testi** (99/99, npm test): `test/imagingPlaylists.test.mjs` — nabor pripon, trd rez annotate, prazen/manjkajoč direktorij → prazen .m3u, iskren povzetek, praznjenje ob rescanu; `test/radioLiqImaging.test.mjs` — strukturna regresija nad radio.liq **brez komentarjev** (komentarji namenoma omenjajo pokvarjene konstrukte, zato se skenira samo koda): overlay switch prisoten, `predicate.activates` odsoten, `delay(1800., …)` + track_sensitive fallback prisotna, emergency kot playlist pod programom, mksafe zadnji, `crossfade(`/`fade.out(` in `single(` ne smejo priti nazaj.
- **Na produkcijski mašini** pred restartom: `liquidsoap --check liquidsoap/radio.liq` (parse-only) in posluš prve polne ure: ID točno ob :00, stinger na prvi meji po ~30 min, emergency slišati le, če programu nameravano odvzameš oba vira (test ročno: preimenuj začasno now_playing.m3u in filler.m3u).

## 6. Viri

savonet/liquidsoap v2.2.5: `src/core/operators/delay.ml`, `src/libs/predicate.liq`, `src/libs/source.liq` (mksafe), cookbook »Mixing and switching« / »Periodic playlists«; SUB/WAVE radio.liq (dead-air stražar, minimalna oblika); docs/ready-made-scripts-analysis.md v2 (točke #1, #3, #9 in matrika); AzuraCast nit #6252 (radijski standard prehodov — omenjen kot kontekst za prihodnji autocue korak, ki je ločen projekt P1 #2).
