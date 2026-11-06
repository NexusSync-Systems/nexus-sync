/**
 * Výchozí role agentury — zdroj pravdy pro `isManager`, ne databáze.
 *
 * Proč v kódu: obě místa, kde role vznikají (`registerAgency`
 * a `registerUser`), kopírovala ze „globální šablony" (`agencyId: null`)
 * jen `permissions`, a `isManager` nenastavovala vůbec. Ve schématu je
 * `isManager Boolean @default(false)`, takže se mlčky vzala nepravda.
 *
 * A ty globální šablony v produkci NEEXISTUJÍ: zakládá je jen `seed.js`,
 * který se na produkci odmítne spustit, a databáze se 3. 11. 2026 stavěla
 * načisto. `globalTemplate` tedy vycházel vždycky `null`.
 *
 * Důsledek změřený 6. 11. 2026 na ostrých datech:
 *
 *     test-admin@nexusstack.eu  role=Agency Admin  isManager=FALSE
 *
 * Admin agentury tedy nebyl manažer. `isManagerRole()` ho zachrání, protože
 * se rozhoduje podle názvu role — ale čtyři controllery čtou ten příznak
 * napřímo a těm by odpověděl 403 na vlastní agenturu.
 *
 * Stejná past čekala na vedoucí operátorku: „Senior Operator" by vznikla
 * bez příznaku, tedy jako řadová operátorka.
 */

// Dvě úrovně operátorek, jak je chce provoz: běžná a vedoucí.
// Vedoucí je manažerská úroveň — `isManagerRole()` s ní tak počítá už dnes
// (má `senior_operator` ve svém seznamu).
// ZNÁMÉ role = všechny, pro které známe správné příznaky a oprávnění.
// VÝCHOZÍ role = podmnožina, která se zakládá hned při vzniku agentury.
//
// „Model" sem patří, ale při zakládání agentury nevzniká: modelka je
// v tomhle systému `Profile`, ne účet, a role se použije jen tehdy, když
// se někdo přihlásí pozvánkou jako Model.
const ZNAME_ROLE = [
  {
    name: 'Agency Admin',
    description: 'Plný přístup ke zdrojům agentury',
    isManager: true,
    isAppOwner: false,
    permissions: {
      permissions: true, hierarchy: true, analytics: true, messaging: true,
      calendar: true, profiles: true, web_profiles: true, device_setup: true,
      audit_logs: true, qa_hub: true, settings: true, referrals: true, inventory: true
    }
  },
  {
    name: 'Senior Operator',
    description: 'Vedoucí operátorka — vidí zprávy všech modelek agentury',
    isManager: true,
    isAppOwner: false,
    permissions: {
      hierarchy: true, analytics: true, messaging: true, calendar: true,
      profiles: true, web_profiles: true, device_setup: false, settings: true,
      qa_hub: true, referrals: true, inventory: true
    }
  },
  {
    name: 'Operator',
    description: 'Operátorka — jen přiřazené modelky',
    isManager: false,
    isAppOwner: false,
    permissions: {
      messaging: true, calendar: true, profiles: true, web_profiles: true,
      device_setup: true, settings: true
    }
  },
  {
    name: 'Model',
    description: 'Modelka s vlastním přístupem (profil je samostatná entita)',
    isManager: false,
    isAppOwner: false,
    permissions: { messaging: true, calendar: true }
  }
];

// Při vzniku agentury se zakládají tři — Model až na vyžádání.
const VYCHOZI_ROLE = ZNAME_ROLE.filter((r) => r.name !== 'Model');

const vychoziRole = (nazev) => ZNAME_ROLE.find((r) => r.name === nazev) || null;

/** Data pro `prisma.role.create`. Šablona smí přebít jen `permissions`. */
const dataRole = (nazev, agencyId, sablona = null) => {
  const v = vychoziRole(nazev);
  return {
    name: nazev,
    description: v?.description ?? null,
    permissions: sablona?.permissions ?? JSON.stringify(v?.permissions ?? {}),
    // Příznaky se ze šablony NEBEROU: když šablona chybí (a v produkci chybí
    // vždycky), musí platit to, co je tady, ne `false` ze schématu.
    isManager: v?.isManager ?? false,
    isAppOwner: v?.isAppOwner ?? false,
    agencyId
  };
};

module.exports = { ZNAME_ROLE, VYCHOZI_ROLE, vychoziRole, dataRole };
