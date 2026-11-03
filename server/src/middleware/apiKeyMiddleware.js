const prisma = require('../services/db');
const bcrypt = require('bcryptjs');
const logger = require('../services/logger');
const { API_ACCESS_DENIED_MESSAGE, agencyHasApiAccess } = require('../utils/apiEntitlement');

/**
 * Middleware to authenticate requests using an X-API-KEY header.
 * Key format: nx_live_KEYID.SECRET
 */
const apiKeyAuth = async (req, res, next) => {
  const apiKeyHeader = req.headers['x-api-key'];

  if (!apiKeyHeader) {
    return res.status(401).json({ message: 'Missing X-API-KEY header' });
  }

  try {
    const [keyId, secret] = apiKeyHeader.split('.');
    
    if (!keyId || !secret) {
      return res.status(401).json({ message: 'Invalid API key format. Expected nx_live_ID.SECRET' });
    }

    // 1. Find the key in DB
    const apiKeyRecord = await prisma.apiKey.findUnique({
      where: { keyId },
      include: { agency: true }
    });

    if (!apiKeyRecord) {
      logger.warn(`[API Auth] Key ID not found: ${keyId}`);
      return res.status(401).json({ message: 'Invalid API key' });
    }

    // 2. Verify secret part (bcrypt hash)
    const isMatch = await bcrypt.compare(secret, apiKeyRecord.keyHash);
    if (!isMatch) {
      logger.warn(`[API Auth] Invalid secret for key ID: ${keyId}`);
      return res.status(401).json({ message: 'Invalid API key' });
    }

    // 3. Check expiration
    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      return res.status(403).json({ message: 'API key has expired' });
    }

    // 4. Check Agency Plan OR Feature Add-on
    // Tataz kontrola jako v apiKeyController pri vydani klice — oba volaji
    // jednu funkci, aby se vydani a overeni nemohly rozejit.
    const currentPlan = apiKeyRecord.agency.plan || apiKeyRecord.agency.tier;
    const hasAccess = agencyHasApiAccess(
      apiKeyRecord.agency,
      (e) => logger.error('[API Auth] Failed to parse extraFeatures JSON:', e)
    );

    if (!hasAccess) {
      logger.warn(`[API Auth] Agency ${apiKeyRecord.agencyId} denied access (Plan: ${currentPlan}, No Add-on)`);
      return res.status(403).json({ message: API_ACCESS_DENIED_MESSAGE });
    }

    // 5. Update lastUsedAt (async, don't block request)
    prisma.apiKey.update({
      where: { id: apiKeyRecord.id },
      data: { lastUsedAt: new Date() }
    }).catch(err => logger.error('[API Auth] Failed to update lastUsedAt:', err));

    // 6. Attach context to request
    req.agency = apiKeyRecord.agency;
    req.apiKeyScopes = apiKeyRecord.scopes.split(',').map(s => s.trim());
    
    next();
  } catch (error) {
    logger.error('[API Auth] Middleware Error:', error);
    res.status(500).json({ message: 'Internal server error during API authentication' });
  }
};

/**
 * Middleware to check if the current API key has a specific scope.
 */
const requireScope = (scope) => {
  return (req, res, next) => {
    if (!req.apiKeyScopes || !req.apiKeyScopes.includes(scope)) {
      return res.status(403).json({ 
        message: `Insufficient permissions. This API key requires the following scope: ${scope}` 
      });
    }
    next();
  };
};

module.exports = { apiKeyAuth, requireScope };
