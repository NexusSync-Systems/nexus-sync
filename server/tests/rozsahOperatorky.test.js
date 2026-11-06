/**
 * Operátorka smí vidět a psát JEN do chatů modelek, které má přiřazené.
 * Hlavní operátorka, manažerka a agency admin vidí všechny.
 *
 * Pravidlo určil vlastník produktu 5. 11. 2026. Do té doby se na pěti
 * místech kontrolovala jen agentura, takže kterákoli operátorka:
 *   - viděla v Doručených chaty všech modelek agentury,
 *   - otevřela si chat libovolné modelky podle ID,
 *   - a hlavně MOHLA DO NĚJ PSÁT — zpráva pak u klienta vypadala
 *     jako zpráva té cizí modelky.
 *
 * Doloženo při testu s telefonem: Testovaci Operatorka Druhá neměla
 * přiřazený žádný profil a v Doručených přesto viděla chat profilu A.
 *
 * `isManagerRole` z utils/authz.js už tu hranici umí a bere mezi manažery
 * i `senior_operator` — tedy hlavní operátorku.
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

const AGENTURA = 'agency-1';
const MOJE = 'profil-moje';
const CIZI = 'profil-cizi';

const token = ({ userId = 'op-1', roleName = 'Operator', isManager = false }) =>
  jwt.sign(
    { userId, agencyId: AGENTURA, role: { name: roleName, isManager, isAppOwner: false } },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

const operatorka = token({ userId: 'op-1' });
const manazerka = token({ userId: 'man-1', roleName: 'Agency Admin', isManager: true });

const chat = (id, profileId) => ({
  id, profileId, agencyId: AGENTURA, externalId: '+420777111222', profile: { phoneNumber: '+420555000101' }
});

beforeEach(() => {
  jest.clearAllMocks();
  socketMock.getIO.mockReturnValue({ to: jest.fn().mockReturnValue({ emit: jest.fn() }) });

  // op-1 má přiřazený JEN profil MOJE
  // POZOR: `authMiddleware` roli z tokenu ZAHAZUJE a bere čerstvou z DB
  // (záměrně — degradace role musí platit hned). Atrapa proto musí vracet
  // roli podle uživatele, jinak se manažerka v testu promění v operátorku
  // a test „manažerka smí" selže na chybě testu, ne kódu.
  prismaMock.user = {
    findUnique: jest.fn().mockImplementation(({ where }) =>
      Promise.resolve({
        tokenVersion: 0,
        role: where.id === 'man-1'
          ? { name: 'Agency Admin', isManager: true, isAppOwner: false }
          : { name: 'Operator', isManager: false, isAppOwner: false }
      })
    )
  };
  prismaMock.profile.findMany = jest.fn().mockImplementation(({ where }) => {
    const chceAssignees = where?.assignees?.some?.id;
    if (chceAssignees === 'op-1') return Promise.resolve([{ id: MOJE }]);
    if (chceAssignees) return Promise.resolve([]);
    return Promise.resolve([{ id: MOJE }, { id: CIZI }]);
  });
  prismaMock.chat.findMany = jest.fn().mockResolvedValue([]);
  prismaMock.message.findMany = jest.fn().mockResolvedValue([]);
});

describe('čtení cizí modelky', () => {
  test('GET /api/messages/:chatId u cizí modelky je 403', async () => {
    prismaMock.chat.findUnique.mockResolvedValue(chat('chat-cizi', CIZI));
    const res = await request(app)
      .get('/api/messages/chat-cizi')
      .set('Authorization', `Bearer ${operatorka}`);
    expect(res.status).toBe(403);
  });

  test('GET /api/messages/:chatId u vlastní modelky projde', async () => {
    prismaMock.chat.findUnique.mockResolvedValue(chat('chat-moje', MOJE));
    const res = await request(app)
      .get('/api/messages/chat-moje')
      .set('Authorization', `Bearer ${operatorka}`);
    expect(res.status).toBe(200);
  });

  test('manažerka na cizí modelku smí', async () => {
    prismaMock.chat.findUnique.mockResolvedValue(chat('chat-cizi', CIZI));
    const res = await request(app)
      .get('/api/messages/chat-cizi')
      .set('Authorization', `Bearer ${manazerka}`);
    expect(res.status).toBe(200);
  });
});

describe('psaní do cizí modelky', () => {
  test('POST /api/messages do chatu cizí modelky je 403', async () => {
    prismaMock.chat.findUnique.mockResolvedValue(chat('chat-cizi', CIZI));
    const res = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${operatorka}`)
      .send({ chatId: 'chat-cizi', text: 'ahoj', direction: 'OUTBOUND' });
    expect(res.status).toBe(403);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});

describe('výpis chatů', () => {
  test('GET /api/chats vrací jen chaty přiřazených modelek', async () => {
    await request(app).get('/api/chats').set('Authorization', `Bearer ${operatorka}`);
    const kde = prismaMock.chat.findMany.mock.calls[0][0].where;
    expect(kde.profileId).toEqual({ in: [MOJE] });
  });

  test('manažerce se seznam nezužuje', async () => {
    await request(app).get('/api/chats').set('Authorization', `Bearer ${manazerka}`);
    const kde = prismaMock.chat.findMany.mock.calls[0][0].where;
    expect(kde.profileId).toBeUndefined();
  });
});
