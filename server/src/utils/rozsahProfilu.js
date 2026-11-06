const prisma = require('../services/db');
const { isManagerRole } = require('./authz');

/**
 * Kdo smí na kterou modelku.
 *
 * Pravidlo: operátorka vidí a píše jen do chatů modelek, které má
 * přiřazené. Hlavní operátorka (`senior_operator`), manažerka a agency
 * admin vidí všechny — tu hranici už umí `isManagerRole`.
 *
 * Do 5. 11. 2026 se na pěti místech kontrolovala jen agentura, takže
 * kterákoli operátorka si mohla otevřít chat libovolné modelky a hlavně
 * do něj psát; zpráva pak u klienta vypadala jako zpráva té cizí modelky.
 *
 * Vazba je `Profile.assignees`. Ve schématu existuje i `TalentAssignment`
 * (operátorka ↔ modelka se směnou a stavem), která by na tohle byla lepší
 * podklad, ale v kódu se nepoužívá ani jednou — až ožije, patří rozhodnutí
 * sem na jedno místo, ne do pěti controllerů.
 */

/** `null` = bez omezení (manažerka a výš), jinak seznam povolených profileId. */
const povoleneProfily = async (user) => {
  if (isManagerRole(user?.role)) return null;
  const profily = await prisma.profile.findMany({
    where: {
      agencyId: String(user?.agencyId),
      assignees: { some: { id: String(user?.userId) } }
    },
    select: { id: true }
  });
  return profily.map((p) => p.id);
};

const smiNaProfil = async (user, profileId) => {
  const povolene = await povoleneProfily(user);
  if (povolene === null) return true;
  if (profileId === null || profileId === undefined) return false;
  return povolene.includes(String(profileId));
};

module.exports = { povoleneProfily, smiNaProfil };
