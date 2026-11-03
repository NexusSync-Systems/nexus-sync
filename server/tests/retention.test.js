/**
 * Úklid osobních údajů podle doby uchování.
 *
 * Testy se dívají na TVAR dotazu, který jde do Prismy, ne na výsledek mazání.
 * Je to schválně: záruka, na které tady všechno stojí, zní „úklid nesáhne na
 * živý incident", a ta se nedá ověřit počtem smazaných řádků — dá se ověřit
 * jedině tím, že podmínka dotazu živou relaci vůbec nepustí dál.
 *
 * Kdyby někdo tu podmínku v budoucnu zjednodušil na `capturedAt < hranice`,
 * testy spadnou. O to jde: mazat polohy podle stáří bodu by znamenalo utnout
 * trasu probíhající schůzce, která trvá dýl než retence.
 */

jest.mock('../src/services/db');
jest.mock('../src/services/logger');

const prisma = require('../src/services/db');
const { spustUklid } = require('../src/services/retentionService');
const { doby, hranice } = require('../src/config/retention');

const TABULKY = [
  'safetyLocationPoint',
  'gpsTrackerLocation',
  'sOSLocationUpdate',
  'message',
  'dataAccessLog',
  'auditLog',
];

const ENV = [
  'RETENTION_SAFETY_LOCATIONS_DAYS',
  'RETENTION_TRACKER_LOCATIONS_DAYS',
  'RETENTION_SOS_LOCATIONS_DAYS',
  'RETENTION_MESSAGES_DAYS',
  'RETENTION_ACCESS_LOGS_DAYS',
  'RETENTION_AUDIT_LOGS_DAYS',
];

/** Tabulky, kde se nemaže, ale nuluje — souřadnice visí na rodiči. */
const NULOVANE = ['sOSAlert', 'gpsTracker'];

/** `where` z prvního volání deleteMany na dané tabulce. */
const kdeU = (tabulka) => prisma[tabulka].deleteMany.mock.calls[0][0].where;

/** Argument prvního updateMany na dané tabulce. */
const updateU = (tabulka) => prisma[tabulka].updateMany.mock.calls[0][0];

const nastavMocky = () => {
  TABULKY.forEach((t) => prisma[t].deleteMany.mockResolvedValue({ count: 0 }));
  NULOVANE.forEach((t) => prisma[t].updateMany.mockResolvedValue({ count: 0 }));
};

beforeEach(() => {
  jest.clearAllMocks();
  ENV.forEach((k) => delete process.env[k]);
  nastavMocky();
});

afterAll(() => ENV.forEach((k) => delete process.env[k]));

describe('Živý incident', () => {
  it('body trasy maže jedině z vyřešených relací', async () => {
    await spustUklid();

    const where = kdeU('safetyLocationPoint');
    expect(where.session.state).toBe('RESOLVED');
    // Bez `not: null` by relace vyřešená s prázdným resolvedAt prošla filtrem
    // na `lt` jako NULL-porovnání a chovala se nepředvídatelně.
    expect(where.session.resolvedAt).toMatchObject({ not: null });
  });

  it('polohu trackeru na NEvyřešené relaci nechá být', async () => {
    await spustUklid();

    const where = kdeU('gpsTrackerLocation');
    // Buď bod k žádné relaci nepatří, nebo ta relace musí být uzavřená.
    expect(where.OR).toEqual([
      { safetySessionId: null },
      { safetySession: { state: 'RESOLVED' } },
    ]);
  });

  it('polohu trackeru na neuzavřeném SOS nechá být', async () => {
    await spustUklid();

    expect(kdeU('gpsTrackerLocation').AND).toEqual([
      { OR: [{ sosAlertId: null }, { sosAlert: { status: 'resolved' } }] },
    ]);
  });

  it('polohy SOS maže jedině z uzavřených poplachů', async () => {
    await spustUklid();

    const where = kdeU('sOSLocationUpdate');
    expect(where.sosAlert.status).toBe('resolved');
    expect(where.sosAlert.resolvedAt).toMatchObject({ not: null });
  });

  it('body trasy NEmaže podle stáří bodu', async () => {
    await spustUklid();

    // capturedAt na nejvyšší úrovni by znamenalo mazání napříč stavy relací.
    expect(kdeU('safetyLocationPoint').capturedAt).toBeUndefined();
  });
});

