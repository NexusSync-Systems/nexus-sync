const { isManagerRole } = require('../utils/authz');
const prisma = require('../services/db');
const { getIO } = require('../services/socket');
const { sendChatPush } = require('../services/pushService');
const { secureCompare, deriveWebhookSecret } = require('../utils/security');
const crypto = require('crypto');

function getWebhookSecret(req) {
  return req.headers['x-webhook-secret'] ||
    req.headers['x-nexus-secret'] ||
    req.headers['x-telegram-bot-api-secret-token'] ||
    req.query?.secret ||
    req.body?.secret;
}

function verifySharedWebhookSecret(req, res, provider, fallbackSecret) {
  const provided = String(getWebhookSecret(req) || '');
  if (!provided) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }

  // Preferred: per-agency secret = HMAC(master, "webhook:"+agencyId). It binds the
  // credential to one agency, so a secret-holder can only inject into their own
  // agency. When it matches, the agencyId is trusted (see getWebhookRouting).
  const { agencyId } = getWebhookRouting(req);
  if (agencyId && secureCompare(provided, deriveWebhookSecret(agencyId))) {
    req.webhookAgencyId = String(agencyId);
    return true;
  }

  // Legacy fallback: a single shared secret with NO agency binding. A holder of it
  // can route into ANY tenant, because this path does not set req.webhookAgencyId
  // and getWebhookRouting then trusts the attacker-supplied agencyId from the body.
  // This is insecure for multi-tenant use, so it is OFF by default and must be
  // explicitly re-enabled (ALLOW_LEGACY_WEBHOOK_SECRET=true) only while migrating a
  // provider to its per-agency secret. Unset it again once migration is complete.
  if (process.env.ALLOW_LEGACY_WEBHOOK_SECRET === 'true') {
    const legacyFallback = process.env.ALLOW_LEGACY_DEVICE_ENDPOINTS === 'true' ? fallbackSecret : null;
    const configuredSecret =
      process.env[`${provider.toUpperCase()}_WEBHOOK_SECRET`] ||
      process.env.WEBHOOK_SECRET ||
      legacyFallback;
    if (configuredSecret && secureCompare(provided, configuredSecret)) {
      return true;
    }
  }

  res.status(401).json({ message: 'Unauthorized' });
  return false;
}

function getWebhookRouting(req, overrides = {}) {
  return {
    profileId: overrides.profileId ||
      req.body?.profileId ||
      req.body?.profile_id ||
      req.query?.profileId ||
      req.headers['x-profile-id'] ||
      null,
    agencyId: overrides.agencyId ||
      req.webhookAgencyId ||
      req.body?.agencyId ||
      req.body?.agency_id ||
      req.query?.agencyId ||
      req.headers['x-agency-id'] ||
      null
  };
}

/**
 * Telegram Bot Webhook — receives incoming messages from Telegram
 * POST /api/webhooks/telegram
 * Telegram sends: { message: { chat: { id }, from: { first_name }, text } }
 */
exports.handleTelegram = async (req, res) => {
  try {
    if (!verifySharedWebhookSecret(req, res, 'telegram')) return;
    const msg = req.body?.message;
    if (!msg?.text || !msg?.chat?.id) {
      return res.sendStatus(200); // Telegram expects 200 even on skip
    }

    const telegramChatId = String(msg.chat.id);
    const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Telegram User';
    const text = msg.text;

    // Find or create chat by externalId (telegram:<chatId>)
    const externalId = `telegram:${telegramChatId}`;
    const chat = await findOrCreateChat(externalId, senderName, 'telegram', getWebhookRouting(req));
    if (!chat) return res.sendStatus(200);

    const message = await prisma.message.create({
      data: {
        chatId: chat.id,
        text,
        direction: 'INBOUND',
        status: 'delivered',
        transport: 'telegram',
      },
    });

    await prisma.chat.update({
      where: { id: chat.id },
      data: { 
        lastMessageAt: new Date(),
        updatedAt: new Date()
      },
    });

    const io = getIO();
    io.to(`agency_${chat.agencyId}`).emit('new_message', {
      message: { ...message, chat: { id: chat.id, clientName: chat.clientName } },
      chatId: chat.id,
    });

    await sendChatPush({
      agencyId: chat.agencyId,
      profileId: chat.profileId,
      chatId: chat.id,
      from: senderName,
      messagePreview: text?.substring(0, 100),
    }).catch(() => {});

    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook][Telegram] Error:', err.message);
    res.sendStatus(200);
  }
};

