---
name: Wikidata dan
cooldown: 6h
---
Rubrika *obzorje* (»Na današnji dan«): avtomatski način s Wikidatine SPARQL končne točke pobere rojstva in smrti na današnji datum ter izbere dogodke, katerih osebe imajo slovensko obliko imena.
Ista kadensa velja za glasbeno različico (»Na današnji dan v glasbi«, rubrični ključ `onthisdaymusic`), zato si obzorje in obzorjeGlasba delita ta skill.
`cooldown` (privzeto 6 ur): dnevni dogodki se čez dan ne spreminjajo, dolga kadensa je poštena do Wikidatine strežnika — spremenite jo TUKAJ, brez dotikanja kode.
Ta skill NIMA ključa `feed` in ga ne more dobiti: SPARQL končna točka ni RSS vir, ampak poizvedba, ki jo sestavi koda — tukaj je nastavljiv samo cooldown.
Ko je vir mrtev, je datum zakonito prazen ali ni slovensko označenih oseb, rubrika ne utihne: prebere se poštena offline vrstica (glasbena različica pa pade na lokalni korpus), glasba nikoli ne obstane.
