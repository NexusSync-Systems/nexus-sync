const { isManagerRole } = require('../utils/authz');
const prisma = require('../services/db');
const logger = require('../services/logger');
const monitoringService = require('../services/monitoringService');
const infraHealthService = require('../services/infraHealthService');
const { isAppOwnerRole } = require('../utils/authz');
const featureLockConfig = require('../config/featureLocks');
const os = require('os');
const { execSync } = require('child_process');

// Výchozí konfigurace funkcí (pokud nejsou v DB ještě uloženy)
const defaultFeatures = [
  { id: 'ai_trans', label: 'AI Voice Relay (Beta)', desc: 'Enable neural speech-to-speech routing', active: true },
  { id: 'vc_hub', label: 'Cross-Agency Analytics', desc: 'Enable view of aggregated data', active: true },
  { id: 'crm_adv', label: 'Proxy Pooling', desc: 'Allow sharing device nodes', active: true },
  { id: 'stats_bi', label: 'Payout Processing', desc: 'Automate weekly commission transfers', active: false }
];

exports.getGlobalFeatures = async (req, res) => {
  try {
    const userRole = req.user?.role;
    // Povolíme přístup App Ownerovi a Managerům
    if (!userRole || !isManagerRole(userRole)) {
      return res.status(403).json({ error: 'Access denied: Requires App Owner or Manager role.' });
    }

    // Načteme všechny nastavení z DB
    const settings = await prisma.globalSetting.findMany({
      where: {
        key: {
          startsWith: 'feature_'
        }
      }
    });

    const settingsMap = settings.reduce((acc, current) => {
      acc[current.key] = current.value === 'true';
      return acc;
    }, {});

    // Spojíme výchozí stav se stavem z databáze
    const features = defaultFeatures.map(feature => ({
      ...feature,
      active: settingsMap[`feature_${feature.id}`] !== undefined ? settingsMap[`feature_${feature.id}`] : feature.active
    }));

    res.json(features);
  } catch (err) {
    logger.error('Error fetching global features:', err.message);
    res.status(500).json({ error: 'Failed to fetch global features' });
  }
};