/**
 * WhatsApp Business API Webhook — verification + incoming messages
 * GET  /api/webhooks/whatsapp — verification challenge
 * POST /api/webhooks/whatsapp — incoming message
 */
exports.verifyWhatsApp = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  // Provide a random fallback string so that if the verify token is missing,
  // it safely rejects all requests without using a hardcoded secret.
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || crypto.randomBytes(32).toString('hex');

  if (mode === 'subscribe' && typeof token === 'string' && secureCompare(token, VERIFY_TOKEN)) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
};

exports.handleWhatsApp = async (req, res) => {
  try {
    if (!verifySharedWebhookSecret(req, res, 'whatsapp')) return;
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (!msg?.text?.body || !msg?.from) {
      return res.sendStatus(200);
    }

    const waNumber = msg.from; // E.164 format
    const text = msg.text.body;
    const contactName = value?.contacts?.[0]?.profile?.name || waNumber;

    const externalId = `whatsapp:${waNumber}`;
    const chat = await findOrCreateChat(externalId, contactName, 'whatsapp', getWebhookRouting(req));
    if (!chat) return res.sendStatus(200);

    const message = await prisma.message.create({
      data: {
        chatId: chat.id,
        text,
        direction: 'INBOUND',
        status: 'delivered',
        transport: 'whatsapp',
      },
    });

    await prisma.chat.update({
      where: { id: chat.id },
      data: { 
        lastMessageAt: new Date(),
        updatedAt: new Date()
      },
    });

    const io = getIO();
    io.to(`agency_${chat.agencyId}`).emit('new_message', {
      message: { ...message, chat: { id: chat.id, clientName: chat.clientName } },
      chatId: chat.id,
    });

    await sendChatPush({
      agencyId: chat.agencyId,
      profileId: chat.profileId,
      chatId: chat.id,
      from: contactName,
      messagePreview: text?.substring(0, 100),
    }).catch(() => {});

    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook][WhatsApp] Error:', err.message);
    res.sendStatus(200);
  }
};

/**
 * Generic webhook for any external messaging service
 * POST /api/webhooks/generic
 * Body: { source, externalId, senderName, text, agencyId? }
 */
exports.handleGeneric = async (req, res) => {
  try {
    if (!verifySharedWebhookSecret(req, res, 'generic', process.env.DEVICE_SECRET)) return;
    const { source, externalId, senderName, text, profileId, agencyId } = req.body;
    if (!source || !externalId || !text) {
      return res.status(400).json({ message: 'source, externalId, and text are required' });
    }

    const fullExternalId = `${source}:${externalId}`;
    const chat = await findOrCreateChat(fullExternalId, senderName || 'Unknown', source, getWebhookRouting(req, { profileId, agencyId }));
    if (!chat) return res.status(404).json({ message: 'No matching profile found' });

    const message = await prisma.message.create({
      data: {
        chatId: chat.id,
        text,
        direction: 'INBOUND',
        status: 'delivered',
        transport: source,
      },
    });

    await prisma.chat.update({
      where: { id: chat.id },
      data: { 
        lastMessageAt: new Date(),
        updatedAt: new Date()
      },
    });

    const io = getIO();
    io.to(`agency_${chat.agencyId}`).emit('new_message', {
      message: { ...message, chat: { id: chat.id, clientName: chat.clientName } },
      chatId: chat.id,
    });

    res.json({ ok: true, messageId: message.id, chatId: chat.id });
  } catch (err) {
    console.error('[Webhook][Generic] Error:', err.message);
    res.status(500).json({ message: 'Webhook processing error' });
  }
};

