const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/db');
jest.mock('../src/services/socket');
jest.mock('../src/services/pushService');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('node-ssh', () => ({
  NodeSSH: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    execCommand: jest.fn(),
    dispose: jest.fn()
  }))
}));

const prismaMock = require('../src/services/db');
const { NodeSSH } = require('node-ssh');
const app = require('../src/app');

const originalNodeEnv = process.env.NODE_ENV;
const originalWebhookSecret = process.env.WEBHOOK_SECRET;
const originalAllowLegacyDeviceEndpoints = process.env.ALLOW_LEGACY_DEVICE_ENDPOINTS;

function makeToken({
  userId = 'user-1',
  agencyId = 'agency-1',
  roleName = 'Agency Admin',
  isManager = true,
  isAppOwner = false
} = {}) {
  return jwt.sign(
    {
      userId,
      agencyId,
      role: { name: roleName, isManager, isAppOwner }
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

afterEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = originalNodeEnv;
  if (originalWebhookSecret === undefined) {
    delete process.env.WEBHOOK_SECRET;
  } else {
    process.env.WEBHOOK_SECRET = originalWebhookSecret;
  }
  if (originalAllowLegacyDeviceEndpoints === undefined) {
    delete process.env.ALLOW_LEGACY_DEVICE_ENDPOINTS;
  } else {
    process.env.ALLOW_LEGACY_DEVICE_ENDPOINTS = originalAllowLegacyDeviceEndpoints;
  }
});

describe('profile authorization boundaries', () => {
  it('blocks managers from updating credentials on another agency profile', async () => {
    prismaMock.profile.findUnique.mockResolvedValue({
      id: 'profile-other-agency',
      agencyId: 'agency-2',
      name: 'Other Agency Profile'
    });

    const res = await request(app)
      .post('/api/profiles/profile-other-agency/credentials')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ credentials: { adultwork: { username: 'secret' } } });

    expect(res.status).toBe(404);
    expect(prismaMock.profile.update).not.toHaveBeenCalled();
  });

  it('rejects assigning users from outside the profile agency', async () => {
    prismaMock.profile.findUnique.mockResolvedValue({
      id: 'profile-1',
      agencyId: 'agency-1',
      name: 'Diana'
    });
    // Dotaz na kandidáty vrací jen jednoho z dvou poslaných — ten druhý
    // je z jiné agentury, takže do `where` s `agencyId` nespadne.
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'user-1', role: { name: 'Operator', isManager: false, isAppOwner: false } }
    ]);

    const res = await request(app)
      .patch('/api/profiles/profile-1/assignees')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ userIds: ['user-1', 'user-from-agency-2'] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: 'All assignees must belong to the profile agency' });
    expect(prismaMock.profile.update).not.toHaveBeenCalled();
  });

  // Od #185 mají modelky účty ve stejné agentuře. Do té doby byli „všichni
  // uživatelé agentury" personál, takže kontrola agentury stačila. Teď už ne:
  // bez kontroly role by manažerka mohla dát modelce A přístup do chatu
  // modelky B. UI účty modelek odfiltruje, ale filtr v prohlížeči není
  // kontrola — tahle rozhoduje na serveru.
  it('nedovolí přiřadit účet modelky jako operátorku', async () => {
    prismaMock.profile.findUnique.mockResolvedValue({
      id: 'profile-1',
      agencyId: 'agency-1',
      name: 'Diana'
    });
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'user-1', role: { name: 'Operator', isManager: false, isAppOwner: false } },
      { id: 'modelka-b', role: { name: 'Model', isManager: false, isAppOwner: false } }
    ]);

    const res = await request(app)
      .patch('/api/profiles/profile-1/assignees')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ userIds: ['user-1', 'modelka-b'] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: 'Model accounts cannot be assigned as operators' });
    // Podstatnější než status: seznam se nesmí uložit ANI ČÁSTEČNĚ.
    expect(prismaMock.profile.update).not.toHaveBeenCalled();
  });

  it('pozná i ručně založenou roli „Modelka" s diakritikou', async () => {
    prismaMock.profile.findUnique.mockResolvedValue({
      id: 'profile-1',
      agencyId: 'agency-1',
      name: 'Diana'
    });
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'modelka-b', role: { name: 'Modelka', isManager: false, isAppOwner: false } }
    ]);

    const res = await request(app)
      .patch('/api/profiles/profile-1/assignees')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ userIds: ['modelka-b'] });

    expect(res.status).toBe(400);
    expect(prismaMock.profile.update).not.toHaveBeenCalled();
  });

  it('operátorku ze stejné agentury přiřadit nechá', async () => {
    // Opačný směr, jinak by test nad tím prošel i u kódu, který zakazuje
    // přiřazení komukoli.
    prismaMock.profile.findUnique.mockResolvedValue({
      id: 'profile-1',
      agencyId: 'agency-1',
      name: 'Diana'
    });
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'op-1', role: { name: 'Operator', isManager: false, isAppOwner: false } },
      { id: 'op-2', role: { name: 'Senior Operator', isManager: true, isAppOwner: false } }
    ]);
    prismaMock.profile.update.mockResolvedValue({ id: 'profile-1', assignees: [] });

    const res = await request(app)
      .patch('/api/profiles/profile-1/assignees')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ userIds: ['op-1', 'op-2'] });

    expect(res.status).toBe(200);
    expect(prismaMock.profile.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.profile.update.mock.calls[0][0].data).toEqual({
      assignees: { set: [{ id: 'op-1' }, { id: 'op-2' }] }
    });
  });

  it('prázdný seznam projde — je to odebrání všech operátorek', async () => {
    // `userIds: []` se do kontroly rolí vůbec nedostane a musí dál fungovat
    // jako „zruš přiřazení", jinak by profil nešel uvolnit.
    prismaMock.profile.findUnique.mockResolvedValue({
      id: 'profile-1',
      agencyId: 'agency-1',
      name: 'Diana'
    });
    prismaMock.profile.update.mockResolvedValue({ id: 'profile-1', assignees: [] });

    const res = await request(app)
      .patch('/api/profiles/profile-1/assignees')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ userIds: [] });

    expect(res.status).toBe(200);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
    expect(prismaMock.profile.update.mock.calls[0][0].data).toEqual({ assignees: { set: [] } });
  });
});

