const prisma = require('../services/db');
const jwt = require('jsonwebtoken');
const { registerPushToken, sendChatPush, sendCallPush, sendSelfTestPush } = require('../services/pushService');
const { getIO } = require('../services/socket');
const logger = require('../services/logger');
const { secureCompare, deriveRelaySecret } = require('../utils/security');
const { getPhoneLookupValues, normalizePhoneNumber } = require('../utils/phoneNumber');
const { isAppOwnerRole, isManagerRole } = require('../utils/authz');

const RELAY_SMS_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

const isLegacyDeviceEndpointEnabled = () =>
  process.env.ALLOW_LEGACY_DEVICE_ENDPOINTS === 'true' || process.env.NODE_ENV === 'test';

const rejectDisabledLegacyEndpoint = (res) =>
  res.status(410).json({ ok: false, message: 'Legacy device endpoint disabled. Use /api/device/relay.' });

const decodeBearerToken = (req) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;

  try {
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) return null;
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};

const isRelayBearerAuthorized = (decoded, binding) => {
  if (!decoded || !binding) return false;
  const tokenUserId = String(decoded.userId || decoded.id || decoded.sub || '');
  const tokenAgencyId = String(decoded.agencyId || '');
  return tokenUserId === String(binding.userId) && tokenAgencyId === String(binding.agencyId);
};

const normalizeCallState = (state) => {
  const normalized = `${state || ''}`.replace(/^State:\s*/i, '').trim().toUpperCase();
  return normalized || 'RINGING';
};

const normalizeTransport = (value) => {
  const normalized = `${value || ''}`.trim().toLowerCase();
  if (normalized === 'sms' || normalized === 'rcs' || normalized === 'call') {
    return normalized;
  }
  return null;
};

const findOrCreateSmsChat = async ({ externalId, profileId, agencyId, referenceNumber }) => {
  const normalizedExternalId = normalizePhoneNumber(externalId, { referenceNumber });
  const lookupValues = getPhoneLookupValues(externalId, { referenceNumber });

  const chat = await prisma.chat.findFirst({
    where: {
      profileId,
      externalId: { in: lookupValues.length ? lookupValues : [normalizedExternalId] }
    },
    orderBy: { lastMessageAt: 'desc' }
  });

  if (chat) return chat;

  return prisma.chat.create({
    data: {
      externalId: normalizedExternalId || externalId,
      profileId,
      agencyId
    }
  });
};

const findProfileByPhoneNumber = async (phoneNumber) => {
  const directLookupValues = getPhoneLookupValues(phoneNumber);
  const directProfile = await prisma.profile.findFirst({
    where: {
      phoneNumber: {
        in: directLookupValues.length ? directLookupValues : [normalizePhoneNumber(phoneNumber)]
      }
    }
  });

  if (directProfile) return directProfile;

  const profiles = await prisma.profile.findMany({
    where: { phoneNumber: { not: null } },
    select: { id: true, name: true, phoneNumber: true, agencyId: true }
  });

  return (profiles || []).find((profile) => {
    const incomingValues = getPhoneLookupValues(phoneNumber, { referenceNumber: profile.phoneNumber });
    const profileValues = getPhoneLookupValues(profile.phoneNumber, { referenceNumber: profile.phoneNumber });
    return incomingValues.some(value => profileValues.includes(value));
  }) || null;
};

// --- AUTHENTICATED ENDPOINTS (RBAC) ---

exports.registerPushToken = async (req, res) => {
  try {
    const { token, platform } = req.body;
    const userId = String(req.user?.userId || req.user?.id || '');
    const agencyId = req.user?.agencyId;

    if (!token || !userId || userId === '') {
      return res.status(400).json({ ok: false, message: 'Invalid token or user context.' });
    }

    const result = await registerPushToken({ userId, agencyId, token, platform: platform || 'android' });
    return res.json({ ok: result.ok });
  } catch (error) {
    console.error('[Device] Register push error:', error);
    return res.status(500).json({ ok: false });
  }
};

