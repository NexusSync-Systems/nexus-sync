const { isManagerRole } = require('../utils/authz');
const prisma = require('../services/db');
const logger = require('../services/logger');
// logAction se requiruje lazy uvnitř handlerů — auditController ↔ roleController
// mají cyklus a top-level destrukturující require by zachytil undefined:
// auditController se načítá první (přes authController) a v okamžiku, kdy odsud
// requirujeme zpět, exports.logAction ještě neexistuje. Zápis do auditu by pak
// tiše zmizel a handler by spadl do catch až PO úspěšném zápisu role.

/**
 * Role Controller - Handles dynamic permissions and add-ons
 */

/**
 * Helper used by agencyController & auditController.
 * Returns true if the user effectively has Agency Admin privileges:
 *   - role name is 'Agency Admin', OR
 *   - role name is 'Manager' AND the agency-specific role has merged_with_admin: true
 * Does a single DB lookup, only called on the 3 sensitive operations.
 */
exports.isEffectiveAdmin = async (userRole, userAgencyId) => {
    if (userRole?.isAppOwner) return true;
    if (userRole?.name === 'Agency Admin') return true;
    if (userRole?.name === 'Manager' && userAgencyId) {
        try {
            const role = await prisma.role.findFirst({
                where: { name: 'Manager', agencyId: userAgencyId }
            });
            if (!role) return false;
            const perms = typeof role.permissions === 'string'
                ? JSON.parse(role.permissions)
                : (role.permissions || {});
            return perms.merged_with_admin === true;
        } catch { return false; }
    }
    return false;
};

