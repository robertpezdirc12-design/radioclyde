# 🌆 Večerni zavoji (avtomatska)

**Duration:** 60 min
**Personas:** olivia
**Segments:** quiz, weather
**Repeat window:** 7 days
Rubrike: vreme, novice, obzorje

---

## Description

Večerni blok za umiritev: pop osemdesetih, ki je preživel čas, med skladbami
zadnje novice dneva, vreme za jutri in rubrika "na današnji dan". Oddaja je
popolnoma deterministična — vsaka poved predloga, vsak podatek iz pravega
vira.

## Hosts

- **Olivia** — vodi večerni blok, poslovenjeno in mirno.

## Track Selection

- genre: Pop
- decade: 1980
- exclude: christmas, soundtrack
- Don't repeat the same artist in a single show.
- No track longer than 5 minutes.
- Favor well-known tracks.

## Tone

Miren, topljen govor; večerna različica predlog `open`/`close` se uporabi
samodejno (`evening` blok).

## Track moves

`intro`/`recap` ob vsaki skladbi, kviz v sredini (`quizIntro` / `quizReveal`).

## Rubrikes

Po `open`: `weatherNow` (ARSO), `newsHeadlines` (RTV Slovenija) in en do
dva dogodka `obzorje` (Wikidata). Vir ne odgovori → segment spusti.