describe('infrastructure authorization boundaries', () => {
  it('keeps Vultr command execution app-owner-only', async () => {
    const res = await request(app)
      .post('/api/vultr/command')
      .set('Authorization', `Bearer ${makeToken({ roleName: 'Agency Admin', isManager: true })}`)
      .send({ command: 'git status' });

    expect(res.status).toBe(403);
    expect(NodeSSH).not.toHaveBeenCalled();
  });

  it('rejects non-read-only commands even for app owners', async () => {
    const res = await request(app)
      .post('/api/vultr/command')
      .set('Authorization', `Bearer ${makeToken({ roleName: 'App Owner', isManager: true, isAppOwner: true })}`)
      .send({ command: 'cat /etc/passwd' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/allowlist/i);
    expect(NodeSSH).not.toHaveBeenCalled();
  });
});

describe('admin settings authorization boundaries', () => {
  it('keeps global settings app-owner-only', async () => {
    const res = await request(app)
      .get('/api/admin/settings')
      .set('Authorization', `Bearer ${makeToken({ roleName: 'Agency Admin', isManager: true })}`);

    expect(res.status).toBe(403);
    expect(prismaMock.globalSetting.findMany).not.toHaveBeenCalled();
  });

  it('allows app owners to read global settings', async () => {
    prismaMock.globalSetting.findMany.mockResolvedValue([
      { id: 'setting-1', key: 'SUBSCRIPTION_PLANS', value: '[]' }
    ]);

    const res = await request(app)
      .get('/api/admin/settings')
      .set('Authorization', `Bearer ${makeToken({ roleName: 'App Owner', isManager: true, isAppOwner: true })}`);

    expect(res.status).toBe(200);
    expect(prismaMock.globalSetting.findMany).toHaveBeenCalledWith({
      orderBy: { key: 'asc' }
    });
  });
});

describe('webhook routing and shared-secret enforcement', () => {
  it('rejects generic webhooks without the shared secret', async () => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.ALLOW_LEGACY_WEBHOOK_SECRET = 'true'; // legacy sdílený secret je nově opt-in

    const res = await request(app)
      .post('/api/webhooks/generic')
      .send({ source: 'telegram', externalId: '123', text: 'hello', agencyId: 'agency-1' });

    expect(res.status).toBe(401);
    expect(prismaMock.chat.create).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('does not create chats when webhook payload has no routed profile or agency', async () => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.ALLOW_LEGACY_WEBHOOK_SECRET = 'true'; // legacy sdílený secret je nově opt-in

    const res = await request(app)
      .post('/api/webhooks/generic')
      .set('x-webhook-secret', 'test-webhook-secret')
      .send({ source: 'telegram', externalId: '123', text: 'hello' });

    expect(res.status).toBe(404);
    expect(prismaMock.profile.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.chat.create).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('rejects webhook profile and agency mismatches', async () => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.ALLOW_LEGACY_WEBHOOK_SECRET = 'true'; // legacy sdílený secret je nově opt-in
    prismaMock.profile.findUnique.mockResolvedValue({
      id: 'profile-2',
      agencyId: 'agency-2',
      status: 'online'
    });

    const res = await request(app)
      .post('/api/webhooks/generic')
      .set('x-webhook-secret', 'test-webhook-secret')
      .send({
        source: 'telegram',
        externalId: '123',
        text: 'hello',
        profileId: 'profile-2',
        agencyId: 'agency-1'
      });

    expect(res.status).toBe(404);
    expect(prismaMock.chat.create).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});

describe('legacy device endpoint production guard', () => {
  it('disables legacy mobile SMS ingestion unless explicitly enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_LEGACY_DEVICE_ENDPOINTS;

    const res = await request(app)
      .post('/api/device/mobile/sms')
      .send({
        secret: process.env.DEVICE_SECRET,
        from: '+420900111222',
        to: '+420773227907',
        text: 'legacy sms'
      });

    expect(res.status).toBe(410);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('disables legacy mobile call ingestion unless explicitly enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_LEGACY_DEVICE_ENDPOINTS;

    const res = await request(app)
      .post('/api/device/mobile/call')
      .send({
        secret: process.env.DEVICE_SECRET,
        from: '+420900111222',
        to: '+420773227907',
        state: 'RINGING'
      });

    expect(res.status).toBe(410);
    expect(prismaMock.callLog.create).not.toHaveBeenCalled();
  });

  it('disables legacy GoIP SMS ingestion unless explicitly enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_LEGACY_DEVICE_ENDPOINTS;

    const res = await request(app)
      .post('/api/device/goip/sms')
      .type('form')
      .send({
        secret: process.env.DEVICE_SECRET,
        src: '+420900111222',
        dst: '+420773227907',
        msg: 'legacy goip sms'
      });

    expect(res.status).toBe(410);
    expect(res.text).toBe('LEGACY ENDPOINT DISABLED');
    expect(prismaMock.profile.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});
