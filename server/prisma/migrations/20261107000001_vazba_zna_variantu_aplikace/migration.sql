-- Vazba zařízení ví, která aplikace na tom telefonu je.
--
-- Modelka potřebuje dva telefony, ne jeden. Na relay telefonu je SIM karta,
-- na kterou chodí SMS; v plné aplikaci vidí kalendář, zprávy a bezpečnostní
-- tlačítka. Jsou to dvě různé aplikace s různým applicationId
-- (`com.nexushub.relay` a `com.nexushub.app`), takže každá má svůj
-- `installationId` a zakládá si vlastní vazbu.
--
-- A právě tady to do teď padalo: párování po sobě deaktivuje VŠECHNY ostatní
-- aktivní vazby téhož profilu, aby na profil zůstala jedna. Dvě aplikace
-- jednoho profilu si ji proto přehazovaly — přihlášení v plné aplikaci
-- vyřadilo relay (přestaly chodit SMS), párování relaye zase vyřadilo plnou.
-- Nikdo si toho nemusel všimnout, protože obojí se chová jako „prostě to
-- přestalo chodit", ne jako chyba.
--
-- `appVariant` dělí vazby na dvě nezávislé přihrádky: jeden relay a jedna
-- plná aplikace na profil, místo jedné vazby celkem.
--
-- VÝCHOZÍ HODNOTA JE `relay` SCHVÁLNĚ, i když je plná aplikace rozšířenější.
-- Všechny vazby, které dnes v databázi jsou, založil relay telefon — plná
-- aplikace se do teď párovala jen tím, že relay vyřadila. Kdyby výchozí
-- hodnota byla `full`, tyhle řádky by se po migraci přestaly považovat za
-- relay a odesílání SMS, hlášení „relay je online" i noční hlídka by
-- přestaly fungovat. Stejná hodnota drží i starší APK, které pole ještě
-- neposílají: relay v terénu zůstane relayem.

ALTER TABLE "DeviceBinding" ADD COLUMN "appVariant" TEXT NOT NULL DEFAULT 'relay';

-- Výběr relay telefonu se dělá přes agenturu i přes profil, vždy spolu
-- s `active`. Index drží ty dotazy u jednoho vyhledání i s novým filtrem.
CREATE INDEX "DeviceBinding_agencyId_appVariant_active_idx"
  ON "DeviceBinding"("agencyId", "appVariant", "active");

CREATE INDEX "DeviceBinding_profileId_appVariant_active_idx"
  ON "DeviceBinding"("profileId", "appVariant", "active");
