const { isManagerRole } = require('../utils/authz');
const prisma = require('../services/db');

// GET /api/payouts/summary?startDate=xxx&endDate=xxx
exports.getPayoutSummary = async (req, res) => {
  try {
    const { agencyId, role } = req.user;
    if (!isManagerRole(role)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { startDate, endDate } = req.query;
    
    const where = {
      agencyId
    };

    if (startDate && endDate) {
      where.startTime = {
        gte: new Date(startDate),
        lte: new Date(endDate)
      };
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        profile: {
          select: { id: true, name: true, commission: true }
        }
      }
    });

    // Aggregate by profile
    const summary = {};
    bookings.forEach(b => {
      const pid = b.profileId;
      if (!summary[pid]) {
        summary[pid] = {
          profileId: pid,
          profileName: b.profile?.name || 'Unknown',
          commission: b.profile?.commission ?? 50,
          totalBookings: 0,
          totalRevenue: 0,
          currency: 'CZK'
        };
      }
      summary[pid].totalBookings += 1;
      summary[pid].totalRevenue += b.price || 0;
    });

    res.json(Object.values(summary));
  } catch (error) {
    console.error('[Payout] Summary error:', error);
    res.status(500).json({ message: 'Failed to fetch payout summary' });
  }
};

// GET /api/payouts/export?format=csv&startDate=xxx&endDate=xxx
exports.exportPayouts = async (req, res) => {
  try {
    const { agencyId, role } = req.user;
    if (!isManagerRole(role)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { startDate, endDate } = req.query;
    
    const where = {
      agencyId
    };

    if (startDate && endDate) {
      where.startTime = {
        gte: new Date(startDate),
        lte: new Date(endDate)
      };
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        profile: {
          select: { name: true }
        }
      },
      orderBy: { startTime: 'asc' }
    });

    // Generate CSV
    let csv = 'Datum;Modelka;Zakaznik;Castka;Mena;Typ\n';
    bookings.forEach(b => {
      const date = new Date(b.startTime).toLocaleDateString('cs-CZ');
      csv += `${date};${b.profile?.name || 'N/A'};${b.clientPhone || 'N/A'};${b.price};CZK;${b.locationType}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=payouts_${startDate || 'export'}.csv`);
    res.status(200).send(csv);

  } catch (error) {
    console.error('[Payout] Export error:', error);
    res.status(500).json({ message: 'Failed to export payouts' });
  }
};
