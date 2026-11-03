const prisma = require('../services/db');
const logger = require('../services/logger');
const { getIO } = require('../services/socket');
const { getPhoneLookupValues, normalizePhoneNumber } = require('../utils/phoneNumber');
const { isAppOwnerRole } = require('../utils/authz');
const { jePlatny: jePlatnyDuvod } = require('../config/blacklistReasons');

const normalizeBlacklistPhone = (phone) => {
    if (phone === undefined) return undefined;
    if (phone === null || `${phone}`.trim() === '') return null;
    return normalizePhoneNumber(phone);
};

const phoneSearchValues = (phone) => {
    const values = getPhoneLookupValues(phone);
    return values.length ? values : [normalizePhoneNumber(phone)];
};

// Sdílený blacklist odhaluje varování napříč agenturami, ale identitu hlásící
// agentury/osoby cizím agenturám neodhalujeme — u cizích reportů vynulujeme
// agencyId/reportedByName/reportedById, obsah (reason/createdAt) zůstává.
// App Owner a vlastní agentura vidí vše. Aplikuj VŠUDE, kde se vrací entry s reports.
function redactReports(reports, req) {
    const callerAgencyId = req.user?.agencyId || null;
    const isOwner = isAppOwnerRole(req.user?.role);
    return (reports || []).map((r) =>
        (isOwner || (callerAgencyId && r.agencyId === callerAgencyId))
            ? r
            : { ...r, agencyId: null, reportedByName: null, reportedById: null }
    );
}

/**
 * Blacklist Controller — Shared cross-agency dangerous client database
 */
class BlacklistController {