/**
 * AdultWork (AW) Webhook
 * POST /api/webhooks/adultwork
 * Expects: { sender_id, profile_id, body }
 */
exports.handleAdultWork = async (req, res) => {
  try {
    if (!verifySharedWebhookSecret(req, res, 'adultwork', process.env.DEVICE_SECRET)) return;
    const { sender_id, profile_id, body } = req.body;
    if (!sender_id || !body) return res.sendStatus(200);

    const externalId = `aw:${sender_id}`;
    // Find chat specifically for this AW profile mapping if needed, 
    // or use generic findOrCreateChat
    const chat = await findOrCreateChat(externalId, `AW User ${sender_id}`, 'adultwork', getWebhookRouting(req, { profileId: profile_id }));
    if (!chat) return res.sendStatus(200);

    const message = await prisma.message.create({
      data: {
        chatId: chat.id,
        text: body,
        direction: 'INBOUND',
        status: 'delivered',
        transport: 'adultwork',
      },
    });

    await prisma.chat.update({
      where: { id: chat.id },
      data: { 
        lastMessageAt: new Date(),
        updatedAt: new Date()
      },
    });

    getIO().to(`agency_${chat.agencyId}`).emit('new_message', {
      message: { ...message, chat: { id: chat.id, clientName: chat.clientName } },
      chatId: chat.id,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook][AdultWork] Error:', err.message);
    res.sendStatus(200);
  }
};

// --- Helper: Find or create a chat for an external contact ---
async function resolveWebhookProfile({ profileId, agencyId } = {}) {
  if (profileId) {
    const profile = await prisma.profile.findUnique({
      where: { id: String(profileId) },
      select: { id: true, agencyId: true, status: true }
    });
    if (!profile) return null;
    if (agencyId && String(profile.agencyId) !== String(agencyId)) return null;
    return profile;
  }

  if (!agencyId) return null;

  return prisma.profile.findFirst({
    where: { agencyId: String(agencyId), status: { not: 'ARCHIVED' } },
    select: { id: true, agencyId: true, status: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function findOrCreateChat(externalId, clientName, transport, routing = {}) {
  const profile = await resolveWebhookProfile(routing);
  if (!profile) {
    console.warn(`[Webhook] No routed profile found for external contact ${externalId}`);
    return null;
  }

  // Look for existing chat with this externalId within the routed profile.
  let chat = await prisma.chat.findFirst({
    where: {
      externalId,
      profileId: profile.id,
      agencyId: profile.agencyId
    },
  });

  if (chat) return chat;

  chat = await prisma.chat.create({
    data: {
      profileId: profile.id,
      agencyId: profile.agencyId,
      externalId,
      lastMessageAt: new Date(),
    },
  });

  chat.clientName = clientName;
  chat.transport = transport || 'external';

  return chat;
}


/**
 * GET /api/webhooks/config  (authenticated, manager+)
 * Returns the caller agency's per-agency webhook secret and ready-to-use URLs.
 * The secret authorizes ONLY this agency.
 */
exports.getMyWebhookConfig = async (req, res) => {
  try {
    const role = req.user?.role;
    if (!isManagerRole(role)) {
      return res.status(403).json({ message: 'Manager role required' });
    }
    const agencyId = req.user?.agencyId;
    if (!agencyId) return res.status(400).json({ message: 'No agency in context' });

    const secret = deriveWebhookSecret(agencyId);
    const base = `${req.protocol}://${req.get('host')}`;
    return res.json({
      agencyId,
      secret,
      note: 'Send this secret in the X-Webhook-Secret header (preferred) or ?secret= query, together with agencyId. It authorizes ONLY your agency.',
      urls: {
        telegram: `${base}/api/webhooks/telegram?agencyId=${agencyId}`,
        whatsapp: `${base}/api/webhooks/whatsapp?agencyId=${agencyId}`,
        generic: `${base}/api/webhooks/generic?agencyId=${agencyId}`,
        adultwork: `${base}/api/webhooks/adultwork?agencyId=${agencyId}`
      }
    });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to build webhook config' });
  }
};
