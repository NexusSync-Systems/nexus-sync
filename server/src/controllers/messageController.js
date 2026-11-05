const prisma = require('../services/db');
const { smiNaProfil } = require('../utils/rozsahProfilu');
const { getIO } = require('../services/socket');
const { sendChatPush, sendRelaySmsPush } = require('../services/pushService');
const { getPhoneLookupValues, normalizePhoneNumber } = require('../utils/phoneNumber');

exports.getMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { role, agencyId } = req.user;
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { profile: { select: { phoneNumber: true } } }
    });
    if (!chat) return res.status(404).json({ message: 'Chat not found' });
    if (chat.agencyId !== agencyId) return res.status(403).json({ message: 'Access denied' });
    // Agentura nestačí: operátorka smí jen na modelky, které má
    // přiřazené. Manažerce `smiNaProfil` vrátí true vždy.
    if (!(await smiNaProfil(req.user, chat.profileId))) {
      return res.status(403).json({ message: 'Access denied: profile not assigned to you' });
    }

    const phoneVariants = getPhoneLookupValues(chat.externalId, { referenceNumber: chat.profile?.phoneNumber });
    let chatIds = [chat.id];

    if (phoneVariants.length > 1) {
      const siblingChats = await prisma.chat.findMany({
        where: {
          agencyId,
          profileId: chat.profileId,
          externalId: { in: phoneVariants }
        },
        select: { id: true }
      });
      chatIds = [...new Set([...chatIds, ...siblingChats.map((sibling) => sibling.id)])];
    }

    const messages = await prisma.message.findMany({
      where: { chatId: { in: chatIds } },
      include: { 
        sender: { select: { id: true, name: true } },
        chat: { include: { client: true } }
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    res.json(messages);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching messages' });
  }
};

exports.createMessage = async (req, res) => {
  try {
    const { chatId, text, direction, status, transport } = req.body;
    const userId = req.user.userId || req.user.id || req.user.sub;
    const { role, agencyId } = req.user;
    const isAppOwner = role?.isAppOwner;
    if (isAppOwner) return res.status(403).json({ message: 'App Owner cannot access messages' });
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) return res.status(404).json({ message: 'Chat not found' });
    if (chat.agencyId !== agencyId) return res.status(403).json({ message: 'Access denied' });
    // Agentura nestačí: operátorka smí jen na modelky, které má
    // přiřazené. Manažerce `smiNaProfil` vrátí true vždy.
    if (!(await smiNaProfil(req.user, chat.profileId))) {
      return res.status(403).json({ message: 'Access denied: profile not assigned to you' });
    }
    
        // 1. Save message to DB first with 'pending_relay' status (User Request: DB first)
    const message = await prisma.message.create({
      data: {
        chatId,
        text,
        direction,
        transport: transport || 'sms',
        status: direction === 'OUTBOUND' ? 'pending_relay' : (status || 'sent'),
        senderId: direction === 'OUTBOUND' ? userId : null
      },
      include: { 
        sender: { select: { id: true, name: true } }
      }
    });

    // Update chat timestamp
    await prisma.chat.update({ where: { id: chatId }, data: { lastMessageAt: new Date() } });

    // 2. Notify the relay device via Push (The phone will then pull or act on this)
    if (direction === 'OUTBOUND') {
      try {
        // Návratová hodnota se DŘÍV zahazovala. sendRelaySmsPush ale při
        // chybějícím push tokenu nebo vazbě nevyhazuje výjimku — vrátí
        // { ok: false, message }. Server tedy tiše neudělal nic a zpráva
        // zůstala viset na pending_relay bez jakékoli stopy, proč.
        //
        // Socket je hlavní cesta a push jen záloha, takže selhání push
        // nesmí shodit odeslání. Ale musí být vidět v logu, jinak se to
        // nedá vůbec diagnostikovat.
        const vysledekPush = await sendRelaySmsPush({
          agencyId: chat.agencyId,
          profileId: chat.profileId,
          to: chat.externalId,
          text: text,
          messageId: message.id
        });
        if (vysledekPush && vysledekPush.ok === false) {
          console.warn(
            `[Relay] Push záloha neodešla pro zprávu ${message.id} (profil ${chat.profileId}): `
            + `${vysledekPush.message}. Zpráva čeká na socket nebo na dotaz relaye na outbox.`
          );
        }
      } catch (e) {
        console.error('[Relay] Failed to trigger outbound push:', e.message);
      }
    }

    try { 
      const io = getIO();
      // Regular inbox update
      io.to(`agency_${chat.agencyId}`).emit('new_message', { 
        ...message,
        chatId: chatId,
        profileId: chat.profileId,
        from: chat.externalId
      }); 

      // Targeted relay command via socket (faster than push)
      if (direction === 'OUTBOUND') {
        console.log(`[Socket-DEBUG] Emitting relay_command to agency_${chat.agencyId} for chat ${chatId}. MessageId: ${message.id}`);
        io.to(`agency_${chat.agencyId}`).emit('relay_command', {
          targetType: 'relay_command', // Explicitly add targetType for client check
          type: 'send_sms',
          to: chat.externalId,
          content: text,
          messageId: message.id,
          profileId: chat.profileId,
          agencyId: chat.agencyId
        });
      }
    } catch (e) {
      console.error('[Socket] Relay emission failed:', e.message);
    }
    
    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error creating message' });
  }
};

