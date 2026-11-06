-- Profil dostane vlastníka: účet modelky, které patří.
--
-- Do teď měl `Profile` jedinou vazbu na uživatele — `assignees`, tedy
-- OPERÁTORKY, které ho obsluhují. Vlastnictví je něco jiného: identita
-- člověka, jehož je to telefon a číslo.
--
-- Bez té vazby se relay telefon modelky hlásil účtem operátorky, protože
-- jiná cesta k profilu nevedla. Vazba zařízení, záznam v auditu i „kdo co
-- udělal" pak ukazovaly na operátorku i u toho, co udělala modelka.
--
-- `ownerId` je NULLABLE schválně: profily, které dnes existují, vlastníka
-- nemají a mít nemusí. Dokud ho nedostanou, chová se všechno jako dřív —
-- párování telefonu padá zpátky na `assignees`.
--
-- UNIKÁTNÍ index: jeden účet vlastní nejvýš jeden profil.
-- Jedna modelka = jeden účet = jeden telefon.
--
-- ON DELETE SET NULL: smazání účtu modelky profil NESMAŽE. Profil nese
-- chaty a historii zpráv, které patří agentuře, ne účtu.

ALTER TABLE "Profile" ADD COLUMN "ownerId" TEXT;

CREATE UNIQUE INDEX "Profile_ownerId_key" ON "Profile"("ownerId");

ALTER TABLE "Profile" ADD CONSTRAINT "Profile_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