exports.verifyDeviceBinding = async (req, res) => {
  try {
    const userId = String(req.user?.userId || req.user?.id || '');
    const userRole = req.user?.role;
    const agencyId = req.user?.agencyId;
    
    const roleName = (typeof userRole === 'string' ? userRole : userRole?.name) || '';
    const internalRole = roleName.toUpperCase();
    const { installationId, profileId, platform, model, deviceModel, deviceName } = req.body;

    // RBAC: RESTRICTED for Modelka (they shouldn't be binding new devices usually, but let's be more permissive than the current block)
    // The previous block was way too aggressive, blocking even admins.
    
    if (!agencyId || !userId || userId === '') {
      console.warn(`[Device Binding] Unauthorized attempt: userId=${userId}, agencyId=${agencyId}`);
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }
    
    if (!installationId) {
      console.warn(`[Device Binding] Missing installationId from user ${userId}`);
      return res.status(400).json({ ok: false, message: 'Missing installationId' });
    }

    const resolvedModel = model || deviceModel || null;

    console.info(`[Device Binding] Attempting: installationId=${installationId}, userId=${userId}, role=${internalRole}, model=${resolvedModel}`);

    let resolvedProfileId = null;
    if (profileId) {
      const profile = await prisma.profile.findFirst({ where: { id: String(profileId), agencyId: String(agencyId) } });
      if (!profile) return res.status(404).json({ ok: false, message: 'Profile not found' });
      resolvedProfileId = profile.id;
    }

    // Vlastnictví má přednost před přiřazením.
    //
    // Relay telefon patří MODELCE a ta se na něj hlásí svým účtem. Profil
    // se proto hledá nejdřív podle vlastnictví (`ownerId`) a teprve pak
    // podle `assignees`, tedy operátorek, které ho obsluhují.
    //
    // Bez tohohle pořadí by se modelka s vlastním účtem nespárovala vůbec
    // (není ničí assignee) a telefon by se dál musel hlásit účtem
    // operátorky — tedy podepisovat její jménem i to, co udělala modelka.
    if (!resolvedProfileId) {
      const vlastni = await prisma.profile.findFirst({
        where: { agencyId: String(agencyId), ownerId: String(userId) }
      });
      if (vlastni) resolvedProfileId = vlastni.id;
    }

    if (!resolvedProfileId) {
      const assignedProfile = await prisma.profile.findFirst({ where: { agencyId: String(agencyId), assignees: { some: { id: String(userId) } } } });
      if (assignedProfile) resolvedProfileId = assignedProfile.id;
    }

    if (!resolvedProfileId) return res.status(409).json({ ok: false, profileRequired: true });

    // Prevent cross-agency device hijack: if this installationId is already bound
    // to a different agency, only the app owner may re-bind it (and thus receive
    // its derived relay secret below).
    const currentBinding = await prisma.deviceBinding.findUnique({
      where: { installationId },
      select: { agencyId: true }
    });
    if (currentBinding && currentBinding.agencyId
        && String(currentBinding.agencyId) !== String(agencyId)
        && req.user?.role?.isAppOwner !== true) {
      return res.status(403).json({ ok: false, message: 'Device already bound to another agency' });
    }

    await prisma.deviceBinding.upsert({
      where: { installationId },
      update: { userId: String(userId), agencyId: String(agencyId), profileId: String(resolvedProfileId), platform: String(platform || 'android'), active: true, model: resolvedModel, deviceName, lastSeenAt: new Date() },
      create: { installationId, userId: String(userId), agencyId: String(agencyId), profileId: String(resolvedProfileId), platform: String(platform || 'android'), active: true, model: resolvedModel, deviceName, lastSeenAt: new Date() },
    });

    // Deactivate redundant bindings for this profile instead of deleting them
    if (resolvedProfileId) {
      await prisma.deviceBinding.updateMany({
        where: {
          profileId: String(resolvedProfileId),
          NOT: { installationId },
          active: true
        },
        data: { active: false }
      });
    }


    // AUTO-ONLINE: When a device verifies, the profile must be marked as online
    if (resolvedProfileId) {
      await prisma.profile.update({
        where: { id: String(resolvedProfileId) },
        data: { status: 'online' }
      });
      console.info(`[Device Binding] Profile ${resolvedProfileId} (Diana) is now ONLINE`);
    }

    // Per-device relay secret pro WebRTC signaling (HMAC master + installationId).
    // Ukládá se jen na klientu; master DEVICE_SECRET nikdy neopouští server.
    const deviceSecret = deriveRelaySecret(installationId);

    return res.json({ ok: true, deviceSecret });
  } catch (error) {
    console.error('[Device] Verify error:', error);
    return res.status(500).json({ ok: false });
  }
};

