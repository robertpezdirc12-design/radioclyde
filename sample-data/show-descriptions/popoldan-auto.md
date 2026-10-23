# 🎸 Popoldanski val (avtomatska)

**Duration:** 60 min
**Personas:** miles
**Segments:** quiz, weather
**Repeat window:** 7 days
Rubrike: vreme, šport

---

## Description

Popoldanski rockskegi blok: klasični rock sedemdesetih, ki popoldne drži
tempo. Med skladbami vedno sveže vremenske razmere in športne naslovnice RTV
Slovenija — rezultati in zgodbe dneva. Popolnoma deterministična oddaja
(način `autoRadio`), brez jezikovnega modela.

## Hosts

- **Miles** — vodi popoldanski blok, naznanja športne rezultate.

## Track Selection

- genre: Rock
- decade: 1970
- exclude: christmas, soundtrack
- Don't repeat the same artist in a single show.
- No track longer than 7 minutes.
- Favor well-known tracks.

## Tone

Zagnano, a profesionalno. Popoldanski blok (`daytime`) predlogi `open` in
`close` izbira samodejno po uri oddaje.

## Track moves

`intro`/`recap` ob vsaki skladbi, kviz sredi bloka (`quizIntro` /
`quizReveal`).

## Rubrikes

Takoj po `open`: `weatherNow` (ARSO) in `sportHeadlines` (RTV Slovenija).
Če vir ne odgovori, se segment spusti.
