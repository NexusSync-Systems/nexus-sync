const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('../src/services/db');
jest.mock('../src/services/socket');
jest.mock('../src/services/logger');
jest.mock('../src/services/pushService');
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({})));

const prismaMock = require('../src/services/db');
const socketMock = require('../src/services/socket');
const app = require('../src/app');

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });

const makeToken = (overrides = {}) => jwt.sign({
  userId: 'user-1',
  agencyId: 'agency-1',
  role: { name: 'Agency Admin', isManager: true, isAppOwner: false },
  ...overrides
}, process.env.JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => {
  jest.clearAllMocks();
  socketMock.getIO.mockReturnValue({ to: mockTo });
  prismaMock.sOSAlert.findFirst.mockResolvedValue(null);
});

describe('GPS tracker pairing', () => {
  it('pairs a tracker to a profile in the caller agency and returns one-time ingest token', async () => {
    prismaMock.profile.findUnique.mockResolvedValue({ id: 'profile-1', agencyId: 'agency-1', name: 'Diana' });
    prismaMock.gpsTracker.findUnique.mockResolvedValue(null);
    prismaMock.gpsTracker.create.mockImplementation(async ({ data }) => ({
      id: 'tracker-1',
      ...data,
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    const res = await request(app)
      .post('/api/trackers/pair')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ imei: ' 123456789012345 ', profileId: 'profile-1', label: 'Diana keyfob' });

    expect(res.status).toBe(201);
    expect(res.body.tracker).toMatchObject({
      id: 'tracker-1',
      agencyId: 'agency-1',
      profileId: 'profile-1',
      imei: '123456789012345',
      active: true
    });
    expect(res.body.tracker.secretHash).toBeUndefined();
    expect(res.body.ingest.token).toMatch(/^nxtrk_tracker-1\./);

    const secret = res.body.ingest.token.split('.')[1];
    const savedHash = prismaMock.gpsTracker.create.mock.calls[0][0].data.secretHash;
    await expect(bcrypt.compare(secret, savedHash)).resolves.toBe(true);
  });

  it('does not allow pairing a tracker to a profile from another agency', async () => {
    prismaMock.profile.findUnique.mockResolvedValue({ id: 'profile-2', agencyId: 'agency-2', name: 'Other' });

    const res = await request(app)
      .post('/api/trackers/pair')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ imei: '123456789012345', profileId: 'profile-2' });

    expect(res.status).toBe(403);
    expect(prismaMock.gpsTracker.create).not.toHaveBeenCalled();
  });
});

describe('GPS tracker ingest', () => {
  it('rejects a wrong tracker secret without storing location', async () => {
    prismaMock.gpsTracker.findUnique.mockResolvedValue({
      id: 'tracker-1',
      agencyId: 'agency-1',
      profileId: 'profile-1',
      active: true,
      secretHash: await bcrypt.hash('correct-secret', 4)
    });

    const res = await request(app)
      .post('/api/trackers/ingest')
      .send({ token: 'nxtrk_tracker-1.wrong-secret', lat: 50.1, lng: 14.4 });

    expect(res.status).toBe(401);
    expect(prismaMock.gpsTrackerLocation.create).not.toHaveBeenCalled();
  });

  it('stores JSON location and mirrors it into an active SafetySession', async () => {
    prismaMock.gpsTracker.findUnique.mockResolvedValue({
      id: 'tracker-1',
      agencyId: 'agency-1',
      profileId: 'profile-1',
      active: true,
      secretHash: await bcrypt.hash('correct-secret', 4)
    });
    prismaMock.safetySession.findFirst.mockResolvedValue({ id: 'session-1', agencyId: 'agency-1', profileId: 'profile-1' });
    prismaMock.gpsTrackerLocation.create.mockResolvedValue({ id: 'loc-1' });
    prismaMock.safetyLocationPoint.create.mockResolvedValue({ id: 'safe-loc-1' });
    prismaMock.gpsTracker.update.mockResolvedValue({ id: 'tracker-1' });

    const res = await request(app)
      .post('/api/trackers/ingest')
      .send({
        token: 'nxtrk_tracker-1.correct-secret',
        lat: 50.0875,
        lng: 14.4213,
        accuracy: 8,
        battery: 81,
        capturedAt: '2026-07-09T12:00:00.000Z'
      });

    expect(res.status).toBe(201);
    expect(prismaMock.gpsTrackerLocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trackerId: 'tracker-1',
        agencyId: 'agency-1',
        profileId: 'profile-1',
        safetySessionId: 'session-1',
        lat: 50.0875,
        lng: 14.4213,
        battery: 81
      })
    });
    expect(prismaMock.safetyLocationPoint.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sessionId: 'session-1', lat: 50.0875, lng: 14.4213 })
    });
    expect(mockTo).toHaveBeenCalledWith('agency_agency-1');
    expect(mockEmit).toHaveBeenCalledWith('tracker_location_update', expect.objectContaining({ trackerId: 'tracker-1' }));
  });

  it('rejects invalid numeric query values without storing location', async () => {
    prismaMock.gpsTracker.findUnique.mockResolvedValue({
      id: 'tracker-1',
      agencyId: 'agency-1',
      profileId: 'profile-1',
      active: true,
      secretHash: await bcrypt.hash('correct-secret', 4)
    });

    const res = await request(app)
      .get('/api/trackers/ingest')
      .query({
        token: 'nxtrk_tracker-1.correct-secret',
        lat: '50.0875',
        lng: '14.4213',
        speed: 'fast'
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid speed');
    expect(prismaMock.gpsTrackerLocation.create).not.toHaveBeenCalled();
  });

  it('accepts GPRMC payloads and stores parsed coordinates', async () => {
    prismaMock.gpsTracker.findUnique.mockResolvedValue({
      id: 'tracker-1',
      agencyId: 'agency-1',
      profileId: 'profile-1',
      active: true,
      secretHash: await bcrypt.hash('correct-secret', 4)
    });
    prismaMock.safetySession.findFirst.mockResolvedValue(null);
    prismaMock.gpsTrackerLocation.create.mockResolvedValue({ id: 'loc-1' });
    prismaMock.gpsTracker.update.mockResolvedValue({ id: 'tracker-1' });

    const res = await request(app)
      .post('/api/trackers/ingest')
      .send({
        token: 'nxtrk_tracker-1.correct-secret',
        gprmc: '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A'
      });

    expect(res.status).toBe(201);
    const data = prismaMock.gpsTrackerLocation.create.mock.calls[0][0].data;
    expect(data.lat).toBeCloseTo(48.1173, 4);
    expect(data.lng).toBeCloseTo(11.5167, 4);
    expect(data.speedKph).toBeCloseTo(41.4848, 4);
    expect(data.heading).toBeCloseTo(84.4, 4);
  });
});

