#!/usr/bin/env node
/**
 * Založí testovací agenturu, operátorské účty a profily.
 *
 * SPOUŠTÍ TO ČLOVĚK, ne automat. Zakládá to účty na ostrém serveru, a to je
 * rozhodnutí, které má udělat někdo, kdo za ten server odpovídá.
 *
 *   (umask 077; printf '%s\n' 'TvojeHeslo1' > ~/.nexus-test-admin-heslo)
 *   node scripts/nachystej-testovaci-agenturu.js --ano
 *
 * Bez `--ano` jen vypíše, co by udělal, a skončí.
 *
 * Co udělá, v tomhle pořadí:
 *   1. POST  /api/auth/register-agency     agentura + účet správce
 *   2. POST  /api/auth/login               přihlášení a KONTROLA, kam vede
 *   3. GET   /api/agency/settings          kód pozvánky
 *   4. POST  /api/auth/register-user       operátorské účty
 *   5. GET   /api/profiles + POST          profily (existující se přeskočí)
 *   6. PATCH /api/profiles/:id/assignees   přiřazení profilu operátorce
 *
 * HESLA:
 *   - Heslo správce se čte ze souboru, ne z výzvy ani z argumentu. Argumenty
 *     vidí v `ps` všichni uživatelé stroje.
 *   - Hesla operátorek se generují a zapisují do souboru IHNED po založení
 *     každého účtu, ne až na konci. Kdyby skript mezitím spadl, účet by na
 *     serveru zůstal s heslem, které už nikdo nezjistí.
 *
 * ÚDAJE JSOU SMYŠLENÉ. Telefony jsou z rozsahu 555, který se v ČR nepřiděluje.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ZAKLAD = (process.env.NEXUS_API || 'https://api.nexusstack.eu').replace(/\/+$/, '');
const EMAIL_SPRAVCE = process.env.NEXUS_TEST_EMAIL || 'test-admin@nexusstack.eu';
const NAZEV_AGENTURY = process.env.NEXUS_TEST_AGENTURA || 'Testovaci agentura';
const KAM_HESLA = process.env.NEXUS_TEST_HESLA || path.join(process.env.HOME || '.', 'nexus-testovaci-ucty.txt');
const HESLO_SOUBOR = process.env.NEXUS_TEST_HESLO_FILE || path.join(process.env.HOME || '.', '.nexus-test-admin-heslo');
const CASOVY_LIMIT_MS = 15000;

const OPERATORKY = [
  { fullName: 'Testovaci Operatorka Prvni', email: 'test-op1@nexusstack.eu' },
  { fullName: 'Testovaci Operatorka Druha', email: 'test-op2@nexusstack.eu' },
];
const PROFILY = [
  { name: 'Testovaci profil A', phoneNumber: '+420555000101' },
  { name: 'Testovaci profil B', phoneNumber: '+420555000102' },
  { name: 'Testovaci profil C', phoneNumber: '+420555000103' },
];

let selhani = 0;
const skonci = (kod) => process.exit(kod);

// ── Heslo ──────────────────────────────────────────────────────────────────
//
// Pravidla NEJSOU jen ta z authController.validatePassword. Dřív než controller
// běží `validate(registerAgency)` a zod `strongPassword` v schemas.js vyžaduje
// NAVÍC malé písmeno. Původní verze tohohle skriptu ho přehlížela: heslo bez
// malého písmene propustila, server vrátil 400, skript to vydal za „agentura
// už existuje" a poslal uživatele hledat problém, který neexistoval.
const PRAVIDLA = 'aspoň 8 znaků, velké písmeno, malé písmeno a číslice';
const hesloSedi = (h) => h.length >= 8 && /[A-Z]/.test(h) && /[a-z]/.test(h) && /[0-9]/.test(h);

const nactiHeslo = () => {
  if (!fs.existsSync(HESLO_SOUBOR)) return null;
  // Ořezává se jen konec řádku, ne mezery — ty můžou být součástí hesla.
  // Jinak by skript odeslal jiné heslo, než jaké má uživatel zapsané,
  // a 401 by si nevysvětlil.
  return fs.readFileSync(HESLO_SOUBOR, 'utf8').split('\n')[0].replace(/\r$/, '');
};

// Vynucuje všechny čtyři požadavky. Předchozí verze malé písmeno jen doufala
// a přibližně jedno heslo z 3 800 ho nemělo — takový účet by selhal na 400
// a zapadl mezi varováními.
const vyrobHeslo = () => {
  const telo = crypto.randomBytes(18).toString('base64url').replace(/[^A-Za-z0-9]/g, '');
  return `T${telo}a7`;
};

// ── Soubor s hesly ─────────────────────────────────────────────────────────
//
// Dvě pasti, obě ověřené:
//   - `writeFileSync(..., { mode })` nastaví práva JEN při vytvoření souboru.
//     Na už existující soubor s právy 644 by se hesla zapsala čitelně pro
//     všechny. Proto se práva nastavují na otevřeném deskriptoru.
//   - `writeFileSync` soubor zkrátí. Při druhém běhu by přepsal hesla
//     z prvního, zatímco účty na serveru zůstanou. Proto se připisuje.
const zapisUcet = (email, heslo) => {
  const fd = fs.openSync(KAM_HESLA, 'a', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    if (fs.fstatSync(fd).size === 0) {
      fs.writeSync(fd, [
        '# Testovací účty Nexus Hub — scripts/nachystej-testovaci-agenturu.js',
        '# Heslo správce tady NENÍ, to sis zvolil sám.',
        '',
      ].join('\n') + '\n');
    }
    fs.writeSync(fd, `${new Date().toISOString()}\t${ZAKLAD}\t${email}\t${heslo}\n`);
  } finally {
    fs.closeSync(fd);
  }
};

// ── Volání API ─────────────────────────────────────────────────────────────
async function zavolej(cesta, { metoda = 'GET', telo, token } = {}) {
  const hlavicky = { 'Content-Type': 'application/json' };
  if (token) hlavicky.Authorization = `Bearer ${token}`;
  // Bez časového limitu čeká undici na odpověď 300 s a mlčí. Host, který
  // spojení přijme a neodpoví, je přitom přesně to, co dělá zahozený provoz
  // na firewallu — a na tomhle serveru pouští iptables jen port 22.
  const odpoved = await fetch(`${ZAKLAD}${cesta}`, {
    method: metoda,
    headers: hlavicky,
    body: telo ? JSON.stringify(telo) : undefined,
    signal: AbortSignal.timeout(CASOVY_LIMIT_MS),
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

  if (!process.argv.includes('--ano')) {
    console.log('  Nic jsem neudělal. Pro skutečné spuštění přidej přepínač --ano:');
    console.log('      node scripts/nachystej-testovaci-agenturu.js --ano');
    console.log('');
    return skonci(0);
  }

  if (!ZAKLAD.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(ZAKLAD)) {
    console.error(`  ❌ ${ZAKLAD} není https. Heslo správce by šlo po síti čitelné. Končím.`);
    return skonci(1);
  }

  const heslo = nactiHeslo();
  if (!heslo) {
    console.error(`  ❌ Nenašel jsem heslo v ${HESLO_SOUBOR}.`);
    console.error('');
    console.error('     Vytvoř ho tak, aby se neuložilo do historie příkazů:');
    console.error(`         (umask 077; printf '%s\\n' 'TvojeHeslo1' > ${HESLO_SOUBOR})`);
    console.error('');
    console.error(`     Pravidla serveru: ${PRAVIDLA}.`);
    return skonci(1);
  }
  if (!hesloSedi(heslo)) {
    console.error(`  ❌ Heslo nesplňuje pravidla serveru (${PRAVIDLA}). Nic se neodeslalo.`);
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
    // Může to být „e-mail už existuje" (pak se pokračuje), ale i obyčejná
    // chyba validace. Vypisuje se proto zpráva serveru, ne vlastní výklad —
    // dřív to skript vydával za „už existuje" i u úplně jiné chyby.
    console.log(`  ℹ️  Registrace neproběhla — server vrátil ${reg.stav}: ${reg.data?.message || 'bez zprávy'}`);
    console.log('     Zkouším přihlášení; pokud agentura existuje z dřívějška, je to v pořádku.');
  } else {
    console.error(`  ❌ Registrace selhala (${reg.stav}): ${reg.data?.message || 'bez zprávy'}`);
    return skonci(1);
  }

  // ── 2. Přihlášení A KONTROLA, KAM VEDE ──
  const prihlaseni = await zavolej('/api/auth/login', { metoda: 'POST', telo: { email: EMAIL_SPRAVCE, password: heslo } });
  if (!prihlaseni.ok || !prihlaseni.data?.token) {
    console.error(`  ❌ Přihlášení selhalo (${prihlaseni.stav}): ${prihlaseni.data?.message || 'bez zprávy'}`);
    return skonci(1);
  }
  const token = prihlaseni.data.token;

  // Nejdůležitější pojistka v celém skriptu. Bez ní by stačilo, aby
  // nakonfigurovaný e-mail patřil skutečnému účtu, a skript by do jeho
  // OSTRÉ agentury v tichosti nasypal dva účty a tři testovací profily —
  // a u všech kroků vypsal ✅.
  const kdeJsem = prihlaseni.data.user?.agencyName;
  if (kdeJsem !== NAZEV_AGENTURY) {
    console.error(`  ❌ Přihlášen do agentury "${kdeJsem ?? 'neznámá'}", ale čekal jsem "${NAZEV_AGENTURY}".`);
    console.error('     Nic dalšího nedělám — do cizí agentury zapisovat nebudu.');
    return skonci(1);
  }
  console.log(`  ✅ Přihlášeno do agentury "${kdeJsem}".`);

  // ── 3. Kód pozvánky ──
  const nastaveni = await zavolej('/api/agency/settings', { token });
  const kodPozvanky = nastaveni.data?.inviteCode;
  if (!kodPozvanky) {
    console.error(`  ❌ Nepodařilo se získat kód pozvánky (${nastaveni.stav}), bez něj nejdou založit účty.`);
    return skonci(1);
  }

  // ── 4. Operátorské účty ──
  let zalozenoUctu = 0;
  for (const o of OPERATORKY) {
    const hesloOperatorky = vyrobHeslo();
    const r = await zavolej('/api/auth/register-user', {
      metoda: 'POST',
      telo: { fullName: o.fullName, email: o.email, password: hesloOperatorky, inviteCode: kodPozvanky },
    });
    if (r.ok) {
      // Zápis IHNED, ne na konci. Kdyby skript spadl o krok dál, účet by na
      // serveru zůstal a jeho heslo by už nikdo nezjistil.
      zapisUcet(o.email, hesloOperatorky);
      zalozenoUctu++;
      console.log(`  ✅ Účet ${o.email}`);
    } else {
      selhani++;
      console.log(`  ⚠️  Účet ${o.email} se nezaložil (${r.stav}: ${r.data?.message || 'bez zprávy'})`);
    }
  }

  // ── 5. Profily ──
  //
  // Profil nemá v databázi unikátní omezení na jméno ani telefon
  // (prisma/schema.prisma) a `createProfile` nic nekontroluje. Bez tohohle
  // kroku by druhý běh nadělal další tři stejně pojmenované profily — a při
  // párování relay telefonu by pak bylo hádání, který z nich je ten pravý.
  const stavajici = await zavolej('/api/profiles', { token });
  const uzExistuji = new Set(
    (Array.isArray(stavajici.data) ? stavajici.data : (stavajici.data?.profiles || []))
      .map((p) => p?.name).filter(Boolean)
  );

  const zalozeneProfily = [];
  for (const p of PROFILY) {
    if (uzExistuji.has(p.name)) {
      console.log(`  ℹ️  Profil ${p.name} už existuje, nezakládám znovu.`);
      continue;
    }
    const r = await zavolej('/api/profiles', { metoda: 'POST', telo: p, token });
    const id = r.data?.id;
    if (r.ok && id) {
      zalozeneProfily.push({ id, name: p.name });
      console.log(`  ✅ Profil ${p.name}`);
    } else {
      selhani++;
      console.log(`  ⚠️  Profil ${p.name} se nezaložil (${r.stav}: ${r.data?.message || 'bez zprávy'})`);
    }
  }

  // ── 6. Přiřazení ──
  if (zalozeneProfily.length > 0) {
    const uzivatele = await zavolej('/api/agency/users', { token });
    const seznam = Array.isArray(uzivatele.data) ? uzivatele.data : (uzivatele.data?.users || []);
    if (seznam.length === 0) {
      selhani++;
      console.log(`  ⚠️  Seznam uživatelů se nenačetl (${uzivatele.stav}) — profily zůstanou bez přiřazení.`);
    }
    for (let i = 0; i < zalozeneProfily.length; i++) {
      const ocekavany = OPERATORKY[i % OPERATORKY.length]?.email;
      const ucet = seznam.find((u) => u.email === ocekavany);
      if (!ucet?.id) {
        if (seznam.length > 0) {
          selhani++;
          console.log(`  ⚠️  Účet ${ocekavany} v seznamu není, ${zalozeneProfily[i].name} nepřiřazuji.`);
        }
        continue;
      }
      const r = await zavolej(`/api/profiles/${zalozeneProfily[i].id}/assignees`, {
        metoda: 'PATCH', token, telo: { userIds: [ucet.id] },
      });
      if (r.ok) {
        console.log(`  ✅ ${zalozeneProfily[i].name} → ${ucet.email}`);
      } else {
        selhani++;
        console.log(`  ⚠️  Přiřazení ${zalozeneProfily[i].name} selhalo (${r.stav})`);
      }
    }
  }

  // ── Závěr ──
  console.log('');
  if (zalozenoUctu > 0) {
    console.log(`  🔑 Hesla operátorek jsou v ${KAM_HESLA} (práva 600).`);
    console.log('     Na obrazovku je nevypisuju — zůstala by v historii terminálu.');
  }
  console.log(`  Založeno: ${zalozenoUctu} účtů, ${zalozeneProfily.length} profilů.`);

  // Dřív tu stálo „Hotovo" a návratový kód 0 i ve chvíli, kdy nevzniklo nic.
  // Skript, který hlásí úspěch po neúspěchu, je horší než skript, který spadne.
  if (selhani > 0) {
    console.log(`  ⚠️  ${selhani} krok(ů) selhalo — viz varování výš. Končím nenulově.`);
    console.log('');
    return skonci(1);
  }
  console.log('  Teď půjde spárovat relay telefon s některým z těch profilů.');
  console.log('');
  return skonci(0);
})().catch((e) => {
  // `fetch failed` je u undici vždy stejné; skutečná příčina (ECONNREFUSED,
  // ENOTFOUND, vypršený limit, certifikát) je až v `cause`.
  const proc = e?.cause?.message || e?.message || String(e);
  console.error(`  ❌ Neočekávaná chyba: ${proc}`);
  skonci(1);
});
