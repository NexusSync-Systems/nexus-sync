const express = require("express");
const router = express.Router();
const axios = require("axios");
const crypto = require("crypto");
const { NodeSSH } = require("node-ssh");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const logger = require("../services/logger");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAppOwner } = require("../utils/authz");
const { z } = require("zod");
const { validate } = require("../middleware/validate");
const ApkReader = require("adbkit-apkreader");

const sshCommand = z.object({
  command: z.string().min(1).max(2000)
});

const gitPull = z.object({
  path: z.string().max(256).optional().default("~/app")
});

const VULTR_API = "https://api.vultr.com/v2";
const headers = () => ({
  "Authorization": `Bearer ${process.env.VULTR_API_KEY}`,
  "Content-Type": "application/json",
});
const AGENT_DOWNLOADS = [
  { id: "windows", label: "Windows (.zip)", filename: "nexus-agent-windows.zip" },
  { id: "macos", label: "macOS (.zip)", filename: "nexus-agent-macos.zip" },
  { id: "linux", label: "Linux (.zip)", filename: "nexus-agent-linux.zip" }
];

// ── APK Upload (multer) ───────────────────────────────────────────────────────
const { apiBaseUrl } = require("../utils/publicUrls");

const DOWNLOADS_DIR = path.join(__dirname, "../../public/downloads");
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

async function readApkManifestMetadata(apkPath, stat) {
  if (!stat || stat.size >= 100 * 1024 * 1024) return null;

  try {
    const reader = await ApkReader.open(apkPath);
    const manifest = await reader.readManifest();
    return {
      version: manifest.versionName || null,
      versionCode: manifest.versionCode || 0,
      packageName: manifest.package || ""
    };
  } catch (err) {
    logger.warn("[APK] Failed to parse APK metadata:", err.message);
    return null;
  }
}

const apkStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOWNLOADS_DIR),
  filename: (req, file, cb) => {
    const type = req.body.type;
    let isFull = false;
    if (type === 'full') {
      isFull = true;
    } else if (type === 'relay') {
      isFull = false;
    } else {
      // Fallback
      isFull = file.originalname && file.originalname.includes('full');
    }
    cb(null, isFull ? "nexus-full-latest.apk" : "nexus-relay-latest.apk");
  }
});
const apkUpload = multer({ 
  storage: apkStorage,
  limits: { fileSize: 150 * 1024 * 1024 } // 150 MB max
});

function resolveAgentDownload(platform) {
  return AGENT_DOWNLOADS.find(item => item.id === String(platform || '').toLowerCase());
}

async function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

const agentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOWNLOADS_DIR),
    filename: (req, file, cb) => {
      const target = resolveAgentDownload(req.body.platform);
      cb(null, target ? target.filename : "nexus-agent-upload.zip");
    }
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isZip = file.mimetype === "application/zip" ||
      file.mimetype === "application/x-zip-compressed" ||
      /\.zip$/i.test(file.originalname || "");
    if (!isZip) return cb(new Error("Only .zip agent packages are allowed"));
    cb(null, true);
  }
});

// Helper for SSH connection
async function getSSHConnection() {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    privateKeyPath: process.env.SSH_KEY_PATH,
  });
  return ssh;
}

// -- Public APK download routes --
router.get("/apk-info", async (req, res) => {
  const type = req.query.type === 'full' ? 'full' : 'relay';
  const apkFileName = type === 'full' ? "nexus-full-latest.apk" : "nexus-relay-latest.apk";
  const metaFileName = type === 'full' ? "nexus-full.meta.json" : "nexus-relay.meta.json";
  
  const apkPath = path.join(DOWNLOADS_DIR, apkFileName);
  const metaPath = path.join(DOWNLOADS_DIR, metaFileName);
  
  if (!fs.existsSync(apkPath)) {
    return res.json({ available: false });
  }
  
  const stat = await fs.promises.stat(apkPath);
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      const fileContent = await fs.promises.readFile(metaPath, "utf8");
      meta = JSON.parse(fileContent);
    } catch {}
  }

  if (!meta.version || meta.version === "1.0" || !meta.versionCode) {
    const parsedMeta = await readApkManifestMetadata(apkPath, stat);
    if (parsedMeta?.version) {
      meta = { ...meta, ...parsedMeta, filename: apkFileName, size: stat.size, uploadedAt: meta.uploadedAt || stat.mtime.toISOString() };
      try {
        await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
      } catch (err) {
        logger.warn("[APK] Failed to refresh APK metadata file:", err.message);
      }
    }
  }
  
  res.json({
    available: true,
    filename: apkFileName,
    version: meta.version || null,
    versionCode: meta.versionCode || 0,
    packageName: meta.packageName || "",
    size: meta.size || stat.size,
    uploadedAt: meta.uploadedAt || stat.mtime.toISOString(),
    downloadUrl: `${apiBaseUrl()}/api/vultr/download-${type}.apk`
  });
});

