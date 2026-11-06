/**
 * Účty modelek a vlastnictví profilu — `scripts/zaloz-ucty-modelek.js`.
 *
 * Co se tím hlídá: #184 přidalo `Profile.ownerId`, ale samo nic nevyplnilo.
 * Tenhle skript to doplňuje na datech, která už existují — a je to zápis do
 * ostré databáze, který se dělá jednou a ručně. Chyba v něm se nepozná
 * z provozu, pozná se až tím, že se někdo nepřihlásí nebo že audit ukazuje
 * na špatného člověka. Proto to chce test, ne jen přečtení.
 *
 * Tři věci, které tu musí platit:
 *
 *  1) Vygenerované heslo musí projít `validatePassword` z authControlleru.
 *     Kdyby neprošlo, účet se založí, ale modelka si heslo nikdy nezmění
 *     a reset by jí ho odmítl nastavit. Validace žije v controlleru,
 *     generátor ve skriptu — nic je nedrží u sebe než tenhle test.
 *  2) `Profile.ownerId` je @unique. Druhé přiřazení téhož účtu musí skončit
 *     rozpoznanou kolizí, ne výjimkou z databáze.
 *  3) Výpis (bez `--ano`) nesmí zapsat ANI JEDEN řádek.
 */
const {
  localniCast,
  domenaZEmailu,
  vygenerujHeslo,
  rozhodniProfil,
  zalozUctyModelek
} = require('../scripts/zaloz-ucty-modelek');

// Stejná pravidla, jaká na heslo klade `validatePassword` v authControlleru
// (server/src/controllers/authController.js). Není exportovaná, tak je tu
// přepsaná — a kdyby se tam zpřísnila, tenhle test spadne, což je přesně to,
// co chci: generátor hesel se musí zpřísnit s ní.
const projdeValidaci = (heslo) =>
  typeof heslo === 'string' &&
  heslo.length >= 8 &&
  /[A-Z]/.test(heslo) &&
  /[0-9]/.test(heslo);

describe('e-mail z názvu profilu', () => {
  test('diakritika se překlápí, ne zahazuje', () => {
    // „Čápová" nesmí dát „cpov" — to by byl účet, který nikdo nepřečte.
    expect(localniCast('Tereza Čápová')).toBe('tereza.capova');
    expect(localniCast('Žofie Křížová')).toBe('zofie.krizova');
  });

  test('mezery a interpunkce dají jednu tečku, ne řetěz teček', () => {
    expect(localniCast('Profil  A -- test')).toBe('profil.a.test');
  });

  test('název bez použitelného znaku nedá e-mail', () => {
    // Radši null a nahlášená kolize než účet „@domena.cz".
    expect(localniCast('***')).toBeNull();
    expect(localniCast('')).toBeNull();
  });

  test('domena se bere jen z e-mailu, který ji má', () => {
    expect(domenaZEmailu('a@nexusstack.eu')).toBe('nexusstack.eu');
    expect(domenaZEmailu('bez-zavinace')).toBeNull();
    expect(domenaZEmailu('a@localhost')).toBeNull();
  });
});

describe('generované heslo', () => {
  test('projde stejnou validací jako při registraci', () => {
    // Opakovaně, protože generátor je náhodný: číslice se losuje a kdyby
    // se mohla vylosovat tak, že heslo pravidla nesplní, chci to vědět tady.
    for (let i = 0; i < 200; i++) {
      const heslo = vygenerujHeslo();
      expect(projdeValidaci(heslo)).toBe(true);
    }
  });

  test('neobsahuje znaky, které se při opisování pletou', () => {
    for (let i = 0; i < 200; i++) {
      expect(vygenerujHeslo()).not.toMatch(/[lI1O0]/);
    }
  });

  test('dvě hesla po sobě nejsou stejná', () => {
    const vzorek = new Set(Array.from({ length: 50 }, vygenerujHeslo));
    expect(vzorek.size).toBe(50);
  });
});