describe('GPS tracker self-pairing (phone as tracker)', () => {
  const modelToken = () => makeToken({ userId: 'model-1', role: { name: 'Model', isManager: false, isAppOwner: false } });

  it('lets a Model pair their own phone to their assigned profile and returns a token', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      agencyId: 'agency-1',
      assignedProfiles: [{ id: 'profile-1', agencyId: 'agency-1' }]
    });
    prismaMock.gpsTracker.findUnique.mockResolvedValue(null);
    prismaMock.gpsTracker.create.mockImplementation(async ({ data }) => ({ id: 'tracker-9', ...data }));

    const res = await request(app)
      .post('/api/trackers/pair-self')
      .set('Authorization', `Bearer ${modelToken()}`)
      .send({ installationId: 'inst_abc123def456' });

    expect(res.status).toBe(201);
    expect(res.body.ingest.token).toMatch(/^nxtrk_tracker-9\./);
    const saved = prismaMock.gpsTracker.create.mock.calls[0][0].data;
    expect(saved.profileId).toBe('profile-1');
    expect(saved.imei).toBe('PHONE:INST_ABC123DEF456'); // installationId as normalized pseudo-IMEI
  });

  it('rejects self-pairing when the account has no assigned profile', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ agencyId: 'agency-1', assignedProfiles: [] });

    const res = await request(app)
      .post('/api/trackers/pair-self')
      .set('Authorization', `Bearer ${modelToken()}`)
      .send({ installationId: 'inst_abc123def456' });

    expect(res.status).toBe(403);
    expect(prismaMock.gpsTracker.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid installationId', async () => {
    const res = await request(app)
      .post('/api/trackers/pair-self')
      .set('Authorization', `Bearer ${modelToken()}`)
      .send({ installationId: 'x' });

    expect(res.status).toBe(400);
  });

  // Modelka s vlastním účtem (#184/#185) NENÍ svým vlastním assignee — vlastní
  // profil, neobsluhuje ho. Dokud se tu hledalo jen přes `assignedProfiles`,
  // dostala 403 a sledování polohy vůbec nenaběhlo. U bezpečnostní funkce to
  // bylo tím horší, že klient tu chybu polykal, takže se to nijak neprojevilo.
  it('lets a Model pair the phone to the profile she OWNS (she is not her own assignee)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      agencyId: 'agency-1',
      ownedProfile: { id: 'profile-vlastni', agencyId: 'agency-1' },
      assignedProfiles: []
    });
    prismaMock.gpsTracker.findUnique.mockResolvedValue(null);
    prismaMock.gpsTracker.create.mockImplementation(async ({ data }) => ({ id: 'tracker-own', ...data }));

    const res = await request(app)
      .post('/api/trackers/pair-self')
      .set('Authorization', `Bearer ${modelToken()}`)
      .send({ installationId: 'inst_vlastnitelefon' });

    expect(res.status).toBe(201);
    expect(prismaMock.gpsTracker.create.mock.calls[0][0].data.profileId).toBe('profile-vlastni');
  });

  it('prefers the owned profile over an assigned one when none is requested', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      agencyId: 'agency-1',
      ownedProfile: { id: 'profile-vlastni', agencyId: 'agency-1' },
      assignedProfiles: [{ id: 'profile-cizi', agencyId: 'agency-1' }]
    });
    prismaMock.gpsTracker.findUnique.mockResolvedValue(null);
    prismaMock.gpsTracker.create.mockImplementation(async ({ data }) => ({ id: 'tracker-own2', ...data }));

    const res = await request(app)
      .post('/api/trackers/pair-self')
      .set('Authorization', `Bearer ${modelToken()}`)
      .send({ installationId: 'inst_vlastnitelefon2' });

    expect(res.status).toBe(201);
    // telefon má sledovat JEJÍ profil, ne ten první přiřazený
    expect(prismaMock.gpsTracker.create.mock.calls[0][0].data.profileId).toBe('profile-vlastni');
  });

  // Pojistka proti převzetí cizího trackeru musí vlastněný profil počítat taky,
  // jinak by si modelka nemohla přepárovat ani svůj vlastní telefon.
  it('lets her re-pair a phone already pinned to her OWN profile', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      agencyId: 'agency-1',
      ownedProfile: { id: 'profile-vlastni', agencyId: 'agency-1' },
      assignedProfiles: []
    });
    prismaMock.gpsTracker.findUnique.mockResolvedValue({
      id: 'tracker-old', agencyId: 'agency-1', profileId: 'profile-vlastni'
    });
    prismaMock.gpsTracker.update.mockImplementation(async ({ data }) => ({ id: 'tracker-old', ...data }));

    const res = await request(app)
      .post('/api/trackers/pair-self')
      .set('Authorization', `Bearer ${modelToken()}`)
      .send({ installationId: 'inst_vlastnitelefon' });

    expect(res.status).toBe(200);
    expect(prismaMock.gpsTracker.update).toHaveBeenCalled();
  });

  it('does not let a caller take over a phone tracker paired to another profile (same agency)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      agencyId: 'agency-1',
      assignedProfiles: [{ id: 'profile-mine', agencyId: 'agency-1' }]
    });
    prismaMock.gpsTracker.findUnique.mockResolvedValue({
      id: 'tracker-x', agencyId: 'agency-1', profileId: 'profile-victim'
    });

    const res = await request(app)
      .post('/api/trackers/pair-self')
      .set('Authorization', `Bearer ${modelToken()}`)
      .send({ installationId: 'inst_victimdevice' });

    expect(res.status).toBe(409);
    expect(prismaMock.gpsTracker.update).not.toHaveBeenCalled();
    expect(prismaMock.gpsTracker.create).not.toHaveBeenCalled();
  });
});