exports.simulateInbound = async (req, res) => {
  try {
    const { externalId, profileId, text } = req.body;
    const { agencyId } = req.user;
    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    if (profile.agencyId !== agencyId) return res.status(403).json({ message: 'Access denied' });
    if (!(await smiNaProfil(req.user, profileId))) {
      return res.status(403).json({ message: 'Access denied: profile not assigned to you' });
    }
    const normalizedExternalId = normalizePhoneNumber(externalId, { referenceNumber: profile.phoneNumber });
    const phoneVariants = getPhoneLookupValues(externalId, { referenceNumber: profile.phoneNumber });
    let chat = await prisma.chat.findFirst({
      where: {
        profileId,
        externalId: { in: phoneVariants.length ? phoneVariants : [normalizedExternalId] }
      },
      orderBy: { lastMessageAt: 'desc' }
    });
    
    // Auto-link to CRM Client
    let clientId = null;
    if (normalizedExternalId) {
      const client = await prisma.client.upsert({
        where: {
          agencyId_phone: {
            agencyId: String(agencyId),
            phone: String(normalizedExternalId)
          }
        },
        update: {}, // Just find it if it exists
        create: {
          agencyId: String(agencyId),
          phone: String(normalizedExternalId),
          name: 'Lead',
          totalSpent: 0
        }
      });
      clientId = client.id;
    }

    if (!chat) {
      chat = await prisma.chat.create({ 
        data: { 
          externalId: normalizedExternalId,
          profileId, 
          agencyId: profile.agencyId,
          clientId
        } 
      });
    } else if (!chat.clientId && clientId) {
      // Link existing chat to client if not linked yet
      await prisma.chat.update({
        where: { id: chat.id },
        data: { clientId }
      });
    }
    const message = await prisma.message.create({ data: { chatId: chat.id, text, direction: 'INBOUND', transport: 'sms', status: 'received' } });
    await prisma.chat.update({ where: { id: chat.id }, data: { lastMessageAt: new Date() } });
    
    try { 
      getIO().to(`agency_${profile.agencyId}`).emit('new_message', { 
        ...message,
        chatId: chat.id,
        profileId: profile.id,
        from: chat.externalId
      }); 
    } catch (e) { /* Socket may not be ready */ }
    
    try {
      await sendChatPush({
        agencyId: profile.agencyId,
        profileId,
        chatId: message.id,
        from: chat.externalId,
        messagePreview: text,
        profileName: profile.name
      });
    } catch (e) { /* Push may be unavailable */ }
    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error simulating inbound message' });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { role, agencyId } = req.user;
    const isAppOwner = role?.isAppOwner;
    if (isAppOwner) return res.status(403).json({ message: 'App Owner cannot access messages' });

    const message = await prisma.message.findUnique({ where: { id: messageId }, include: { chat: true } });
    if (!message) return res.status(404).json({ message: 'Message not found' });
    if (message.chat.agencyId !== agencyId) return res.status(403).json({ message: 'Access denied' });
    // Agentura nestačí: operátorka smí jen na modelky, které má
    // přiřazené. Manažerce `smiNaProfil` vrátí true vždy.
    if (!(await smiNaProfil(req.user, message.chat.profileId))) {
      return res.status(403).json({ message: 'Access denied: profile not assigned to you' });
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { status: 'read' }
    });

    try {
      getIO().to(`agency_${message.chat.agencyId}`).emit('message_updated', { chatId: message.chatId, message: updated });
    } catch (e) { /* Socket may not be ready */ }

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error marking message as read' });
  }
};

