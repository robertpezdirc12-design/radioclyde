# ☕ Delovni dan (avtomatska)

**Duration:** 60 min
**Personas:** ryan
**Segments:** quiz, weather
**Repeat window:** 7 days
Rubrike: vreme, obzorje

---

## Description

Dopoldanski blok za delovni dan: prepoznaven pop-rock osemdesetih v ozadju,
med skladbami trenutne vremenske razmere in rubrika "na današnji dan"
(rojstva in smrti znanih osebnosti z dnevnega datuma, iz Wikidata s
slovenskimi oznakami). Popolnoma deterministična oddaja brez jezikovnega
modela.

## Hosts

- **Ryan** — vodi dopoldanski blok, pove vreme in obzorje.

## Track Selection

- genre: Pop/Rock
- decade: 1980
- exclude: christmas, soundtrack
- Don't repeat the same artist in a single show.
- No track longer than 6 minutes.
- Favor well-known tracks.

## Tone

Mirnejši kot jutranji blok, nevsiljiv — glasba nosi, govor samo obroblja.
Čez delovni dopoldan (`daytime`) predlogi `open`/`close` samodejno prevzameta
nevtralno dnevno različico.

## Track moves

`intro`/`recap` ob vsaki skladbi, kviz v sredini bloka (`quizIntro` /
`quizReveal`).

## Rubrikes

Po `open`: `weatherNow` (ARSO) in en do dva dogodka `obzorje`. Vir ne
odgovori → segment spusti, blok teče dalje.
