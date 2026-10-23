# 📻 1980s Rock Shop (avtomatska)

**Duration:** 30 min
**Personas:** elena, ryan
**Segments:** quiz, weather
**Repeat window:** 7 days

---

## Description

Pregled rockskega zvoka osemdesetih, sestavljen iz vaše glasbene knjižnice.

## Hosts

- **Elena** — vodi oddajo.
- **Ryan** — vremenska napoved, sicer ne nastopa.

## Track Selection

- genre: Pop/Rock
- decade: 1980
- exclude: christmas, soundtrack
- Don't repeat the same artist in a single show.
- No track longer than 5 minutes.
- Favor well-known tracks.

## Tone

Energicno, toda vedno po enakih predlogah -- ta oddaja je popolnoma
deterministična (način `autoRadio`), brez jezikovnega modela. Vsaka poved je
predloga iz `config.autoRadio.templates`, izpolnjena s podatki o skladbi iz
knjižnice.

## Track moves

Vsaka skladba dobi `intro` (kratka najava pred skladbo) in `recap`
(povzetek po njej) iz predlog. Kviz v sredini oddaje uporablja leto iz knjižnice
(`quizIntro` / `quizReveal`).

## Weather

Predaja vremenski napovedi približno dve tretjini skozi oddajo (predloga
`handoff` + `live` segment, sestavljen ob oddaji iz pravih podatkov
Open-Meteo).
