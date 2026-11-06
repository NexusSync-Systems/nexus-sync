const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/db');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');

const prismaMock = require('../src/services/db');
const app = require('../src/app');

const TEST_USER = {
  id: 'user-1',
  email: 'test@agency.com',
  name: 'Test User',
  password: '', // set in beforeAll
  agencyId: 'agency-1',
  roleId: 'role-1',
  role: { name: 'Agency Admin', isManager: true, isAppOwner: false },
  agency: { name: 'Test Agency' },
  assignedProfiles: [],
};

beforeAll(async () => {
  TEST_USER.password = await bcrypt.hash('ValidPass1', 10);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/auth/login', () => {
  it('returns 200 with tokens on valid credentials', async () => {
    prismaMock.user.findUnique.mockResolvedValue(TEST_USER);
    prismaMock.refreshToken.create.mockResolvedValue({ id: 'rt-1', token: 'refresh-tok' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@agency.com', password: 'ValidPass1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body).toHaveProperty('expiresIn', 3600);
    expect(res.body.user.email).toBe('test@agency.com');
    expect(res.body.user.role).toBe('Agency Admin');

    // Verify JWT payload
    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(decoded.userId).toBe('user-1');
    expect(decoded.agencyId).toBe('agency-1');
  });

  it('does not fail login when assigned profile lookup fails', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.user.findUnique.mockResolvedValue(TEST_USER);
    prismaMock.refreshToken.create.mockResolvedValue({ id: 'rt-1', token: 'refresh-tok' });
    prismaMock.profile.findMany.mockRejectedValueOnce(new Error('relation mismatch'));

    try {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@agency.com', password: 'ValidPass1' });

      expect(res.status).toBe(200);
      expect(res.body.user.profileId).toBeNull();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('loads auth context only after password is verified', async () => {
    const { role: _role, agency: _agency, assignedProfiles: _profiles, ...bareUser } = TEST_USER;
    prismaMock.user.findUnique.mockResolvedValue(bareUser);
    prismaMock.role.findUnique.mockResolvedValue(TEST_USER.role);
    prismaMock.agency.findUnique.mockResolvedValue(TEST_USER.agency);
    prismaMock.refreshToken.create.mockResolvedValue({ id: 'rt-1', token: 'refresh-tok' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@agency.com', password: 'ValidPass1' });

    expect(res.status).toBe(200);
    expect(prismaMock.role.findUnique).toHaveBeenCalledWith({ where: { id: TEST_USER.roleId } });
    expect(prismaMock.agency.findUnique).toHaveBeenCalledWith({
      where: { id: TEST_USER.agencyId },
      select: { id: true, name: true }
    });
  });

  it('returns 401 on wrong password', async () => {
    prismaMock.user.findUnique.mockResolvedValue(TEST_USER);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@agency.com', password: 'WrongPass1' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('returns 401 on wrong password without loading role relations', async () => {
    const { role: _role, agency: _agency, assignedProfiles: _profiles, ...bareUser } = TEST_USER;
    prismaMock.user.findUnique.mockResolvedValue(bareUser);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@agency.com', password: 'WrongPass1' });

    expect(res.status).toBe(401);
    expect(prismaMock.role.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.agency.findUnique).not.toHaveBeenCalled();
  });

  it('returns 401 instead of 500 when stored password hash is missing', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...TEST_USER, password: null });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@agency.com', password: 'WrongPass1' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('returns 401 when user not found', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'ValidPass1' });

    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid email format', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'ValidPass1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation error');
  });

  it('normalizes email to lowercase', async () => {
    prismaMock.user.findUnique.mockResolvedValue(TEST_USER);
    prismaMock.refreshToken.create.mockResolvedValue({ id: 'rt-1', token: 'tok' });

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'TEST@Agency.COM', password: 'ValidPass1' });

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'test@agency.com' } })
    );
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates tokens on valid refresh token', async () => {
    const stored = {
      id: 'rt-1',
      token: 'valid-refresh',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
      user: TEST_USER,
    };
    prismaMock.refreshToken.findUnique.mockResolvedValue(stored);
    prismaMock.refreshToken.update.mockResolvedValue({});
    prismaMock.refreshToken.create.mockResolvedValue({ token: 'new-refresh' });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'valid-refresh' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('refreshToken');
    // Old token should be revoked
    expect(prismaMock.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt-1' },
        data: { revokedAt: expect.any(Date) },
      })
    );
  });

  it('returns 401 on expired refresh token', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      token: 'expired',
      expiresAt: new Date(Date.now() - 1000),
      revokedAt: null,
      user: TEST_USER,
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'expired' });

    expect(res.status).toBe(401);
  });

  it('returns 401 on revoked refresh token', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      token: 'revoked',
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: new Date(),
      user: TEST_USER,
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'revoked' });

    expect(res.status).toBe(401);
  });

  it('returns 401 when token not found', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'nonexistent-token' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes refresh token', async () => {
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: 'some-token' });

    expect(res.status).toBe(200);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('succeeds even without refreshToken', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .send({});

    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/register-agency', () => {
  it('creates agency, role, and user', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const mockAgency = { id: 'ag-1', name: 'New Agency', inviteCode: 'NEXUS-ABC123' };
    const mockRole = { id: 'r-1', name: 'Agency Admin' };
    const mockUser = { id: 'u-1', email: 'admin@new.com' };

    prismaMock.$transaction.mockImplementation(async (fn) => {
      prismaMock.agency.create.mockResolvedValue(mockAgency);
      // Dvě různá hledání: nejdřív globální šablona (`agencyId: null`),
      // která v produkci neexistuje, pak role právě založená pro agenturu.
      prismaMock.role.findFirst.mockImplementation(({ where }) =>
        Promise.resolve(where?.agencyId == null ? null : mockRole));
      prismaMock.role.createMany.mockResolvedValue({ count: 3 });
      prismaMock.role.create.mockResolvedValue(mockRole);
      prismaMock.user.create.mockResolvedValue(mockUser);
      return fn(prismaMock);
    });

    const res = await request(app)
      .post('/api/auth/register-agency')
      .send({
        fullName: 'Admin User',
        agencyName: 'New Agency',
        email: 'admin@new.com',
        password: 'StrongPass1',
      });

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/successfully/i);
  });

  it('rejects weak password', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/register-agency')
      .send({
        fullName: 'User',
        agencyName: 'Agency',
        email: 'user@test.com',
        password: 'weak',
      });

    // Zod validates min 8 chars + uppercase + lowercase + number
    expect(res.status).toBe(400);
  });

  it('rejects password without uppercase', async () => {
    const res = await request(app)
      .post('/api/auth/register-agency')
      .send({
        fullName: 'User',
        agencyName: 'Agency',
        email: 'user@test.com',
        password: 'alllowercase1',
      });

    expect(res.status).toBe(400);
  });

  it('rejects password without number', async () => {
    const res = await request(app)
      .post('/api/auth/register-agency')
      .send({
        fullName: 'User',
        agencyName: 'Agency',
        email: 'user@test.com',
        password: 'NoNumberHere',
      });

    expect(res.status).toBe(400);
  });

  it('rejects duplicate email', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'existing' });
    // Need transaction mock since validation passes before duplicate check
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));

    const res = await request(app)
      .post('/api/auth/register-agency')
      .send({
        fullName: 'User',
        agencyName: 'Agency',
        email: 'existing@test.com',
        password: 'StrongPass1',
      });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/me', () => {
  it('returns user profile with valid token', async () => {
    prismaMock.user.findUnique.mockResolvedValue(TEST_USER);

    const token = jwt.sign(
      { userId: 'user-1', agencyId: 'agency-1', role: { name: 'Agency Admin' } },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('test@agency.com');
    expect(res.body.role).toBe('Agency Admin');
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid-token');

    expect(res.status).toBe(401);
  });

  it('returns 401 with expired token', async () => {
    const token = jwt.sign(
      { userId: 'user-1' },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });
});
