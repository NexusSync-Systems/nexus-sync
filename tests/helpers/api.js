/**
 * Nexus Hub Test Helpers
 * Shared utilities for testing against the live production API.
 */

import axios from 'axios';

// Dřív tu pro CI byla zapsaná produkční adresa. CI si NEXUS_API_URL nastavuje
// samo (viz ci.yml, job Playwright E2E Tests) a vlastní server si na localhostu
// zvedne, takže ta hodnota jen tiše mířila na server, který zanikl.
const DEFAULT_API_BASE = 'http://localhost:3000/api';

export const API_BASE = process.env.NEXUS_API_URL || DEFAULT_API_BASE;
export const DEVICE_SECRET = process.env.NEXUS_DEVICE_SECRET || (process.env.CI ? '' : 'devicesecret12345');
export const HAS_DEVICE_SECRET = Boolean(DEVICE_SECRET);
export const TRANSIENT_API_STATUSES = [502, 503, 504];

export function isApiUnavailableStatus(status) {
  return TRANSIENT_API_STATUSES.includes(Number(status));
}

/**
 * Test user credentials (seeded in production DB).
 * NOTE: appOwner has a real password different from the seed default.
 * alice@nexus.sync is seeded as 'Senior Operator', not 'Manager'.
 */
export const TEST_USERS = {
  appOwner:    { email: process.env.TEST_OWNER_EMAIL || 'owner@nexus.sync',  password: process.env.TEST_OWNER_PASSWORD || 'Nexus2024!',   roleName: 'App Owner'       },
  agencyAdmin: { email: 'mark@nexus.sync',    password: 'password123',  roleName: 'Agency Admin'    },
  manager:     { email: 'jan@nexus.sync',     password: 'password123',  roleName: 'Manager'         },
  seniorOp:    { email: 'alice@nexus.sync',   password: 'password123',  roleName: 'Senior Operator' },
  operator:    { email: 'sarah@nexus.sync',   password: 'password123',  roleName: 'Operator'        },
  model:       { email: 'diana@nexus.sync',   password: 'password123',  roleName: 'Model'           },
};

let _dostupnost = null;

/**
 * Jednou zjistí, jestli živé API vůbec odpovídá.
 *
 * Lokálně míří API_BASE na http://localhost:3000/api, kde obvykle nic neběží.
 * Testy proti živému API tam padaly na odmítnuté spojení a dělaly v každém
 * běhu 28 falešně červených řádků. V takovém šumu nejde poznat skutečný
 * regres — a přesně kvůli tomu jsem ho dvakrát přehlédl.
 *
 * V CI se NIKDY nepřeskakuje. Tam běží krok „Check API is reachable“, který
 * job shodí dřív; kdyby se skákalo i tam, výpadek backendu by vypadal jako
 * úspěšný běh a bezpečnostní testy by tiše zmizely.
 */
export async function apiJeDostupne() {
  if (process.env.CI) return true;
  if (_dostupnost !== null) return _dostupnost;

  const base = API_BASE.replace(/\/+$/, '').replace(/\/api$/, '');
  try {
    const res = await axios.get(`${base}/api/health`, {
      timeout: 3000,
      validateStatus: () => true,
    });
    // 5xx znamená, že něco běží, ale je to rozbité — to je nález, ne prostředí.
    _dostupnost = res.status < 500;
  } catch {
    _dostupnost = false;
  }
  return _dostupnost;
}

/** Hláška do přeskočených testů, ať je z reportu poznat proč. */
export const DUVOD_BEZ_API =
  `Živé API na ${API_BASE} neodpovídá — testy proti němu se lokálně přeskakují. `
  + 'V CI se nepřeskakují nikdy (job má vlastní kontrolu dostupnosti).';

/**
 * Login a user and return { token, user }.
 * Returns null on failure instead of throwing — lets beforeAll skip gracefully.
 */
export async function loginAs(credentials) {
  try {
    const res = await axios.post(`${API_BASE}/auth/login`, {
      email: credentials.email,
      password: credentials.password,
    }, { validateStatus: () => true });

    if (res.status !== 200 || !res.data.token) {
      console.error(`[auth] Login FAILED for ${credentials.email}: HTTP ${res.status} – ${res.data?.message}`);
      return null;
    }
    return { token: res.data.token, user: res.data.user };
  } catch (err) {
    console.error(`[auth] Login ERROR for ${credentials.email}: ${err.message}`);
    return null;
  }
}

/**
 * Create an authorized axios instance for a given token.
 */
export function authClient(token) {
  return axios.create({
    baseURL: API_BASE,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
}

/**
 * Unauthenticated axios client (for testing 401 responses).
 */
export const anonClient = axios.create({
  baseURL: API_BASE,
  validateStatus: () => true,
});
