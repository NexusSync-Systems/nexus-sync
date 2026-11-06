/**
 * Překlopí role už založených agentur na správnou manažerskou úroveň
 * a doplní chybějící roli vedoucí operátorky.
 *
 * Proč je to potřeba: do #182 se `isManager` při zakládání role vůbec
 * nenastavoval a ve schématu je `@default(false)`. Každá agentura tedy má
 * admina s `isManager=false` a roli „Senior Operator" nemá vůbec.
 *
 * #182 opravuje, jak role VZNIKAJÍ. Tenhle skript opravuje, co už vzniklo.
 *
 * VÝCHOZÍ CHOVÁNÍ JE JEN VÝPIS. Zapisuje se až s `--ano`.
 *
 *   node scripts/preklop-role-agentur.js          # ukáže, co by udělal
 *   node scripts/preklop-role-agentur.js --ano    # provede to
 */
const path = require('path');
// Cesta k `.env` se odvozuje od UMÍSTĚNÍ SKRIPTU, ne od pracovního adresáře.
// Na serveru je kořen serverové části `/root/nexus-backend`, takže
// `__dirname/..` je přesně ono. Bez toho by `DATABASE_URL` chybělo pokaždé,
// když se skript nespustí z toho adresáře — a Prisma by neřekla proč.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const { ZNAME_ROLE, dataRole } = require('../src/config/vychoziRole');

const ZAPSAT = process.argv.includes('--ano');

(async () => {
  const prisma = new PrismaClient();
  let zmen = 0;

  try {
    const agentury = await prisma.agency.findMany({ select: { id: true, name: true } });
    if (!agentury.length) {
      console.log('Žádná agentura — není co překlápět.');
      return;
    }

    for (const a of agentury) {
      console.log(`\n=== ${a.name} ===`);
      const role = await prisma.role.findMany({ where: { agencyId: a.id } });

      // 1) srovnat priznak u roli, ktere uz existuji
      for (const r of role) {
        const vzor = ZNAME_ROLE.find((z) => z.name === r.name);
        if (!vzor) {
          console.log(`  ${r.name}: vlastní role, nechávám být`);
          continue;
        }
        if (r.isManager === vzor.isManager) {
          console.log(`  ${r.name}: isManager=${r.isManager} — v pořádku`);
          continue;
        }
        console.log(`  ${r.name}: isManager ${r.isManager} → ${vzor.isManager}`);
        zmen++;
        if (ZAPSAT) {
          await prisma.role.update({ where: { id: r.id }, data: { isManager: vzor.isManager } });
        }
      }

      // 2) doplnit chybejici role zakladane pri vzniku agentury
      for (const vzor of ZNAME_ROLE.filter((z) => z.name !== 'Model')) {
        if (role.some((r) => r.name === vzor.name)) continue;
        console.log(`  ${vzor.name}: CHYBÍ, založí se`);
        zmen++;
        if (ZAPSAT) {
          await prisma.role.create({ data: dataRole(vzor.name, a.id, null) });
        }
      }
    }

    console.log(
      zmen === 0
        ? '\nNic k překlopení.'
        : ZAPSAT
          ? `\nHotovo: ${zmen} změn zapsáno.`
          : `\n${zmen} změn k provedení. Spusť znovu s --ano.`
    );
  } finally {
    await prisma.$disconnect();
  }
})();