describe('Souřadnice uložené na rodiči', () => {
  it('poplach SOS přijde i o vlastní lat/lng, nejen o podřízené body', async () => {
    // SOSAlert nese první polohu přímo na sobě. Kdyby se mazaly jen
    // SOSLocationUpdate, u poplachu bez dalších bodů by zůstala JEDINÁ
    // uložená poloha napořád.
    await spustUklid();

    const { where, data } = updateU('sOSAlert');
    expect(where.status).toBe('resolved');
    expect(where.resolvedAt).toMatchObject({ not: null });
    expect(data).toEqual({ lat: null, lng: null, accuracy: null });
  });

  it('neuzavřenému poplachu souřadnice nesmaže', async () => {
    await spustUklid();

    // Jediná přípustná hodnota je 'resolved' — cokoli jiného by sahalo na
    // živý poplach.
    expect(updateU('sOSAlert').where.status).toBe('resolved');
  });

  it('tracker přijde o uloženou poslední polohu', async () => {
    await spustUklid();

    const { where, data } = updateU('gpsTracker');
    expect(where.lastCapturedAt).toMatchObject({ not: null });
    expect(data).toEqual({ lastLat: null, lastLng: null, lastAccuracy: null, lastCapturedAt: null });
  });

  it('čerstvé hlášení trackeru se nepřepíše', async () => {
    await spustUklid();

    // Podmínka na stáří razítka je to jediné, co brání vynulování polohy,
    // kterou tracker poslal před minutou.
    expect(updateU('gpsTracker').where.lastCapturedAt.lt).toBeInstanceOf(Date);
  });

  it('tracker visící na živém incidentu se vynechá', async () => {
    await spustUklid();

    expect(updateU('gpsTracker').where.locations.none.OR).toEqual([
      { safetySession: { state: { not: 'RESOLVED' } } },
      { sosAlert: { status: { not: 'resolved' } } },
    ]);
  });
});

describe('Co se nemaže', () => {
  it('pokusy o neoprávněný přístup v logu zůstávají', async () => {
    await spustUklid();

    // violation: true je bezpečnostní důkaz, ne provozní záznam.
    expect(kdeU('dataAccessLog').violation).toBe(false);
  });

  it('auditní log se ve výchozím stavu nemaže (řetěz integrity)', async () => {
    await spustUklid();

    expect(doby().auditLog).toBe(0);
    expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('nulová retence vypne mazání daného druhu dat', async () => {
    process.env.RETENTION_MESSAGES_DAYS = '0';

    const vysledek = await spustUklid();

    expect(prisma.message.deleteMany).not.toHaveBeenCalled();
    expect(vysledek.message).toBeNull();
  });
});

describe('Konfigurace', () => {
  it('čte se při každém běhu, ne při načtení modulu', async () => {
    // Kdyby se četla při importu, tahle změna by se neprojevila — přesně ta
    // chyba, kvůli které fioSyncWorker mlčky přeskakoval i s nastaveným tokenem.
    process.env.RETENTION_MESSAGES_DAYS = '30';
    await spustUklid();
    const prvni = kdeU('message').createdAt.lt;

    jest.clearAllMocks();
    nastavMocky();

    process.env.RETENTION_MESSAGES_DAYS = '1';
    await spustUklid();
    const druhy = kdeU('message').createdAt.lt;

    expect(druhy.getTime()).toBeGreaterThan(prvni.getTime());
  });

  it('nesmyslná hodnota spadne na výchozí, ne na mazání do budoucnosti', () => {
    process.env.RETENTION_MESSAGES_DAYS = '-5';
    expect(doby().message).toBe(365);

    process.env.RETENTION_MESSAGES_DAYS = 'nesmysl';
    expect(doby().message).toBe(365);

    process.env.RETENTION_MESSAGES_DAYS = '';
    expect(doby().message).toBe(365);
  });

  it('hranice leží přesně N dní zpátky', () => {
    const ted = new Date('2026-10-27T12:00:00.000Z');

    expect(hranice(7, ted).toISOString()).toBe('2026-10-20T12:00:00.000Z');
    expect(hranice(0, ted)).toBeNull();
    expect(hranice(null, ted)).toBeNull();
  });
});

describe('Odolnost', () => {
  it('selhání jedné tabulky nezastaví úklid ostatních', async () => {
    prisma.message.deleteMany.mockRejectedValue(new Error('spojení spadlo'));

    const vysledek = await spustUklid();

    expect(vysledek.message).toBeNull();
    // Logy přístupu se uklízejí až za zprávami — musely tedy proběhnout.
    expect(vysledek.dataAccessLog).toBe(0);
    expect(prisma.dataAccessLog.deleteMany).toHaveBeenCalled();
  });

  it('vrací počty smazaných záznamů po druzích', async () => {
    prisma.safetyLocationPoint.deleteMany.mockResolvedValue({ count: 12 });
    prisma.message.deleteMany.mockResolvedValue({ count: 3 });

    const vysledek = await spustUklid();

    expect(vysledek.safetyLocationPoint).toBe(12);
    expect(vysledek.message).toBe(3);
  });
});