exports.getRelayStatus = async (req, res) => {
  try {
    const userId = String(req.user?.userId || req.user?.id || '');
    const userRole = req.user?.role;
    const { installationId } = req.query;

    const roleName = (typeof userRole === 'string' ? userRole : userRole?.name) || '';
    const internalRole = roleName.toUpperCase();

    // Previous block was incorrectly blocking admins from checking relay status.
    
    if (!installationId || !userId || userId === '') return res.status(400).json({ ok: false });

    const binding = await prisma.deviceBinding.findUnique({ where: { installationId }, select: { userId: true, active: true } });
    if (!binding) return res.status(404).json({ ok: true, registered: false });
    if (binding.userId !== userId) return res.status(403).json({ ok: false });

    return res.json({ ok: true, registered: true, active: Boolean(binding.active) });
  } catch (error) {
    return res.status(500).json({ ok: false });
  }
};

exports.getDeviceBindings = async (req, res) => {
  try {
    const userRole = req.user?.role;
    const agencyId = req.user?.agencyId;
    const userId = String(req.user?.userId || req.user?.id || '');

    const roleName = (typeof userRole === 'string' ? userRole : userRole?.name) || '';
    const internalRole = roleName.toUpperCase();

    // RBAC: App Owner, Agency Admin, Manager and Senior Operator can see all bindings in their agency.
    const isAgencyLevel = ['APP OWNER', 'AGENCY ADMIN', 'MANAGER', 'SENIOR OPERATOR'].includes(internalRole);
    
    const bindings = await prisma.deviceBinding.findMany({
      where: isAgencyLevel ? { agencyId: String(agencyId) } : { userId: String(userId) },
      include: { profile: { select: { name: true } } },
      orderBy: { lastSeenAt: 'desc' }
    });

    return res.json({ ok: true, bindings });
  } catch (error) {
    return res.status(500).json({ ok: false });
  }
};

exports.revokeDeviceBinding = async (req, res) => {
  try {
    const userId = String(req.user?.userId || req.user?.id || '');
    const userRole = req.user?.role;
    const agencyId = req.user?.agencyId;
    const { installationId } = req.body;

    const isOwner = isAppOwnerRole(userRole);
    const isAgencyLevel = isOwner || isManagerRole(userRole);

    const binding = await prisma.deviceBinding.findUnique({ where: { installationId } });
    if (!binding) return res.status(404).json({ ok: false, message: 'Binding not found' });
    
    if (isAgencyLevel && !isOwner && String(binding.agencyId) !== String(agencyId)) {
      return res.status(403).json({ ok: false, message: 'Unauthorized' });
    }

    if (!isAgencyLevel && binding.userId !== userId) {
      return res.status(403).json({ ok: false, message: 'Unauthorized' });
    }

    await prisma.deviceBinding.update({ where: { installationId }, data: { active: false } });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false });
  }
};

