/**
 * Založí modelkám účty a přiřadí jim vlastnictví jejich profilu.
 *
 * Proč je to potřeba: #184 přidalo `Profile.ownerId`, takže vazba „čí profil
 * to je" už ve schématu existuje. Jenže sloupec je u všech profilů prázdný
 * a modelky žádné účty nemají. Dokud se to nedoplní, hlásí se relay telefon
 * modelky pořád účtem operátorky a audit ukazuje na špatného člověka —
 * tedy přesně to, co #184 mělo odstranit.
 *
 * #184 dalo možnost. Tenhle skript ji použije na data, která už existují.
 *
 * VÝCHOZÍ CHOVÁNÍ JE JEN VÝPIS. Zapisuje se až s `--ano`.
 *
 *   node scripts/zaloz-ucty-modelek.js                    # ukáže, co by udělal
 *   node scripts/zaloz-ucty-modelek.js --ano              # provede to
 *   node scripts/zaloz-ucty-modelek.js --domena=firma.cz  # e-maily na téhle doméně
 *   node scripts/zaloz-ucty-modelek.js --agentura=<id>    # jen jedna agentura
 *
 * POZOR NA VÝSTUP: při `--ano` se vypíšou vygenerovaná hesla. Je to jediná
 * chvíle, kdy je kdokoli uvidí — v databázi je jen bcrypt hash. Výpis proto
 * nikam nekopíruj: repozitář je VEŘEJNÝ, takže ani do commitu, ani do CI,
 * ani do issue. Předej je modelkám jinou cestou a nech si je změnit.
 */
const path = require('path');
// Cesta k `.env` se odvozuje od UMÍSTĚNÍ SKRIPTU, ne od pracovního adresáře.
// Na serveru je kořen serverové části `/root/nexus-backend`, takže
// `__dirname/..` je přesně ono. Bez toho by `DATABASE_URL` chybělo pokaždé,
// když se skript nespustí z toho adresáře — a Prisma by neřekla proč.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { dataRole } = require('../src/config/vychoziRole');

/** Role, pod kterou modelka vzniká. Musí být v ZNAME_ROLE. */
const ROLE_MODELKY = 'Model';

// ── e-mail ───────────────────────────────────────────────────────────────

const BEZ_DIAKRITIKY = (s) =>
  String(s || '')
    .normalize('NFD')
    // Diakritiku zahodíme až po rozkladu, takže „Tereza Čápová" nedá
    // „tereza.cpov" ale „tereza.capova".
    .replace(/[̀-ͯ]/g, '');

/**
 * Jméno profilu → lokální část e-mailu.
 *
 * Záměrně je to čistá funkce bez databáze: je to jediné místo, kde se
 * rozhoduje, jak se účet bude jmenovat, a chci to mít pokryté testem.
 */
const localniCast = (nazev) => {
  const zaklad = BEZ_DIAKRITIKY(nazev)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return zaklad || null;
};

/** Domena z e-mailu, nebo null. */
const domenaZEmailu = (email) => {
  const kus = String(email || '').split('@')[1];
  return kus && kus.includes('.') ? kus.toLowerCase() : null;
};

// ── heslo ────────────────────────────────────────────────────────────────

// Bez znaků, které se na displeji pletou (l/I/1, O/0) — heslo se opisuje
// z výpisu do telefonu, takže čitelnost je tu funkční požadavek, ne kosmetika.
const SOUHLASKY = 'bcdfghjkmnprstvz';
const SAMOHLASKY = 'aeuy';
// Číslice taky, a ze stejného důvodu: 0 se plete s O a 1 s l/I. Bez tohohle
// řádku by generátor sliboval čitelnost, kterou by u dvou číslic porušoval.
const CISLICE = '23456789';

const slabika = () =>
  SOUHLASKY[crypto.randomInt(SOUHLASKY.length)] + SAMOHLASKY[crypto.randomInt(SAMOHLASKY.length)];

const slovo = (slabik) => Array.from({ length: slabik }, slabika).join('');

/**
 * Heslo, které jde opsat do telefonu a přitom projde `validatePassword`
 * z authControlleru (≥ 8 znaků, velké písmeno, číslice).
 *
 * Tvar: Xxxxxx-xxxxxx-NN, např. „Mekaru-tyzafo-47".
 */