    /** List all blacklist entries with search & pagination */
    async list(req, res) {
        try {
            const { search, severity, page = 1, limit = 50 } = req.query;
            const skip = (Number(page) - 1) * Number(limit);

            const where = {};
            if (severity) where.severity = severity;
            if (search) {
                const phoneValues = phoneSearchValues(search);
                where.OR = [
                    { phone: { in: phoneValues } },
                    { phone: { contains: search } },
                    { licensePlate: { contains: search } },
                    { name: { contains: search } },
                    { reason: { contains: search } }
                ];
            }

            const [entries, total] = await Promise.all([
                prisma.blacklistEntry.findMany({
                    where,
                    include: { reports: { select: { agencyId: true, reportedByName: true, reason: true, createdAt: true } } },
                    orderBy: { createdAt: 'desc' },
                    skip,
                    take: Number(limit)
                }),
                prisma.blacklistEntry.count({ where })
            ]);

            const sanitized = entries.map((e) => ({ ...e, reports: redactReports(e.reports, req) }));
            res.json({ entries: sanitized, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
        } catch (error) {
            logger.error('Blacklist list error:', error);
            res.status(500).json({ message: 'Failed to load blacklist' });
        }
    }

    /** Create a new blacklist entry */
    async create(req, res) {
        try {
            const { phone, licensePlate, name, reason, severity = 'warning' } = req.body;
            const { userId, agencyId } = req.user;

            // Kategorii validuje už schema (z.enum), tohle je pojistka pro případ,
            // že by se ruta někdy zavolala mimo validate().
            if (!jePlatnyDuvod(reason)) {
                return res.status(400).json({ message: 'Valid reason is required' });
            }
            if (!phone && !licensePlate && !name) {
                return res.status(400).json({ message: 'At least one identifier (phone, license plate, or name) is required' });
            }

            const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
            const normalizedPhone = normalizeBlacklistPhone(phone);

            const entry = await prisma.blacklistEntry.create({
                data: {
                    phone: normalizedPhone,
                    licensePlate: licensePlate ? licensePlate.toUpperCase() : null,
                    name: name || null,
                    reason,
                    severity,
                    createdById: userId,
                    createdByName: user?.name || 'Unknown',
                    agencyId
                },
                include: { reports: true }
            });

            // Broadcast to all connected users
            try {
                const io = getIO();
                io.emit('blacklist_new', {
                    id: entry.id,
                    phone: entry.phone,
                    licensePlate: entry.licensePlate,
                    name: entry.name,
                    severity: entry.severity,
                    createdByName: entry.createdByName
                });
            } catch (e) { /* socket not available */ }

            logger.info(`Blacklist entry created: ${entry.id} by user ${userId}`);
            res.status(201).json({ ...entry, reports: redactReports(entry.reports, req) });
        } catch (error) {
            logger.error('Blacklist create error:', error);
            res.status(500).json({ message: 'Failed to create blacklist entry' });
        }
    }

    /** Update own blacklist entry */
    async update(req, res) {
        try {
            const { id } = req.params;
            const { userId } = req.user;
            const { phone, licensePlate, name, reason, severity } = req.body;

            const existing = await prisma.blacklistEntry.findUnique({ where: { id } });
            if (!existing) return res.status(404).json({ message: 'Entry not found' });

            const isAppOwner = req.user.role?.isAppOwner;
            if (!isAppOwner && existing.createdById !== userId) {
                return res.status(403).json({ message: 'You can only edit your own entries' });
            }

            const entry = await prisma.blacklistEntry.update({
                where: { id },
                data: {
                    ...(phone !== undefined && { phone: normalizeBlacklistPhone(phone) }),
                    ...(licensePlate !== undefined && { licensePlate: licensePlate ? licensePlate.toUpperCase() : null }),
                    ...(name !== undefined && { name: name || null }),
                    ...(reason !== undefined && { reason }),
                    ...(severity !== undefined && { severity })
                },
                include: { reports: true }
            });

            res.json({ ...entry, reports: redactReports(entry.reports, req) });
        } catch (error) {
            logger.error('Blacklist update error:', error);
            res.status(500).json({ message: 'Failed to update entry' });
        }
    }

    /** Delete own blacklist entry (or admin) */
    async delete(req, res) {
        try {
            const { id } = req.params;
            const { userId } = req.user;

            const existing = await prisma.blacklistEntry.findUnique({ where: { id } });
            if (!existing) return res.status(404).json({ message: 'Entry not found' });

            const isAppOwner = req.user.role?.isAppOwner;
            if (!isAppOwner && existing.createdById !== userId) {
                return res.status(403).json({ message: 'You can only delete your own entries' });
            }

            await prisma.blacklistEntry.delete({ where: { id } });
            res.json({ ok: true });
        } catch (error) {
            logger.error('Blacklist delete error:', error);
            res.status(500).json({ message: 'Failed to delete entry' });
        }
    }

    /** Report/confirm an existing entry from another agency */
    async report(req, res) {
        try {
            const { id } = req.params;
            const { reason } = req.body;
            const { userId, agencyId } = req.user;

            const entry = await prisma.blacklistEntry.findUnique({ where: { id } });
            if (!entry) return res.status(404).json({ message: 'Entry not found' });

            const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });

            const report = await prisma.blacklistReport.upsert({
                where: { entryId_agencyId: { entryId: id, agencyId } },
                create: {
                    entryId: id,
                    reportedById: userId,
                    reportedByName: user?.name || 'Unknown',
                    agencyId,
                    reason: reason || null
                },
                update: {
                    reportedById: userId,
                    reportedByName: user?.name || 'Unknown',
                    reason: reason || null
                }
            });

            res.json(report);
        } catch (error) {
            logger.error('Blacklist report error:', error);
            res.status(500).json({ message: 'Failed to report entry' });
        }
    }

    /** Quick check: is this phone number blacklisted? */
    async check(req, res) {
        try {
            const { phone } = req.query;
            if (!phone) return res.status(400).json({ message: 'Phone number is required' });
            const phoneValues = phoneSearchValues(phone);

            const entry = await prisma.blacklistEntry.findFirst({
                where: { phone: { in: phoneValues } },
                include: { reports: { select: { agencyId: true } } }
            });

            if (!entry) return res.json({ blacklisted: false });

            res.json({
                blacklisted: true,
                severity: entry.severity,
                name: entry.name,
                reason: entry.reason,
                reportCount: entry.reports.length + 1
            });
        } catch (error) {
            logger.error('Blacklist check error:', error);
            res.status(500).json({ message: 'Failed to check blacklist' });
        }
    }
}

module.exports = new BlacklistController();
