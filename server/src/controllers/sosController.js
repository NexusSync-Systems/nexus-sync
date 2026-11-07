const prisma = require('../services/db');
const logger = require('../services/logger');
const { getIO } = require('../services/socket');
const { sendAlert } = require('../services/alertService');
const { sendSafetyPush } = require('../services/pushService');

/**
 * SOS Controller — Emergency alerts, check-in timers, fake calls
 * Extends the existing safety infrastructure (safetyService escalation, socket rooms)
 */
class SOSController {

    /** Trigger SOS alert (from mobile) */
    async triggerSOS(req, res) {
        try {
            const { type = 'manual', lat, lng, accuracy, profileId } = req.body;
            const { userId, agencyId } = req.user;
            const isAppOwner = req.user.role?.isAppOwner;

            // `profileId` chodí z requestu, takže se musí ověřit proti agentuře
            // volajícího — jinak šlo jméno cizího profilu protlačit do poplachu
            // i do Telegramu. Jako `safetyController.createSession`, který to
            // dělá od začátku.
            //
            // Cizí profil poplach NEZRUŠÍ, jen se zahodí. Tohle je tlačítko
            // paniky: odmítnout celé volání kvůli špatné položce by znamenalo,
            // že se poplach nespustí vůbec. Jméno pak vyjde z účtu volajícího.
            let profile = null;
            if (profileId) {
                const kandidat = await prisma.profile.findUnique({
                    where: { id: String(profileId) },
                    select: { id: true, name: true, agencyId: true }
                });
                if (kandidat && (isAppOwner || kandidat.agencyId === agencyId)) {
                    profile = kandidat;
                } else {
                    logger.warn(`SOS: ignoring profileId ${profileId} — not in agency ${agencyId}`);
                }
            }

            const alert = await prisma.sOSAlert.create({
                data: {
                    agencyId,
                    profileId: profile?.id || null,
                    userId,
                    type,
                    lat: lat || null,
                    lng: lng || null,
                    accuracy: accuracy || null
                }
            });

            // Get user info for notification
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { name: true }
            });

            const displayName = profile?.name || user?.name || 'Unknown';

            // Broadcast to agency operators/managers
            try {
                const io = getIO();
                io.to(`agency_${agencyId}`).emit('sos_triggered', {
                    alertId: alert.id,
                    type,
                    userName: displayName,
                    userId,
                    lat, lng,
                    timestamp: alert.createdAt
                });
            } catch (e) { /* socket not available */ }

