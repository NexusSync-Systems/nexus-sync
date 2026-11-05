const fs = require('fs');
const path = require('path');
const z = require('zod');
const schemas = require('../src/middleware/schemas');

/**
 * Hlídá jednu konkrétní třídu chyb: schéma, které nemůže projít NIKDY.
 * Takový endpoint vrací 400 na každý požadavek a je tím úplně nedosažitelný —
 * a protože 400 vypadá jako chyba klienta, nikoho to nezačne pálit.
 *
 * Reálný případ: `permissions: z.record(z.boolean())`. Zod do verze 4.3 bral
 * u z.record() první argument jako typ KLÍČE, takže schéma vyžadovalo boolean
 * klíče. Klíč v JS objektu je vždy string, takže
 * PATCH /api/agency/roles/:id/permissions odmítal všechno — několik týdnů,
 * než si toho někdo všiml.
 *
 * POZOR, zod to mezitím změnil. Od 4.6.7 (ověřeno 5. 11. 2026) je
 * u jednoargumentového volání klíč `string` a argument je typ HODNOTY, takže
 * ta konkrétní past už nesklapne. Testy níž to pokrývají z obou stran:
 * detektor se zkouší na dvouargumentovém tvaru, kde je boolean klíč
 * nepochybný, a zvlášť stojí kanárek na chování zodu — kdyby se to někdy
 * vrátilo zpátky, bude hned jasné proč.
 *
 * Test nepoužívá ručně psané vzorky. Vzorek si poskládá z definice schématu
 * a na každé úrovni ho proti tomu samému schématu ověří, takže nemůže projít
 * omylem. Když vzorek nedokáže vyrobit, řekne u kterého pole a proč.
 */

// Kandidáti na string. Generátor je zkouší v tomhle pořadí a vezme první,
// který dané schéma přijme — proto tu jsou i tvary pro regexem omezená pole.
const STRING_CANDIDATES = [
  'Test1234',
  'test@example.com',
  '2026-01-01T00:00:00.000Z',
  '123e4567-e89b-12d3-a456-426614174000',
  'https://example.com',
  'Aa1_-:.',
  'Aa1_-.',
  'Aa1',
  'a',
  '1'
];

const checksOf = (schema) => (schema._zod.def.checks || []).map((c) => c._zod.def);

function stringBounds(schema) {
  let min = null;
  let max = null;
  for (const c of checksOf(schema)) {
    if (c.check === 'min_length') min = c.minimum;
    if (c.check === 'max_length') max = c.maximum;
    if (c.check === 'length_equals') { min = c.length; max = c.length; }
  }
  return { min, max };
}

// Varianty kandidáta v různých délkách. Prodlužujeme opakováním jeho vlastních
// znaků — tím zůstaneme v povolené znakové sadě, kdyby pole mělo regex.
function lengthVariants(base, min, max) {
  const out = [base];
  if (min !== null && base.length < min) {
    let s = base;
    while (s.length < min) s += base;
    out.push(s.slice(0, Math.max(min, base.length)));
    out.push(s.slice(0, min));
  }
  if (max !== null && base.length > max) out.push(base.slice(0, max));
  if (min !== null && max !== null && min <= max) {
    let s = base;
    while (s.length < min) s += base;
    out.push(s.slice(0, Math.min(Math.max(min, 1), max)));
  }
  return out;
}

function numberSample(schema) {
  let min = null;
  let max = null;
  let int = false;
  for (const c of checksOf(schema)) {
    if (c.check === 'greater_than') min = c.inclusive ? c.value : c.value + 1;
    if (c.check === 'less_than') max = c.inclusive ? c.value : c.value - 1;
    if (c.check === 'number_format' && (c.format === 'safeint' || c.format === 'int32')) int = true;
  }
  const candidates = [];
  if (min !== null) candidates.push(min);
  if (max !== null) candidates.push(max);
  if (min !== null && max !== null) candidates.push(Math.floor((min + max) / 2));
  candidates.push(1, 0);
  return candidates.map((n) => (int ? Math.round(n) : n));
}

/**
 * Vrátí { ok: true, value } nebo { ok: false, why }.
 * `verify` = ověřit vygenerovanou hodnotu proti schématu, které ji má přijmout.
 */