// Ověření, že push na tenhle účet opravdu dojde.
//
// Dřív to nešlo použít k ničemu: výsledek odeslání se zahodil a endpoint vrátil
// ok:true i tehdy, když Firebase nic neodeslal. Přesně tímhle způsobem nám
// mohl měsíce nefungovat push včetně bezpečnostních upozornění, aniž by to
// cokoli nahlásilo. Test, který vždycky hlásí úspěch, je horší než žádný.
//
// Druhá změna: posílá se jen na zařízení volajícího. sendChatPush mířil přes
// getAgencyTokens na celou agenturu, takže si člověk ověřil push tím, že
// rozbzučel telefony všem kolegům.
exports.sendTestPush = async (req, res) => {
  try {
    const { title, body } = req.body;
    const userId = String(req.user?.userId || req.user?.id || '');

    if (!title || !body) return res.status(400).json({ ok: false, message: 'title and body are required' });
    if (!userId) return res.status(401).json({ ok: false, message: 'Missing user context' });

    const result = await sendSelfTestPush({ userId, title, body });
    const delivered = (result?.sent ?? 0) > 0;

    return res.status(delivered ? 200 : 502).json({
      ok: delivered,
      sent: result?.sent ?? 0,
      failed: result?.failed ?? 0,
      // Bez tohohle se nedá poznat, jestli chybí registrované zařízení, nebo
      // jestli Firebase odmítá tokeny (jiný projekt, odhlášená aplikace…).
      details: result?.details ?? null
    });
  } catch (error) {
    logger.error('[Device] sendTestPush failed:', error);
    return res.status(500).json({ ok: false, message: 'Push test failed' });
  }
};

// --- PUBLIC WEBHOOKS (SECRET BASED) ---

