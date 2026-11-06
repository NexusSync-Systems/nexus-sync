/**
 * Role nové agentury musí vzniknout se správnou manažerskou úrovní.
 *
 * Co se dělo do 6. 11. 2026: obě místa, kde role vznikají, kopírovala ze
 * „globální šablony" jen `permissions` a `isManager` nenastavovala vůbec.
 * Ve schématu je `isManager Boolean @default(false)`, takže se mlčky vzala
 * nepravda. A ty šablony (`agencyId: null`) v produkci NEEXISTUJÍ — zakládá
 * je jen `seed.js`, který se na produkci odmítne spustit.
 *
 * Změřeno na ostrých datech:
 *
 *     test-admin@nexusstack.eu   role=Agency Admin   isManager=FALSE
 *
 * `isManagerRole()` admina zachránil, protože se rozhoduje podle názvu role,
 * ale čtyři controllery četly ten příznak napřímo a odpověděly by mu 403
 * na jeho vlastní agenturu.
 *
 * Stejná past čekala na vedoucí operátorku: „Senior Operator" by vznikla
 * bez příznaku, tedy jako řadová operátorka.
 */
const { ZNAME_ROLE, VYCHOZI_ROLE, vychoziRole, dataRole } = require('../src/config/vychoziRole');
const { isManagerRole } = require('../src/utils/authz');

describe('výchozí role agentury', () => {
  test('agentura má obě úrovně operátorky i admina', () => {
    expect(VYCHOZI_ROLE.map((r) => r.name).sort())
      .toEqual(['Agency Admin', 'Operator', 'Senior Operator']);
  });

  test('vedoucí operátorka je manažerská úroveň, běžná není', () => {
    expect(vychoziRole('Senior Operator').isManager).toBe(true);
    expect(vychoziRole('Agency Admin').isManager).toBe(true);
    expect(vychoziRole('Operator').isManager).toBe(false);
  });

  test('žádná výchozí role není app owner', () => {
    expect(VYCHOZI_ROLE.every((r) => r.isAppOwner === false)).toBe(true);
  });
});

describe('dataRole: příznaky se neberou ze schématu ani ze šablony', () => {
  test('bez šablony (produkční stav) vznikne admin jako manažer', () => {
    const d = dataRole('Agency Admin', 'agency-1', null);
    expect(d.isManager).toBe(true);
    expect(d.agencyId).toBe('agency-1');
    expect(JSON.parse(d.permissions).audit_logs).toBe(true);
  });

  test('vedoucí operátorka vznikne jako manažerka i bez šablony', () => {
    expect(dataRole('Senior Operator', 'agency-1', null).isManager).toBe(true);
  });

  test('šablona smí přebít jen oprávnění, ne manažerskou úroveň', () => {
    const sablona = { permissions: JSON.stringify({ jen: 'tohle' }), isManager: false, isAppOwner: true };
    const d = dataRole('Agency Admin', 'agency-1', sablona);
    expect(JSON.parse(d.permissions)).toEqual({ jen: 'tohle' });
    expect(d.isManager).toBe(true);    // ze šablony se NEBERE
    expect(d.isAppOwner).toBe(false);  // app ownera nelze získat šablonou
  });

  test('Model má svá oprávnění, ne prázdná', () => {
    // Regrese, kterou jsem si do PR sám přinesl: `dataRole` nejdřív Model
    // neznal, takže modelka přihlášená pozvánkou dostala roli s `{}`.
    const d = dataRole('Model', 'agency-1', null);
    expect(JSON.parse(d.permissions)).toEqual({ messaging: true, calendar: true });
    expect(d.isManager).toBe(false);
  });

  test('Model se při zakládání agentury NEzakládá', () => {
    // Modelka je `Profile`, ne účet. Role se použije až když se někdo
    // přihlásí pozvánkou jako Model.
    expect(ZNAME_ROLE.map((r) => r.name)).toContain('Model');
    expect(VYCHOZI_ROLE.map((r) => r.name)).not.toContain('Model');
  });

  test('neznámá role nedostane manažerskou úroveň náhodou', () => {
    const d = dataRole('Neznama Role', 'agency-1', null);
    expect(d.isManager).toBe(false);
    expect(d.isAppOwner).toBe(false);
  });
});

describe('návaznost na isManagerRole', () => {
  test('role vyrobené podle výchozích hodnot sedí s tím, co rozhoduje o přístupu', () => {
    for (const r of VYCHOZI_ROLE) {
      const d = dataRole(r.name, 'agency-1', null);
      expect(isManagerRole({ name: d.name, isManager: d.isManager, isAppOwner: d.isAppOwner }))
        .toBe(r.isManager);
    }
  });

  test('admin se starými daty (isManager=false) je pořád manažer podle názvu', () => {
    // Takhle vypadají role založené před touhle opravou. Dokud se nepřeženou,
    // musí je `isManagerRole` pustit — jinak by oprava zamkla stávající agentury.
    expect(isManagerRole({ name: 'Agency Admin', isManager: false, isAppOwner: false })).toBe(true);
    expect(isManagerRole({ name: 'Senior Operator', isManager: false, isAppOwner: false })).toBe(true);
    expect(isManagerRole({ name: 'Operator', isManager: false, isAppOwner: false })).toBe(false);
  });
});
