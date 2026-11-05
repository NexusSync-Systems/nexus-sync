#!/usr/bin/env node
/**
 * Založí testovací agenturu, operátorské účty a profily.
 *
 * SPOUŠTÍ TO ČLOVĚK, ne automat. Zakládá to účty na ostrém serveru, a to je
 * rozhodnutí, které má udělat někdo, kdo za ten server odpovídá.
 *
 *   node scripts/nachystej-testovaci-agenturu.js
 *
 * Co udělá, v tomhle pořadí:
 *   1. POST /api/auth/register-agency   agentura + účet správce
 *   2. POST /api/auth/login             přihlášení, získání tokenu
 *   3. GET  /api/agency/settings        vytažení kódu pozvánky
 *   4. POST /api/auth/register-user     operátorské účty (podle kódu pozvánky)
 *   5. POST /api/profiles               profily
 *   6. PATCH /api/profiles/:id/assignees  přiřazení profilu operátorce
 *
 * HESLA:
 *   - Heslo správce se zadává do výzvy a NEVYPISUJE se. Nejde argumentem,
 *     protože argumenty vidí v `ps` všichni uživatelé stroje.
 *   - Hesla operátorek se vygenerují a zapíší do souboru s právy 600,
 *     ne na obrazovku. Ve výpisu terminálu a v historii příkazů nemají co dělat.
 *
 * ÚDAJE JSOU SMYŠLENÉ. Žádná skutečná jména, telefony ani adresy — jsou to
 * testovací data na ostrém serveru a není důvod tam dávat cokoli skutečného.
 *
 * Když agentura s tím e-mailem už existuje, registrace se přeskočí a skript
 * jen pokračuje přihlášením. Dá se tedy pustit znovu.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ZAKLAD = (process.env.NEXUS_API || 'https://api.nexusstack.eu').replace(/\/+$/, '');
const EMAIL_SPRAVCE = process.env.NEXUS_TEST_EMAIL || 'test-admin@nexusstack.eu';
const NAZEV_AGENTURY = process.env.NEXUS_TEST_AGENTURA || 'Testovaci agentura';
const KAM_HESLA = process.env.NEXUS_TEST_HESLA || path.join(process.env.HOME || '.', 'nexus-testovaci-ucty.txt');

// Smyšlená data. Telefony jsou z rozsahu 555, který se v ČR nepřiděluje.
const OPERATORKY = [
  { fullName: 'Testovaci Operatorka Prvni',  email: 'test-op1@nexusstack.eu' },
  { fullName: 'Testovaci Operatorka Druha',  email: 'test-op2@nexusstack.eu' },
];
const PROFILY = [
  { name: 'Testovaci profil A', phoneNumber: '+420555000101' },
  { name: 'Testovaci profil B', phoneNumber: '+420555000102' },
  { name: 'Testovaci profil C', phoneNumber: '+420555000103' },
];

// ── Pomůcky ────────────────────────────────────────────────────────────────

// ── Heslo ze souboru, ne z výzvy ───────────────────────────────────────────
//
// Původně tu byla interaktivní výzva s potlačeným echem. Nefungovala: readline
// si při přesměrovaném vstupu přečte řádek dřív, než je otázka položená, takže
// se callback nikdy nezavolal a skript tiše skončil. Vyzkoušeno.
//
// Soubor je navíc v tomhle projektu zavedený způsob (`--passphrase-file`
// u záloh): heslo se neobjeví v historii příkazů ani ve výpisu procesů
// a celá cesta jde otestovat.
const HESLO_SOUBOR = process.env.NEXUS_TEST_HESLO_FILE
  || path.join(process.env.HOME || '.', '.nexus-test-admin-heslo');

const nactiHeslo = () => {
  if (!fs.existsSync(HESLO_SOUBOR)) return null;
  return fs.readFileSync(HESLO_SOUBOR, 'utf8').split('\n')[0].trim();
};

const skonci = (kod) => process.exit(kod);

// Heslo splňuje pravidla z authController.validatePassword:
// aspoň 8 znaků, jedno velké písmeno, jedna číslice.
const vyrobHeslo = () => 'T' + crypto.randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '') + '7';

async function zavolej(cesta, { metoda = 'GET', telo, token } = {}) {
  const hlavicky = { 'Content-Type': 'application/json' };
  if (token) hlavicky.Authorization = `Bearer ${token}`;
  const odpoved = await fetch(`${ZAKLAD}${cesta}`, {
    method: metoda,
    headers: hlavicky,
    body: telo ? JSON.stringify(telo) : undefined,
  });
  let data = null;
  try { data = await odpoved.json(); } catch { /* prázdná odpověď */ }
  return { stav: odpoved.status, ok: odpoved.ok, data };
}

