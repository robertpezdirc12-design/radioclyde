---
name: RTV šport
cooldown: 30m
feed: https://www.rtvslo.si/sport/rss
---
Rubrika *šport*: avtomatski način prebere najnovejše športne naslovnice iz RSS vira RTV Slovenija in na etro poveže prvih nekaj (število se nastavi v `config.json`, `autoRadio.rubrics.sportLimit`).
`cooldown` (privzeto 30 minut) določa, kako dolgo so naslovnice predpomnjene — kadenco spremenite TUKAJ, brez dotikanja kode.
`feed` JE priključen: bralec je splošen RSS odjemalec, zato lahko vir zamenjate s katerim koli drugim športnim RSS (naslovnice se poberejo iz naslovov `<item>`).
Ko je vir mrtev ali feed ni berljiv kot RSS, rubrika ne utihne in nikoli ne izmisli rezultatov: prebere se poštena offline vrstica, glasba nikoli ne obstane.
