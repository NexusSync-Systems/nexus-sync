#!/usr/bin/env node
const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const REPO        = 'Zdenekdi/nexus-sync';
const ENV_PATH    = path.join(__dirname, '../server/.env');
// Adresa API se NEZAPISUJE. Tenhle skript secret API_BASE_URL skutečně
// nastavuje, takže zapsaná hodnota se jeho spuštěním rozšíří do CI — a přesně
// tak se tam 19. 6. 2026 dostal `nexus-api.myvnc.com`, server, který
// 3. 11. 2026 přestal existovat. Od té doby na něm padaly build APK i web.
//
// Hodnota se proto bere z prostředí nebo z argumentu a kontroluje se stejnými
// pravidly jako v ci.yml: ne myvnc.com, ne s /api na konci.
const API_BASE_URL = (process.env.API_BASE_URL || process.argv[3] || '').trim().replace(/\/+$/, '');
if (!API_BASE_URL) {
  console.error('Chybí API_BASE_URL. Použij:');
  console.error('  API_BASE_URL=https://api.example.eu node scripts/setup-github-secrets.js <GH_TOKEN>');
  console.error('  node scripts/setup-github-secrets.js <GH_TOKEN> https://api.example.eu');
  process.exit(1);
}
if (API_BASE_URL.includes('myvnc.com')) {
  console.error(`API_BASE_URL míří na ${API_BASE_URL} — to je zaniklý server. Zadej novou adresu.`);
  process.exit(1);
}
if (/\/api$/.test(API_BASE_URL)) {
  console.error('API_BASE_URL nesmí končit na /api — jednotlivé úlohy si ho dopisují samy.');
  process.exit(1);
}

// 1. JWT_SECRET z .env
const content   = fs.readFileSync(ENV_PATH, 'utf8');
const jwtSecret = content.match(/^JWT_SECRET=(.+)$/m)?.[1]?.trim();
if (!jwtSecret) { console.error('JWT_SECRET nenalezen v .env'); process.exit(1); }

// 2. Vygeneruj token
const jwt   = require(path.join(__dirname, '../server/node_modules/jsonwebtoken'));
const token = jwt.sign(
  { userId:'ci-github-actions', role:{ isAppOwner:true, isManager:true }, type:'relay' },
  jwtSecret,
  { expiresIn:'365d' }
);

// 3. GitHub PAT z argumentu nebo GH_TOKEN env
const ghToken = process.argv[2] || process.env.GH_TOKEN;
if (!ghToken) { console.error('Chybí GitHub PAT: node setup-github-secrets.js <TOKEN>'); process.exit(1); }

console.log('🔑 Token vygenerován, nastavuji GitHub secrets...\n');
const env = { ...process.env, GH_TOKEN: ghToken };

try {
  execSync(`gh secret set DEPLOY_API_TOKEN --body "${token}" --repo ${REPO}`, { env, stdio:'inherit' });
  execSync(`gh secret set API_BASE_URL --body "${API_BASE_URL}" --repo ${REPO}`, { env, stdio:'inherit' });
  console.log('\n✅ Hotovo! DEPLOY_API_TOKEN + API_BASE_URL nastaveny v GitHub Actions.');
} catch {
  console.log('\nGitHub CLI (gh) není — token pro ruční zadání:\n');
  console.log('DEPLOY_API_TOKEN:\n' + token);
  console.log('\nAPI_BASE_URL:\n' + API_BASE_URL);
}