// ── Hlavní běh ─────────────────────────────────────────────────────────────

(async () => {
  console.log('');
  console.log('  Nachystání testovací agentury');
  console.log('  ─────────────────────────────');
  console.log(`  server:   ${ZAKLAD}`);
  console.log(`  agentura: ${NAZEV_AGENTURY}`);
  console.log(`  správce:  ${EMAIL_SPRAVCE}`);
  console.log(`  vytvoří:  ${OPERATORKY.length} operátorské účty, ${PROFILY.length} profily`);
  console.log('');
  console.log('  POZOR: tohle zakládá skutečné účty na uvedeném serveru.');
  console.log('');

  // Potvrzení přepínačem, ne otázkou: zakládá to účty na ostrém serveru,
  // takže se to nesmí spustit omylem — a přepínač se dá otestovat.
  if (!process.argv.includes('--ano')) {
    console.log('  Nic jsem neudělal. Pro skutečné spuštění přidej přepínač --ano:');
    console.log('      node scripts/nachystej-testovaci-agenturu.js --ano');
    console.log('');
    return skonci(0);
  }

  const heslo = nactiHeslo();
  if (!heslo) {
    console.error(`  ❌ Nenašel jsem heslo v ${HESLO_SOUBOR}.`);
    console.error('');
    console.error('     Vytvoř ho tak, aby se neuložilo do historie příkazů:');
    console.error(`         (umask 077; printf '%s\\n' 'TvojeHeslo1' > ${HESLO_SOUBOR})`);
    console.error('');
    console.error('     Pravidla serveru: aspoň 8 znaků, velké písmeno, číslice.');
    return skonci(1);
  }
  if (heslo.length < 8 || !/[A-Z]/.test(heslo) || !/[0-9]/.test(heslo)) {
    console.error('  ❌ Heslo nesplňuje pravidla serveru (8 znaků, velké písmeno, číslice). Nic se neodeslalo.');
    return skonci(1);
  }

  // ── 1. Agentura ──
  const reg = await zavolej('/api/auth/register-agency', {
    metoda: 'POST',
    telo: { agencyName: NAZEV_AGENTURY, fullName: 'Spravce testovaci agentury', email: EMAIL_SPRAVCE, password: heslo },
  });
  if (reg.ok) {
    console.log('  ✅ Agentura založena.');
  } else if (reg.stav === 400 || reg.stav === 409) {
    // Nejčastěji „e-mail už existuje". Není to důvod skončit — skript má jít
    // pustit znovu, aby se daly doplnit profily k už existující agentuře.
    console.log(`  ℹ️  Agentura se nezaložila (${reg.stav}: ${reg.data?.message || 'bez zprávy'}).`);
    console.log('     Pokud už existuje, pokračuji přihlášením.');
  } else {
    console.error(`  ❌ Registrace selhala (${reg.stav}): ${reg.data?.message || 'bez zprávy'}`);
    return skonci(1);
  }

  // ── 2. Přihlášení ──
  const prihlaseni = await zavolej('/api/auth/login', { metoda: 'POST', telo: { email: EMAIL_SPRAVCE, password: heslo } });
  if (!prihlaseni.ok || !prihlaseni.data?.token) {
    console.error(`  ❌ Přihlášení selhalo (${prihlaseni.stav}): ${prihlaseni.data?.message || 'bez zprávy'}`);
    console.error('     Když agentura existuje z dřívějška, heslo musí být to její.');
    return skonci(1);
  }
  const token = prihlaseni.data.token;
  console.log('  ✅ Přihlášeno.');

  // ── 3. Kód pozvánky ──
  const nastaveni = await zavolej('/api/agency/settings', { token });
  const kodPozvanky = nastaveni.data?.inviteCode;
  if (!kodPozvanky) {
    console.error('  ❌ Nepodařilo se získat kód pozvánky, bez něj nejdou založit operátorské účty.');
    return skonci(1);
  }

  // ── 4. Operátorské účty ──
  const zalozeneUcty = [];
  for (const o of OPERATORKY) {
    const hesloOperatorky = vyrobHeslo();
    const r = await zavolej('/api/auth/register-user', {
      metoda: 'POST',
      telo: { fullName: o.fullName, email: o.email, password: hesloOperatorky, inviteCode: kodPozvanky },
    });
    if (r.ok) {
      zalozeneUcty.push({ email: o.email, heslo: hesloOperatorky });
      console.log(`  ✅ Účet ${o.email}`);
    } else {
      console.log(`  ⚠️  Účet ${o.email} se nezaložil (${r.stav}: ${r.data?.message || 'bez zprávy'})`);
    }
  }

  // ── 5. Profily ──
  const zalozeneProfily = [];
  for (const p of PROFILY) {
    const r = await zavolej('/api/profiles', { metoda: 'POST', telo: p, token });
    const id = r.data?.id || r.data?.profile?.id;
    if (r.ok && id) {
      zalozeneProfily.push({ id, name: p.name });
      console.log(`  ✅ Profil ${p.name}`);
    } else {
      console.log(`  ⚠️  Profil ${p.name} se nezaložil (${r.stav}: ${r.data?.message || 'bez zprávy'})`);
    }
  }

  // ── 6. Přiřazení ──
  // Potřebné proto, aby měl relay telefon co spárovat: binding se váže
  // na profil a operátorka musí k tomu profilu mít přístup.
  // `/api/agency/users` vrací prosté pole (agencyController.getUsers) a je
  // dostupné jen manažerské roli. Když se seznam nepodaří načíst, přiřazení
  // by tiše neproběhlo a profily by zůstaly bez operátorky — relay by pak
  // neměl co spárovat a vypadalo by to jako chyba párování.
  const uzivatele = await zavolej('/api/agency/users', { token });
  const seznam = Array.isArray(uzivatele.data) ? uzivatele.data : (uzivatele.data?.users || []);
  if (seznam.length === 0) {
    console.log(`  ⚠️  Seznam uživatelů se nenačetl (${uzivatele.stav}) — profily zůstanou bez přiřazení.`);
  }
  for (let i = 0; i < zalozeneProfily.length; i++) {
    const ocekavany = OPERATORKY[i % OPERATORKY.length]?.email;
    const ucet = seznam.find((u) => u.email === ocekavany);
    if (!ucet?.id) {
      if (seznam.length > 0) console.log(`  ⚠️  Účet ${ocekavany} v seznamu není, ${zalozeneProfily[i].name} nepřiřazuji.`);
      continue;
    }
    const r = await zavolej(`/api/profiles/${zalozeneProfily[i].id}/assignees`, {
      metoda: 'PATCH', token, telo: { userIds: [ucet.id] },
    });
    console.log(r.ok
      ? `  ✅ ${zalozeneProfily[i].name} → ${ucet.email}`
      : `  ⚠️  Přiřazení ${zalozeneProfily[i].name} selhalo (${r.stav})`);
  }

  // ── Hesla do souboru, ne na obrazovku ──
  if (zalozeneUcty.length > 0) {
    const obsah = [
      '# Testovací účty Nexus Hub — vygeneroval scripts/nachystej-testovaci-agenturu.js',
      `# server: ${ZAKLAD}`,
      `# vytvořeno: ${new Date().toISOString()}`,
      '#',
      '# Heslo správce tady NENÍ, to sis zvolil sám.',
      '',
      ...zalozeneUcty.map((u) => `${u.email}\t${u.heslo}`),
      '',
    ].join('\n');
    fs.writeFileSync(KAM_HESLA, obsah, { mode: 0o600 });
    console.log('');
    console.log(`  🔑 Hesla operátorek jsou v ${KAM_HESLA} (práva 600).`);
    console.log('     Na obrazovku je nevypisuju — zůstala by v historii terminálu.');
  }

  console.log('');
  console.log(`  Hotovo: ${zalozeneUcty.length} účtů, ${zalozeneProfily.length} profilů.`);
  console.log('  Teď půjde spárovat relay telefon s některým z těch profilů.');
  console.log('');
  skonci(0);
})().catch((e) => {
  console.error('  ❌ Neočekávaná chyba:', e.message);
  skonci(1);
});