function sample(schema, path = '') {
  const def = schema._zod.def;
  const at = path || '(korenove schema)';
  const verify = (value) => schema.safeParse(value).success;

  switch (def.type) {
    case 'string': {
      // Pozn.: string s min > max tady neřešíme — Zod na něm hází výjimku už při
      // konstrukci (staví si regex {10,3}), takže by se takové schéma nedalo ani
      // nasadit. U čísel, polí a enumů to Zod projde, proto tam guardy jsou.
      const { min, max } = stringBounds(schema);
      for (const base of STRING_CANDIDATES) {
        for (const v of lengthVariants(base, min, max)) {
          if (verify(v)) return { ok: true, value: v };
        }
      }
      return { ok: false, why: `${at}: nepodařilo se vyrobit string, který by schéma přijalo (min=${min}, max=${max}, checks=${checksOf(schema).map((c) => c.check || c.format).join(',')})` };
    }

    case 'number': {
      for (const v of numberSample(schema)) if (verify(v)) return { ok: true, value: v };
      return { ok: false, why: `${at}: žádné číslo z jeho vlastního rozsahu neprošlo — interval je prázdný (např. min > max, nebo .int() nad rozsahem bez celého čísla). checks=${JSON.stringify(checksOf(schema))}` };
    }

    case 'boolean':
      for (const v of [true, false]) if (verify(v)) return { ok: true, value: v };
      return { ok: false, why: `${at}: boolean neprošel ani jako true, ani jako false` };

    case 'enum': {
      const entries = Object.values(def.entries || {});
      if (!entries.length) return { ok: false, why: `${at}: enum nemá žádnou hodnotu, nemůže projít nikdy` };
      for (const v of entries) if (verify(v)) return { ok: true, value: v };
      return { ok: false, why: `${at}: enum neprošel ani jednou ze svých hodnot (${entries.join(', ')})` };
    }

    case 'literal': {
      const vals = def.values || [def.value];
      for (const v of vals) if (verify(v)) return { ok: true, value: v };
      return { ok: false, why: `${at}: literal neprošel svou vlastní hodnotou` };
    }

    case 'any':
    case 'unknown':
      return { ok: true, value: 'x' };

    case 'optional':
    case 'nullable':
    case 'default':
    case 'catch':
    case 'readonly':
      // Vnitřní typ generujeme schválně i u nepovinných polí: některá schémata
      // mají .refine('aspoň jedno pole'), takže prázdný objekt by neprošel.
      return sample(def.innerType, path);

    case 'record': {
      const keyTry = sample(def.keyType, `${at} (klíč záznamu)`);
      if (!keyTry.ok) {
        return { ok: false, why: `${at}: typ klíče u z.record() nepřijme žádný string — klíč objektu je v JS vždy string, takže schéma nemůže projít nikdy. Pozor: Zod 4 bere první argument z.record() jako typ KLÍČE. ${keyTry.why}` };
      }
      if (typeof keyTry.value !== 'string') {
        return { ok: false, why: `${at}: typ klíče u z.record() chce ${typeof keyTry.value}, ale klíč objektu je v JS vždy string — schéma nemůže projít nikdy` };
      }
      const valTry = sample(def.valueType, `${at} (hodnota záznamu)`);
      if (!valTry.ok) return valTry;
      const value = { [keyTry.value]: valTry.value };
      return verify(value) ? { ok: true, value } : { ok: false, why: `${at}: vygenerovaný záznam ${JSON.stringify(value)} schéma nepřijalo` };
    }

    case 'array': {
      const el = sample(def.element, `${at}[]`);
      if (!el.ok) return el;
      for (const v of [[el.value], [el.value, el.value], []]) if (verify(v)) return { ok: true, value: v };
      return { ok: false, why: `${at}: pole neprošlo ani prázdné, ani s jedním či dvěma prvky` };
    }

    case 'union': {
      const why = [];
      for (const [i, opt] of (def.options || []).entries()) {
        const t = sample(opt, `${at}|${i}`);
        if (t.ok && verify(t.value)) return { ok: true, value: t.value };
        if (!t.ok) why.push(t.why);
      }
      return { ok: false, why: `${at}: žádná varianta unionu nešla naplnit. ${why.join(' | ')}` };
    }

    case 'pipe': {
      // z.preprocess(fn, cíl) → pipe{in: transform, out: cíl}. Vzorek vyrobíme
      // pro cílové schéma a necháme ho projít celou pipe (preprocess bývá
      // normalizace, která na už čisté hodnotě nic nezmění).
      const inner = sample(def.out, path);
      if (inner.ok && verify(inner.value)) return { ok: true, value: inner.value };
      const alt = sample(def.in, path);
      if (alt.ok && verify(alt.value)) return { ok: true, value: alt.value };
      return { ok: false, why: `${at}: pipe/preprocess nepřijalo vzorek vyrobený pro svůj cílový typ. ${inner.why || ''}` };
    }

    case 'object': {
      const shape = def.shape || {};
      const full = {};
      const problems = [];
      for (const [key, child] of Object.entries(shape)) {
        const t = sample(child, path ? `${path}.${key}` : key);
        if (t.ok) full[key] = t.value;
        else problems.push(t.why);
      }
      if (problems.length) return { ok: false, why: problems.join('\n  ') };
      if (verify(full)) return { ok: true, value: full };

      // Některá schémata mají .refine() na vzájemnou výlučnost polí — zkusíme
      // ještě jen povinná pole.
      const required = {};
      for (const [key, child] of Object.entries(shape)) {
        const t = child._zod.def.type;
        if (t === 'optional' || t === 'default' || t === 'nullable') continue;
        if (key in full) required[key] = full[key];
      }
      if (verify(required)) return { ok: true, value: required };

      const err = schema.safeParse(full).error;
      return { ok: false, why: `${at}: objekt neprošel ani se všemi poli, ani jen s povinnými. Chyba: ${JSON.stringify(err?.issues?.slice(0, 3))}` };
    }

    default:
      // Nezavíráme oči: neznámý typ je důvod test rozbít, ne ho přeskočit.
      return { ok: false, why: `${at}: generátor neumí typ '${def.type}' — doplň ho do sample() v tomhle testu` };
  }
}

