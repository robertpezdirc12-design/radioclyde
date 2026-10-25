---
name: RTV novice
cooldown: 30m
feed: https://www.rtvslo.si/feeds/novice.xml
---
Rubrika *novice*: avtomatski način prebere najnovejše naslovnice iz RSS vira RTV Slovenija in na etro poveže prvih nekaj (število se nastavi v `config.json`, `autoRadio.rubrics.newsLimit`).
`cooldown` (privzeto 30 minut) določa, kako dolgo so naslovnice predpomnjene — kadenco spremenite TUKAJ, brez dotikanja kode.
`feed` JE priključen: bralec je splošen RSS odjemalec, zato lahko vir zamenjate s katerim koli drugim RSS (naslovnice se poberejo iz naslovov `<item>`).
Ko je vir mrtev ali feed ni berljiv kot RSS, rubrika ne utihne in nikoli ne izmisli naslovnic: prebere se poštena offline vrstica, glasba nikoli ne obstane.
