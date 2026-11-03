const cron = require('node-cron');
const prisma = require('./db');
const logger = require('./logger');
const monitoringService = require('./monitoringService');

/**
 * Scheduled jobs for the Nexus Hub server.
 */
class CronService {
  start() {
    // Generate daily stats every day at 01:00
    cron.schedule('0 1 * * *', () => this.generateDailyStats());

    // Clean up expired subscriptions every day at 02:00
    cron.schedule('0 2 * * *', () => this.expireSubscriptions());

    // AdultWork Organic Boost every 30 minutes
    cron.schedule('*/30 * * * *', () => this.triggerOrganicBoosts());

    // Production health monitoring every 5 minutes
    cron.schedule('*/5 * * * *', () => this.runOperationalMonitoring());

    // Párování plateb převodem. Worker existoval, ale nikdo ho nespouštěl —
    // i s nastaveným tokenem by tedy nikdy neproběhl a zaplacené převody by
    // zůstaly viset jako PENDING. Sám se vypne, když není zapnutý převod
    // nebo chybí token, takže tady nemusí být žádná podmínka.
    cron.schedule('*/10 * * * *', () => this.syncBankTransfers());

    // Úklid osobních údajů po uplynutí doby uchování, denně ve 03:00.
    // Běží po generování statistik (01:00), aby se denní čísla stihla spočítat
    // z dat, která se teprve potom smažou.
    cron.schedule('0 3 * * *', () => this.runRetentionCleanup());

    logger.info('Cron service started (daily stats @ 01:00, subscription check @ 02:00, retention @ 03:00, monitoring every 5 min)');
  }

  /**
   * Smaže osobní údaje, kterým vypršela doba uchování.
   *
   * Doby a pravidla jsou v config/retention.js a services/retentionService.js.
   * Služba si selhání jednotlivých tabulek ošetřuje sama, tohle je poslední
   * pojistka, aby výjimka neshodila cron.
   */
  async runRetentionCleanup() {
    try {
      await require('./retentionService').spustUklid();
    } catch (err) {
      logger.error('[Cron] Úklid podle retence selhal:', err.message);
    }
  }

  async generateDailyStats() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      const endOfDay = new Date(yesterday);
      endOfDay.setHours(23, 59, 59, 999);

      const agencies = await prisma.agency.findMany({ select: { id: true } });

      for (const agency of agencies) {
        const [bookingsCount, activeProfiles, revenue] = await Promise.all([
          prisma.booking.count({
            where: {
              agencyId: agency.id,
              startTime: { gte: yesterday, lte: endOfDay }
            }
          }),
          prisma.profile.count({
            where: { agencyId: agency.id, status: 'online' }
          }),
          // Revenue from subscriptions paid that day
          prisma.subscription.aggregate({
            where: {
              agencyId: agency.id,
              startedAt: { gte: yesterday, lte: endOfDay },
              amountPaid: { not: null }
            },
            _sum: { amountPaid: true }
          })
        ]);

        await prisma.dailyStat.upsert({
          where: {
            agencyId_date: { agencyId: agency.id, date: yesterday }
          },
          update: { bookingsCount, activeProfiles, revenue: revenue._sum.amountPaid || 0 },
          create: {
            agencyId: agency.id,
            date: yesterday,
            bookingsCount,
            activeProfiles,
            revenue: revenue._sum.amountPaid || 0
          }
        });
      }