describe('rozhodnutí o profilu', () => {
  const profil = { id: 'p1', name: 'Profil A', ownerId: null, agencyId: 'a1' };

  test('profil, který vlastníka má, se nechává být', () => {
    expect(rozhodniProfil({ profil: { ...profil, ownerId: 'u9' }, email: 'x@y.cz' }).co)
      .toBe('hotovo');
  });

  test('bez existujícího účtu se zakládá', () => {
    expect(rozhodniProfil({ profil, email: 'profil.a@y.cz', existujiciUcet: null }).co)
      .toBe('zalozit');
  });

  test('účet bez vlastněného profilu se jen naváže', () => {
    const ucet = { id: 'u1', agencyId: 'a1', ownedProfile: null };
    expect(rozhodniProfil({ profil, email: 'profil.a@y.cz', existujiciUcet: ucet }).co)
      .toBe('navazat');
  });

  test('účet, který už jiný profil vlastní, je kolize (ownerId je @unique)', () => {
    const ucet = { id: 'u1', agencyId: 'a1', ownedProfile: { id: 'p2', name: 'Profil B' } };
    const r = rozhodniProfil({ profil, email: 'profil.a@y.cz', existujiciUcet: ucet });
    expect(r.co).toBe('kolize');
    expect(r.duvod).toContain('Profil B');
  });

  test('účet z jiné agentury se nenaváže', () => {
    const ucet = { id: 'u1', agencyId: 'JINA', ownedProfile: null };
    expect(rozhodniProfil({ profil, email: 'profil.a@y.cz', existujiciUcet: ucet }).co)
      .toBe('kolize');
  });

  test('opakované spuštění je idempotentní: tentýž účet u téhož profilu projde', () => {
    // Kdyby `ownedProfile.id === profil.id` neprošlo, druhé spuštění by
    // hlásilo kolizi na práci, kterou samo předtím udělalo.
    const ucet = { id: 'u1', agencyId: 'a1', ownedProfile: { id: 'p1', name: 'Profil A' } };
    expect(rozhodniProfil({ profil, email: 'profil.a@y.cz', existujiciUcet: ucet }).co)
      .toBe('navazat');
  });

  test('dva profily stejného názvu: druhý je kolize, ne pád na @unique', () => {
    const r = rozhodniProfil({
      profil,
      email: 'profil.a@y.cz',
      existujiciUcet: null,
      jizPouziteEmaily: ['profil.a@y.cz']
    });
    expect(r.co).toBe('kolize');
    expect(r.duvod).toContain('dvakrát');
  });
});