exports.handleRelay = async (req, res) => {
  try {
    const { installationId, type, transport, from, content, body, text, secret, userId, timestamp } = req.body;
    const eventContent = content || body || text;
    if (!from || !eventContent) return res.status(400).json({ ok: false, message: 'Missing from or content' });
    
    const messageTransport = normalizeTransport(transport || type);
    if (!messageTransport) return res.status(400).json({ ok: false, message: 'Invalid transport' });

    // NOTE: deviceId is a device label (e.g. "RELAY-DEVICE"), NOT the DB userId.
    // Only use the explicit `userId` field for the ownership check.
    const reqUserId = String(userId || '');
    const binding = await prisma.deviceBinding.findUnique({
      where: { installationId: installationId || 'none' },
      include: { profile: { select: { id: true, name: true, agencyId: true, phoneNumber: true } } }
    });

    if (!binding) {
      console.warn(`[Relay] Device not found: installationId=${installationId}`);
      return res.status(404).json({ ok: false, message: 'Source device not found' });
    }
    if (!binding.active) {
      console.warn(`[Relay] Inactive binding: installationId=${installationId}`);
      return res.status(401).json({ message: 'Unauthorized: Device binding inactive' });
    }

    // Auth precedence (per-tenant): the production relay app uses a per-binding
    // Bearer token; the "installationId + secret" model uses a PER-DEVICE HMAC
    // secret (HMAC(DEVICE_SECRET, installationId)). The legacy GLOBAL DEVICE_SECRET
    // is only accepted when legacy endpoints are explicitly enabled — it lets any
    // secret-holder target any agency, so it stays off in production.
    const perDeviceAuthorized = secureCompare(secret, deriveRelaySecret(binding.installationId));
    const bearerAuthorized = !perDeviceAuthorized && isRelayBearerAuthorized(decodeBearerToken(req), binding);
    const legacyAuthorized = !perDeviceAuthorized && !bearerAuthorized
      && isLegacyDeviceEndpointEnabled() && secureCompare(secret, process.env.DEVICE_SECRET);
    if (!perDeviceAuthorized && !bearerAuthorized && !legacyAuthorized) {
      console.warn(`[Relay] Auth failed: installationId=${installationId}, hasSecret=${!!secret}, hasBearer=${!!req.headers.authorization}`);
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Extra ownership check: only if the request explicitly provides a userId field.
    // deviceId is intentionally excluded – it is a device label, not a user identifier.
    if (reqUserId && String(binding.userId) !== reqUserId) {
      console.warn(`[Relay] User mismatch: binding.userId=${binding.userId}, reqUserId=${reqUserId}`);
      return res.status(401).json({ message: 'Unauthorized: User ID mismatch' });
    }

    try {
      await prisma.deviceBinding.update({
        where: { installationId: binding.installationId },
        data: { lastSeenAt: new Date() }
      });
    } catch {
      // Heartbeat update must not block delivery processing.
    }

    const eventDate = timestamp ? new Date(timestamp) : new Date();
    const createdAt = Number.isNaN(eventDate.getTime()) ? new Date() : eventDate;

    if (binding && (messageTransport === 'sms' || messageTransport === 'rcs')) {
      const direction = (type === 'SMS_SENT' || type === 'OUTBOUND') ? 'OUTBOUND' : 'INBOUND';
      const chat = await findOrCreateSmsChat({
        externalId: from,
        profileId: binding.profileId,
        agencyId: binding.agencyId,
        referenceNumber: binding.profile?.phoneNumber
      });
      
      const duplicateWindowStart = new Date(createdAt.getTime() - RELAY_SMS_DUPLICATE_WINDOW_MS);
      const duplicateWindowEnd = new Date(createdAt.getTime() + RELAY_SMS_DUPLICATE_WINDOW_MS);
      const duplicateMessage = await prisma.message.findFirst({
        where: {
          chatId: chat.id,
          text: eventContent,
          transport: messageTransport,
          direction,
          createdAt: {
            gte: duplicateWindowStart,
            lte: duplicateWindowEnd
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      if (duplicateMessage) {
        return res.json({ ok: true, duplicate: true, chatId: chat.id, messageId: duplicateMessage.id });
      }

      const createdMessage = await prisma.message.create({ data: { chatId: chat.id, text: eventContent, transport: messageTransport, direction, status: 'delivered', createdAt } });
      await prisma.chat.update({ where: { id: chat.id }, data: { lastMessageAt: createdAt } });
      getIO().to(`agency_${binding.agencyId}`).emit('new_message', {
        id: createdMessage.id,
        profileId: binding.profileId,
        chatId: chat.id,
        from: chat.externalId,
        text: eventContent,
        transport: messageTransport,
        direction,
        status: createdMessage.status,
        createdAt: createdMessage.createdAt,
        timestamp: createdMessage.createdAt
      });
      
      try { await sendChatPush({ agencyId: binding.agencyId, profileId: binding.profileId, chatId: chat.id, from: chat.externalId, messagePreview: eventContent, profileName: binding.profile.name }); } catch { /* skip */ }
    } else if (binding && messageTransport === 'call') {
      const callState = normalizeCallState(eventContent);
      await prisma.callLog.create({ data: { profileId: binding.profileId, from: from || 'UNKNOWN', status: callState } });
      getIO().to(`agency_${binding.agencyId}`).emit('incoming_call', { profileId: binding.profileId, from, profileName: binding.profile.name, state: callState });
      try { await sendCallPush({ agencyId: binding.agencyId, profileId: binding.profileId, from, caller: from, profileName: binding.profile.name, callState }); } catch { /* skip */ }
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false });
  }
};

exports.handleGoIP = async (req, res) => {
  try {
    if (!isLegacyDeviceEndpointEnabled()) return res.status(410).send('LEGACY ENDPOINT DISABLED');
    const { src, dst, msg, secret } = req.body;
    if (!secureCompare(secret, process.env.DEVICE_SECRET)) return res.status(401).send('UNAUTHORIZED');
    if (!src || !dst || !msg) return res.status(400).send('BAD FIELDS');
    const profile = await findProfileByPhoneNumber(dst);
    if (!profile) return res.status(404).send('NOT FOUND');

    const chat = await findOrCreateSmsChat({
      externalId: src,
      profileId: profile.id,
      agencyId: profile.agencyId,
      referenceNumber: profile.phoneNumber
    });
    await prisma.message.create({ data: { chatId: chat.id, text: msg, transport: 'sms', direction: 'INBOUND', status: 'delivered' } });
    getIO().to(`agency_${profile.agencyId}`).emit('new_message', { id: Date.now(), chatId: chat.id, profileId: profile.id, from: chat.externalId, text: msg, transport: 'sms' });
    return res.status(200).send('RECEIVE OK');
  } catch (error) {
    return res.status(500).send('ERROR');
  }
};

exports.handleMobileSms = async (req, res) => {
  try {
    if (!isLegacyDeviceEndpointEnabled()) return rejectDisabledLegacyEndpoint(res);
    const { from, to, text, secret } = req.body;
    if (!from || !to || !text) return res.status(400).json({ ok: false, message: 'Missing fields' });
    if (!secureCompare(secret, process.env.DEVICE_SECRET)) return res.status(401).json({ message: 'Unauthorized' });
    const profile = await findProfileByPhoneNumber(to);
    if (!profile) return res.status(404).json({ message: 'Profile not found' });

    const chat = await findOrCreateSmsChat({
      externalId: from,
      profileId: profile.id,
      agencyId: profile.agencyId,
      referenceNumber: profile.phoneNumber
    });
    await prisma.message.create({ data: { chatId: chat.id, text, transport: 'sms', direction: 'INBOUND', status: 'delivered' } });
    getIO().to(`agency_${profile.agencyId}`).emit('new_message', { chatId: chat.id, profileId: profile.id, from: chat.externalId, text, transport: 'sms' });
    return res.json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ message: 'Error' });
  }
};

exports.handleMobileCall = async (req, res) => {
  try {
    if (!isLegacyDeviceEndpointEnabled()) return rejectDisabledLegacyEndpoint(res);
    const { from, to, state, secret } = req.body;
    if (!from || !to || !state) return res.status(400).json({ ok: false, message: 'Missing fields' });
    if (!secureCompare(secret, process.env.DEVICE_SECRET)) return res.status(401).json({ message: 'Unauthorized' });
    const profile = await findProfileByPhoneNumber(to);
    if (!profile) return res.status(404).json({ message: 'Profile not found' });

    const callState = normalizeCallState(state);
    await prisma.callLog.create({ data: { profileId: profile.id, from: from || 'UNKNOWN', status: callState } });
    getIO().to(`agency_${profile.agencyId}`).emit('incoming_call', { from, profileName: profile.name, profileId: profile.id, state: callState });
    return res.json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ message: 'Error' });
  }
};

