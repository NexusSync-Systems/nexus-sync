/**
 * Veřejné adresy, které server skládá do odpovědí a e-mailů.
 *
 * Do 3. 11. 2026 mělo pět míst ve `vultrRoutes` a jedno v `emailService`
 * zapsanou výchozí hodnotu `https://nexus-api.myvnc.com` — server, který toho
 * dne přestal existovat. Odkazy ke stažení APK, OTA i odkazy v e-mailech tedy
 * tiše mířily nikam. Nic na to neupozornilo, protože odpovědi vypadaly platně.
 *
 * `APP_URL` navíc ve výchozím stavu ukazovala na API, ne na web. Odkaz na reset
 * hesla tak nevedl na formulář ani v době, kdy ten host žil — API žádnou
 * stránku neservíruje (v `app.js` je staticky jen `/downloads`).
 */

jest.mock('../src/services/logger');

const nacti = () => {
  jest.resetModules();
  return require('../src/utils/publicUrls');
};

const PUVODNI = { ...process.env };
afterEach(() => { process.env = { ...PUVODNI }; });

describe('apiBaseUrl', () => {
  it('vrátí nastavenou adresu bez koncového lomítka', () => {
    process.env.API_BASE_URL = 'https://api.example.eu/';
    expect(nacti().apiBaseUrl()).toBe('https://api.example.eu');
  });

  it('bez nastavení vrátí prázdno, ne zapsanou adresu', () => {
    delete process.env.API_BASE_URL;
    expect(nacti().apiBaseUrl()).toBe('');
  });

  it('nikdy nevrátí zaniklý host', () => {
    delete process.env.API_BASE_URL;
    expect(nacti().apiBaseUrl()).not.toContain('myvnc.com');
  });

  it('o chybějící hodnotě varuje, ale jen jednou', () => {
    delete process.env.API_BASE_URL;
    const { apiBaseUrl } = nacti();
    const logger = require('../src/services/logger');
    apiBaseUrl(); apiBaseUrl(); apiBaseUrl();
    const varovani = logger.warn.mock.calls.filter(c => String(c[0]).includes('API_BASE_URL'));
    expect(varovani).toHaveLength(1);
  });
});

describe('webAppUrl', () => {
  it('dá přednost APP_URL', () => {
    process.env.APP_URL = 'https://web.example.eu/';
    process.env.ALLOWED_ORIGINS = 'https://jiny.example.eu';
    expect(nacti().webAppUrl()).toBe('https://web.example.eu');
  });

  it('bez APP_URL vezme první https origin z ALLOWED_ORIGINS', () => {
    delete process.env.APP_URL;
    process.env.ALLOWED_ORIGINS = 'http://nezabezpeceny.test,https://web.example.eu,https://druhy.example.eu';
    expect(nacti().webAppUrl()).toBe('https://web.example.eu');
  });

  it('bez obojího vrátí prázdno, ne adresu API', () => {
    delete process.env.APP_URL;
    delete process.env.ALLOWED_ORIGINS;
    const url = nacti().webAppUrl();
    expect(url).toBe('');
    expect(url).not.toContain('myvnc.com');
  });
});

describe('zdrojový kód', () => {
  it('nikde v utils/publicUrls nestojí zaniklý host jako hodnota', () => {
    const kod = require('fs').readFileSync(require('path').join(__dirname, '../src/utils/publicUrls.js'), 'utf8');
    // V komentáři smí být jako vysvětlení; jako hodnota v kódu ne.
    const radky = kod.split('\n').filter(r => !r.trim().startsWith('*') && !r.trim().startsWith('//'));
    expect(radky.join('\n')).not.toContain('myvnc.com');
  });

  it('vultrRoutes ani emailService už zaniklý host neobsahují', () => {
    const fs = require('fs'), path = require('path');
    for (const rel of ['../src/routes/vultrRoutes.js', '../src/services/emailService.js']) {
      const kod = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const radky = kod.split('\n').filter(r => !r.trim().startsWith('*') && !r.trim().startsWith('//'));
      expect(radky.join('\n')).not.toContain('myvnc.com');
    }
  });
});