exports.getRoles = async (req, res) => {
    try {
        const { agencyId } = req.query;
        const { role: userRole, agencyId: userAgencyId } = req.user;

        if (!isManagerRole(userRole)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Build where clause
        let where;
        if (!userRole?.isAppOwner) {
            if (!userAgencyId) return res.status(403).json({ message: 'No agency' });
            where = { agencyId: String(userAgencyId) };
        } else if (agencyId) {
            where = { agencyId: String(agencyId) };
        } else {
            // Global view: fetch agencyId null AND empty string to catch all global-scoped roles
            where = { OR: [{ agencyId: null }, { agencyId: '' }] };
        }

        const raw = await prisma.role.findMany({ where, orderBy: { createdAt: 'asc' } });

        // Deduplicate by name (case-insensitive) — first occurrence wins
        const seen = new Set();
        const roles = raw.filter(r => {
            if (!r?.name) return false;
            const key = r.name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Parse permissions
        const parsedRoles = roles.map(r => {
            let perms = {};
            try {
                if (typeof r.permissions === 'string') {
                    perms = JSON.parse(r.permissions);
                } else if (r.permissions && typeof r.permissions === 'object') {
                    perms = r.permissions;
                }
            } catch (_e) {
                perms = {};
            }
            return { ...r, permissions: perms };
        });

        res.json(parsedRoles);
    } catch (error) {
        logger.error('Error fetching roles:', error);
        res.status(500).json({ message: 'Failed to fetch roles' });
    }
};

exports.updateRolePermissions = async (req, res) => {
    try {
        const { id } = req.params;
        const { permissions } = req.body;
        const { role: userRole } = req.user;

        if (!isManagerRole(userRole)) {
            return res.status(403).json({ message: 'Not authorized to modify roles' });
        }

        const existingRole = await prisma.role.findUnique({ where: { id } });
        if (!existingRole) {
            return res.status(404).json({ message: 'Role not found' });
        }

        if (!userRole.isAppOwner) {
            // Agency managers can only modify roles belonging to their agency, and never global templates
            if (!existingRole.agencyId || existingRole.agencyId !== req.user.agencyId) {
                return res.status(403).json({ message: 'Can only modify roles for your own agency' });
            }
            // Prevent privilege escalation: only the app owner may grant admin-merge
            // (promotes a role to effective Agency Admin). Mirrors the App-Owner-only
            // toggleAdminMerge endpoint.
            let permCheck = permissions;
            if (typeof permCheck === 'string') { try { permCheck = JSON.parse(permCheck); } catch { permCheck = {}; } }
            if (permCheck && permCheck.merged_with_admin) {
                return res.status(403).json({ message: 'Only the app owner can grant admin-merged permissions' });
            }
        }

        const serializedPerms = typeof permissions === 'object' ? JSON.stringify(permissions) : permissions;

        const role = await prisma.role.update({
            where: { id },
            data: { permissions: serializedPerms }
        });

        // Cascade global template updates down to all agencies using this role
        if (!existingRole.agencyId) {
            await prisma.role.updateMany({
                where: { name: existingRole.name, agencyId: { not: null } },
                data: { permissions: serializedPerms }
            });
            logger.info(`Global role template "${existingRole.name}" edited. Changes cascaded to all agencies.`);
        }

        logger.info(`Role ${id} permissions updated by ${req.user.userId}`);
        const { logAction } = require('./auditController');
        logAction(req.user.agencyId, req.user.userId || req.user.id, 'ROLE_UPDATED', `Role "${existingRole.name}" permissions changed`);
        res.json(role);
    } catch (error) {
        logger.error('Error updating role permissions:', error);
        res.status(500).json({ message: 'Failed to update role' });
    }
};

exports.purchaseAddon = async (req, res) => {
    try {
        const { agencyId, featureKey } = req.body;
        const { role: userRole } = req.user;

        // In a real app, verify payment here
        if (!userRole.isAppOwner) return res.status(403).json({ message: 'Mock purchase only for admins' });

        const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
        if (!agency) return res.status(404).json({ message: 'Agency not found' });

        let extras = [];
        try {
            extras = JSON.parse(agency.extraFeatures || '[]');
        } catch (e) { extras = []; }

        if (!extras.includes(featureKey)) {
            extras.push(featureKey);
        }

        await prisma.agency.update({
            where: { id: agencyId },
            data: { extraFeatures: JSON.stringify(extras) }
        });

        res.json({ success: true, extraFeatures: extras });
    } catch (error) {
        logger.error('Error purchasing addon:', error);
        res.status(500).json({ message: 'Failed to purchase addon' });
    }
};

/**
 * Toggle merged_with_admin flag on an agency-specific Manager role.
 * App Owner only. Allows smaller agencies to merge Manager + Agency Admin privileges.
 */
exports.toggleAdminMerge = async (req, res) => {
    try {
        const { id } = req.params;
        const { role: userRole } = req.user;

        if (!userRole?.isAppOwner) {
            return res.status(403).json({ message: 'Only App Owner can merge roles' });
        }

        const existing = await prisma.role.findUnique({ where: { id } });
        if (!existing) return res.status(404).json({ message: 'Role not found' });
        if (existing.name !== 'Manager') {
            return res.status(400).json({ message: 'Only Manager role can be merged with Agency Admin' });
        }
        if (!existing.agencyId) {
            return res.status(400).json({ message: 'Cannot merge global role templates' });
        }

        let perms = {};
        try {
            perms = typeof existing.permissions === 'string'
                ? JSON.parse(existing.permissions)
                : (existing.permissions || {});
        } catch { perms = {}; }

        const wasMerged = perms.merged_with_admin === true;
        const newMerged = !wasMerged;

        if (newMerged) {
            perms = { ...perms, merged_with_admin: true, settings: true, audit_logs: true, can_add_users: true, plans: true };
        } else {
            const { merged_with_admin, can_add_users, ...rest } = perms;
            perms = { ...rest, settings: false, audit_logs: false, plans: false };
        }

        await prisma.role.update({ where: { id }, data: { permissions: JSON.stringify(perms) } });

        logger.info(`Manager role (${id}) admin-merge → ${newMerged}`);
        const { logAction } = require('./auditController');
        logAction(existing.agencyId, req.user.userId, 'ROLE_MERGE_TOGGLED',
            `Manager role merged_with_admin set to ${newMerged}`);

        res.json({ success: true, merged: newMerged, permissions: perms });
    } catch (error) {
        logger.error('Error toggling admin merge:', error);
        res.status(500).json({ message: 'Failed to toggle role merge' });
    }
};
