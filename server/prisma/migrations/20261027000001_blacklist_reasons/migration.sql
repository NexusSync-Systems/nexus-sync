-- Blacklist: volný text → kategorie z číselníku
--
-- POZOR: tahle migrace NENÁVRATNĚ MAŽE obsah sloupců "description" a "comment".
-- Je to záměr, ne vedlejší efekt. Volný popis u záznamu o konkrétním, jménem
-- i telefonem identifikovaném člověku je fakticky obvinění z protiprávního
-- jednání (GDPR čl. 10) a navíc se v něm nedá vyhovět žádosti o opravu.
--
-- Existující záznamy dostanou kategorii 'unclassified'. Zůstanou tedy platné
-- jako varování, jen bez příběhu. Kdo chce texty zachovat, musí si je vyexportovat
-- PŘED spuštěním migrace — potom už nejsou.

ALTER TABLE "BlacklistEntry" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE "BlacklistEntry" DROP COLUMN "description";

ALTER TABLE "BlacklistReport" ADD COLUMN "reason" TEXT;
ALTER TABLE "BlacklistReport" DROP COLUMN "comment";