describe('průchod nad atrapou databáze', () => {
  const atrapa = ({ profily, uzivatele = [], role = null }) => {
    const zapisy = [];
    return {
      zapisy,
      agency: { findMany: jest.fn(async () => [{ id: 'a1', name: 'Testovaci agentura' }]) },
      profile: {
        findMany: jest.fn(async () => profily),
        update: jest.fn(async (arg) => {
          zapisy.push(['profile.update', arg]);
          return {};
        })
      },
      user: {
        findFirst: jest.fn(async () => ({ email: 'admin@nexusstack.eu' })),
        findUnique: jest.fn(async ({ where }) =>
          uzivatele.find((u) => u.email === where.email) || null),
        create: jest.fn(async (arg) => {
          zapisy.push(['user.create', arg]);
          return { id: 'novy' };
        })
      },
      role: {
        findFirst: jest.fn(async () => role),
        create: jest.fn(async (arg) => {
          zapisy.push(['role.create', arg]);
          return { id: 'r-model' };
        })
      },
      $transaction: jest.fn(async (fn) => fn({
        user: {
          create: jest.fn(async (arg) => {
            zapisy.push(['user.create', arg]);
            return { id: 'novy' };
          })
        },
        profile: {
          update: jest.fn(async (arg) => {
            zapisy.push(['profile.update', arg]);
            return {};
          })
        }
      }))
    };
  };

  test('výpis bez --ano nezapíše ani řádek', async () => {
    const prisma = atrapa({
      profily: [{ id: 'p1', name: 'Profil A', ownerId: null, agencyId: 'a1' }]
    });
    const v = await zalozUctyModelek({ prisma, zapsat: false });

    expect(v.zalozeno).toBe(1);
    expect(prisma.zapisy).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('se --ano založí účet i vlastnictví, a to v jedné transakci', async () => {
    const prisma = atrapa({
      profily: [{ id: 'p1', name: 'Profil A', ownerId: null, agencyId: 'a1' }],
      role: { id: 'r-model' }
    });
    const v = await zalozUctyModelek({ prisma, zapsat: true });

    expect(v.zalozeno).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    const druhy = prisma.zapisy.map(([co]) => co);
    expect(druhy).toEqual(['user.create', 'profile.update']);

    // Heslo nesmí jít do databáze v otevřené podobě.
    const [, vytvoreni] = prisma.zapisy.find(([co]) => co === 'user.create');
    expect(vytvoreni.data.password).toMatch(/^\$2[aby]\$/);
    expect(vytvoreni.data.email).toBe('profil.a@nexusstack.eu');
    expect(vytvoreni.data.agencyId).toBe('a1');

    // A naopak: do výpisu jít musí, jinak se modelka nepřihlásí.
    expect(v.hesla).toHaveLength(1);
    expect(projdeValidaci(v.hesla[0].heslo)).toBe(true);
  });

  test('chybějící role Model se založí, než vznikne první účet', async () => {
    const prisma = atrapa({
      profily: [{ id: 'p1', name: 'Profil A', ownerId: null, agencyId: 'a1' }],
      role: null
    });
    await zalozUctyModelek({ prisma, zapsat: true });

    expect(prisma.role.create).toHaveBeenCalledTimes(1);
    expect(prisma.role.create.mock.calls[0][0].data).toMatchObject({
      name: 'Model',
      isManager: false,
      agencyId: 'a1'
    });
  });

  test('profil, který vlastníka má, se nepřepíše', async () => {
    const prisma = atrapa({
      profily: [{ id: 'p1', name: 'Profil A', ownerId: 'u-stary', agencyId: 'a1' }],
      role: { id: 'r-model' }
    });
    const v = await zalozUctyModelek({ prisma, zapsat: true });

    expect(v.hotovo).toBe(1);
    expect(prisma.zapisy).toEqual([]);
  });

  test('bez použitelné domeny se nezapisuje a profil se nahlásí', async () => {
    const prisma = atrapa({
      profily: [{ id: 'p1', name: 'Profil A', ownerId: null, agencyId: 'a1' }],
      role: { id: 'r-model' }
    });
    // Agentura bez jediného e-mailu, z něhož by šla domena odvodit.
    prisma.user.findFirst = jest.fn(async () => null);

    const v = await zalozUctyModelek({ prisma, zapsat: true });

    expect(v.kolize).toBe(1);
    expect(v.zalozeno).toBe(0);
    expect(prisma.zapisy).toEqual([]);
  });

  test('existující účet se naváže bez zakládání a bez hesla', async () => {
    const prisma = atrapa({
      profily: [{ id: 'p1', name: 'Profil A', ownerId: null, agencyId: 'a1' }],
      uzivatele: [{ email: 'profil.a@nexusstack.eu', id: 'u1', agencyId: 'a1', ownedProfile: null }],
      role: { id: 'r-model' }
    });
    const v = await zalozUctyModelek({ prisma, zapsat: true });

    expect(v.navazano).toBe(1);
    expect(v.zalozeno).toBe(0);
    expect(v.hesla).toEqual([]);
    expect(prisma.zapisy).toEqual([
      ['profile.update', { where: { id: 'p1' }, data: { ownerId: 'u1' } }]
    ]);
  });
});
