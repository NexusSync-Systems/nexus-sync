const request = require('supertest');
const jwt = require('jsonwebtoken');

// Mock all external services BEFORE requiring app
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
const pushMock = require('../src/services/pushService');
const app = require('../src/app');

// ─── Socket mock helpers ────────────────────────────────────────────────────
const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });

beforeEach(() => {
  mockEmit.mockClear();
  mockTo.mockClear();
  socketMock.getIO.mockReturnValue({ to: mockTo });
  pushMock.sendChatPush.mockResolvedValue({ sent: 1, failed: 0 });
  pushMock.sendCallPush.mockResolvedValue({ sent: 1, failed: 0 });
  prismaMock.message.findFirst.mockResolvedValue(null);
  prismaMock.profile.findMany.mockResolvedValue([]);
  // authMiddleware nově ověřuje tokenVersion u relay tokenů (revokace) → user musí existovat
  prismaMock.user.findUnique.mockResolvedValue({ tokenVersion: 0 });
});

afterEach(() => jest.clearAllMocks());

// ─── Shared test data ────────────────────────────────────────────────────────
const DEVICE_SECRET = process.env.DEVICE_SECRET; // 'test-device-secret-16chars'
const PROFILE_PHONE = '+420773227907';
const CALLER_PHONE = '+420900111222';
const INSTALLATION_ID = 'test-installation-abc123';

const makeRelayToken = (overrides = {}) => jwt.sign({
  userId: 'user-relay-1',
  agencyId: 'agency-1',
  role: { name: 'Relay', isManager: false, isAppOwner: false },
  type: 'relay',
  ...overrides,
}, process.env.JWT_SECRET, { expiresIn: '1h' });

const mockProfile = {
  id: 'profile-1',
  name: 'Diana Test',
  phoneNumber: PROFILE_PHONE,
  agencyId: 'agency-1',
};

const mockChat = {
  id: 'chat-1',
  externalId: CALLER_PHONE,
  profileId: 'profile-1',
  agencyId: 'agency-1',
};

const mockMessage = {
  id: 'msg-1',
  chatId: 'chat-1',
  text: 'Test SMS',
  transport: 'sms',
  direction: 'INBOUND',
  status: 'delivered',
  createdAt: new Date(),
};

const mockCallLog = {
  id: 'call-1',
  profileId: 'profile-1',
  from: CALLER_PHONE,
  status: 'RINGING',
  createdAt: new Date(),
};

