# R128 glasnostna poravnava (autocue, omejen na delujoče na 2.2.4)

Profesionalni radijski sloj, ki poravna glasnost vseh glasbenih skladb na en
skupni cilj (EBU R128), tako da med skladbami ni več skokov glasnosti.
Ozko-izbrani del vzorca **autocue** (Moonbase59, MIT; rojstni list
[AzuraCast #6252](https://github.com/AzuraCast/AzuraCast/discussions/6252)),
kjer je dosledno upoštevano, kaj naš build (Liquidsoap 2.2.4-1+dev)
**realno lahko** izvede — in nič več.

## Zakaj samo `liq_amplify` in ne tudi cue/fade polj

Celoten autocue piše per-datotekne cue točke (`liq_cue_in/out`), fade
dolžine in glasnostno korekcijo (`liq_amplify`). Verificirano iz primarnih
virov (tar balo savonet/liquidsoap v2.2.4 in v2.2.5, 1:1 pregled):

| Polje | 2.2.4 (naš build) | 2.2.5+ | Odločitev |
|---|---|---|---|
| `liq_amplify` | `amplify(override="liq_amplify", 1., s)` ga bere — `amplify.ml` je **bajtno identičen** med 2.2.4 in 2.2.5; format `" %f dB"` (in golo število); brez metadata = gain 1.0 (pass-through) | enako | **UPORABLJAMO** |
| `liq_cue_in/out` | **noben operator ga ne bere** — `cue()` operator in `autocue.liq` stdlib obstajata šele od 2.2.5 | metadata resolver + seek | **NE pišemo** (mrtva polja = zavajanje) |
| `liq_fade_in` | že v uporabi od začetka (fade.in) | enako | nespremenjeno |
| `liq_fade_out` | brez operatorja (fade.out je na tem buildu prepovedan — utiša celo skladbo, utrjeno 2026-07-29) | cross/cue | NE pišemo |

Če postaja boleča tišina na začetkih skladb ali prekiniti konci, je prava pot
**nadgradnja na 2.2.5+** in ena vrstica: `enable_autocue_metadata()` (notranja
implementacija, sama analizira ob predvajanju). Ta modul se ne spremeni — je
gain-only in ostane uporaben.

Dobesedni dokaz iz `amplify.ml` (2.2.4 = 2.2.5):

```ocaml
let s = Hashtbl.find m f in
let k = try Scanf.sscanf s " %f dB" Audio.lin_of_dB
        with _ -> float_of_string s in
self#log#info "Overriding amplification: %f." k;
override <- Some k
```

…in reset ob meji skladbe (`if AFrame.is_partial buf && override <> None then
override <- None`), zato **gain nikoli ne uhaja med skladbe**.

Privzeti cilj **−16 LUFS** je enak uradnemu `settings.autocue.internal.lufs_target`
privzetku v LS 2.2.5 `autocue.liq` — nismo si izmislili lastnega standarda.

## Arhitektura (isti Node-piše/Liquidsoap-beri pogodbeni vzorec)

```
scheduler/autocueScan.js (job, vsak config.autocue.checkIntervalMinutes ?? 60)
  └─ fetchAllTracksAny() → lokalne poti skladb (isti trackLocalPath vzorec kot filler)
  └─ lib/autocue.js analyzeMissing(): za nove/spremenjene datoteke po en ffmpeg ebur128 prehod
       ├─ shrani { lufs, peak, mtimeMs, size } v dataDir/autocue_index.json (atomski tmp+rename)
       └─ budget: maxAnalyzePerRun (privzeto 100) — prvi sweep velike knjižnice se raztegne čez tike
director/playlist.js annotateTrackEntry(): za vsak glasbeni vnos pogleda indeks
  └─ z analizо:  annotate:liq_fade_in="2",liq_amplify="-2.3 dB":<pot>
  └─ brez nje:   annotate:liq_fade_in="2":<pot>        (točno kot prej)
liquidsoap/radio.liq: radio = amplify(override="liq_amplify", 1., radio)
  └─ pred emergency fallbackom: le programski skladbi se poravna,
     govor/jingle/imaging (brez polja) ostanejo na producentski glasnosti
```

Ključna dizajnerska odločitev: v indeks se shrani **samo izmerjeno** (LUFS,
peak). `amplify` se **izpelje ob branju** iz trenutnega `targetLufs` —
sprememba cilja v configu učinkuje ob naslednjem prepisu plejliste, brez
re-analize.

## Config

```json
"autocue": {
  "targetLufs": -16,        // ciljna integrirana glasnost (LS 2.2.5 privzetek)
  "maxGainDb": 6.0,         // zgornja meja pozitivne korekcije (varnost)
  "checkIntervalMinutes": 60,
  "maxAnalyzePerRun": 100
}
```

- Blok je opcijski: brez njega job teče z enakimi privzetki; obstoječi configi
  se ne pokvarijo (F2 pravilo `?.` + privzetek).
- `maxGainDb` obstaja, ker v verigi **ni limiterja**: ojačati zelo tih master
  nad +6 dB bi pomenilo klipanje skozi MP3 kodirnik. Negativne korekcije se
  nikoli ne omejujejo (utišanje je vedno varno). Števec zaskočenih gre v log
  ("gain-clamped N") — če raste, je cilj preveč agresiven za knjižnico.

## Iskrena degradacija

| Stanje | Vedenje |
|---|---|
| Scan še ni tekel / indeks prazen | noben vnos nosi `liq_amplify` → postaja se točno kot prej |
| Datoteka ni bila analizirana (budget) | predvaja se neporavnana, dokler je ne prime naslednji tik |
| Indeks pokvarjen | degradira na prazen (pass-through), naslednja uspešna analiza ga prepriše |
| ffmpeg manjka | analize failajo in se štejejo; postaja brez spremembe |
| govor / jingle / ID / stinger / emergency | nikoli ne nosijo polja — fiksna producentska glasnost |

## Reverzibilnost

1. Odstrani vrstico `radio = amplify(override="liq_amplify", 1., radio)` iz
   `liquidsoap/radio.liq` — postaja je takoj nazaj na prejšnje vedenje (polja
   v m3u ostanejo neškodljiva, ker jih ni več kdo bere).
2. Izbriši job vrstico v `scheduler/scheduler.js` in `autocue` blok iz configa.
3. `dataDir/autocue_index.json` je čisti side index — brisanje ni škodljivo.

## Verifikacija na boxu

```bash
# 1) Ročna analiza posamezne datoteke (JSON na stdout):
node src/lib/autocue.js /pot/do/skladbe.mp3
# -> {"file":"...","lufs":-21.1,"peak":-21.1,"amplify":5.1,"clamped":false,...}

# 2) Enkratni scan brez schedulerja:
node src/scheduler/autocueScan.js

# 3) Liquidsoap check (če je na boxu):
liquidsoap --check /home/ai/radioclyde/liquidsoap/radio.liq

# 4) Na zraku: ko pride skladba z liq_amplify na vrsto, mora v LS logu biti
#    "Overriding amplification: <faktor>" (amplify.ml log vrstica), in
#    vrednosti med skladbami morajo zveneti poravnano.
```

## Omejitve (pošteno zapisano)

- Analiza je **offline** (job interval); zelo sveže dodana skladba igra en tik
  neporavnana. Radijsko to ni problem (katalog se spreminja počasi).
- `ebur128` meri **integrirano** glasnost — ne ločuje "tihega introa" od
  celote; to je standard radijske normalizacije, ne napaka.
- True peak po pozitivni korekciji se **ne limira** — zato `maxGainDb` in
  zato clamp obstaja. Če bo knjižnica zelo tiha, razmisli o višjem cilju
  (npr. −18 LUFS) namesto dvigovanja `maxGainDb`.
- Cue točke/fadei (profesionalna nadgradnja): šele po premiku na LS 2.2.5+,
  kjer `enable_autocue_metadata()` pokrije vse v eni vrstici.
