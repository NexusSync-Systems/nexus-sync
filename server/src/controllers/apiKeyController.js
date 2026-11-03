const prisma = require('../services/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const logger = require('../services/logger');
const { isEffectiveAdmin } = require('./roleController');

const { API_ACCESS_DENIED_MESSAGE, agencyHasApiAccess } = require('../utils/apiEntitlement');

const ALLOWED_API_KEY_SCOPES = new Set(['read:stats', 'read:profiles', 'read:messages', 'relay:bridge']);

const normalizeApiKeyScopes = (input) => {
  const rawScopes = Array.isArray(input)
    ? input
    : String(input || 'read:stats').split(',');
  const scopes = [...new Set(rawScopes.map(scope => String(scope).trim()).filter(Boolean))];
  const invalidScopes = scopes.filter(scope => !ALLOWED_API_KEY_SCOPES.has(scope));

  return {
    scopes: scopes.length ? scopes : ['read:stats'],
    invalidScopes,
    value: scopes.length ? scopes.join(',') : 'read:stats'
  };
};

const normalizeKeyName = (name) => {
  if (name === undefined || name === null || name === '') return 'Default Key';
  if (typeof name !== 'string') return null;
  return name.trim().slice(0, 120) || 'Default Key';
};

const requireAgencyScope = (res, agencyId) => {
  if (agencyId) return true;
  res.status(403).json({
    code: 'agency_required',
    message: 'API key management requires an agency-scoped user.'
  });
  return false;
};

/**
 * Generate a new API key for the agency.
 * Returns the plain text key (only shown once).
 */
exports.createKey = async (req, res) => {
  try {
    const { agencyId, role } = req.user;
    const { name, scopes } = req.body;

    if (!requireAgencyScope(res, agencyId)) return;

    // 1. Check permissions (Must be an effective admin)
    const isAdmin = await isEffectiveAdmin(role, agencyId);
    if (!isAdmin) {
      return res.status(403).json({ message: 'Only agency administrators can manage API keys' });
    }

    const normalizedName = normalizeKeyName(name);
    if (!normalizedName) {
      return res.status(400).json({ message: 'API key name must be a string' });
    }

    const normalizedScopes = normalizeApiKeyScopes(scopes);
    if (normalizedScopes.invalidScopes.length) {
      return res.status(400).json({
        code: 'invalid_api_key_scopes',
        message: 'API key contains unsupported scopes',
        invalidScopes: normalizedScopes.invalidScopes,
        allowedScopes: [...ALLOWED_API_KEY_SCOPES]
      });
    }

    // 2. Validate Agency Plan
    const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) {
      return res.status(404).json({ message: 'Agency not found' });
    }
    // Tataz kontrola jako v apiKeyMiddleware — vydani a overeni se nesmi
    // rozejit, jinak se klic vyda a hned dostava 403 od vsech endpointu.
    if (!agencyHasApiAccess(agency, (e) => logger.error('[API Keys] Failed to parse extraFeatures JSON:', e))) {
      return res.status(403).json({ message: API_ACCESS_DENIED_MESSAGE });
    }

    // 3. Generate Key Parts
    const keyId = `nx_live_${crypto.randomBytes(6).toString('hex')}`;
    const secretPart = crypto.randomBytes(32).toString('base64').replace(/[/+=]/g, ''); // Clean alphanumeric-ish secret
    const fullKey = `${keyId}.${secretPart}`;
    
    // 4. Hash Secret and Save
    const keyHash = await bcrypt.hash(secretPart, 10);
    
    await prisma.apiKey.create({
      data: {
        keyId,
        keyHash,
        name: normalizedName,
        scopes: normalizedScopes.value,
        agencyId
      }
    });

    logger.info(`[API Controller] New API key generated for Agency ${agencyId} by User ${req.user.userId}`);

    res.status(201).json({
      message: 'API key generated successfully. Please save it now, it will never be shown again.',
      apiKey: fullKey,
      name: normalizedName,
      scopes: normalizedScopes.scopes
    });
  } catch (error) {
    logger.error('[API Controller] createKey ERROR:', error);
    res.status(500).json({ message: 'Failed to generate API key' });
  }
};

/**
 * List all active API keys for the agency.
 */
exports.listKeys = async (req, res) => {
  try {
    const { agencyId, role } = req.user;

    if (!requireAgencyScope(res, agencyId)) return;
    
    const isAdmin = await isEffectiveAdmin(role, agencyId);
    if (!isAdmin) return res.status(403).json({ message: 'Forbidden' });

    const keys = await prisma.apiKey.findMany({
      where: { agencyId },
      select: {
        id: true,
        keyId: true,
        name: true,
        scopes: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(keys);
  } catch (error) {
    logger.error('[API Controller] listKeys ERROR:', error);
    res.status(500).json({ message: 'Failed to fetch API keys' });
  }
};

/**
 * Revoke (delete) an API key.
 */
exports.revokeKey = async (req, res) => {
  try {
    const { id } = req.params;
    const { agencyId, role } = req.user;

    if (!requireAgencyScope(res, agencyId)) return;

    const isAdmin = await isEffectiveAdmin(role, agencyId);
    if (!isAdmin) return res.status(403).json({ message: 'Forbidden' });

    // Ensure the key belongs to the user's agency
    const key = await prisma.apiKey.findFirst({
      where: { id, agencyId }
    });

    if (!key) {
      return res.status(404).json({ message: 'API key not found or already revoked' });
    }

    await prisma.apiKey.delete({ where: { id } });
    
    logger.info(`[API Controller] API key ${id} revoked by User ${req.user.userId}`);
    res.json({ message: 'API key successfully revoked' });
  } catch (error) {
    logger.error('[API Controller] revokeKey ERROR:', error);
    res.status(500).json({ message: 'Failed to revoke API key' });
  }
};