const vygenerujHeslo = () => {
  const prvni = slovo(3);
  const druhe = slovo(3);
  const cislice = CISLICE[crypto.randomInt(CISLICE.length)] + CISLICE[crypto.randomInt(CISLICE.length)];
  return `${prvni[0].toUpperCase()}${prvni.slice(1)}-${druhe}-${cislice}`;
};

// ── rozhodování ──────────────────────────────────────────────────────────

/**
 * Co udělat s jedním profilem. Čistá funkce — žádná databáze, žádný zápis.
 *
 * Vrací `{ co, duvod }`, kde `co` je jedno z:
 *   'hotovo'   — profil už vlastníka má, nic nedělat
 *   'navazat'  — účet s tím e-mailem existuje a je použitelný, jen doplnit ownerId
 *   'zalozit'  — účet neexistuje, založit ho a navázat
 *   'kolize'   — nejde to a je potřeba člověk (důvod je v `duvod`)
 */
const rozhodniProfil = ({ profil, email, existujiciUcet, jizPouziteEmaily = [] }) => {
  if (profil.ownerId) {
    return { co: 'hotovo', duvod: 'vlastníka už má' };
  }
  if (!email) {
    return { co: 'kolize', duvod: 'z názvu profilu nejde udělat e-mail' };
  }
  if (jizPouziteEmaily.includes(email)) {
    // Dva profily stejného názvu v jedné agentuře. Druhý by spadl na
    // `User.email @unique` až při zápisu — radši to řeknu dřív a jasně.
    return { co: 'kolize', duvod: `e-mail ${email} by vznikl dvakrát (shodné názvy profilů)` };
  }
  if (!existujiciUcet) {
    return { co: 'zalozit', duvod: null };
  }
  if (existujiciUcet.ownedProfile && existujiciUcet.ownedProfile.id !== profil.id) {
    // `Profile.ownerId` je @unique: jeden účet = nejvýš jeden profil.
    return {
      co: 'kolize',
      duvod: `účet ${email} už vlastní profil ${existujiciUcet.ownedProfile.name}`
    };
  }
  if (existujiciUcet.agencyId && existujiciUcet.agencyId !== profil.agencyId) {
    return { co: 'kolize', duvod: `účet ${email} patří jiné agentuře` };
  }
  return { co: 'navazat', duvod: null };
};

// ── vlastní průchod ──────────────────────────────────────────────────────

