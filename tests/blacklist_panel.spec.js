import { test, expect } from '@playwright/test';
import { TEST_USERS } from './helpers/api.js';
import { setupApiMocks } from './helpers/mocks.js';
import { doLogin as loginToApp } from './helpers/auth.js';

/**
 * Blacklist na stránce Ochrana.
 *
 * Je to bezpečnostní seznam: operátorka podle něj pozná, že volající je
 * někdo, s kým se už jinde staly problémy. Když se seznam nezobrazí,
 * nikdo si toho nevšimne — prázdný blacklist vypadá úplně stejně jako
 * blacklist, který se nenačetl.
 *
 * Přesně tak to do teď v testech vypadalo. Panel čte `data.entries`, ale
 * zachytávač vracel holé `[]`, takže `data.entries` bylo `undefined`
 * a seznam zůstal prázdný v každém testu.
 */

const ZAZNAMY = {
  entries: [
    {
      id: 'bl-1',
      phone: '+420604111222',
      reason: 'aggressive',
      createdAt: '2026-07-30T10:00:00.000Z',
      reports: [],
    },
    {
      id: 'bl-2',
      phone: '+420777999888',
      reason: 'no_show',
      createdAt: '2026-08-01T12:00:00.000Z',
      reports: [],
    },
  ],
  total: 2, page: 1, totalPages: 1,
};

async function otevriOchranu(page, testInfo) {
  const jeMobil = testInfo.project.name === 'mobile';
  if (jeMobil) {
    const ham = page.getByTestId('sidebar-hamburger');
    if (await ham.isVisible().catch(() => false)) {
      await ham.click();
      await page.waitForTimeout(500);
    }
  }
  await page.getByTestId('nav-link-safety').click();
  await page.waitForTimeout(2000);
}

test.describe('Blacklist', () => {
  test('zobrazí zablokovaná čísla i důvod', async ({ page }, testInfo) => {
    await setupApiMocks(page);
    await page.route('**/blacklist', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ZAZNAMY) });
    });
    await loginToApp(page, TEST_USERS.manager.email, TEST_USERS.manager.password);
    await otevriOchranu(page, testInfo);

    await expect(page.getByText('+420604111222')).toBeVisible({ timeout: 15000 });

    // Popisek se hledá UVNITŘ řádku, ne na stránce: stejné texty jsou i
    // v rozbalovacím seznamu důvodů nad tabulkou.
    //
    // Server posílá KÓD kategorie, uživatel musí vidět popisek. Kdyby se
    // číselníky klienta a serveru rozešly, zobrazil by se holý 'aggressive'.
    const radek = (telefon) => page.getByText(telefon).locator('..');
    await expect(radek('+420604111222').getByText('Agresivní chování')).toBeVisible();

    await expect(page.getByText('+420777999888')).toBeVisible();
    await expect(radek('+420777999888').getByText('Opakovaně nedorazil')).toBeVisible();
  });

  test('prázdný seznam nic nevymyslí (kontrolní vzorek)', async ({ page }, testInfo) => {
    // Globální mock vrací prázdno. Bez tohohle případu by první test prošel,
    // i kdyby se čísla brala odjinud než z odpovědi serveru.
    await setupApiMocks(page);
    await loginToApp(page, TEST_USERS.manager.email, TEST_USERS.manager.password);
    await otevriOchranu(page, testInfo);

    await expect(page.getByText('+420604111222')).toHaveCount(0);
    await expect(page.getByText('+420777999888')).toHaveCount(0);
  });
});
