import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Adresa API — jediný zdroj.
 *
 * Do 3. 11. 2026 měl stejný výraz `import.meta.env.VITE_API_URL || '<adresa>'`
 * zkopírovaný dvacet souborů, každý s vlastní zapsanou záložní hodnotou
 * `https://nexus-api.myvnc.com/api`. Když ten server zanikl, opravil se v #146
 * jediný z nich (`NexusContext.jsx`) a devatenáct dalších mířilo dál na mrtvý
 * host. Projevilo se to až v prohlížeči uživatele; build i nasazení prošly.
 *
 * Testuje se proto obojí: že se adresa bere z prostředí, A ŽE pro produkci
 * žádná zapsaná záloha neexistuje. Kdyby se tu zkoušelo jen první, prošla by
 * i verze, která zapsanou adresu zpátky přidá.
 *
 * Hodnoty se počítají při načtení modulu, takže každý případ potřebuje
 * `vi.resetModules()` a nový import.
 */

async function nacti() {
  vi.resetModules();
  return import('./config.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('API_BASE', () => {
  it('vezme hodnotu z VITE_API_URL a zahodí koncové lomítko', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.eu/api/');
    const { API_BASE } = await nacti();
    expect(API_BASE).toBe('https://api.example.eu/api');
  });

  it('v produkčním buildu bez proměnné nevrátí žádnou adresu', async () => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('DEV', false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { API_BASE } = await nacti();
    expect(API_BASE).toBe('');
  });

  it('v produkčním buildu bez proměnné nahlas ohlásí chybu', async () => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('DEV', false);
    const chyba = vi.spyOn(console, 'error').mockImplementation(() => {});
    await nacti();
    expect(chyba).toHaveBeenCalledTimes(1);
    expect(String(chyba.mock.calls[0][0])).toContain('VITE_API_URL');
  });

  it('ve vývoji bez proměnné použije místní backend', async () => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('DEV', true);
    const { API_BASE } = await nacti();
    expect(API_BASE).toContain('localhost');
    expect(API_BASE).toMatch(/\/api$/);
  });

  it('nikdy nevrátí zaniklý host', async () => {
    for (const dev of [true, false]) {
      vi.stubEnv('VITE_API_URL', '');
      vi.stubEnv('DEV', dev);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { API_BASE } = await nacti();
      expect(API_BASE).not.toContain('myvnc.com');
    }
  });
});

describe('SERVER_ORIGIN', () => {
  it('je API_BASE bez koncového /api — pro Socket.IO a soubory', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.eu/api');
    const { SERVER_ORIGIN } = await nacti();
    expect(SERVER_ORIGIN).toBe('https://api.example.eu');
  });
});

describe('API_HOST', () => {
  it('vrátí jen jméno hostitele, pro zobrazení uživateli', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.eu/api');
    const { API_HOST } = await nacti();
    expect(API_HOST).toBe('api.example.eu');
  });

  it('bez adresy vrátí prázdno, ne rozbitý text', async () => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('DEV', false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { API_HOST } = await nacti();
    expect(API_HOST).toBe('');
  });
});