const mockBinding = {
  installationId: INSTALLATION_ID,
  userId: 'user-relay-1',
  agencyId: 'agency-1',
  profileId: 'profile-1',
  active: true,
  profile: { id: 'profile-1', name: 'Diana Test', agencyId: 'agency-1' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/device/verify (Nexus APK pairing flow)
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /api/device/verify', () => {
  it('binds a relay installation to an explicit same-agency profile and marks it online', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    prismaMock.deviceBinding.upsert.mockResolvedValue(mockBinding);
    prismaMock.deviceBinding.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.profile.update.mockResolvedValue({ ...mockProfile, status: 'online' });

    const res = await request(app)
      .post('/api/device/verify')
      .set('Authorization', `Bearer ${makeRelayToken({ role: { name: 'Agency Admin', isManager: true, isAppOwner: false } })}`)
      .send({
        installationId: INSTALLATION_ID,
        profileId: 'profile-1',
        platform: 'android',
        model: 'RelayApp',
        deviceName: 'Nexus Relay',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(prismaMock.profile.findFirst).toHaveBeenCalledWith({
      where: { id: 'profile-1', agencyId: 'agency-1' },
    });
    expect(prismaMock.deviceBinding.upsert).toHaveBeenCalledWith({
      where: { installationId: INSTALLATION_ID },
      update: expect.objectContaining({
        userId: 'user-relay-1',
        agencyId: 'agency-1',
        profileId: 'profile-1',
        platform: 'android',
        active: true,
        model: 'RelayApp',
        deviceName: 'Nexus Relay',
      }),
      create: expect.objectContaining({
        installationId: INSTALLATION_ID,
        userId: 'user-relay-1',
        agencyId: 'agency-1',
        profileId: 'profile-1',
        platform: 'android',
        active: true,
      }),
    });
    // `appVariant` ve filtru: deaktivují se jen ostatní vazby TÉŽE varianty.
    // Tenhle požadavek pole neposlal, takže se bere jako relay — a vazba
    // plné aplikace stejného profilu musí zůstat aktivní (#188).
    expect(prismaMock.deviceBinding.updateMany).toHaveBeenCalledWith({
      where: {
        profileId: 'profile-1',
        appVariant: 'relay',
        NOT: { installationId: INSTALLATION_ID },
        active: true,
      },
      data: { active: false },
    });
    expect(prismaMock.profile.update).toHaveBeenCalledWith({
      where: { id: 'profile-1' },
      data: { status: 'online' },
    });
  });

  it('rejects binding a relay installation to a profile outside the user agency', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/device/verify')
      .set('Authorization', `Bearer ${makeRelayToken({ role: { name: 'Agency Admin', isManager: true, isAppOwner: false } })}`)
      .send({
        installationId: INSTALLATION_ID,
        profileId: 'profile-other-agency',
        platform: 'android',
      });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, message: 'Profile not found' });
    expect(prismaMock.deviceBinding.upsert).not.toHaveBeenCalled();
    expect(prismaMock.profile.update).not.toHaveBeenCalled();
  });

  it('returns profileRequired when no profileId is provided and the user has no assigned profile', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/device/verify')
      .set('Authorization', `Bearer ${makeRelayToken({ role: { name: 'Senior Operator', isManager: true, isAppOwner: false } })}`)
      .send({
        installationId: INSTALLATION_ID,
        platform: 'android',
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, profileRequired: true });
    expect(prismaMock.deviceBinding.upsert).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/device/mobile/sms
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /api/device/mobile/sms', () => {
  it('valid secret + known to phone → 200, message saved, socket new_message emitted', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    prismaMock.chat.findFirst.mockResolvedValue(null); // no existing chat → create one
    prismaMock.chat.create.mockResolvedValue(mockChat);
    prismaMock.message.create.mockResolvedValue(mockMessage);

    const res = await request(app)
      .post('/api/device/mobile/sms')
      .send({
        secret: DEVICE_SECRET,
        from: CALLER_PHONE,
        to: PROFILE_PHONE,
        text: 'Test SMS',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'success' });
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith('agency_agency-1');
    expect(mockEmit).toHaveBeenCalledWith('new_message', expect.objectContaining({ transport: 'sms' }));
  });

  it('finds the target profile when mobile SMS uses an international dialing prefix', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    prismaMock.chat.findFirst.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue(mockChat);
    prismaMock.message.create.mockResolvedValue(mockMessage);

    const res = await request(app)
      .post('/api/device/mobile/sms')
      .send({
        secret: DEVICE_SECRET,
        from: CALLER_PHONE,
        to: '00420 773 227 907',
        text: 'International prefix SMS',
      });

    expect(res.status).toBe(200);
    expect(prismaMock.profile.findFirst).toHaveBeenCalledWith({
      where: {
        phoneNumber: {
          in: expect.arrayContaining(['00420773227907', '+420773227907', '+420 773 227 907']),
        },
      },
    });
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to stored profile country context for local non-EU mobile SMS destinations', async () => {
    const ukProfile = {
      id: 'profile-uk',
      name: 'Bella UK',
      phoneNumber: '+44 7700 900456',
      agencyId: 'agency-uk',
    };
    prismaMock.profile.findFirst.mockResolvedValue(null);
    prismaMock.profile.findMany.mockResolvedValue([ukProfile]);
    prismaMock.chat.findFirst.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue({ ...mockChat, profileId: 'profile-uk', agencyId: 'agency-uk' });
    prismaMock.message.create.mockResolvedValue(mockMessage);

    const res = await request(app)
      .post('/api/device/mobile/sms')
      .send({
        secret: DEVICE_SECRET,
        from: '+1 212 555 0101',
        to: '07700 900456',
        text: 'UK local destination SMS',
      });

    expect(res.status).toBe(200);
    expect(prismaMock.profile.findMany).toHaveBeenCalledWith({
      where: { phoneNumber: { not: null } },
      select: { id: true, name: true, phoneNumber: true, agencyId: true },
    });
    expect(mockTo).toHaveBeenCalledWith('agency_agency-uk');
  });

  it('wrong secret → 401', async () => {
    const res = await request(app)
      .post('/api/device/mobile/sms')
      .send({
        secret: 'WRONGSECRET',
        from: CALLER_PHONE,
        to: PROFILE_PHONE,
        text: 'Test SMS',
      });

    expect(res.status).toBe(401);
  });

  it('unknown to phone (profile not found) → 404', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/device/mobile/sms')
      .send({
        secret: DEVICE_SECRET,
        from: CALLER_PHONE,
        to: '+999000000000',
        text: 'Test SMS',
      });

    expect(res.status).toBe(404);
  });

  it('missing from field → 400', async () => {
    const res = await request(app)
      .post('/api/device/mobile/sms')
      .send({
        secret: DEVICE_SECRET,
        to: PROFILE_PHONE,
        text: 'Test SMS',
        // from is missing
      });

    // The zod schema requires 'from'; validation should reject with 400
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/device/mobile/call
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /api/device/mobile/call', () => {
  it('valid secret + known to + state RINGING → 200, CallLog created, incoming_call emitted', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    prismaMock.callLog.create.mockResolvedValue({ ...mockCallLog, status: 'RINGING' });

    const res = await request(app)
      .post('/api/device/mobile/call')
      .send({
        secret: DEVICE_SECRET,
        from: CALLER_PHONE,
        to: PROFILE_PHONE,
        state: 'RINGING',
      });

    expect(res.status).toBe(200);
    expect(prismaMock.callLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RINGING' }) })
    );
    expect(mockTo).toHaveBeenCalledWith('agency_agency-1');
    expect(mockEmit).toHaveBeenCalledWith('incoming_call', expect.objectContaining({ state: 'RINGING' }));
  });

  it('finds the target profile when mobile call uses an international dialing prefix', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    prismaMock.callLog.create.mockResolvedValue({ ...mockCallLog, status: 'RINGING' });

    const res = await request(app)
      .post('/api/device/mobile/call')
      .send({
        secret: DEVICE_SECRET,
        from: CALLER_PHONE,
        to: '00420 773 227 907',
        state: 'RINGING',
      });

    expect(res.status).toBe(200);
    expect(prismaMock.callLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ profileId: 'profile-1' }) })
    );
  });

  it('state ANSWERED → 200, CallLog with state ANSWERED', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    prismaMock.callLog.create.mockResolvedValue({ ...mockCallLog, status: 'ANSWERED' });

    const res = await request(app)
      .post('/api/device/mobile/call')
      .send({
        secret: DEVICE_SECRET,
        from: CALLER_PHONE,
        to: PROFILE_PHONE,
        state: 'ANSWERED',
      });

    expect(res.status).toBe(200);
    expect(prismaMock.callLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ANSWERED' }) })
    );
  });

  it('state MISSED → 200, CallLog with state MISSED', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    prismaMock.callLog.create.mockResolvedValue({ ...mockCallLog, status: 'MISSED' });

    const res = await request(app)
      .post('/api/device/mobile/call')
      .send({
        secret: DEVICE_SECRET,
        from: CALLER_PHONE,
        to: PROFILE_PHONE,
        state: 'MISSED',
      });

    expect(res.status).toBe(200);
    expect(prismaMock.callLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'MISSED' }) })
    );
  });

  it('wrong secret → 401', async () => {
    const res = await request(app)
      .post('/api/device/mobile/call')
      .send({
        secret: 'WRONGSECRET',
        from: CALLER_PHONE,
        to: PROFILE_PHONE,
        state: 'RINGING',
      });

    expect(res.status).toBe(401);
  });

  it('unknown to phone → 404', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/device/mobile/call')
      .send({
        secret: DEVICE_SECRET,
        from: CALLER_PHONE,
        to: '+999000000000',
        state: 'RINGING',
      });

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/device/relay (Nexus APK flow)
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /api/device/relay', () => {
  it('active binding + transport sms → 200, message saved, socket emitted', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);
    prismaMock.chat.findFirst.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue(mockChat);
    prismaMock.message.create.mockResolvedValue(mockMessage);
    prismaMock.chat.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        from: CALLER_PHONE,
        content: 'Relay SMS text',
        transport: 'sms',
        secret: DEVICE_SECRET,
      });

    expect(res.status).toBe(200);
    expect(prismaMock.deviceBinding.update).toHaveBeenCalledWith({
      where: { installationId: INSTALLATION_ID },
      data: { lastSeenAt: expect.any(Date) }
    });
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith('agency_agency-1');
    expect(mockEmit).toHaveBeenCalledWith('new_message', expect.objectContaining({ transport: 'sms' }));
  });

  it('accepts relay payloads with a non-user deviceId label', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);
    prismaMock.chat.findFirst.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue(mockChat);
    prismaMock.message.create.mockResolvedValue(mockMessage);
    prismaMock.chat.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        deviceId: 'RELAY-DEVICE-LABEL',
        from: CALLER_PHONE,
        content: 'Relay SMS with device label',
        transport: 'sms',
        secret: DEVICE_SECRET,
      });

    expect(res.status).toBe(200);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith('new_message', expect.objectContaining({ transport: 'sms' }));
  });

  it('rejects relay payloads with an explicit mismatched userId', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        userId: 'user-from-another-binding',
        from: CALLER_PHONE,
        content: 'Relay SMS user mismatch',
        transport: 'sms',
        secret: DEVICE_SECRET,
      });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ message: 'Unauthorized: User ID mismatch' });
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('normalizes local Czech caller numbers before creating a relay chat', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue({
      ...mockBinding,
      profile: { ...mockBinding.profile, phoneNumber: '+420 773 227 907' },
    });
    prismaMock.chat.findFirst.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue({
      ...mockChat,
      externalId: '+420739777718',
    });
    prismaMock.message.create.mockResolvedValue({
      ...mockMessage,
      chatId: mockChat.id,
      createdAt: new Date(),
    });
    prismaMock.chat.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        from: '739 777 718',
        content: 'July message',
        transport: 'sms',
        secret: DEVICE_SECRET,
      });

    expect(res.status).toBe(200);
    expect(prismaMock.chat.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalId: {
            in: expect.arrayContaining(['739777718', '0739777718', '+420739777718', '420739777718', '0420739777718']),
          },
        }),
      })
    );
    expect(prismaMock.chat.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalId: '+420739777718' }),
      })
    );
    expect(mockEmit).toHaveBeenCalledWith('new_message', expect.objectContaining({ from: '+420739777718' }));
  });

  it('deduplicates relay SMS resent by Android broadcast and inbox fallback', async () => {
    const duplicateMessage = {
      ...mockMessage,
      id: 'msg-duplicate',
      text: 'Relay SMS text',
      createdAt: new Date('2026-07-07T09:18:52.000Z'),
    };
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);
    prismaMock.chat.findFirst.mockResolvedValue(mockChat);
    prismaMock.message.findFirst.mockResolvedValue(duplicateMessage);

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        from: CALLER_PHONE,
        content: 'Relay SMS text',
        transport: 'sms',
        timestamp: '2026-07-07T09:18:53.000Z',
        secret: DEVICE_SECRET,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true, messageId: 'msg-duplicate' });
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalledWith('new_message', expect.anything());
  });

  it('active binding without DEVICE_SECRET → 401', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        from: CALLER_PHONE,
        content: 'Relay SMS text',
        transport: 'sms',
      });

    expect(res.status).toBe(401);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('active binding + matching Bearer token without DEVICE_SECRET → 200', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);
    prismaMock.chat.findFirst.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue(mockChat);
    prismaMock.message.create.mockResolvedValue(mockMessage);
    prismaMock.chat.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/device/relay')
      .set('Authorization', `Bearer ${makeRelayToken()}`)
      .send({
        installationId: INSTALLATION_ID,
        from: CALLER_PHONE,
        content: 'Relay SMS via bearer',
        transport: 'sms',
      });

    expect(res.status).toBe(200);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith('new_message', expect.objectContaining({ transport: 'sms' }));
  });

  it('active binding + Bearer token for another agency → 401', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);

    const res = await request(app)
      .post('/api/device/relay')
      .set('Authorization', `Bearer ${makeRelayToken({ agencyId: 'agency-2' })}`)
      .send({
        installationId: INSTALLATION_ID,
        from: CALLER_PHONE,
        content: 'Cross-agency relay SMS',
        transport: 'sms',
      });

    expect(res.status).toBe(401);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('active binding + transport call → 200, CallLog created, incoming_call emitted', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);
    prismaMock.callLog.create.mockResolvedValue({ ...mockCallLog, status: 'RINGING' });

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        from: CALLER_PHONE,
        content: 'RINGING',
        transport: 'call',
        secret: DEVICE_SECRET,
      });

    expect(res.status).toBe(200);
    expect(prismaMock.callLog.create).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith('incoming_call', expect.objectContaining({ profileId: 'profile-1' }));
  });

  it('unknown installationId (no binding) + no secret → 401 or 404', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: 'unknown-installation-id',
        from: CALLER_PHONE,
        content: 'Test',
        transport: 'sms',
      });

    // Without active binding and without correct secret, should be 401 or 404
    expect([401, 404]).toContain(res.status);
  });

  it('inactive binding + wrong secret → 401', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue({ ...mockBinding, active: false });

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        from: CALLER_PHONE,
        content: 'Test',
        transport: 'sms',
        secret: 'WRONGSECRET',
      });

    expect(res.status).toBe(401);
  });

  it('type SMS_SENT → direction OUTBOUND in message', async () => {
    prismaMock.deviceBinding.findUnique.mockResolvedValue(mockBinding);
    prismaMock.chat.findFirst.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue(mockChat);
    const outboundMessage = { ...mockMessage, direction: 'OUTBOUND' };
    prismaMock.message.create.mockResolvedValue(outboundMessage);
    prismaMock.chat.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/device/relay')
      .send({
        installationId: INSTALLATION_ID,
        from: CALLER_PHONE,
        content: 'Sent SMS',
        transport: 'sms',
        type: 'SMS_SENT',
        secret: DEVICE_SECRET,
      });

    expect(res.status).toBe(200);
    expect(prismaMock.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: 'OUTBOUND' }),
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/device/goip/sms
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /api/device/goip/sms', () => {
  it('valid src/dst/msg, profile found → 200 text "RECEIVE OK"', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    // GoIP uses findUnique with compound key
    prismaMock.chat.findUnique.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue(mockChat);
    prismaMock.message.create.mockResolvedValue(mockMessage);

    const res = await request(app)
      .post('/api/device/goip/sms')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`secret=${process.env.DEVICE_SECRET}&src=${encodeURIComponent('+420900111333')}&dst=${encodeURIComponent(PROFILE_PHONE)}&msg=${encodeURIComponent('GoIP test message')}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('RECEIVE OK');
  });

  it('finds the target profile when GoIP destination uses 00 international prefix', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(mockProfile);
    prismaMock.chat.findFirst.mockResolvedValue(null);
    prismaMock.chat.create.mockResolvedValue(mockChat);
    prismaMock.message.create.mockResolvedValue(mockMessage);

    const res = await request(app)
      .post('/api/device/goip/sms')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`secret=${process.env.DEVICE_SECRET}&src=${encodeURIComponent('+420900111333')}&dst=${encodeURIComponent('00420 773 227 907')}&msg=${encodeURIComponent('GoIP prefix test')}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('RECEIVE OK');
    expect(prismaMock.profile.findFirst).toHaveBeenCalledWith({
      where: {
        phoneNumber: {
          in: expect.arrayContaining(['00420773227907', '+420773227907']),
        },
      },
    });
  });

  it('unknown dst phone → 404', async () => {
    prismaMock.profile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/device/goip/sms')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`secret=${process.env.DEVICE_SECRET}&src=${encodeURIComponent('+420900111333')}&dst=${encodeURIComponent('+999000000000')}&msg=test`);

    expect(res.status).toBe(404);
  });

  it('missing fields → 400', async () => {
    const res = await request(app)
      .post('/api/device/goip/sms')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`secret=${process.env.DEVICE_SECRET}&src=${encodeURIComponent('+420900111333')}`); // dst and msg missing

    expect(res.status).toBe(400);
  });

  it('missing secret → 401', async () => {
    const res = await request(app)
      .post('/api/device/goip/sms')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`src=${encodeURIComponent('+420900111333')}&dst=${encodeURIComponent(PROFILE_PHONE)}&msg=${encodeURIComponent('GoIP test message')}`);

    expect(res.status).toBe(401);
  });
});
