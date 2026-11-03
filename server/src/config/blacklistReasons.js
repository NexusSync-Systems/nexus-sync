/**
 * Číselník důvodů zápisu na blacklist.
 *
 * Proč číselník a ne volný text:
 *
 * Záznam na blacklistu je tvrzení o konkrétním, identifikovatelném člověku —
 * drží se u něj jméno, telefon i registrační značka — a sdílí se mezi
 * agenturami. Volný popis z toho dělá vyprávění o tom, co kdo komu udělal, tedy
 * fakticky obvinění z protiprávního jednání. Takové údaje mají v GDPR vlastní,
 * přísnější režim (čl. 10) a navíc se v nich nedá rozumně vyhovět žádosti o
 * přístup ani opravu: co s větou, se kterou dotyčný nesouhlasí?
 *
 * Pevná kategorie zachová, k čemu blacklist slouží — varovat před klientem,
 * se kterým byl problém —, ale zbaví záznam příběhu. „Nezaplatil" je provozní
 * údaj. Odstavec o tom, jak se choval, je něco jiného.
 *
 * Klientská kopie je v client/src/config/blacklistReasons.js a KÓDY musí
 * sedět. Popisky se smí lišit, kódy ne.
 */

/** Důvod přiřazený záznamům, které vznikly ještě s volným textem. */
const NEZATRIDENO = 'unclassified';

const REASONS = {
  unpaid: { cz: 'Nezaplatil', en: 'Did not pay' },
  no_show: { cz: 'Opakovaně nedorazil', en: 'Repeated no-show' },
  fake_booking: { cz: 'Falešná rezervace', en: 'Fake booking' },
  boundaries: { cz: 'Překročil dohodnuté hranice', en: 'Crossed agreed boundaries' },
  aggressive: { cz: 'Agresivní chování', en: 'Aggressive behaviour' },
  other: { cz: 'Jiné', en: 'Other' },

  // Nejde zvolit ručně — vzniká jen migrací starých záznamů. Kdyby šel zvolit,
  // stal by se z něj výchozí „nechce se mi vybírat" a číselník by ztratil smysl.
  [NEZATRIDENO]: { cz: 'Nezatříděno', en: 'Unclassified' },
};

/** Kódy, které smí přijít od uživatele. */
const VOLITELNE = Object.keys(REASONS).filter((k) => k !== NEZATRIDENO);

const jePlatny = (kod) => Object.prototype.hasOwnProperty.call(REASONS, kod);

module.exports = { REASONS, VOLITELNE, NEZATRIDENO, jePlatny };
