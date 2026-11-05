/**
 * POST /api/sms/incoming nesmí existovat.
 *
 * Ta route emitovala `sms:incoming` do celé místnosti `agency_<id>`, ale
 * visela na `authMiddleware`, který pouští KAŽDÝ platný session token, ne jen
 * relay. Kterákoli přihlášená operátorka tak mohla jedním POSTem vyrobit
 * příchozí SMS s libovolným odesílatelem, libovolným textem a libovolným
 * `installationId` a poslat ji na obrazovku všem kolegyním. Do databáze se
 * přitom nic neukládalo, takže po tom nezůstal žádný záznam.
 *
 * Relay tu route nikdy nepoužil — posílá nativně na POST /api/device/relay,
 * kde se zpráva uloží jako Message(direction: INBOUND) a teprve pak se rozešle
 * událost `new_message`. Živá cesta je ta druhá a tyhle testy na ni nesahají.
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

const operatorka = jwt.sign({
  userId: 'user-1',
  agencyId: 'agency-1',
  role: { name: 'Operator', isManager: false, isAppOwner: false },
}, process.env.JWT_SECRET, { expiresIn: '1h' });

const podvrh = {
  from: '+420777000111',
  body: 'Dobry den, zmenilo se nam cislo uctu, poslete platbu sem.',
  installationId: 'cizi-zarizeni',
};

beforeEach(() => {
  jest.clearAllMocks();
  socketMock.getIO.mockReturnValue({ to: mockTo });
  // Token musí projít `authMiddleware`, aby test měřil chybějící route,
  // a ne odmítnuté přihlášení.
  prismaMock.user = {
    findUnique: jest.fn().mockResolvedValue({
      tokenVersion: 0,
      role: { name: 'Operator', isManager: false, isAppOwner: false },
    }),
  };
});

describe('POST /api/sms/incoming', () => {
  test('s platným tokenem operátorky vrací 404 — route neexistuje', async () => {
    const res = await request(app)
      .post('/api/sms/incoming')
      .set('Authorization', `Bearer ${operatorka}`)
      .send(podvrh);

    expect(res.status).toBe(404);
  });

  test('nevyšle žádnou socketovou událost do agentury', async () => {
    await request(app)
      .post('/api/sms/incoming')
      .set('Authorization', `Bearer ${operatorka}`)
      .send(podvrh);

    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('bez tokenu se zastaví už na přihlášení (401), ne na routě', async () => {
    const res = await request(app)
      .post('/api/sms/incoming')
      .send(podvrh);

    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('odchozí /api/sms/send na stejném routeru funguje dál', async () => {
    // Jen důkaz, že odstranění nesundalo celý router: /send se dostane
    // do controlleru, kde chybějící spárovaný telefon dá 409.
    prismaMock.deviceBinding = { findMany: jest.fn().mockResolvedValue([]) };

    const res = await request(app)
      .post('/api/sms/send')
      .set('Authorization', `Bearer ${operatorka}`)
      .send({ to: '+420777111222', text: 'ahoj' });

    expect(res.status).not.toBe(404);
  });
});
