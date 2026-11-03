/**
 * Jediné místo, kde se rozhoduje, jestli agentura má nárok na Developer API.
 *
 * Dřív to bylo na dvou místech s různými seznamy: `apiKeyController` pouštěl
 * k vydání klíče i tarif Professional, `apiKeyMiddleware` ho k endpointům
 * nepustil. Výsledek byl klíč, který se úspěšně vydal (201) a hned nato
 * dostával 403 od všech endpointů — a uživatel neměl jak poznat proč.
 *
 * Nárok má tarif v `API_ACCESS_PLANS`, nebo dokoupený modul `api_access`.
 * Seznam se musí shodovat s `hasApiAccess` v
 * `client/src/components/Views/ApiSettingsView.jsx` a s výčtem funkcí
 * v `GET /api/subscriptions/plans`, kde „Developer API přístup" patří
 * výhradně tarifu Agency.
 */

const API_ACCESS_PLANS = new Set(['Agency', 'Enterprise']);

/** Hláška u 403. Drží se u seznamu, aby nešlo změnit jedno bez druhého. */
const API_ACCESS_DENIED_MESSAGE =
  'API access requires an Agency plan or the API access add-on';

/**
 * @param agency       záznam agentury (stačí `plan`/`tier` a `extraFeatures`)
 * @param onParseError volitelně dostane chybu, když `extraFeatures` není
 *                     platný JSON — ať se vadná data dají dohledat v logu
 */
const agencyHasApiAccess = (agency, onParseError) => {
  const currentPlan = agency?.plan || agency?.tier;
  if (API_ACCESS_PLANS.has(currentPlan)) return true;

  if (!agency?.extraFeatures) return false;

  try {
    const features = JSON.parse(agency.extraFeatures);
    return features.api_access === true || features.api_access === 'true';
  } catch (error) {
    if (onParseError) onParseError(error);
    return false;
  }
};

module.exports = { API_ACCESS_PLANS, API_ACCESS_DENIED_MESSAGE, agencyHasApiAccess };
