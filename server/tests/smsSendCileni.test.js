/**
 * Odchozí SMS musí jít na JEDEN konkrétní telefon, ne do celé agentury.
 *
 * Dřív se `relay_event` rozesílal do `agency_<id>`. Do té místnosti patří
 * každý přihlášený socket agentury, takže:
 *   - příjemce i text zprávy dostal každý prohlížeč operátorky,
 *   - při dvou spárovaných telefonech odešla SMS DVAKRÁT,
 *   - odpověď byla `ok: true`, i když neposlouchal žádný telefon.
 *
 * Tyhle testy drží všechny tři vlastnosti opravy.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/db');
jest.mock('../src/services/socket');
jest.mock('../src/services/pushService');
jest.mock('../src/services/logger');
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() }
})));

const prismaMock = require('../src/services/db');
const socketMock = require('../src/services/socket');
const app = require('../src/app');

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
// `in()` vrací objekt s fetchSockets — tím se zjišťuje, jestli je telefon
// opravdu připojený. Jednotlivé testy si návratovou hodnotu přenastaví.
const mockFetchSockets = jest.fn();
const mockIn = jest.fn().mockReturnValue({ fetchSockets: mockFetchSockets });

const token = jwt.sign({
  userId: 'user-1',
  agencyId: 'agency-1',
  role: { name: 'Operator', isManager: false, isAppOwner: false },
}, process.env.JWT_SECRET, { expiresIn: '1h' });

const posli = (telo) => request(app)
  .post('/api/sms/send')
  .set('Authorization', `Bearer ${token}`)
  .send({ to: '+420777111222', text: 'ahoj', ...telo });

beforeEach(() => {
  mockEmit.mockClear();
  mockTo.mockClear();
  mockIn.mockClear();
  mockFetchSockets.mockReset();
  socketMock.getIO.mockReturnValue({ to: mockTo, in: mockIn });
  prismaMock.user.findUnique.mockResolvedValue({ tokenVersion: 0 });
});

afterEach(() => jest.clearAllMocks());

describe('POST /api/sms/send — cílení na konkrétní telefon', () => {
  test('bez spárovaného telefonu vrátí 409 a nic neodešle', async () => {
    prismaMock.deviceBinding.findMany.mockResolvedValue([]);

    const res = await posli();

    expect(res.status).toBe(409);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('spárovaný, ale nepřipojený telefon vrátí 503 — ne falešné „odesláno"', async () => {
    prismaMock.deviceBinding.findMany.mockResolvedValue([{ installationId: 'inst-A' }]);
    mockFetchSockets.mockResolvedValue([]); // nikdo v místnosti

    const res = await posli();

    expect(res.status).toBe(503);
    expect(res.body.ok).toBeUndefined();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('posílá do relay:<installationId>, NE do agency_', async () => {
    prismaMock.deviceBinding.findMany.mockResolvedValue([{ installationId: 'inst-A' }]);
    mockFetchSockets.mockResolvedValue([{ id: 'socket-1' }]);

    const res = await posli();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, installationId: 'inst-A' });
    expect(mockTo).toHaveBeenCalledWith('relay:inst-A');
    // Tohle je jádro opravy: do místnosti agentury se nesmí poslat nic.
    expect(mockTo).not.toHaveBeenCalledWith('agency_agency-1');
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  test('při dvou spárovaných telefonech odešle jen JEDEN', async () => {
    prismaMock.deviceBinding.findMany.mockResolvedValue([
      { installationId: 'inst-A' },
      { installationId: 'inst-B' },
    ]);
    mockFetchSockets.mockResolvedValue([{ id: 'socket-1' }]);

    const res = await posli();

    expect(res.status).toBe(200);
    // Dřív by SMS odešly obě a zákazník by ji dostal dvakrát.
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith('relay:inst-A');
    expect(mockTo).not.toHaveBeenCalledWith('relay:inst-B');
  });

  test('přeskočí nepřipojený telefon a vezme další v pořadí', async () => {
    prismaMock.deviceBinding.findMany.mockResolvedValue([
      { installationId: 'inst-A' },
      { installationId: 'inst-B' },
    ]);
    mockFetchSockets
      .mockResolvedValueOnce([])              // inst-A je offline
      .mockResolvedValueOnce([{ id: 's-2' }]); // inst-B je online

    const res = await posli();

    expect(res.status).toBe(200);
    expect(res.body.installationId).toBe('inst-B');
    expect(mockTo).toHaveBeenCalledWith('relay:inst-B');
  });

  test('cizí installationId se nedá adresovat — dotaz je vždy omezený agenturou', async () => {
    prismaMock.deviceBinding.findMany.mockResolvedValue([]);

    const res = await posli({ installationId: 'telefon-cizi-agentury' });

    expect(res.status).toBe(409);
    expect(prismaMock.deviceBinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agencyId: 'agency-1',
          installationId: 'telefon-cizi-agentury',
          active: true,
        }),
      })
    );
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('chybějící příjemce nebo text vrátí 400 dřív, než se sáhne do databáze', async () => {
    const res = await request(app)
      .post('/api/sms/send')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '', text: '' });

    expect(res.status).toBe(400);
    expect(prismaMock.deviceBinding.findMany).not.toHaveBeenCalled();
  });
});
