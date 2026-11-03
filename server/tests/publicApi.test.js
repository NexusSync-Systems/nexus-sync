/**
 * Veřejné API na klíč: GET /api/v1/public/*
 *
 * Dvě věci, které tu drží pohromadě jen testem:
 *
 * 1. `metrics.totalBookings` se počítalo z `safetySession`. Plánovaná relace
 *    vzniká JEN u výjezdů (`ensurePlannedSafetySession` se u incall schválně
 *    nespustí), takže agentura s převahou incall viděla skoro nulu. Tentýž omyl
 *    byl opraven v `agencyController.getStats` (viz tests/agencyStats.test.js),
 *    ale veřejné API si staré počítání neslo dál pod stejným popiskem.
 *
 * 2. Přístup k API patří tarifu Agency, nebo dokoupenému modulu. Dřív middleware
 *    pouštěl i Professional — tedy klíč, který si UI vůbec nedovolilo vygenerovat
 *    (`hasApiAccess` v ApiSettingsView.jsx) a `GET /api/subscriptions/plans`
 *    neprodává. Server byl v tom trojlístku jediný, kdo říkal něco jiného.
 */

const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/services/db');
jest.mock('../src/services/socket');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');

const prismaMock = require('../src/services/db');
const app = require('../src/app');

const TAJEMSTVI = 'tajna-cast-klice';
const KLIC = `nx_live_key-1.${TAJEMSTVI}`;
let hash;

beforeAll(async () => { hash = await bcrypt.hash(TAJEMSTVI, 4); });

function klicVDatabazi({ plan = 'Agency', scopes = 'read:stats,read:profiles,read:messages', expiresAt = null, extraFeatures = null } = {}) {
  prismaMock.apiKey.findUnique.mockResolvedValue({
    id: 'ak-1', keyId: 'key-1', keyHash: hash, scopes, expiresAt,
    agencyId: 'agency-1',
    agency: { id: 'agency-1', plan, tier: plan, extraFeatures },
  });
  prismaMock.apiKey.update.mockResolvedValue({});
}

const zavolej = (cesta = '/api/v1/public/stats', klic = KLIC) => {
  const r = request(app).get(cesta);
  return klic === null ? r : r.set('X-API-KEY', klic);
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.message.count.mockResolvedValue(120);
  prismaMock.booking.count.mockResolvedValue(37);
  prismaMock.safetySession.count.mockResolvedValue(4);
  prismaMock.profile.count.mockResolvedValue(8);
  prismaMock.profile.findMany.mockResolvedValue([]);
  prismaMock.message.findMany.mockResolvedValue([]);
});

describe('veřejné API — počty', () => {
  it('rezervace počítá z rezervací, ne z bezpečnostních relací', async () => {
    klicVDatabazi();
    const res = await zavolej();
    expect(res.status).toBe(200);
    expect(res.body.metrics.totalBookings).toBe(37);
    expect(res.body.metrics.totalBookings).not.toBe(4);
    expect(prismaMock.booking.count).toHaveBeenCalled();
    expect(prismaMock.safetySession.count).not.toHaveBeenCalled();
  });

  it('omezí počty na agenturu, které klíč patří', async () => {
    klicVDatabazi();
    await zavolej();
    expect(prismaMock.booking.count.mock.calls[0][0].where).toEqual({ agencyId: 'agency-1' });
    expect(prismaMock.profile.count.mock.calls[0][0].where).toEqual({ agencyId: 'agency-1' });
  });

  it('revenue zůstává neimplementované — kdyby se rozjelo, ať to test oznámí', async () => {
    klicVDatabazi();
    const res = await zavolej();
    expect(res.body.metrics.revenue).toBe('0.00');
  });
});

describe('veřejné API — tarify', () => {
  it('tarif Agency pustí', async () => {
    klicVDatabazi({ plan: 'Agency' });
    expect((await zavolej()).status).toBe(200);
  });

  it('tarif Professional nepustí, protože API neprodává', async () => {
    klicVDatabazi({ plan: 'Professional' });
    const res = await zavolej();
    expect(res.status).toBe(403);
    expect(prismaMock.booking.count).not.toHaveBeenCalled();
  });

  it('dokoupený modul pustí i mimo tarif Agency', async () => {
    klicVDatabazi({ plan: 'Starter', extraFeatures: JSON.stringify({ api_access: true }) });
    expect((await zavolej()).status).toBe(200);
  });
});

describe('veřejné API — klíč a oprávnění', () => {
  it('bez hlavičky vrátí 401', async () => {
    const res = await zavolej('/api/v1/public/stats', null);
    expect(res.status).toBe(401);
    expect(prismaMock.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('špatná tajná část vrátí 401', async () => {
    klicVDatabazi();
    const res = await zavolej('/api/v1/public/stats', 'nx_live_key-1.spatne');
    expect(res.status).toBe(401);
  });

  it('vypršelý klíč vrátí 403', async () => {
    klicVDatabazi({ expiresAt: new Date(Date.now() - 86400000) });
    expect((await zavolej()).status).toBe(403);
  });

  it('chybějící scope vrátí 403 a data nečte', async () => {
    klicVDatabazi({ scopes: 'read:profiles' });
    const res = await zavolej('/api/v1/public/stats');
    expect(res.status).toBe(403);
    expect(prismaMock.booking.count).not.toHaveBeenCalled();
  });

  it('scope platí zvlášť pro každý endpoint (kontrolní vzorek)', async () => {
    klicVDatabazi({ scopes: 'read:profiles' });
    expect((await zavolej('/api/v1/public/profiles')).status).toBe(200);
    expect((await zavolej('/api/v1/public/messages')).status).toBe(403);
  });
});

describe('neznámá cesta pod /api', () => {
  it('vrátí JSON, ne HTML stránku Expressu', async () => {
    const res = await request(app).get('/api/takova-cesta-neexistuje');
    expect(res.status).toBe(404);
    expect(res.type).toBe('application/json');
    expect(res.body.message).toMatch(/neexistuje/);
  });
});