// Kontrola dostupné verze — VEŘEJNÁ, stejně jako samotné stahování APK níž.
// Dřív tahle cesta ležela až za authMiddleware + requireAppOwner, jenže UpdateBanner
// ji volá bez tokenu → vracela 401, chyba se jen zalogovala a banner s aktualizací
// se NIKDY nezobrazil. Zařízení tak zůstávala na staré verzi.
// Vrací pouze metadata buildu (verze, velikost, odkaz ke stažení), nic citlivého.
router.get("/latest-version", async (req, res) => {
  // Upload zapisuje metadata zvlášť pro každou variantu, ale tahle cesta dřív
  // vracela natvrdo relay — takže Nexus Hub (full) dostával verzi Relay aplikace
  // a nabízel k instalaci cizí APK. Default zůstává relay kvůli starším klientům.
  const variant = req.query.variant === "full" ? "full" : "relay";
  const metaPath = path.join(DOWNLOADS_DIR, `nexus-${variant}.meta.json`);
  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ message: "No version info available" });
  }
  try {
    const fileContent = await fs.promises.readFile(metaPath, "utf8");
    res.json(JSON.parse(fileContent));
  } catch (err) {
    res.status(500).json({ message: "Error reading version info" });
  }
});

router.get("/download-relay.apk", (req, res) => {
  const apkPath = path.join(DOWNLOADS_DIR, "nexus-relay-latest.apk");
  if (fs.existsSync(apkPath)) {
    res.download(apkPath, "nexus-relay-latest.apk");
  } else {
    res.status(404).send("APK not found");
  }
});

router.get("/download-full.apk", (req, res) => {
  const apkPath = path.join(DOWNLOADS_DIR, "nexus-full-latest.apk");
  if (fs.existsSync(apkPath)) {
    res.download(apkPath, "nexus-full-latest.apk");
  } else {
    res.status(404).send("APK not found");
  }
});

router.get("/agent-downloads", async (req, res) => {
  const baseUrl = apiBaseUrl();
  const downloads = await Promise.all(AGENT_DOWNLOADS.map(async (item) => {
    const filePath = path.join(DOWNLOADS_DIR, item.filename);
    const meta = await readJsonIfExists(path.join(DOWNLOADS_DIR, `${item.id}.agent.meta.json`));
    if (!fs.existsSync(filePath)) {
      return { ...item, available: false, version: meta.version || null };
    }
    const stat = await fs.promises.stat(filePath);
    return {
      ...item,
      available: true,
      version: meta.version || null,
      size: stat.size,
      updatedAt: meta.uploadedAt || stat.mtime.toISOString(),
      downloadUrl: `${baseUrl}/downloads/${item.filename}`
    };
  }));

  res.json({
    available: downloads.some(item => item.available),
    downloads
  });
});

// ── Deploy token pro nahrání APK z CI ────────────────────────────────────────
//
// CI nahrává sestavené APK neinteraktivně, takže nemá JWT App Ownera. Dřív se
// posílal dlouhodobý JWT jako secret — ten vypršel a upload začal tiše padat na
// 401, takže se nové buildy přestaly distribuovat na zařízení. Pro TUTO JEDNU
// cestu proto povolíme dedikovaný statický token; všechno ostatní ve vultrRoutes
// zůstává owner-only.
//
// Pozor na dopad: kdo má token, může nahrát APK, které si uživatelé nainstalují.
// Proto: token musí být dostatečně dlouhý, porovnává se v konstantním čase (přes
// hash, ať neuniká ani délka) a bez nastavené proměnné je tahle cesta VYPNUTÁ.
const APK_DEPLOY_TOKEN_MIN_LENGTH = 32;

