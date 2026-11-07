const prisma = require('./db');
const { JEN_RELAY } = require('../utils/deviceVariants');
const logger = require('./logger');
const { sendAlert } = require('./alertService');
const fs = require('fs');
const path = require('path');

const DEFAULT_PENDING_PAYMENT_MINUTES = 60;
const DEFAULT_RELAY_OFFLINE_MINUTES = 15;
const DEFAULT_RELAY_OUTBOX_PENDING_MINUTES = 10;
const DEFAULT_BACKUP_MAX_AGE_MINUTES = 26 * 60;
const DEFAULT_ALERT_COOLDOWN_MINUTES = 60;

const lastAlertAt = new Map();

const positiveIntEnv = (name, fallback) => {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const minutesAgoCutoff = (now, minutes) => new Date(now.getTime() - minutes * 60 * 1000);

const booleanEnv = (name) => String(process.env[name] || '').toLowerCase() === 'true';

const ageMinutes = (now, value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
};

const safeJson = (value) => {
  if (!value || typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const isStripeOrCardPending = (subscription) => {
  const note = safeJson(subscription.note);
  const provider = String(note.provider || '').toLowerCase();
  const paymentMethod = String(note.paymentMethod || '').toLowerCase();
  const paymentRef = String(subscription.paymentRef || '');

  return provider === 'stripe' ||
    paymentMethod === 'card' ||
    paymentRef.startsWith('cs_') ||
    Boolean(note.stripeSessionId);
};

const formatSubscription = (subscription, now) => ({
  id: subscription.id,
  agencyId: subscription.agencyId,
  plan: subscription.plan,
  paymentRef: subscription.paymentRef || null,
  amountPaid: subscription.amountPaid ?? null,
  currency: subscription.currency || null,
  createdAt: subscription.createdAt,
  ageMinutes: ageMinutes(now, subscription.createdAt)
});

const formatBinding = (binding, now) => ({
  installationId: binding.installationId,
  agencyId: binding.agencyId || null,
  profileId: binding.profileId || null,
  profileName: binding.profile?.name || null,
  deviceName: binding.deviceName || binding.model || null,
  lastSeenAt: binding.lastSeenAt,
  ageMinutes: ageMinutes(now, binding.lastSeenAt)
});

const formatPendingRelayMessage = (message, now) => ({
  id: message.id,
  agencyId: message.chat?.agencyId || null,
  profileId: message.chat?.profileId || null,
  profileName: message.chat?.profile?.name || null,
  to: message.chat?.externalId || null,
  transport: message.transport || null,
  createdAt: message.createdAt,
  ageMinutes: ageMinutes(now, message.createdAt)
});

class MonitoringService {
  async checkDatabase() {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', issues: [] };
    } catch (error) {
      return {
        status: 'degraded',
        issues: [`Database connectivity check failed: ${error.message}`]
      };
    }
  }

  async checkStripe(now) {
    const thresholdMinutes = positiveIntEnv('PENDING_BILLING_ALERT_MINUTES', DEFAULT_PENDING_PAYMENT_MINUTES);
    const issues = [];
    const secretKeyConfigured = Boolean(process.env.STRIPE_SECRET_KEY);
    const publishableKeyConfigured = Boolean(process.env.STRIPE_PUBLISHABLE_KEY);
    const webhookSecretConfigured = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
    const requireStripe = process.env.REQUIRE_STRIPE_CONFIG === 'true';

    if (secretKeyConfigured && !webhookSecretConfigured) {
      issues.push('Stripe secret key is configured, but STRIPE_WEBHOOK_SECRET is missing. Paid checkouts may not activate.');
    }
    if (requireStripe && !secretKeyConfigured) {
      issues.push('REQUIRE_STRIPE_CONFIG=true, but STRIPE_SECRET_KEY is missing.');
    }

    let staleSubscriptions = [];
    try {
      const candidates = await prisma.subscription.findMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: minutesAgoCutoff(now, thresholdMinutes) }
        },
        orderBy: { createdAt: 'asc' },
        take: 25
      });
      staleSubscriptions = candidates.filter(isStripeOrCardPending).map(sub => formatSubscription(sub, now));
      if (staleSubscriptions.length > 0) {
        issues.push(`${staleSubscriptions.length} Stripe/card subscription(s) pending for more than ${thresholdMinutes} minutes.`);
      }
    } catch (error) {
      issues.push(`Stripe pending payment query failed: ${error.message}`);
    }

    return {
      status: issues.length > 0 ? 'degraded' : 'ok',
      thresholdMinutes,
      secretKeyConfigured,
      publishableKeyConfigured,
      webhookSecretConfigured,
      pendingCount: staleSubscriptions.length,
      pending: staleSubscriptions.slice(0, 10),
      issues
    };
  }

  async checkRelay(now) {
    const thresholdMinutes = positiveIntEnv('RELAY_OFFLINE_ALERT_MINUTES', DEFAULT_RELAY_OFFLINE_MINUTES);
    const issues = [];
    let offlineBindings = [];

    try {
      // `...JEN_RELAY`: hlídá se relay telefon. Plná aplikace modelky má
      // od #188 vlastní vazbu, ale `lastSeenAt` jí obnovuje jen příchozí
      // SMS, dotaz na outbox a SIP ping — tedy nic, co plná aplikace dělá.
      // Bez filtru by tedy zahlcovala poplach „relay je offline" vždy.
      offlineBindings = await prisma.deviceBinding.findMany({
        where: {
          ...JEN_RELAY,
          active: true,
          lastSeenAt: { lt: minutesAgoCutoff(now, thresholdMinutes) }
        },
        select: {
          installationId: true,
          agencyId: true,
          profileId: true,
          deviceName: true,
          model: true,
          lastSeenAt: true,
          profile: { select: { name: true } }
        },
        orderBy: { lastSeenAt: 'asc' },
        take: 25
      });
    } catch (error) {
      issues.push(`Relay offline query failed: ${error.message}`);
    }

    const formattedOffline = offlineBindings.map(binding => formatBinding(binding, now));
    if (formattedOffline.length > 0) {
      issues.push(`${formattedOffline.length} active Relay binding(s) have not checked in for more than ${thresholdMinutes} minutes.`);
    }

    return {
      status: issues.length > 0 ? 'degraded' : 'ok',
      thresholdMinutes,
      offlineCount: formattedOffline.length,
      offline: formattedOffline.slice(0, 10),
      issues
    };
  }

  async checkOutbox(now) {
    const thresholdMinutes = positiveIntEnv('RELAY_OUTBOX_PENDING_MINUTES', DEFAULT_RELAY_OUTBOX_PENDING_MINUTES);
    const issues = [];
    let pendingMessages = [];

    try {
      pendingMessages = await prisma.message.findMany({
        where: {
          direction: 'OUTBOUND',
          status: 'pending_relay',
          createdAt: { lt: minutesAgoCutoff(now, thresholdMinutes) }
        },
        include: {
          chat: {
            select: {
              agencyId: true,
              profileId: true,
              externalId: true,
              profile: { select: { name: true } }
            }
          }
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 25
      });
    } catch (error) {
      issues.push(`Relay outbox query failed: ${error.message}`);
    }

    const formattedPending = pendingMessages.map(message => formatPendingRelayMessage(message, now));
    if (formattedPending.length > 0) {
      issues.push(`${formattedPending.length} outbound Relay SMS message(s) have been pending for more than ${thresholdMinutes} minutes.`);
    }

    return {
      status: issues.length > 0 ? 'degraded' : 'ok',
      thresholdMinutes,
      pendingCount: formattedPending.length,
      pending: formattedPending.slice(0, 10),
      issues
    };
  }

  checkBackups(now) {
    const enabled = booleanEnv('BACKUP_MONITORING_ENABLED') || booleanEnv('REQUIRE_BACKUP_MONITORING');
    const required = booleanEnv('REQUIRE_BACKUP_MONITORING');
    const thresholdMinutes = positiveIntEnv('BACKUP_MAX_AGE_MINUTES', DEFAULT_BACKUP_MAX_AGE_MINUTES);
    const backupDir = process.env.BACKUP_DIR || '/var/backups/nexus';
    const issues = [];

    if (!enabled) {
      return {
        status: 'skipped',
        enabled: false,
        required,
        backupDir,
        thresholdMinutes,
        latest: null,
        issues
      };
    }

    let latest = null;
    try {
      const entries = fs.readdirSync(backupDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^nexus_.*\.dump$/.test(entry.name))
        .map(entry => {
          const fullPath = path.join(backupDir, entry.name);
          const stats = fs.statSync(fullPath);
          return {
            file: fullPath,
            createdAt: stats.mtime,
            ageMinutes: ageMinutes(now, stats.mtime),
            sizeBytes: stats.size
          };
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      latest = entries[0] || null;
      if (!latest) {
        issues.push(`No database backup files matching nexus_*.dump were found in ${backupDir}.`);
      } else if (latest.ageMinutes !== null && latest.ageMinutes > thresholdMinutes) {
        issues.push(`Latest database backup is ${latest.ageMinutes} minutes old, above the ${thresholdMinutes} minute threshold.`);
      }
    } catch (error) {
      issues.push(`Database backup check failed for ${backupDir}: ${error.message}`);
    }

    return {
      status: issues.length > 0 ? 'degraded' : 'ok',
      enabled,
      required,
      backupDir,
      thresholdMinutes,
      latest: latest ? {
        file: latest.file,
        createdAt: latest.createdAt,
        ageMinutes: latest.ageMinutes,
        sizeBytes: latest.sizeBytes
      } : null,
      issues
    };
  }

  async summarizeOperationalHealth(options = {}) {
    const now = options.now || new Date();
    const [database, stripe, relay, outbox] = await Promise.all([
      this.checkDatabase(),
      this.checkStripe(now),
      this.checkRelay(now),
      this.checkOutbox(now)
    ]);
    const backups = this.checkBackups(now);

    const checks = { database, stripe, relay, outbox, backups };
    const issues = Object.entries(checks).flatMap(([name, check]) =>
      (check.issues || []).map(message => ({ check: name, message }))
    );

    return {
      status: issues.length > 0 ? 'degraded' : 'ok',
      timestamp: now.toISOString(),
      checks,
      issues
    };
  }

  formatAlert(report) {
    if (!report || report.status === 'ok') return null;
    const lines = report.issues
      .slice(0, 12)
      .map(issue => `- ${issue.check}: ${issue.message}`);
    return [
      `Operational monitoring degraded (${process.env.NODE_ENV || 'unknown'})`,
      `Time: ${report.timestamp}`,
      '',
      ...lines
    ].join('\n');
  }

  shouldSendAlert(fingerprint, now) {
    const cooldownMinutes = positiveIntEnv('MONITOR_ALERT_COOLDOWN_MINUTES', DEFAULT_ALERT_COOLDOWN_MINUTES);
    const previous = lastAlertAt.get(fingerprint);
    if (!previous || now.getTime() - previous.getTime() >= cooldownMinutes * 60 * 1000) {
      lastAlertAt.set(fingerprint, now);
      return true;
    }
    return false;
  }

  async runOperationalChecks(options = {}) {
    const now = options.now || new Date();
    const report = await this.summarizeOperationalHealth({ now });
    const shouldAlert = options.sendAlerts !== false && report.status !== 'ok';

    if (shouldAlert) {
      const fingerprint = report.issues.map(issue => `${issue.check}:${issue.message}`).join('|');
      if (this.shouldSendAlert(fingerprint, now)) {
        const message = this.formatAlert(report);
        if (message) {
          try {
            await sendAlert(message, 'warning');
          } catch (error) {
            logger.warn('[Monitoring] Failed to send alert:', error.message);
          }
        }
      }
    }

    if (report.status !== 'ok') {
      logger.warn('[Monitoring] Operational health degraded', report.issues);
    }

    return report;
  }

  _resetForTests() {
    lastAlertAt.clear();
  }
}

module.exports = new MonitoringService();
