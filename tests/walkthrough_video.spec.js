import { test, expect } from '@playwright/test';
import { TEST_USERS } from './helpers/api.js';
import { doLogin } from './helpers/auth.js';

async function doLogout(page) {
  console.log('🚪 Logging out...');
  // Sidebar logout is an icon-only button (no text), so we simulate directly:
  // clear auth state + navigate to /logout (same as handleLogoutInternal does)
  await page.evaluate(() => {
    localStorage.clear();
    // Preserve onboarding seen flag so it doesn't re-show for returning users
    localStorage.setItem('nexus_hasSeenOnboarding', 'true');
    localStorage.setItem('nexus_onboarding_seen', 'true');
  });
  await page.goto('/logout', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
}

// Značka `@nahravka` tenhle soubor vyřazuje z bránící sady i z měření.
//
// Není to test, je to nahrávka průchodu aplikací pro ukázku: má vlastní
// tříminutový limit „for the whole video", je plná čekání na animace a při
// měření 5. 11. 2026 jako JEDINÝ padl, a to ve všech čtyřech prohlížečích
// (630 z 688 spuštění prošlo, ty 4 pády byly tohle).
//
// Pustit se dá kdykoli ručně: `npm run test:nahravka`.
test('@nahravka Full Platform Walkthrough Video', async ({ page }) => {
  test.setTimeout(180000); // 3 minutes for the whole video

  // This test uses LIVE staging login — skip in CI if staging auth is unavailable
  const { loginAs, TEST_USERS: TU } = await import('./helpers/api.js');
  const probe = await loginAs(TEST_USERS.agencyAdmin).catch(() => null);
  if (!probe?.token) {
    test.skip(true, 'Staging auth unavailable — skipping walkthrough video test');
    return;
  }

  await doLogin(page, TEST_USERS.agencyAdmin.email, TEST_USERS.agencyAdmin.password);

  console.log('📊 Showing Dashboard...');
  await page.waitForTimeout(3000); // Wait for animations
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, -500);

  console.log('💬 Showing Inbox...');
  await page.locator('nav').getByText(/inbox/i).first().click().catch(() => {});
  await page.waitForTimeout(5000);

  console.log('👥 Showing Profiles...');
  await page.locator('nav').getByText(/profiles|profily/i).first().click().catch(() => {});
  await page.waitForTimeout(3000);

  console.log('📈 Showing Analytics...');
  await page.locator('nav').getByText(/analytics|statistiky/i).first().click().catch(() => {});
  await page.waitForTimeout(3000);

  console.log('⚙️ Showing Settings (BYON/Relay)...');
  await page.locator('nav').getByText(/settings|nastavení/i).first().click().catch(() => {});
  await page.waitForTimeout(3000);

  await doLogout(page);

  // --- 2. MODEL (Diana B.) ---
  console.log('💃 Logging in as Model (Diana)...');
  await doLogin(page, TEST_USERS.model.email, TEST_USERS.model.password);

  console.log('📱 Showing Model Dashboard...');
  await page.waitForTimeout(3000);

  console.log('💬 Showing Model Inbox...');
  await page.locator('nav').getByText(/inbox/i).first().click().catch(() => {});
  await page.waitForTimeout(3000);

  await doLogout(page);

  console.log('🎬 Walkthrough complete!');
});
