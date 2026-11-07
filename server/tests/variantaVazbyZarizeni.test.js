/**
 * Relay telefon a plná aplikace jsou dvě vazby jednoho profilu, ne jedna.
 *
 * Modelka má dva telefony: relay se SIM kartou, na kterou chodí SMS,
 * a plnou aplikaci, kde vidí kalendář, zprávy a bezpečnostní tlačítka.
 * Párování ale po sobě deaktivovalo VŠECHNY ostatní aktivní vazby téhož
 * profilu, takže si tu jedinou vazbu přehazovaly: přihlášení v plné
 * aplikaci vyřadilo relay (přestaly chodit SMS), spárování relaye zase
 * vyřadilo plnou aplikaci.
 *
 * `appVariant` z toho dělá dvě nezávislé přihrádky. Druhá polovina opravy
 * je stejně důležitá: dotazy, které míní „relay telefon", si teď nesmí
 * vybrat vazbu plné aplikace — jinak by oprava jednu tichou poruchu
 * vyměnila za druhou (SMS by se poslala telefonu bez SIM karty).
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/db');
jest.mock('../src/services/socket');
jest.mock('../src/services/pushService');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() }
})));

const prismaMock = require('../src/services/db');
const socketMock = require('../src/services/socket');
const { normalizujVariantu, JEN_RELAY, VARIANTA_RELAY, VARIANTA_PLNA } =
  require('../src/utils/deviceVariants');
const app = require('../src/app');

const INSTALACE = 'instalace-plne-aplikace';
const PROFIL = { id: 'profile-1', name: 'Diana Test', agencyId: 'agency-1' };

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
const mockFetchSockets = jest.fn();
const mockIn = jest.fn().mockReturnValue({ fetchSockets: mockFetchSockets });

const token = (prepis = {}) => jwt.sign({
  userId: 'user-1',
  agencyId: 'agency-1',
  role: { name: 'Agency Admin', isManager: true, isAppOwner: false },
  ...prepis,
}, process.env.JWT_SECRET, { expiresIn: '1h' });

const sparuj = (telo) => request(app)
  .post('/api/device/verify')
  .set('Authorization', `Bearer ${token()}`)
  .send({ installationId: INSTALACE, profileId: PROFIL.id, platform: 'android', ...telo });

beforeEach(() => {
  mockEmit.mockClear();
  mockTo.mockClear();
  mockIn.mockClear();
  mockFetchSockets.mockReset();
  socketMock.getIO.mockReturnValue({ to: mockTo, in: mockIn });
  prismaMock.user.findUnique.mockResolvedValue({ tokenVersion: 0 });
  prismaMock.profile.findFirst.mockResolvedValue(PROFIL);
  prismaMock.profile.update.mockResolvedValue({ ...PROFIL, status: 'online' });
  prismaMock.deviceBinding.findUnique.mockResolvedValue(null);
  prismaMock.deviceBinding.upsert.mockResolvedValue({ id: 'vazba-1' });
  prismaMock.deviceBinding.updateMany.mockResolvedValue({ count: 0 });
});

afterEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
describe('normalizujVariantu', () => {
  test('zná jen dvě hodnoty a velikost písmen neřeší', () => {
    expect(normalizujVariantu('full')).toBe(VARIANTA_PLNA);
    expect(normalizujVariantu('FULL')).toBe(VARIANTA_PLNA);
    expect(normalizujVariantu(' full ')).toBe(VARIANTA_PLNA);
    expect(normalizujVariantu('relay')).toBe(VARIANTA_RELAY);
  });

  test('cokoli neznámého je relay, ne plná aplikace', () => {
    // Zásadní směr té výchozí hodnoty: starší APK pole neposílají a všechny
    // vazby z doby před migrací patří relay telefonům. Kdyby se neznámá
    // hodnota brala jako plná aplikace, vypadly by ty telefony z odesílání
    // SMS i z hlídání — a to mlčky.
    for (const vstup of [undefined, null, '', 'relayy', 'fully', 'telefon', 0, {}]) {
      expect(normalizujVariantu(vstup)).toBe(VARIANTA_RELAY);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/device/verify — varianta aplikace', () => {
  test('plná aplikace se uloží jako "full" a relay stejného profilu nechá být', async () => {
    const res = await sparuj({ appVariant: 'full' });

    expect(res.status).toBe(200);
    const volani = prismaMock.deviceBinding.upsert.mock.calls[0][0];
    expect(volani.create.appVariant).toBe('full');
    expect(volani.update.appVariant).toBe('full');

    // Tohle je jádro opravy: deaktivace se omezuje na stejnou variantu.
    const kde = prismaMock.deviceBinding.updateMany.mock.calls[0][0].where;
    expect(kde.appVariant).toBe('full');
    expect(kde.profileId).toBe(PROFIL.id);
    expect(kde.NOT).toEqual({ installationId: INSTALACE });
  });

  test('bez pole appVariant se vazba bere jako relay', async () => {
    const res = await sparuj({});

    expect(res.status).toBe(200);
    expect(prismaMock.deviceBinding.upsert.mock.calls[0][0].create.appVariant).toBe('relay');
    expect(prismaMock.deviceBinding.updateMany.mock.calls[0][0].where.appVariant).toBe('relay');
  });

  test('nesmyslná hodnota od klienta skončí jako relay, ne jako nová varianta', async () => {
    // Bez normalizace by se do databáze dostala třetí hodnota, která by
    // nepatřila do žádné přihrádky — takový telefon by nikdo nenašel.
    const res = await sparuj({ appVariant: 'neco-jineho' });

    expect(res.status).toBe(200);
    expect(prismaMock.deviceBinding.upsert.mock.calls[0][0].create.appVariant).toBe('relay');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('dotazy, které míní relay telefon', () => {
  test('odchozí SMS hledá jen relay telefony', async () => {
    prismaMock.deviceBinding.findMany.mockResolvedValue([{ installationId: 'inst-relay' }]);
    mockFetchSockets.mockResolvedValue([{ id: 'socket-1' }]);
    prismaMock.message.create.mockResolvedValue({ id: 'zprava-1' });

    await request(app)
      .post('/api/sms/send')
      .set('Authorization', `Bearer ${token({ role: { name: 'Operator', isManager: false, isAppOwner: false } })}`)
      .send({ to: '+420777111222', text: 'ahoj' });

    const kde = prismaMock.deviceBinding.findMany.mock.calls[0][0].where;
    expect(kde).toMatchObject({ ...JEN_RELAY, active: true, agencyId: 'agency-1' });
  });

  test('fantomový hovor přes /api/sos/fake-call míří na relay, ne na plnou aplikaci', async () => {
    // `fake_call_request` poslouchá jedině relay (RelayMode.jsx). Plná
    // aplikace má svůj vlastní fantomový hovor přes `ghost_call`, takže
    // vybraná vazba plné aplikace by signál poslala do prázdna.
    prismaMock.user.findUnique.mockResolvedValue({ tokenVersion: 0, agencyId: 'agency-1', name: 'Diana' });
    prismaMock.deviceBinding.findFirst.mockResolvedValue({ installationId: 'inst-relay' });

    const res = await request(app)
      .post('/api/sos/fake-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ targetUserId: 'user-modelka', delay: 0 });

    expect(res.status).toBe(200);
    const kde = prismaMock.deviceBinding.findFirst.mock.calls[0][0].where;
    expect(kde).toMatchObject({ ...JEN_RELAY, userId: 'user-modelka', active: true });
  });

  test('hlášení „relay je online" nepočítá plnou aplikaci', async () => {
    // Jinak by odznak svítil zeleně i tehdy, když relay telefon leží
    // vybitý doma — tedy přesně v situaci, kvůli které se sleduje.
    prismaMock.deviceBinding.count.mockResolvedValue(0);

    await request(app)
      .get('/api/agency/relay-status')
      .set('Authorization', `Bearer ${token()}`);

    const kde = prismaMock.deviceBinding.count.mock.calls[0][0].where;
    expect(kde).toMatchObject({ ...JEN_RELAY, active: true, agencyId: 'agency-1' });
  });
});
