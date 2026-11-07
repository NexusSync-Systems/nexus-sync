const request = require('supertest');
const jwt = require('jsonwebtoken');

const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
const mockRoomSize = jest.fn(() => 1);
const mockSendGhostCallPush = jest.fn();

jest.mock('../src/services/db');
jest.mock('../src/services/logger');
jest.mock('../src/services/safetyService');
jest.mock('../src/services/socket', () => ({
  getIO: () => ({ to: mockTo }),
  initSocket: jest.fn(),
  getRoomSize: () => mockRoomSize()
}));
jest.mock('../src/services/pushService', () => ({
  sendGhostCallPush: (...args) => mockSendGhostCallPush(...args),
  sendSafetyPush: jest.fn(),
  sendRelaySmsPush: jest.fn(),
  sendRelaySyncPush: jest.fn()
}));
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() }
})));

const prisma = require('../src/services/db');
const app = require('../src/app');

const token = () => jwt.sign(
  { userId: 'user-1', agencyId: 'agency-1', role: { name: 'Senior Operator', isManager: true } },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(undefined);
  prisma.user.findMany.mockResolvedValue([{ id: 'model-user-1' }]);
  mockSendGhostCallPush.mockResolvedValue({ sent: 1, failed: 0 });
  mockRoomSize.mockReturnValue(1);
});

describe('POST /api/safety/ghost-call', () => {
  it('delivers the call to the device instead of just claiming success', async () => {
    prisma.profile.findUnique.mockResolvedValue({ id: 'p1', name: 'Diana', agencyId: 'agency-1' });

    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'p1' });

    expect(res.status).toBe(200);
    expect(res.body.socketEmitted).toBe(true);
    // cílíme na osobní místnost modelky, ne na celou agenturu
    expect(mockTo).toHaveBeenCalledWith('user:model-user-1');
    expect(mockEmit).toHaveBeenCalledWith('ghost_call', expect.objectContaining({ profileId: 'p1' }));
    // push MUSÍ jít na telefon modelky, ne operátorům přes safety push
    expect(mockSendGhostCallPush).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p1' }));
  });

  it('reports failure when nothing could be delivered', async () => {
    prisma.profile.findUnique.mockResolvedValue({ id: 'p1', name: 'Diana', agencyId: 'agency-1' });
    mockTo.mockImplementationOnce(() => { throw new Error('socket down'); });
    mockSendGhostCallPush.mockResolvedValue({ sent: 0, failed: 2 });

    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'p1' });

    // Operátor se MUSÍ dozvědět, že hovor nedorazil — dřív vracelo vždy ok:true.
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    // i chybová odpověď musí nést stejná pole, ať operátor ví, co selhalo
    expect(res.body).toHaveProperty('socketEmitted', false);
    expect(res.body).toHaveProperty('pushDelivered', false);
  });

  it('does not claim delivery when nobody is connected and push fails', async () => {
    prisma.profile.findUnique.mockResolvedValue({ id: 'p1', name: 'Diana', agencyId: 'agency-1' });
    mockRoomSize.mockReturnValue(0);                       // nikdo v roomu
    mockSendGhostCallPush.mockResolvedValue({ sent: 0, failed: 0 });

    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'p1' });

    // emit sám o sobě nic nedokazuje — bez připojeného klienta a bez pushe hovor nedorazil
    expect(res.status).toBe(502);
    expect(res.body.clientsOnline).toBe(0);
  });

  it('reports failure when the profile has no model user linked', async () => {
    prisma.profile.findUnique.mockResolvedValue({ id: 'p1', name: 'Diana', agencyId: 'agency-1' });
    prisma.user.findMany.mockResolvedValue([]);           // profil nemá navázanou modelku
    mockSendGhostCallPush.mockResolvedValue({ sent: 0, failed: 0 });

    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'p1' });

    expect(res.status).toBe(502);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // Jádro: modelka s vlastním účtem vlastní profil, ale není jeho assignee.
  // Dokud se příjemci hledali jen přes `assignedProfiles`, byl seznam prázdný
  // a fantomový hovor nedorazil nikam — u funkce, která jí má dát záminku
  // k odchodu ze schůzky.
  it('rings the profile OWNER even when nobody is assigned to the profile', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      id: 'p1', name: 'Diana', agencyId: 'agency-1', ownerId: 'model-owner-1'
    });
    prisma.user.findMany.mockResolvedValue([]);   // žádná přiřazená modelka

    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'p1' });

    expect(res.status).toBe(200);
    expect(mockTo).toHaveBeenCalledWith('user:model-owner-1');
    expect(mockSendGhostCallPush).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ['model-owner-1'] })
    );
  });

  it('does not ring the owner twice when she is also an assignee', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      id: 'p1', name: 'Diana', agencyId: 'agency-1', ownerId: 'model-1'
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'model-1' }]);

    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'p1' });

    expect(res.status).toBe(200);
    expect(mockTo).toHaveBeenCalledTimes(1);
    expect(mockSendGhostCallPush).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ['model-1'] })
    );
  });

  // Výchozí role se jmenuje „Model", ale ručně založená bývá „Modelka" —
  // u staršího profilu bez vlastníka je název role jediné, podle čeho to jde.
  it('accepts both spellings of the model role name for assignees', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      id: 'p1', name: 'Diana', agencyId: 'agency-1', ownerId: null
    });

    await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'p1' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: { name: { in: ['Model', 'Modelka'] } } })
      })
    );
  });

  it("refuses to ring another agency's model", async () => {
    prisma.profile.findUnique.mockResolvedValue({ id: 'p9', name: 'Foreign', agencyId: 'other-agency' });

    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'p9' });

    expect(res.status).toBe(403);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown profile', async () => {
    prisma.profile.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({ profileId: 'nope' });

    expect(res.status).toBe(404);
  });

  it('requires a profileId', async () => {
    const res = await request(app)
      .post('/api/safety/ghost-call')
      .set('Authorization', `Bearer ${token()}`)
      .send({});

    expect(res.status).toBe(400);
  });
});
