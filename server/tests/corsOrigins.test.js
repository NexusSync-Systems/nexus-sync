/**
 * Jediný seznam povolených originů.
 *
 * 3. 11. 2026 byly seznamy dva a rozcházely se ve třech věcech. `socket.js`
 * neměl obě domény `nexus-sync-8d50b.*` — tedy tu, na které aplikace běží —
 * takže HTTP prošlo a Socket.IO vrátilo 403. Operátorka by nedostávala
 * příchozí SMS v reálném čase; schránka by vypadala prázdná, ne rozbitá.
 *
 * Testuje se proto obojí: že seznam obsahuje, co má, A že žádný druhý seznam
 * v kódu nezbyl. Kdyby se hlídal jen obsah, prošla by i verze, která si
 * v `socket.js` zase založí vlastní pole.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.mock('../src/services/db');
jest.mock('../src/services/socket');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');

const PUVODNI = { ...process.env };
afterEach(() => { process.env = { ...PUVODNI }; jest.resetModules(); });

const nacti = () => {
  jest.resetModules();
  return require('../src/utils/corsOrigins');
};

describe('obsah seznamu', () => {
  it('obsahuje obě domény projektu, na kterém aplikace běží', () => {
    const { originPovolen } = nacti();
    expect(originPovolen('https://nexus-sync-8d50b.web.app')).toBe(true);
    expect(originPovolen('https://nexus-sync-8d50b.firebaseapp.com')).toBe(true);
  });

  it('obsahuje všechny tři originy Capacitoru', () => {
    const { originPovolen } = nacti();
    for (const o of ['https://localhost', 'http://localhost', 'capacitor://localhost']) {
      expect(originPovolen(o)).toBe(true);
    }
  });

  it('bere originy z ALLOWED_ORIGINS', () => {
    process.env.ALLOWED_ORIGINS = 'https://hub.example.eu, https://druhy.example.eu';
    const { originPovolen } = nacti();
    expect(originPovolen('https://hub.example.eu')).toBe(true);
    expect(originPovolen('https://druhy.example.eu')).toBe(true);
  });

  it('cizí doménu nepustí', () => {
    const { originPovolen } = nacti();
    expect(originPovolen('https://cizi.example.com')).toBe(false);
  });

  it('požadavek bez originu pustí (mobil, curl)', () => {
    const { originPovolen } = nacti();
    expect(originPovolen(undefined)).toBe(true);
    expect(originPovolen('')).toBe(true);
  });
});

describe('vývojové originy', () => {
  it('ve vývoji projdou', () => {
    process.env.NODE_ENV = 'development';
    const { originPovolen } = nacti();
    expect(originPovolen('http://localhost:5173')).toBe(true);
    expect(originPovolen('http://localhost:3000')).toBe(true);
  });

  it('v produkci NE — tohle byl třetí rozdíl mezi seznamy', () => {
    // `socket.js` je pouštěl i v produkci, `app.js` ne. Dva seznamy se nelišily
    // jen tím, co chybí, ale i tím, co jeden povoluje navíc.
    process.env.NODE_ENV = 'production';
    const { originPovolen } = nacti();
    expect(originPovolen('http://localhost:5173')).toBe(false);
    expect(originPovolen('http://localhost:3000')).toBe(false);
  });
});

describe('varování při chybějící adrese webu', () => {
  it('v produkci bez https originu varuje, ale jen jednou', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOWED_ORIGINS;
    const { varujKdyzChybiWebOrigin } = nacti();
    const logger = require('../src/services/logger');
    varujKdyzChybiWebOrigin(); varujKdyzChybiWebOrigin();
    const v = logger.warn.mock.calls.filter(c => String(c[0]).includes('ALLOWED_ORIGINS'));
    expect(v).toHaveLength(1);
  });

  it('s nastaveným https originem mlčí', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://hub.example.eu';
    const { varujKdyzChybiWebOrigin } = nacti();
    const logger = require('../src/services/logger');
    varujKdyzChybiWebOrigin();
    expect(logger.warn.mock.calls.filter(c => String(c[0]).includes('ALLOWED_ORIGINS'))).toHaveLength(0);
  });
});

describe('opravdu jediný zdroj', () => {
  const precti = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  it.each([
    ['../src/app.js', 'Express'],
    ['../src/services/socket.js', 'Socket.IO'],
  ])('%s (%s) nemá vlastní seznam originů', (rel) => {
    const kod = precti(rel);
    // Jmenovitě ty domény, kvůli kterým se seznamy rozešly. V komentáři smí
    // být jako vysvětlení, v kódu ne.
    const radky = kod.split('\n').filter(r => !r.trim().startsWith('//') && !r.trim().startsWith('*'));
    const telo = radky.join('\n');
    expect(telo).not.toContain('firebaseapp.com');
    expect(telo).not.toContain('web.app');
    expect(telo).not.toContain('capacitor://localhost');
  });

  it('oba soubory rozhodují touž funkcí', () => {
    for (const rel of ['../src/app.js', '../src/services/socket.js']) {
      expect(precti(rel)).toContain('originPovolen');
    }
  });
});

describe('HTTP CORS proti běžící aplikaci', () => {
  it('pustí doménu, na které aplikace běží (regrese 3. 11. 2026)', async () => {
    const app = require('../src/app');
    const res = await request(app)
      .get('/api/auth/me')
      .set('Origin', 'https://nexus-sync-8d50b.web.app');
    expect(res.headers['access-control-allow-origin']).toBe('https://nexus-sync-8d50b.web.app');
  });

  it('cizí doménu odmítne', async () => {
    const app = require('../src/app');
    const res = await request(app)
      .get('/api/auth/me')
      .set('Origin', 'https://cizi.example.com');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