function hasValidApkDeployToken(req) {
  const expected = process.env.APK_DEPLOY_TOKEN;
  if (!expected || expected.length < APK_DEPLOY_TOKEN_MIN_LENGTH) return false;

  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const provided = header.slice(7);
  if (!provided) return false;

  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

// Platí výhradně pro upload APK — ne pro ostatní (infrastrukturní) vultr cesty.
function isApkDeployRequest(req) {
  return req.method === 'POST' && req.path === '/upload-apk' && hasValidApkDeployToken(req);
}

// Apply auth to all OTHER vultr routes
router.use((req, res, next) => {
  if (isApkDeployRequest(req)) {
    logger.info('[Vultr] APK upload authorized via deploy token');
    return next();
  }
  return authMiddleware(req, res, next);
});

// Infrastructure operations can read secrets or control servers; keep them owner-only.
router.use((req, res, next) => {
  if (isApkDeployRequest(req)) return next();
  return requireAppOwner(req, res, next);
});

// ── Vultr API ─────────────────────────────────────────────────────────────────
router.get("/status", async (req, res) => {
  try {
    const { data } = await axios.get(`${VULTR_API}/instances/${process.env.VULTR_INSTANCE_ID}`, { headers: headers() });
    res.json(data.instance);
  } catch (err) {
    logger.error("Vultr Status Error:", err.message);
    res.status(err.response?.status || 500).json({ message: 'Failed to fetch server status' });
  }
});

router.post("/start", async (req, res) => {
  try {
    await axios.post(`${VULTR_API}/instances/${process.env.VULTR_INSTANCE_ID}/start`, {}, { headers: headers() });
    res.json({ ok: true });
  } catch (err) {
    logger.error("Vultr Start Error:", err.message);
    res.status(500).json({ message: 'Failed to start server' });
  }
});

router.post("/stop", async (req, res) => {
  try {
    await axios.post(`${VULTR_API}/instances/${process.env.VULTR_INSTANCE_ID}/halt`, {}, { headers: headers() });
    res.json({ ok: true });
  } catch (err) {
    logger.error("Vultr Stop Error:", err.message);
    res.status(500).json({ message: 'Failed to stop server' });
  }
});

router.post("/restart", async (req, res) => {
  try {
    await axios.post(`${VULTR_API}/instances/${process.env.VULTR_INSTANCE_ID}/reboot`, {}, { headers: headers() });
    res.json({ ok: true });
  } catch (err) {
    logger.error("Vultr Restart Error:", err.message);
    res.status(500).json({ message: 'Failed to restart server' });
  }
});

router.get("/bandwidth", async (req, res) => {
  try {
    const { data } = await axios.get(`${VULTR_API}/instances/${process.env.VULTR_INSTANCE_ID}/bandwidth`, { headers: headers() });
    res.json(data.bandwidth);
  } catch (err) {
    logger.error("Vultr Bandwidth Error:", err.message);
    res.status(err.response?.status || 500).json({ message: 'Failed to fetch bandwidth data' });
  }
});

// ── SSH Terminal ──────────────────────────────────────────────────────────────
const COMMAND_ALLOWLIST = [
  /^(ls|head|tail|grep|wc|df|du|free|uptime|whoami|date|pwd)(\s|$)/,
  /^pm2\s+(list|status|logs)(\s|$)/,
  /^systemctl\s+status(\s|$)/,
  /^nginx\s+-t(\s|$)/,
  /^git\s+status(\s|$)/,
];
const COMMAND_BLOCKLIST = /rm\s+-rf|mkfs|dd\s+if=|:\(\)\{|>\s*\/dev\/|chmod\s+777|curl\s+.*\|\s*(ba)?sh|wget\s+.*\|\s*(ba)?sh|eval\s|exec\s/i;

router.post("/command", validate(sshCommand), async (req, res) => {
  const { command } = req.body;
  const trimmed = command.trim();

  // The command is executed as a raw shell string, so reject ALL shell
  // metacharacters (chaining / redirection / substitution / subshell) up front.
  if (/[;&|`$<>()\n\r\\]/.test(trimmed)) {
    return res.status(403).json({ message: 'Command contains disallowed characters' });
  }

  if (COMMAND_BLOCKLIST.test(trimmed)) {
    return res.status(403).json({ message: 'This command is not allowed for security reasons' });
  }

  const isAllowed = COMMAND_ALLOWLIST.some(rx => rx.test(trimmed));
  if (!isAllowed) {
    return res.status(403).json({ message: 'Command not in allowlist. Allowed: read-only status commands only.' });
  }

  try {
    const ssh = await getSSHConnection();
    const result = await ssh.execCommand(command);
    ssh.dispose();
    res.json({ stdout: result.stdout, stderr: result.stderr });
  } catch (err) {
    logger.error("SSH Command Error:", err.message);
    res.status(500).json({ message: 'Command execution failed' });
  }
});

router.post("/git-pull", validate(gitPull), async (req, res) => {
  const { path: repoPath } = req.body;
  
  // Prevent path traversal and command injection
  if (/[$;|&<>()\n`]|\.\./.test(repoPath)) {
    return res.status(403).json({ message: 'Invalid path — traversal and command injection not allowed' });
  }
  
  try {
    const ssh = await getSSHConnection();
    const result = await ssh.execCommand(`cd ${repoPath} && git pull origin master`);
    ssh.dispose();
    res.json({ stdout: result.stdout || "Already up to date.", stderr: result.stderr });
  } catch (err) {
    logger.error("SSH Git Pull Error:", err.message);
    res.status(500).json({ message: 'Git pull failed' });
  }
});

router.post("/upload-apk", apkUpload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No APK file provided' });
  
  try {
    const stat = fs.statSync(req.file.path);
    let version = "1.0";
    let versionCode = 0;
    let packageName = "";
    
    const baseName = req.file.filename; // nexus-full-latest.apk or nexus-relay.apk
    const isFull = baseName.includes('full');

    // Prevent OOM by skipping ApkReader for large files (> 100MB)
    const parsedMeta = await readApkManifestMetadata(req.file.path, stat);
    if (parsedMeta?.version) {
      version = parsedMeta.version;
      versionCode = parsedMeta.versionCode;
      packageName = parsedMeta.packageName;
      logger.info(`[APK] Parsed metadata: ${packageName} v${version} (${versionCode})`);
    } else {
      logger.info(`[APK] Using fallback metadata for ${req.file.filename} (${stat.size} bytes)`);
    }

    const meta = {
      version,
      versionCode,
      packageName,
      filename: baseName,
      size: stat.size,
      uploadedAt: new Date().toISOString(),
      downloadUrl: `${apiBaseUrl()}/api/vultr/download-relay.apk`
    };

    const metaFile = isFull ? "nexus-full.meta.json" : "nexus-relay.meta.json";
    fs.writeFileSync(path.join(DOWNLOADS_DIR, metaFile), JSON.stringify(meta, null, 2));
    logger.info(`[APK] New APK uploaded (${baseName}): ${stat.size} bytes`);
    res.json({ ok: true, ...meta });
  } catch (err) {
    logger.error("[APK] Upload processing error:", err.message);
    res.status(500).json({ message: "Failed to process APK upload" });
  }
});

router.post("/upload-agent", (req, res, next) => {
  agentUpload.single("agent")(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    next();
  });
}, async (req, res) => {
  const target = resolveAgentDownload(req.body.platform);
  if (!target) return res.status(400).json({ message: "Invalid platform. Use windows, macos or linux." });
  if (!req.file) return res.status(400).json({ message: "No agent package provided" });

  try {
    const stat = await fs.promises.stat(req.file.path);
    const baseUrl = apiBaseUrl();
    const meta = {
      platform: target.id,
      filename: target.filename,
      label: target.label,
      version: req.body.version || null,
      size: stat.size,
      uploadedAt: new Date().toISOString(),
      downloadUrl: `${baseUrl}/downloads/${target.filename}`
    };

    await fs.promises.writeFile(
      path.join(DOWNLOADS_DIR, `${target.id}.agent.meta.json`),
      JSON.stringify(meta, null, 2)
    );

    logger.info(`[Agent] New ${target.id} package uploaded: ${stat.size} bytes`);
    res.json({ ok: true, ...meta });
  } catch (err) {
    logger.error("[Agent] Upload processing error:", err.message);
    res.status(500).json({ message: "Failed to process agent package" });
  }
});