exports.getLogs = async (req, res) => {
  try {
    const { installationId, limit = 50 } = req.query;
    const agencyId = req.user?.agencyId;

    if (!installationId) {
      return res.status(400).json({ ok: false, message: 'Missing installationId' });
    }

    const binding = await prisma.deviceBinding.findUnique({
      where: { installationId },
      select: { profileId: true, agencyId: true }
    });

    if (!binding || !binding.profileId) {
      return res.json({ ok: true, logs: [] });
    }

    // Security check: ensure user belongs to same agency
    if (agencyId && String(binding.agencyId) !== String(agencyId)) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }

    const [messages, calls] = await Promise.all([
      prisma.message.findMany({
        where: {
          OR: [
            { chat: { profileId: binding.profileId } }
          ],
          transport: { in: ['sms', 'rcs'] }

        },
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { 
          chat: { select: { externalId: true } },
          sender: { select: { name: true } }
        }
      }),
      prisma.callLog.findMany({
        where: { profileId: binding.profileId },
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      })
    ]);

    // Unify format
    const unifiedLogs = [
      ...messages.map(m => ({
        id: m.id,
        transport: m.transport,
        type: m.transport,
        from: m.chat.externalId,
        content: m.text,
        direction: m.direction.toLowerCase(),
        timestamp: m.createdAt,
        status: m.status
      })),
      ...calls.map(c => ({
        id: c.id,
        transport: 'call',
        type: 'call',
        from: c.from,
        content: `Status: ${c.status}`,
        direction: 'inbound',
        timestamp: c.createdAt,
        status: 'forwarded'
      }))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, parseInt(limit));

    return res.json({ ok: true, logs: unifiedLogs });
  } catch (error) {
    console.error('[Device] getLogs error:', error);
    return res.status(500).json({ ok: false });
  }
};
