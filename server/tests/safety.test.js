const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/db');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({})));

const prismaMock = require('../src/services/db');
const app = require('../src/app');

function makeToken(overrides = {}) {
  return jwt.sign(
    {
      userId: 'user-1',
      agencyId: 'agency-1',
      role: { name: 'Agency Admin', isManager: true, isAppOwner: false },
      ...overrides,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

afterEach(() => jest.clearAllMocks());

describe('GET /api/blacklist', () => {
  it('returns blacklist entries', async () => {
    prismaMock.blacklistEntry.findMany.mockResolvedValue([
      { id: 'bl1', phone: '+420111222333', severity: 'danger', description: 'Known scammer', reports: [], createdBy: { name: 'Admin' } },
    ]);
    prismaMock.blacklistEntry.count = jest.fn().mockResolvedValue(1);

    const res = await request(app)
      .get('/api/blacklist')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
  });

  it('searches blacklist phone entries across phone variants', async () => {
    prismaMock.blacklistEntry.findMany.mockResolvedValue([]);
    prismaMock.blacklistEntry.count = jest.fn().mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/blacklist?search=${encodeURIComponent('00420 739 777 718')}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(prismaMock.blacklistEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { phone: { in: expect.arrayContaining(['00420739777718', '+420739777718']) } }
          ])
        })
      })
    );
  });
});

describe('POST /api/blacklist', () => {
  it('normalizes phone numbers before creating blacklist entries', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ name: 'Test User' });
    prismaMock.blacklistEntry.create.mockResolvedValue({
      id: 'bl1',
      phone: '+420739777718',
      licensePlate: null,
      name: null,
      severity: 'danger',
      reason: 'fake_booking',
      createdByName: 'Test User',
      reports: [],
    });

    const res = await request(app)
      .post('/api/blacklist')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        phone: '739 777 718',
        reason: 'fake_booking',
        severity: 'danger',
      });

    expect(res.status).toBe(201);
    expect(prismaMock.blacklistEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phone: '+420739777718' })
      })
    );
  });
});

describe('GET /api/blacklist/check', () => {
  it('checks blacklist phone numbers across phone variants', async () => {
    prismaMock.blacklistEntry.findFirst.mockResolvedValue({
      id: 'bl1',
      phone: '+420739777718',
      severity: 'danger',
      name: 'Risky Client',
      description: 'Known scammer',
      reports: [{ agencyId: 'agency-2' }],
    });

    const res = await request(app)
      .get(`/api/blacklist/check?phone=${encodeURIComponent('00420 739 777 718')}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ blacklisted: true, severity: 'danger', reportCount: 2 });
    expect(prismaMock.blacklistEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          phone: { in: expect.arrayContaining(['00420739777718', '+420739777718']) }
        }
      })
    );
  });
});

describe('POST /api/sos', () => {
  it('creates SOS alert', async () => {
    prismaMock.sOSAlert.create.mockResolvedValue({
      id: 'sos1',
      type: 'manual',
      userId: 'user-1',
      agencyId: 'agency-1',
      status: 'active',
      createdAt: new Date(),
    });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', name: 'Test', agency: { name: 'Test Agency' } });

    const res = await request(app)
      .post('/api/sos')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ type: 'manual' });

    expect(res.status).toBe(201);
  });
});

describe('Safety sessions', () => {
  const getActive = () => request(app)
    .get('/api/safety/sessions/active')
    .set('Authorization', `Bearer ${makeToken()}`);

  // Původní verze tohohle testu přijímala 200 i 404, takže neověřovala nic —
  // právě proto mohlo 404 na prázdný stav projít až na produkci a zaplavovat
  // konzoli chybou při každém načtení dashboardu.
  it('returns 200 with null when nobody is out on a booking', async () => {
    prismaMock.safetySession.findFirst.mockResolvedValue(null);

    const res = await getActive();

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('returns the session when one is running', async () => {
    prismaMock.safetySession.findFirst.mockResolvedValue({ id: 's1', state: 'CHECKED_IN' });

    const res = await getActive();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 's1', state: 'CHECKED_IN' });
  });
});