async function zalozUctyModelek({ prisma, zapsat = false, domena = null, agenturaFiltr = null }) {
  const vysledek = { zalozeno: 0, navazano: 0, hotovo: 0, kolize: 0, hesla: [] };

  const kdeAgentura = agenturaFiltr
    ? { OR: [{ id: agenturaFiltr }, { name: agenturaFiltr }] }
    : {};
  const agentury = await prisma.agency.findMany({
    where: kdeAgentura,
    select: { id: true, name: true }
  });

  if (!agentury.length) {
    console.log(agenturaFiltr ? `Agentura „${agenturaFiltr}" neexistuje.` : 'Žádná agentura.');
    return vysledek;
  }

  for (const agentura of agentury) {
    console.log(`\n=== ${agentura.name} ===`);

    const profily = await prisma.profile.findMany({
      where: { agencyId: agentura.id },
      select: { id: true, name: true, ownerId: true, agencyId: true },
      orderBy: { name: 'asc' }
    });
    if (!profily.length) {
      console.log('  (žádné profily)');
      continue;
    }

    // Domena: z parametru, jinak podle e-mailů, které v agentuře už jsou.
    // Hádat ji nebudu — špatná domena znamená účet, na který se nikdo
    // nepřihlásí a který pak musí někdo ručně mazat.
    let domenaAgentury = domena;
    if (!domenaAgentury) {
      const vzor = await prisma.user.findFirst({
        where: { agencyId: agentura.id },
        select: { email: true },
        orderBy: { createdAt: 'asc' }
      });
      domenaAgentury = domenaZEmailu(vzor?.email);
    }
    if (!domenaAgentury) {
      console.log('  ⚠ Nevím, jakou domenu dát e-mailům. Doplň --domena=…');
      vysledek.kolize += profily.filter((p) => !p.ownerId).length;
      continue;
    }

    // Role „Model" se při vzniku agentury nezakládá (viz vychoziRole.js),
    // takže ji tu většinou budu zakládat poprvé.
    let role = await prisma.role.findFirst({
      where: { agencyId: agentura.id, name: ROLE_MODELKY },
      select: { id: true }
    });
    if (!role) {
      console.log(`  role ${ROLE_MODELKY}: CHYBÍ, založí se`);
      if (zapsat) {
        role = await prisma.role.create({
          data: dataRole(ROLE_MODELKY, agentura.id, null),
          select: { id: true }
        });
      }
    }

    const jizPouziteEmaily = [];

    for (const profil of profily) {
      const lokalni = localniCast(profil.name);
      const email = lokalni ? `${lokalni}@${domenaAgentury}` : null;

      const existujiciUcet = email
        ? await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            agencyId: true,
            ownedProfile: { select: { id: true, name: true } }
          }
        })
        : null;

      const { co, duvod } = rozhodniProfil({ profil, email, existujiciUcet, jizPouziteEmaily });

      if (co === 'hotovo') {
        console.log(`  ${profil.name}: ${duvod}`);
        vysledek.hotovo++;
        continue;
      }
      if (co === 'kolize') {
        console.log(`  ${profil.name}: ⚠ ${duvod}`);
        vysledek.kolize++;
        continue;
      }
      if (email) jizPouziteEmaily.push(email);

      if (co === 'navazat') {
        console.log(`  ${profil.name}: účet ${email} existuje → doplní se vlastnictví`);
        vysledek.navazano++;
        if (zapsat) {
          await prisma.profile.update({
            where: { id: profil.id },
            data: { ownerId: existujiciUcet.id }
          });
        }
        continue;
      }

      // 'zalozit'
      console.log(`  ${profil.name}: založí se účet ${email}`);
      vysledek.zalozeno++;
      if (!zapsat) continue;

      const heslo = vygenerujHeslo();
      // Účet a vlastnictví v jedné transakci: účet modelky bez navázaného
      // profilu je přihlášení, které nic nevidí, a profil s odkazem na
      // neexistující účet by neprošel cizím klíčem. Buď obojí, nebo nic.
      await prisma.$transaction(async (tx) => {
        const ucet = await tx.user.create({
          data: {
            email,
            name: profil.name,
            password: await bcrypt.hash(heslo, 12),
            roleId: role.id,
            agencyId: agentura.id
          },
          select: { id: true }
        });
        await tx.profile.update({ where: { id: profil.id }, data: { ownerId: ucet.id } });
      });
      vysledek.hesla.push({ profil: profil.name, email, heslo });
    }
  }

  return vysledek;
}

// ── výpis ────────────────────────────────────────────────────────────────

function vypisSouhrn(v, zapsat) {
  const zmen = v.zalozeno + v.navazano;
  console.log('\n--- souhrn ---');
  console.log(`  už v pořádku:        ${v.hotovo}`);
  console.log(`  účtů k založení:     ${v.zalozeno}`);
  console.log(`  vlastnictví doplnit: ${v.navazano}`);
  console.log(`  vyžaduje člověka:    ${v.kolize}`);

  if (v.hesla.length) {
    console.log('\n--- HESLA (vidíš je teď jedinkrát, v databázi je jen hash) ---');
    for (const h of v.hesla) {
      console.log(`  ${h.profil}\n    ${h.email}\n    ${h.heslo}`);
    }
    console.log('\n  Nikam je nekopíruj — repozitář je veřejný. Předej je a nech změnit.');
  }

  if (zmen === 0) {
    console.log(v.kolize ? '\nNic k založení, ale něco chce člověka (výše).' : '\nNic k založení.');
  } else if (!zapsat) {
    console.log(`\n${zmen} změn k provedení. Spusť znovu s --ano.`);
  } else {
    console.log(`\nHotovo: ${zmen} změn zapsáno.`);
  }
}

// ── spuštění ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const arg = (jmeno) => {
    const nalez = process.argv.find((a) => a.startsWith(`--${jmeno}=`));
    return nalez ? nalez.slice(jmeno.length + 3) : null;
  };

  const { PrismaClient } = require('@prisma/client');
  const zapsat = process.argv.includes('--ano');

  (async () => {
    const prisma = new PrismaClient();
    try {
      const v = await zalozUctyModelek({
        prisma,
        zapsat,
        domena: arg('domena'),
        agenturaFiltr: arg('agentura')
      });
      vypisSouhrn(v, zapsat);
    } finally {
      await prisma.$disconnect();
    }
  })().catch((e) => {
    console.error('❌ Skript spadl:', e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  localniCast,
  domenaZEmailu,
  vygenerujHeslo,
  rozhodniProfil,
  zalozUctyModelek,
  ROLE_MODELKY
};
