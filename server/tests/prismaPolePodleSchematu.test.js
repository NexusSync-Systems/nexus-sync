/**
 * Hlídá dotazy, které se ptají na pole, jaké v Prisma schématu NEEXISTUJE.
 *
 * Reálný případ, kvůli kterému test vznikl (5. 11. 2026):
 *
 *   authController.withAssignedProfile()
 *     prisma.profile.findMany({ where: { assignedUsers: { some: { id } } } })
 *
 * Relace na `Profile` se ale jmenuje `assignees`, ne `assignedUsers`. Prisma
 * hodí validační chybu, okolní try/catch ji spolkne a vrátí prázdný seznam —
 * takže přihlášení VŽDYCKY vrátilo `profileId: null`. Relay telefon pak
 * posílal `?profileId=` a server mu na frontu odchozích zpráv odpovídal
 * HTTP 400 každých třicet sekund. Žádná odchozí zpráva se k žádné modelce
 * nemohla dostat a v aplikaci o tom nebyla ani stopa.
 *
 * Proč to nechytily ostatní testy: skoro všechny mají `jest.mock('db')`,
 * takže Prisma je atrapa a té je jméno pole jedno. Tenhle test proto nesahá
 * na běh aplikace — čte DMMF vygenerovaného klienta, tedy totéž schéma,
 * proti kterému poběží produkce.
 *
 * Kontrolují se jen klíče NEJVYŠŠÍ úrovně u `where`, `select`, `include`
 * a `orderBy`. Zanořené filtry patří navázanému modelu, ne tomuhle, a jejich
 * ověřování by vyžadovalo sledovat typ na každé úrovni.
 */
const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');

const SRC = path.join(__dirname, '..', 'src');

// Operátory, které Prisma na nejvyšší úrovni povoluje vedle názvů polí.
const OPERATORY = new Set(['AND', 'OR', 'NOT', '_count', '_avg', '_sum', '_min', '_max']);

function vsechnySoubory(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? vsechnySoubory(p) : (p.endsWith('.js') ? [p] : []);
  });
}

/** Vrátí text uvnitř složených závorek začínajících na `od` (včetně vnoření). */
function vyrizniBlok(text, od) {
  if (text[od] !== '{') return null;
  let hloubka = 0;
  for (let i = od; i < text.length; i++) {
    if (text[i] === '{') hloubka++;
    else if (text[i] === '}') {
      hloubka--;
      if (hloubka === 0) return text.slice(od + 1, i);
    }
  }
  return null;
}

/** Klíče nejvyšší úrovně i s rozsahem jejich hodnoty (vnořené bloky přeskakuje). */
function polozkyNejvyssiUrovne(telo) {
  const polozky = [];
  let hloubka = 0;
  let sbirej = '';
  let klic = null;
  let zacatekHodnoty = -1;
  for (let i = 0; i < telo.length; i++) {
    const z = telo[i];
    if (z === '{' || z === '[' || z === '(') { hloubka++; continue; }
    if (z === '}' || z === ']' || z === ')') { hloubka--; continue; }
    if (hloubka !== 0) continue;
    if (z === ':' && klic === null) {
      const m = sbirej.match(/([A-Za-z_$][\w$]*)\s*$/);
      if (m) { klic = m[1]; zacatekHodnoty = i + 1; }
      sbirej = '';
      continue;
    }
    if (z === ',') {
      if (klic !== null) polozky.push({ klic, od: zacatekHodnoty, do: i });
      klic = null; sbirej = '';
      continue;
    }
    sbirej += z;
  }
  if (klic !== null) polozky.push({ klic, od: zacatekHodnoty, do: telo.length });
  return polozky;
}

const kliceNejvyssiUrovne = (telo) => polozkyNejvyssiUrovne(telo).map((p) => p.klic);

const modely = new Map(
  Prisma.dmmf.datamodel.models.map((m) => {
    const jmena = new Set(m.fields.map((f) => f.name));
    // Prisma vedle polí povoluje i názvy složených unikátních klíčů,
    // tedy `@@unique([agencyId, date])` → `agencyId_date`. Nejsou to pole,
    // ale dotaz s nimi je platný.
    for (const idx of m.uniqueIndexes || []) {
      jmena.add(idx.name || idx.fields.join('_'));
    }
    if (m.primaryKey && m.primaryKey.fields.length > 1) {
      jmena.add(m.primaryKey.name || m.primaryKey.fields.join('_'));
    }
    return [m.name.charAt(0).toLowerCase() + m.name.slice(1), jmena];
  })
);

describe('Prisma dotazy se ptají jen na pole, která ve schématu existují', () => {
  test('DMMF se načetlo a zná modely', () => {
    expect(modely.size).toBeGreaterThan(5);
    expect(modely.get('profile')).toBeDefined();
  });

  test('detektor umí chybu najít (kanárek)', () => {
    const vzorek = 'prisma.profile.findMany({ where: { assignedUsers: { some: { id: 1 } } } })';
    const i = vzorek.indexOf('{', vzorek.indexOf('findMany('));
    const klice = kliceNejvyssiUrovne(vyrizniBlok(vzorek, i));
    const whereIdx = vzorek.indexOf('{', vzorek.indexOf('where:'));
    const whereKlice = kliceNejvyssiUrovne(vyrizniBlok(vzorek, whereIdx));
    expect(klice).toContain('where');
    expect(whereKlice).toEqual(['assignedUsers']);
    expect(modely.get('profile').has('assignedUsers')).toBe(false);
  });

  test('žádný dotaz v src/ nepoužívá neexistující pole', () => {
    const nalezy = [];
    for (const soubor of vsechnySoubory(SRC)) {
      const text = fs.readFileSync(soubor, 'utf8');
      const re = /prisma\.([a-zA-Z_$][\w$]*)\.(findMany|findFirst|findUnique|update|updateMany|create|delete|deleteMany|count|upsert)\s*\(\s*\{/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const model = m[1];
        const pole = modely.get(model);
        if (!pole) continue; // např. prisma.$transaction nebo neznámá property
        const telo = vyrizniBlok(text, re.lastIndex - 1);
        if (!telo) continue;
        for (const polozka of polozkyNejvyssiUrovne(telo)) {
          const sekce = polozka.klic;
          if (!['where', 'select', 'include', 'orderBy'].includes(sekce)) continue;
          const usek = telo.slice(polozka.od, polozka.do);
          const posun = usek.indexOf('{');
          if (posun === -1) continue;
          const vnitrek = vyrizniBlok(telo, polozka.od + posun);
          if (!vnitrek) continue;
          for (const klic of kliceNejvyssiUrovne(vnitrek)) {
            if (OPERATORY.has(klic) || pole.has(klic)) continue;
            nalezy.push(
              `${path.relative(SRC, soubor)}: prisma.${model} — ${sekce}.${klic} ve schématu není`
            );
          }
        }
      }
    }
    expect(nalezy).toEqual([]);
  });
});