// ── Outbox Pull: for the relay app to fetch pending messages ──
exports.getOutbox = async (req, res) => {
  try {
    const { profileId, installationId } = req.query;
    const { agencyId } = req.user;
    if (!profileId) return res.status(400).json({ message: 'profileId required' });

    // Když se prokázalo ZAŘÍZENÍ (ne uživatel), smí vidět jedině frontu profilu,
    // ke kterému je spárované. Jinak by stačil ukradený secret jednoho telefonu
    // k přečtení odchozích zpráv všech profilů v agentuře.
    if (req.relayBinding && String(req.relayBinding.profileId) !== String(profileId)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { agencyId: true } });
    if (!profile || profile.agencyId !== agencyId) return res.status(403).json({ message: 'Access denied' });

    if (installationId) {
      try {
        await prisma.deviceBinding.updateMany({
          where: {
            installationId: String(installationId),
            agencyId,
            profileId,
            active: true
          },
          data: { lastSeenAt: new Date() }
        });
      } catch {
        // Heartbeat update must not block outbox polling.
      }
    }

    const pending = await prisma.message.findMany({
      where: {
        chat: { profileId, agencyId },
        direction: 'OUTBOUND',
        status: 'pending_relay'
      },
      include: { chat: { select: { externalId: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });

    res.json(pending.map(m => ({
      id: m.id,
      to: m.chat.externalId,
      text: m.text,
      transport: m.transport,
      createdAt: m.createdAt
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching outbox' });
  }
};

exports.updateMessageStatus = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { status } = req.body;
    const { agencyId } = req.user;

    const prevMessage = await prisma.message.findUnique({
      where: { id: messageId },
      select: { status: true, chat: { select: { agencyId: true, profileId: true } } }
    });
    if (!prevMessage) return res.status(404).json({ message: 'Message not found' });
    if (prevMessage.chat.agencyId !== agencyId) return res.status(403).json({ message: 'Access denied' });
    // Agentura nestačí: uživatel smí jen na modelky, které má přiřazené.
    // Na zařízení se to nevztahuje — to omezuje vazba hned pod tím.
    if (!req.relayBinding && !(await smiNaProfil(req.user, prevMessage.chat.profileId))) {
      return res.status(403).json({ message: 'Access denied: profile not assigned to you' });
    }
    // Zařízení hlásí stav jen u zpráv svého profilu — stejné omezení jako
    // u výdeje fronty, jinak by šlo přepsat stav cizí zprávy.
    if (req.relayBinding && String(req.relayBinding.profileId) !== String(prevMessage.chat.profileId)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const prevStatus = prevMessage.status || 'unknown';

    const message = await prisma.message.update({
      where: { id: messageId },
      data: { status }
    });

    if (status === 'sent') {
      console.log(`[Relay ✅ OUTBOUND] SMS odeslána relay zařízením, message=${messageId}: ${prevStatus} → sent`);
    } else if (status === 'failed') {
      console.warn(`[Relay ❌ FAILED] SMS odeslání selhalo, message=${messageId}: ${prevStatus} → failed`);
    } else {
      console.log(`[Relay] Message ${messageId} status updated: ${prevStatus} → ${status}`);
    }

    try {
      const chat = await prisma.chat.findUnique({ where: { id: message.chatId } });
      getIO().to(`agency_${chat.agencyId}`).emit('message_updated', { chatId: message.chatId, message });
    } catch {
      // Socket may not be ready.
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error updating status' });
  }
};

exports.getRelayHistory = async (req, res) => {
  try {
    const { profileId } = req.query;
    const { agencyId } = req.user;
    if (!profileId) return res.status(400).json({ message: 'profileId required' });

    const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { agencyId: true } });
    if (!profile || profile.agencyId !== agencyId) return res.status(403).json({ message: 'Access denied' });

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const messages = await prisma.message.findMany({
      where: { chat: { profileId, agencyId }, createdAt: { gte: since } },
      include: {
        chat: { select: { externalId: true, profileId: true } },
        sender: { select: { id: true, name: true } }
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500
    });
    res.json(messages);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching relay history' });
  }
};