describe('Traccar gateway forwarding (physical GPS+SIM trackers)', () => {
  const FORWARD_SECRET = 'test-forward-secret';
  beforeAll(() => { process.env.TRACCAR_FORWARD_SECRET = FORWARD_SECRET; });

  const traccarPayload = () => ({
    device: { uniqueId: '123456789012345' },
    position: {
      latitude: 50.1, longitude: 14.4, speed: 10, course: 90, accuracy: 5,
      fixTime: '2026-07-14T12:00:00Z', attributes: { batteryLevel: 87 }
    }
  });

  it('maps a Traccar position to the tracker (by IMEI) and persists it (knots→kph)', async () => {
    prismaMock.gpsTracker.findUnique.mockResolvedValue({ id: 'tracker-7', agencyId: 'agency-1', profileId: 'profile-1', active: true });
    prismaMock.safetySession.findFirst.mockResolvedValue(null);
    prismaMock.gpsTrackerLocation.create.mockImplementation(async ({ data }) => ({ id: 'loc-1', ...data }));
    prismaMock.gpsTracker.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/trackers/traccar-forward')
      .set('x-forward-secret', FORWARD_SECRET)
      .send(traccarPayload());

    expect(res.status).toBe(201);
    const saved = prismaMock.gpsTrackerLocation.create.mock.calls[0][0].data;
    expect(saved.lat).toBeCloseTo(50.1, 4);
    expect(saved.lng).toBeCloseTo(14.4, 4);
    expect(saved.speedKph).toBeCloseTo(18.52, 2); // 10 knots
    expect(saved.battery).toBe(87);
  });

  it('rejects a wrong forward secret (401)', async () => {
    const res = await request(app)
      .post('/api/trackers/traccar-forward')
      .set('x-forward-secret', 'nope')
      .send(traccarPayload());
    expect(res.status).toBe(401);
    expect(prismaMock.gpsTrackerLocation.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown / inactive tracker (404)', async () => {
    prismaMock.gpsTracker.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/trackers/traccar-forward')
      .set('x-forward-secret', FORWARD_SECRET)
      .send(traccarPayload());
    expect(res.status).toBe(404);
  });
});
