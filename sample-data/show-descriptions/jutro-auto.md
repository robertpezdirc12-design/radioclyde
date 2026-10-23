# 🌅 Dobro jutro (avtomatska)

**Duration:** 60 min
**Personas:** elena
**Segments:** quiz, weather
**Repeat window:** 7 days
Rubrike: vreme, novice, šport

---

## Description

Jutranja progamska bloka, ki poslušalca zbudi: zagnan pop devetdesetih in
zgodnjih dvatisočih, med skladbami pa vedno aktualne rubrike — vreme pri
ARSO, novične naslovnice RTV Slovenija in šport. Oddaja je popolnoma
deterministična (način `autoRadio`), brez jezikovnega modela: vsaka poved je
predloga iz `config.autoRadio.templates`, izpolnjena s podatki o skladbi iz
knjižnice in živimi podatki virov.

## Hosts

- **Elena** — vodi oddajo, bere rubrike, kviz s poslušalci.

## Track Selection

- genre: Pop
- decade: 1990
- exclude: christmas, soundtrack
- Don't repeat the same artist in a single show.
- No track longer than 5 minutes.
- Favor well-known tracks.

## Tone

Energično in prijazno, a vedno po enakih predlogah. Jutranji blok
(`morning`) samodejno uporabi jutranje različice predlog `open` in `close`.

## Track moves

Vsaka skladba dobi `intro` (kratka najava pred skladbo) in `recap` (povzetek
po njej) iz predlog. Kviz sredi bloka uporablja leto iz knjižnice
(`quizIntro` / `quizReveal`).

## Rubrikes

Takoj po `open` sledita `weatherNow` (ARSO, postaja po `config.autoRadio.rubrics.station`)
in `newsHeadlines` (RTV Slovenija), nato `sportHeadlines`. Če kateri vir
ne odgovori, se segment samodejno spusti — glasba teče naprej.
