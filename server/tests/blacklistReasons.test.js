/**
 * Blacklist přijímá jen kategorie z číselníku, ne volný text.
 *
 * Proč na to test: zápis na blacklistu je tvrzení o konkrétním, jménem
 * i telefonem identifikovaném člověku a sdílí se mezi agenturami. Volný popis
 * z něj dělá obvinění z protiprávního jednání (GDPR čl. 10), které nejde ani
 * doložit, ani opravit. Číselník to omezení drží — ale drží ho jen potud,
 * pokud ho někdo zase nerozvolní na `z.string()`.
 *
 * Nejdůležitější test v souboru je ten první: ručně psaný text musí skončit
 * chybou. Kdyby prošel, vrátil by se volný popis zadními vrátky.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/db');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({})));

const prismaMock = require('../src/services/db');
const app = require('../src/app');
const { REASONS, VOLITELNE, NEZATRIDENO } = require('../src/config/blacklistReasons');

const token = () => jwt.sign(
  {
    userId: 'user-1',
    agencyId: 'agency-1',
    role: { name: 'Agency Admin', isManager: true, isAppOwner: false },
  },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

const zalozit = (telo) => request(app)
  .post('/api/blacklist')
  .set('Authorization', `Bearer ${token()}`)
  .send({ phone: '+420739777718', ...telo });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({ name: 'Test User' });
  prismaMock.blacklistEntry.create.mockResolvedValue({ id: 'bl1', reports: [] });
});

describe('Volný text se nepřijme', () => {
  it('ručně psaný popis skončí chybou', async () => {
    const res = await zalozit({ reason: 'Choval se hnusně a nezaplatil mi' });

    expect(res.status).toBe(400);
    expect(prismaMock.blacklistEntry.create).not.toHaveBeenCalled();
  });

  it('staré pole description se do databáze nedostane', async () => {
    // Klient, který se neaktualizoval, pošle starý tvar. Nesmí projít —
    // a hlavně se nesmí nic uložit.
    const res = await zalozit({ description: 'Known scammer' });

    expect(res.status).toBe(400);
    expect(prismaMock.blacklistEntry.create).not.toHaveBeenCalled();
  });

  it('prázdný důvod skončí chybou', async () => {
    expect((await zalozit({ reason: '' })).status).toBe(400);
    expect((await zalozit({})).status).toBe(400);
  });
});

describe('Kategorie z číselníku', () => {
  it.each(VOLITELNE)('„%s" projde a uloží se jako kategorie', async (kod) => {
    const res = await zalozit({ reason: kod });

    expect(res.status).toBe(201);
    expect(prismaMock.blacklistEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: kod }) })
    );
  });

  it('„nezatříděno" nejde zvolit ručně — vzniká jen migrací', async () => {
    expect(VOLITELNE).not.toContain(NEZATRIDENO);
    expect((await zalozit({ reason: NEZATRIDENO })).status).toBe(400);
  });
});

describe('Číselník', () => {
  it('každá kategorie má český i anglický popisek', () => {
    for (const [kod, popisky] of Object.entries(REASONS)) {
      expect(typeof popisky.cz).toBe('string');
      expect(popisky.cz.length).toBeGreaterThan(0);
      expect(typeof popisky.en).toBe('string');
      expect(popisky.en.length).toBeGreaterThan(0);
      expect(kod).toMatch(/^[a-z_]+$/);
    }
  });

  it('klientská kopie má stejné kódy jako serverová', () => {
    // Klient kódy jen zobrazuje, server je validuje. Kdyby se rozešly, uživatel
    // by vybral kategorii, kterou server odmítne — nebo by dostal holý kód
    // místo popisku. Stejný důvod, proč se hlídají zámky funkcí.
    const fs = require('fs');
    const path = require('path');
    const klient = fs.readFileSync(
      path.join(__dirname, '../../client/src/config/blacklistReasons.js'),
      'utf8'
    );

    const kodyKlienta = [...klient.matchAll(/^ {2}([a-z_]+):\s*\{\s*cz:/gm)].map((m) => m[1]);
    // NEZATRIDENO je na klientu zapsané přes [NEZATRIDENO], ne literálem.
    expect(klient).toContain('[NEZATRIDENO]:');
    expect(klient).toContain(`export const NEZATRIDENO = '${NEZATRIDENO}'`);

    expect(kodyKlienta.sort()).toEqual(VOLITELNE.slice().sort());
  });
});
