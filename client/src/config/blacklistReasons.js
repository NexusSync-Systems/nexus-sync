// Číselník důvodů zápisu na blacklist — klientská kopie.
//
// KÓDY musí sedět se serverovým server/src/config/blacklistReasons.js. Popisky
// se smí lišit, kódy ne: server kód validuje a neznámý odmítne.
//
// Proč pevné kategorie místo volného popisu je vysvětlené v serverové kopii.
// Zkráceně: záznam je tvrzení o konkrétním člověku a sdílí se mezi agenturami,
// takže volný text z něj dělá obvinění, které nejde opravit ani doložit.
//
// Popisky jsou schválně tady, a ne v translations.js: číselník se mění jako
// celek a rozdělit kódy a jejich překlady do dvou souborů znamená, že někdo
// přidá kód a zapomene popisek.

export const NEZATRIDENO = 'unclassified';

export const REASONS = {
  unpaid: { cz: 'Nezaplatil', en: 'Did not pay' },
  no_show: { cz: 'Opakovaně nedorazil', en: 'Repeated no-show' },
  fake_booking: { cz: 'Falešná rezervace', en: 'Fake booking' },
  boundaries: { cz: 'Překročil dohodnuté hranice', en: 'Crossed agreed boundaries' },
  aggressive: { cz: 'Agresivní chování', en: 'Aggressive behaviour' },
  other: { cz: 'Jiné', en: 'Other' },
  [NEZATRIDENO]: { cz: 'Nezatříděno', en: 'Unclassified' },
};

/** Co smí uživatel vybrat. „Nezatříděno" vzniká jen migrací starých záznamů. */
export const VOLITELNE = Object.keys(REASONS).filter((k) => k !== NEZATRIDENO);

/**
 * Popisek důvodu. Neznámý kód vrací sám sebe — server může mít novější
 * číselník než nasazený klient a holý kód je pořád lepší než prázdné místo.
 */
export function popisDuvodu(kod, lang = 'cz') {
  const r = REASONS[kod];
  if (!r) return kod || '';
  return lang === 'cz' ? r.cz : r.en;
}