            // Telegram notification
            const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { name: true } });
            await sendAlert(
                `🆘 SOS ALERT!\nUser: ${displayName}\nAgency: ${agency?.name}\nType: ${type.toUpperCase()}\nLocation: ${lat ? `${lat}, ${lng}` : 'N/A'}`,
                'error'
            );

            // FCM push
            await sendSafetyPush({
                agencyId,
                sessionId: alert.id,
                profileId: profile?.id || userId,
                profileName: displayName,
                type: `sos_${type}`
            });

            logger.warn(`SOS triggered: ${alert.id} by ${displayName} (${type})`);
            res.status(201).json(alert);
        } catch (error) {
            logger.error('SOS trigger error:', error);
            res.status(500).json({ message: 'Failed to trigger SOS' });
        }
    }

    /** Acknowledge SOS (operator/manager) */
    async acknowledgeSOS(req, res) {
        try {
            const { id } = req.params;
            const { userId, agencyId } = req.user;
            const isAppOwner = req.user.role?.isAppOwner;

            const alert = await prisma.sOSAlert.findUnique({ where: { id } });
            if (!alert) return res.status(404).json({ message: 'SOS alert not found' });
            if (!isAppOwner && alert.agencyId !== agencyId) {
                return res.status(403).json({ message: 'Access denied' });
            }

            const updated = await prisma.sOSAlert.update({
                where: { id },
                data: {
                    status: 'acknowledged',
                    acknowledgedBy: userId,
                    acknowledgedAt: new Date()
                }
            });

            try {
                const io = getIO();
                io.to(`agency_${alert.agencyId}`).emit('sos_acknowledged', {
                    alertId: id,
                    acknowledgedBy: userId
                });
            } catch (e) { /* socket not available */ }

            res.json(updated);
        } catch (error) {
            logger.error('SOS acknowledge error:', error);
            res.status(500).json({ message: 'Failed to acknowledge SOS' });
        }
    }

    /** Resolve SOS */
    async resolveSOS(req, res) {
        try {
            const { id } = req.params;
            const { userId, agencyId } = req.user;
            const isAppOwner = req.user.role?.isAppOwner;

            const alert = await prisma.sOSAlert.findUnique({ where: { id } });
            if (!alert) return res.status(404).json({ message: 'SOS alert not found' });
            if (!isAppOwner && alert.agencyId !== agencyId) {
                return res.status(403).json({ message: 'Access denied' });
            }

            const updated = await prisma.sOSAlert.update({
                where: { id },
                data: {
                    status: 'resolved',
                    resolvedBy: userId,
                    resolvedAt: new Date()
                }
            });

            try {
                const io = getIO();
                io.to(`agency_${alert.agencyId}`).emit('sos_resolved', { alertId: id });
            } catch (e) { /* socket not available */ }

            res.json(updated);
        } catch (error) {
            logger.error('SOS resolve error:', error);
            res.status(500).json({ message: 'Failed to resolve SOS' });
        }
    }

    /** Get active SOS alerts for agency */
    async getActive(req, res) {
        try {
            const { agencyId } = req.user;
            const isAppOwner = req.user.role?.isAppOwner;

            const alerts = await prisma.sOSAlert.findMany({
                where: {
                    ...(isAppOwner ? {} : { agencyId }),
                    status: { in: ['active', 'acknowledged'] }
                },
                include: {
                    locationUpdates: { orderBy: { capturedAt: 'desc' }, take: 1 }
                },
                orderBy: { createdAt: 'desc' }
            });

            res.json(alerts);
        } catch (error) {
            logger.error('SOS active list error:', error);
            res.status(500).json({ message: 'Failed to load active SOS alerts' });
        }
    }

    /** Update SOS location (from mobile during active SOS) */
    async updateLocation(req, res) {
        try {
            const { id } = req.params;
            const { lat, lng, accuracy, capturedAt } = req.body;
            const { agencyId } = req.user;

            const alert = await prisma.sOSAlert.findUnique({ where: { id } });
            if (!alert) return res.status(404).json({ message: 'SOS alert not found' });
            if (alert.agencyId !== agencyId && !req.user.role?.isAppOwner) {
                return res.status(403).json({ message: 'Access denied' });
            }

            const point = await prisma.sOSLocationUpdate.create({
                data: {
                    sosAlertId: id,
                    lat, lng,
                    accuracy: accuracy || null,
                    capturedAt: capturedAt ? new Date(capturedAt) : new Date()
                }
            });

            // Also update main SOS alert coordinates
            await prisma.sOSAlert.update({
                where: { id },
                data: { lat, lng, accuracy }
            });

            // Broadcast location update
            try {
                const io = getIO();
                io.to(`agency_${alert.agencyId}`).emit('sos_location_update', {
                    alertId: id, lat, lng, accuracy
                });
            } catch (e) { /* socket not available */ }

            res.status(201).json(point);
        } catch (error) {
            logger.error('SOS location update error:', error);
            res.status(500).json({ message: 'Failed to update SOS location' });
        }
    }

    /** Request fake call to relay device (operator → model's phone) */
    async requestFakeCall(req, res) {
        try {
            const { targetUserId, delay = 0 } = req.body;
            const { agencyId } = req.user;

            if (!targetUserId) {
                return res.status(400).json({ message: 'Target user ID is required' });
            }

            // Verify target is in same agency
            const target = await prisma.user.findUnique({
                where: { id: targetUserId },
                select: { agencyId: true, name: true }
            });
            if (!target) return res.status(404).json({ message: 'Target user not found' });
            if (!req.user.role?.isAppOwner && target.agencyId !== agencyId) {
                return res.status(403).json({ message: 'Access denied' });
            }

            // Find active device binding for target
            const binding = await prisma.deviceBinding.findFirst({
                where: { userId: targetUserId, active: true },
                select: { installationId: true }
            });

            if (!binding) {
                return res.status(404).json({ message: 'No active relay device for this user' });
            }

            // Send fake call request via socket
            try {
                const io = getIO();
                io.to(`agency_${target.agencyId}`).emit('fake_call_request', {
                    targetInstallationId: binding.installationId,
                    targetUserId,
                    delay: Number(delay)
                });
            } catch (e) {
                return res.status(500).json({ message: 'Failed to send fake call signal' });
            }

            logger.info(`Fake call requested for user ${targetUserId} (delay: ${delay}s)`);
            res.json({ ok: true, targetUserId, delay });
        } catch (error) {
            logger.error('Fake call request error:', error);
            res.status(500).json({ message: 'Failed to request fake call' });
        }
    }

    /** SOS history for agency */
    async history(req, res) {
        try {
            const { agencyId } = req.user;
            const isAppOwner = req.user.role?.isAppOwner;
            const { page = 1, limit = 20 } = req.query;
            const skip = (Number(page) - 1) * Number(limit);

            const [alerts, total] = await Promise.all([
                prisma.sOSAlert.findMany({
                    where: isAppOwner ? {} : { agencyId },
                    orderBy: { createdAt: 'desc' },
                    skip,
                    take: Number(limit)
                }),
                prisma.sOSAlert.count({ where: isAppOwner ? {} : { agencyId } })
            ]);

            res.json({ alerts, total, page: Number(page) });
        } catch (error) {
            logger.error('SOS history error:', error);
            res.status(500).json({ message: 'Failed to load SOS history' });
        }
    }
}

module.exports = new SOSController();