exports.updateGlobalFeature = async (req, res) => {
  try {
    const userRole = req.user?.role;
    // Měnit stav může POUZE App Owner (zabezpečení)
    if (!userRole || !userRole.isAppOwner) {
      return res.status(403).json({ error: 'Access denied: Requires App Owner role to modify global features.' });
    }

    const { id } = req.params;
    const { active } = req.body;

    if (active === undefined) {
      return res.status(400).json({ error: 'Missing active status in body' });
    }

    const key = `feature_${id}`;
    const stringValue = active ? 'true' : 'false';

    // Upsert uloží nebo zaktualizuje záznam
    const updatedSetting = await prisma.globalSetting.upsert({
      where: { key: key },
      update: { value: stringValue },
      create: { key: key, value: stringValue }
    });

    res.json({ id, active: updatedSetting.value === 'true' });
  } catch (err) {
    logger.error(`Error updating global feature ${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to update global feature' });
  }
};

// GET /api/admin/settings — list all system settings (App Owner only)
exports.getGlobalSettings = async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (!userRole || !userRole.isAppOwner) {
      return res.status(403).json({ error: 'Access denied: Requires App Owner role.' });
    }

    const settings = await prisma.globalSetting.findMany({
      orderBy: { key: 'asc' }
    });
    res.json(settings);
  } catch (err) {
    logger.error('Error fetching global settings:', err.message);
    res.status(500).json({ error: 'Failed to fetch global settings' });
  }
};

// POST /api/admin/settings — create or update a setting (App Owner only)
// GET /api/admin/settings/public — dvě hodnoty, které se zobrazují VŠEM
//
// getGlobalSettings je vyhrazený App Ownerovi a to je správně: mezi
// globálními nastaveními můžou být provozní věci, které ostatním do oka
// nic nejsou. Jenže banner údržby a globální oznámení má vidět každý —
// v tom je jejich celý smysl. Bez téhle ruty by si je SystemBanners
// nemohl přečíst (403) a banner by se nezobrazil nikomu kromě ownera.
//
// Vrací se JEN tyhle dva klíče, ne celý seznam. Stejný vzor jako
// u feature-locks: čte každý přihlášený, mění jen App Owner.
exports.getPublicSettings = async (req, res) => {
  try {
    const rows = await prisma.globalSetting.findMany({
      where: { key: { in: ['maintenance_mode', 'global_announcement'] } }
    });
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      maintenanceMode: String(map.maintenance_mode || '') === 'true',
      globalAnnouncement: map.global_announcement || ''
    });
  } catch (err) {
    logger.error('Error fetching public settings:', err.message);
    // Nedostupné nastavení nesmí shodit aplikaci — bannery prostě nebudou.
    res.json({ maintenanceMode: false, globalAnnouncement: '' });
  }
};

exports.updateGlobalSetting = async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (!userRole || !userRole.isAppOwner) {
      return res.status(403).json({ error: 'Access denied: Requires App Owner role to modify settings.' });
    }

    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Missing key or value' });
    }

    const updated = await prisma.globalSetting.upsert({
      where: { key: key },
      update: { value: String(value) },
      create: { key: key, value: String(value) }
    });

    res.json(updated);
  } catch (err) {
    logger.error(`Error updating setting ${req.body.key}:`, err.message);
    res.status(500).json({ error: 'Failed to update global setting' });
  }
};

// GET /api/admin/feature-locks — aktuální stav zámků nedodělaných funkcí.
// Čte KAŽDÝ přihlášený uživatel: klient podle toho renderuje UI (zamčeno/odemčeno)
// a vypíná reálné chování. Merge DB overrides (`lock_<key>`) s defaultem (zamčeno).
exports.getFeatureLocks = async (req, res) => {
  try {
    const rows = await prisma.globalSetting.findMany({
      where: { key: { startsWith: featureLockConfig.SETTING_PREFIX } }
    });
    const overrides = rows.reduce((acc, row) => {
      acc[row.key.slice(featureLockConfig.SETTING_PREFIX.length)] = row.value === 'true';
      return acc;
    }, {});

    const locks = {};
    for (const key of featureLockConfig.LOCKABLE_KEYS) {
      locks[key] = overrides[key] !== undefined ? overrides[key] : featureLockConfig.DEFAULT_LOCKED;
    }
    res.json({ locks });
  } catch (err) {
    logger.error('Error fetching feature locks:', err.message);
    res.status(500).json({ error: 'Failed to fetch feature locks' });
  }
};

// PATCH /api/admin/feature-locks/:key — zamkne/odemkne funkci. POUZE App Owner.
exports.updateFeatureLock = async (req, res) => {
  try {
    if (!isAppOwnerRole(req.user?.role)) {
      return res.status(403).json({ error: 'Access denied: Requires App Owner role to modify feature locks.' });
    }

    const { key } = req.params;
    if (!featureLockConfig.LOCKABLE_KEYS.includes(key)) {
      return res.status(400).json({ error: 'Unknown feature lock key' });
    }

    const { locked } = req.body;
    const stringValue = locked ? 'true' : 'false';

    await prisma.globalSetting.upsert({
      where: { key: featureLockConfig.keyToSetting(key) },
      update: { value: stringValue },
      create: { key: featureLockConfig.keyToSetting(key), value: stringValue }
    });

    logger.info(`[FeatureLock] ${key} -> ${locked ? 'LOCKED' : 'UNLOCKED'} by ${req.user?.userId || req.user?.id || 'unknown'}`);
    res.json({ key, locked: !!locked });
  } catch (err) {
    logger.error(`Error updating feature lock ${req.params.key}:`, err.message);
    res.status(500).json({ error: 'Failed to update feature lock' });
  }
};

// GET /api/admin/health — system monitoring (App Owner only)
exports.getSystemHealth = async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (!userRole || !userRole.isAppOwner) {
      return res.status(403).json({ error: 'Access denied: Requires App Owner role.' });
    }

    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const usedMem = totalMem - freeMem;
    const memUsage = (usedMem / totalMem) * 100;

    const cpus = os.cpus();
    const loadAvg = os.loadavg(); 

    const uptimeSeconds = os.uptime();
    const uptimeDays = Math.floor(uptimeSeconds / (24 * 3600));
    const uptimeHours = Math.floor((uptimeSeconds % (24 * 3600)) / 3600);
    const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);

    let diskUsage = { total: 'N/A', used: 'N/A', available: 'N/A', percent: '0%' };
    try {
        const df = execSync('df -h / | tail -1').toString().trim().split(/\s+/);
        if (df.length >= 5) {
            diskUsage = {
                total: df[1],
                used: df[2],
                available: df[3],
                percent: df[4]
            };
        }
    } catch (e) {
        logger.warn('Could not fetch disk usage:', e.message);
    }

    res.json({
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        uptime: {
            days: uptimeDays,
            hours: uptimeHours,
            minutes: uptimeMinutes,
            totalSeconds: uptimeSeconds
        },
        cpu: {
            model: cpus[0].model,
            cores: cpus.length,
            loadAvg: loadAvg.map(l => l.toFixed(2))
        },
        memory: {
            total: (totalMem / (1024 ** 3)).toFixed(2) + ' GB',
            free: (freeMem / (1024 ** 3)).toFixed(2) + ' GB',
            used: (usedMem / (1024 ** 3)).toFixed(2) + ' GB',
            percent: memUsage.toFixed(1)
        },
        disk: diskUsage,
        nodeVersion: process.version,
        timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Error fetching system health:', err.message);
    res.status(500).json({ error: 'Failed to fetch system health' });
  }
};

// GET /api/admin/operational-health - billing/relay/infra monitoring (App Owner only)
exports.getOperationalHealth = async (req, res) => {
  try {
    if (!isAppOwnerRole(req.user?.role)) {
      return res.status(403).json({ error: 'Access denied: Requires App Owner role.' });
    }

    const report = await monitoringService.summarizeOperationalHealth();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  } catch (err) {
    logger.error('Error fetching operational health:', err.message);
    res.status(500).json({ error: 'Failed to fetch operational health' });
  }
};

// GET /api/admin/infra-health - servers, PM2, AI tunnel, Ollama and provider state
exports.getInfraHealth = async (req, res) => {
  try {
    if (!isAppOwnerRole(req.user?.role)) {
      return res.status(403).json({ error: 'Access denied: Requires App Owner role.' });
    }

    const report = await infraHealthService.summarize();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  } catch (err) {
    logger.error('Error fetching infra health:', err.message);
    res.status(500).json({ error: 'Failed to fetch infrastructure health' });
  }
};