describe('Kontrolní vzorky generátoru', () => {
  // Bez těchhle šesti by chyba v generátoru znamenala, že projde všechno: kdyby
  // sample() vracel ok:true na cokoli, tabulka schémat níž by byla bezcenná.
  it('rozumné schéma projde a vrátí použitelný vzorek', () => {
    const s = z.object({
      name: z.string().min(1).max(50),
      count: z.coerce.number().int().min(0).max(10),
      flags: z.record(z.string(), z.boolean()),
      mode: z.enum(['a', 'b'])
    });
    const r = sample(s);
    expect(r.ok).toBe(true);
    expect(s.safeParse(r.value).success).toBe(true);
  });

  it('odhalí boolean klíč v z.record — klíč objektu nemůže být boolean', () => {
    // Dvouargumentový tvar schválně: klíč je tu boolean nade vší pochybnost,
    // takže se testuje DETEKTOR, ne to, jak zrovna zod vykládá jednoargumentové
    // volání. Tohle schéma neprojde ani v jedné verzi zodu.
    const r = sample(z.object({ permissions: z.record(z.boolean(), z.string()) }));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/klíč/i);
  });

  it('jednoargumentové z.record(T) bere zod 4.6+ jako typ HODNOTY, ne klíče', () => {
    // Kanárek. Do zodu 4.3 bral první argument jako typ KLÍČE, což shodilo
    // PATCH /api/agency/roles/:id/permissions na několik týdnů (viz komentář
    // v hlavičce souboru). V 4.6.7 už je klíč string a schéma funguje.
    //
    // Kdyby se to někdy vrátilo zpátky, spadne tenhle test — a bude hned
    // jasné proč, místo aby zase týdny tiše padaly požadavky.
    expect(z.record(z.boolean()).safeParse({ cokoliv: true }).success).toBe(true);

    const r = sample(z.object({ permissions: z.record(z.boolean()) }));
    expect(r.ok).toBe(true);
  });

  it('odhalí číslo s prázdným intervalem (min > max)', () => {
    const r = sample(z.object({ x: z.number().min(10).max(3) }));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/interval je prázdný/);
  });

  it('odhalí .int() nad rozsahem, kde žádné celé číslo není', () => {
    const r = sample(z.object({ x: z.number().int().min(0.2).max(0.8) }));
    expect(r.ok).toBe(false);
  });

  it('odhalí prázdný enum', () => {
    const r = sample(z.object({ x: z.enum([]) }));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/enum nemá žádnou hodnotu/);
  });

  it('odhalí pole, jehož min je větší než max', () => {
    const r = sample(z.object({ x: z.array(z.string()).min(5).max(2) }));
    expect(r.ok).toBe(false);
  });

  it('odhalí regex, který nic nepovolí', () => {
    const r = sample(z.object({ x: z.string().regex(/^$/).min(5) }));
    expect(r.ok).toBe(false);
  });
});

describe('Každé validační schéma musí přijmout aspoň jeden vstup', () => {
  const all = Object.entries(schemas);

  it('schemas.js vůbec něco exportuje', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  // Test kontroluje jen to, co je exportované. Kdyby někdo schéma přidal a zapomněl
  // ho vyvést, tiše by se na pokrytí nedostalo — tenhle invariant to nedovolí.
  it('každé top-level z.object schéma je i exportované', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'schemas.js'), 'utf-8');
    const deklarovana = [...src.matchAll(/^const\s+(\w+)\s*=\s*z\.object\(/gm)].map((m) => m[1]);
    expect(deklarovana.length).toBeGreaterThan(20);
    const chybi = deklarovana.filter((name) => !(name in schemas));
    expect(chybi).toEqual([]);
  });

  it.each(all)('%s', (name, schema) => {
    const r = sample(schema);
    if (!r.ok) {
      throw new Error(
        `Schéma "${name}" nepřijme žádný vstup, který z jeho definice jde vyrobit.\n`
        + `Endpoint za ním vrací 400 na každý požadavek.\n  ${r.why}`
      );
    }
    expect(schema.safeParse(r.value).success).toBe(true);
  });
});
