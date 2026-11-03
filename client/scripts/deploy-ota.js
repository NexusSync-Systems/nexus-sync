/* global process */
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import FormData from 'form-data';
import axios from 'axios';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '../dist');
// Adresa se nezapisuje. Zapsaná hodnota tu mířila na server, který 3. 11. 2026
// zanikl, a komentář „Update to your real API URL" to nikomu nepřipomněl.
//
// Dvě role, které se nesmí splést:
//   API_ORIGIN    kam se balík NAHRAVA (bez /api, dopisuje se níž)
//   VITE_API_URL  co se ZAPEKE do balíku pro telefony (s /api)
//
// Druhá role se tu nejdřív zapomněla: skript pouští `npm run build` a Vite vidí
// jen proměnné začínající VITE_, takže z `API_BASE_URL=... node deploy-ota.js`
// se do balíku nedostalo nic. OTA aktualizace by telefonům dosadila prázdnou
// adresu API a odřízla je od serveru — včetně kontroly dalších aktualizací.
const API_ZADANE = (process.env.API_BASE_URL || process.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
if (!API_ZADANE) {
  console.error('Chybí API_BASE_URL (nebo VITE_API_URL). Např.:');
  console.error('  API_BASE_URL=https://api.example.eu node client/scripts/deploy-ota.js');
  process.exit(1);
}
if (API_ZADANE.includes('myvnc.com')) {
  console.error(`Adresa ${API_ZADANE} míří na zaniklý server. Zadej novou.`);
  process.exit(1);
}
const API_ORIGIN = API_ZADANE.replace(/\/api$/, '');
const VITE_API_URL = `${API_ORIGIN}/api`;
const API_URL = `${API_ORIGIN}/api/vultr/upload-ota`;

// Varianta se PŘEDÁVÁ, nehádá. Skript dřív pouštěl holé `npm run build`, takže
// vznikl balík plné aplikace — jenže se jmenoval nexus-relay.zip a mířil na
// relay zařízení. Kdyby si ho relay stáhl, dosadilo by se mu __APP_VARIANT__
// = 'full' a choval by se jako plná aplikace: žádné okno příchozí SMS
// a odpovědi přes API serveru místo přes SIM. Přesně ta chyba, která už
// jednou v NexusSms.js byla.
const VARIANTA = process.argv[2] === 'full' ? 'full' : 'relay';
const ZIP_PATH = path.join(__dirname, `../nexus-${VARIANTA}.zip`);

async function deploy() {
  try {
    console.log('🚀 Starting OTA Deployment...');

    // 1. Build the project
    console.log(`📦 Building project (varianta: ${VARIANTA})...`);
    // cwd se předává natvrdo. Kořenový package.json skript `build` NEMÁ
    // (jmenuje se tam build:client), takže spuštění odjinud než z client/
    // by skončilo na „Missing script: build".
    execSync('npm run build', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, VITE_APP_VARIANT: VARIANTA, VITE_API_URL },
    });

    // Relay má vlastní vstupní HTML (jiný titulek, jazyk a relativní cesty
    // k ikonám). Bez téhle záměny by balík obsahoval index.html plné
    // aplikace — stejný krok dělá i build-android v CI.
    if (VARIANTA === 'relay') {
      const relayHtml = path.join(DIST_DIR, 'index.relay.html');
      if (!fs.existsSync(relayHtml)) {
        throw new Error('dist/index.relay.html chybí — relay balík by měl vstupní HTML plné aplikace');
      }
      fs.copyFileSync(relayHtml, path.join(DIST_DIR, 'index.html'));
      console.log('🔁 index.relay.html → index.html');
    }

    // Pojistka: ověř, že se do balíku opravdu dostala správná varianta.
    // Vite dosazuje __APP_VARIANT__ jako holý identifikátor, takže se v
    // přeloženém kódu objeví jako řetězec "relay" / "full".
    const jsSoubory = fs.readdirSync(path.join(DIST_DIR, 'assets')).filter(f => f.endsWith('.js'));
    const obsah = jsSoubory.map(f => fs.readFileSync(path.join(DIST_DIR, 'assets', f), 'utf8')).join('');
    if (!obsah.includes(`"${VARIANTA}"`) && !obsah.includes(`'${VARIANTA}'`)) {
      throw new Error(`V balíku není varianta ${VARIANTA} — build dostal špatné VITE_APP_VARIANT`);
    }

    // Tatáž pojistka pro adresu API. Balík bez ní by se nahrál, telefony by si
    // ho stáhly a odřízly se od serveru — a poznalo by se to až na nich.
    if (!obsah.includes(VITE_API_URL)) {
      throw new Error(`V balíku není adresa ${VITE_API_URL} — build nedostal VITE_API_URL`);
    }

    // 2. Zip the dist folder
    console.log('🤐 Zipping dist folder...');
    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver('zip', { zlib: { level: 9 } });

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(DIST_DIR, false);
      archive.finalize();
    });

    console.log(`✅ Zip created: ${(fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2)} MB`);

    // 3. Upload to server
    console.log('☁️  Uploading to server...');
    const form = new FormData();
    form.append('ota', fs.createReadStream(ZIP_PATH));
    // Server podle toho ukládá balík i metadata zvlášť pro každou variantu.
    form.append('variant', VARIANTA);
    
    // We can also send version info if needed
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    form.append('version', pkg.version);

    const response = await axios.post(API_URL, form, {
      headers: {
        ...form.getHeaders(),
        // Add auth token if your API requires it
        'Authorization': `Bearer ${process.env.NEXUS_TOKEN || ''}`
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    if (response.data.ok) {
      console.log('🎉 OTA Deployment successful!');
      console.log(`📍 Version: ${response.data.version}`);
    } else {
      throw new Error(response.data.message || 'Upload failed');
    }

    // Cleanup
    fs.unlinkSync(ZIP_PATH);

  } catch (error) {
    console.error('❌ Deployment failed:');
    console.error(error.message);
    if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);
    process.exit(1);
  }
}

deploy();