// Varianta se bere z těla požadavku. Dřív se balík vždycky ukládal jako
// nexus-relay.zip, i když šlo o plnou aplikaci — a relay zařízení by si tak
// stáhlo cizí build.
const otaVarianta = (req) => (req.body?.variant === "full" ? "full" : "relay");

const otaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOWNLOADS_DIR),
    filename: (req, file, cb) => cb(null, `nexus-${otaVarianta(req)}.zip`)
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

router.post("/upload-ota", otaUpload.single("ota"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No OTA file provided' });
  const varianta = otaVarianta(req);
  const version = req.body.version || "1.0";
  const metaPath = path.join(DOWNLOADS_DIR, `nexus-${varianta}.meta.json`);

  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      const fileContent = await fs.promises.readFile(metaPath, "utf8");
      meta = JSON.parse(fileContent);
    } catch {}
  }

  // OTA verze se drží ZVLÁŠŤ od APK.
  //
  // `version` a `versionCode` popisují nainstalovanou aplikaci a zapisuje je
  // jedině nahrání APK. UpdateBanner porovnával právě versionCode, takže po
  // nahrání samotného webového balíku se nezměnilo nic — a bleskový update
  // se uživateli NIKDY nenabídl. Přepisovat kvůli tomu `version` by rozbilo
  // hlášení verze aplikace, protože web a APK jsou dvě různé věci.
  meta.otaVersion = version;
  meta.otaUploadedAt = new Date().toISOString();
  meta.otaUrl = `${apiBaseUrl()}/downloads/nexus-${varianta}.zip`;

  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
  logger.info(`[OTA] Nový webový balík v${version} (${varianta}) nahrán`);
  res.json({ ok: true, version, variant: varianta });
});

module.exports = router;
