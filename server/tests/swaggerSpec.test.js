/**
 * Konzistence popisu API ve swaggeru (`server/src/app.js`).
 *
 * Dvě vady, které se tu už staly a projevily by se až u konzumenta:
 *
 * 1. `'/developer/keys/{id}'` neměla deklarovaný parametr `id`. To je neplatný
 *    OpenAPI — Swagger UI ani generovaný klient nemají kam to id zadat.
 * 2. `POST /developer/keys` neměla `requestBody`, takže se přes dokumentovanou
 *    operaci nedalo poslat `name` ani `scopes`. `createKey` vynechané scopes
 *    doplní na `read:stats`, takže takto vytvořený klíč dostane od
 *    dokumentovaných endpointů `/profiles` a `/messages` rovnou 403.
 *
 * Test proto nekontroluje jen ty dva případy, ale celé pravidlo: každý
 * zástupný úsek v cestě musí mít parametr, a každá operace, která něco přijímá
 * v těle, ho musí popsat.
 */

const request = require('supertest');

jest.mock('../src/services/db');
jest.mock('../src/services/socket');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');

const app = require('../src/app');

let spec;

beforeAll(async () => {
  // swagger-ui-express vkládá hotový dokument do swagger-ui-init.js.
  const res = await request(app).get('/api/docs/swagger-ui-init.js');
  expect(res.status).toBe(200);
  const m = res.text.match(/"swaggerDoc":\s*(\{[\s\S]*?\}),\n\s*"customOptions"/);
  if (!m) throw new Error('swaggerDoc se v swagger-ui-init.js nenašel');
  spec = JSON.parse(m[1]);
});

const operace = () => {
  const out = [];
  for (const [cesta, telo] of Object.entries(spec.paths)) {
    for (const [metoda, op] of Object.entries(telo)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(metoda)) out.push({ cesta, metoda, op });
    }
  }
  return out;
};

describe('popis API ve swaggeru', () => {
  it('spec se vůbec postaví a má cesty', () => {
    expect(Object.keys(spec.paths).length).toBeGreaterThan(20);
  });

  it('každý zástupný úsek v cestě má deklarovaný parametr', () => {
    const chybi = [];
    for (const { cesta, metoda, op } of operace()) {
      const zastupne = [...cesta.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
      if (!zastupne.length) continue;
      const deklarovane = (op.parameters || [])
        .filter(p => p.in === 'path')
        .map(p => p.name);
      for (const z of zastupne) {
        if (!deklarovane.includes(z)) chybi.push(`${metoda.toUpperCase()} ${cesta} — chybí parametr {${z}}`);
      }
    }
    expect(chybi).toEqual([]);
  });

  it('parametry v cestě jsou povinné, jak OpenAPI vyžaduje', () => {
    const spatne = [];
    for (const { cesta, metoda, op } of operace()) {
      for (const p of (op.parameters || []).filter(p => p.in === 'path')) {
        if (p.required !== true) spatne.push(`${metoda.toUpperCase()} ${cesta} — {${p.name}} není required`);
      }
    }
    expect(spatne).toEqual([]);
  });

  it('vytvoření klíče popisuje tělo požadavku včetně podporovaných scopes', () => {
    const op = spec.paths['/developer/keys']?.post;
    expect(op).toBeDefined();
    const schema = op.requestBody?.content?.['application/json']?.schema;
    expect(schema).toBeDefined();
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['name', 'scopes']));
    expect(schema.properties.scopes.items.enum).toEqual(
      expect.arrayContaining(['read:stats', 'read:profiles', 'read:messages', 'relay:bridge'])
    );
  });

  it('scopes v dokumentaci se shodují s tím, co server přijímá', () => {
    // Zdroj pravdy je ALLOWED_API_KEY_SCOPES v apiKeyController.
    const kod = require('fs').readFileSync(require('path').join(__dirname, '../src/controllers/apiKeyController.js'), 'utf8');
    const m = kod.match(/ALLOWED_API_KEY_SCOPES = new Set\(\[([^\]]+)\]\)/);
    expect(m).not.toBeNull();
    const vKodu = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    const vDokumentaci = [...spec.paths['/developer/keys'].post.requestBody.content['application/json'].schema.properties.scopes.items.enum].sort();
    expect(vDokumentaci).toEqual(vKodu);
  });

  it('veřejné endpointy jsou popsané jako chráněné klíčem, ne tokenem', () => {
    for (const cesta of ['/v1/public/stats', '/v1/public/profiles', '/v1/public/messages']) {
      const op = spec.paths[cesta]?.get;
      expect(op).toBeDefined();
      expect(JSON.stringify(op.security)).toContain('apiKeyAuth');
    }
    expect(spec.components.securitySchemes.apiKeyAuth.name).toBe('X-API-KEY');
  });
});