      logger.info(`Daily stats generated for ${agencies.length} agencies (${yesterday.toISOString().slice(0, 10)})`);
    } catch (err) {
      logger.error('Failed to generate daily stats:', err);
    }
  }

  /**
   * Párování plateb převodem s Fio API.
   *
   * Worker si sám ohlídá, jestli je převod zapnutý a jestli je token — takže
   * na vypnutém nasazení jen zapíše řádek a skončí.
   */
  async syncBankTransfers() {
    try {
      const { syncFioTransactions } = require('../workers/fioSyncWorker');
      await syncFioTransactions();
      await this.expireBankTransferOrders();
    } catch (error) {
      logger.error('[Cron] Párování plateb převodem selhalo:', error.message);
    }
  }

  /**
   * Nezaplacené objednávky převodem po splatnosti.
   *
   * Bez tohohle by ve frontě k ručnímu potvrzení narůstaly objednávky, které
   * nikdo nikdy nezaplatil, a mezi nimi by zanikly ty skutečné. Objednávka se
   * jen uzavře — nic se neruší zákazníkovi, který má aktivní předplatné.
   */
  async expireBankTransferOrders() {
    try {
      const ted = new Date();
      const cekajici = await prisma.subscription.findMany({
        where: { status: 'PENDING', provider: 'bank_transfer' },
        select: { id: true, note: true, paymentRef: true },
      });

      const propadle = cekajici.filter((s) => {
        try {
          const dueAt = JSON.parse(s.note || '{}').dueAt;
          return dueAt && new Date(dueAt) < ted;
        } catch { return false; }
      });
      if (!propadle.length) return;

      await prisma.subscription.updateMany({
        where: { id: { in: propadle.map((s) => s.id) } },
        data: { status: 'EXPIRED', providerStatus: 'transfer_not_received' },
      });
      logger.info(`[Cron] Propadlo ${propadle.length} nezaplacených objednávek převodem (VS: ${propadle.map((s) => s.paymentRef).join(', ')})`);
    } catch (error) {
      logger.error('[Cron] Uzavírání propadlých objednávek selhalo:', error.message);
    }
  }

  async expireSubscriptions() {
    try {
      const now = new Date();
      const result = await prisma.subscription.updateMany({
        where: {
          status: 'ACTIVE',
          expiresAt: { lt: now }
        },
        data: { status: 'EXPIRED' }
      });

      if (result.count > 0) {
        logger.info(`Expired ${result.count} subscription(s)`);
      }
    } catch (err) {
      logger.error('Failed to expire subscriptions:', err);
    }
  }

  async triggerOrganicBoosts() {
    try {
      // Web automation je zatím uzamčená/neověřená (viz featureLocks.js na klientu).
      // Autonomní boost neběží, dokud ho výslovně nepovolíš přes WEB_AUTOMATION_ENABLED=true.
      if (process.env.WEB_AUTOMATION_ENABLED !== 'true') return;

      const { decrypt } = require('../utils/encryption');
      const { getIO } = require('./socket');
      const io = getIO();

      // Find all profiles with active automation settings
      const profiles = await prisma.profile.findMany({
        where: {
          data: { contains: '"awAutomation"' }
        }
      });

      for (const profile of profiles) {
        let data = {};
        try { data = JSON.parse(profile.data); } catch (e) { continue; }
        
        const settings = data.awAutomation;
        if (!settings || (!settings.autoAvailable && !settings.rotatePhotos && !settings.tweakSummary && !settings.autoLogin)) {
          continue;
        }

        // Randomize to avoid bot patterns (only run for ~30% of scheduled profiles each time)
        if (Math.random() > 0.3) continue;

        let decryptedCredentials = null;
        if (profile.credentials) {
          const decryptedString = await decrypt(profile.credentials);
          if (decryptedString) decryptedCredentials = JSON.parse(decryptedString);
        }

        logger.info(`[Cron] Triggering organic boost for profile: ${profile.name}`);
        io.to(`agency_${profile.agencyId}`).emit('relay_command', { 
          type: 'BOOST_WEB_PROFILE', 
          profileId: profile.id, 
          payload: { 
            name: profile.name, 
            credentials: decryptedCredentials, 
            platform: 'adultwork',
            settings: settings,
            adsPowerId: decryptedCredentials?.adsPowerId ?? null // adsPowerId žije v credentials; Profile takový sloupec nemá
          } 
        });
      }
    } catch (err) {
      logger.error('Failed to trigger organic boosts:', err);
    }
  }

  async runOperationalMonitoring() {
    try {
      await monitoringService.runOperationalChecks();
    } catch (err) {
      logger.error('Failed to run operational monitoring:', err);
    }
  }
}

module.exports = new CronService();
