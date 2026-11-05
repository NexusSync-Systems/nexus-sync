const prisma = require('../services/db');
const { povoleneProfily, smiNaProfil } = require('../utils/rozsahProfilu');

exports.getChats = async (req, res) => {
  try {
    const { role, agencyId } = req.user;
    const isAppOwner = role?.isAppOwner;
    if (isAppOwner) return res.status(403).json({ message: 'App Owner cannot access messages' });
    // Operátorka vidí jen chaty svých přiřazených modelek; manažerce
    // se `povoleneProfily` vrátí null a seznam se nezužuje.
    const povolene = await povoleneProfily(req.user);
    const whereClause = povolene === null
      ? { agencyId }
      : { agencyId, profileId: { in: povolene } };
    const chats = await prisma.chat.findMany({
      where: whereClause,
      include: { 
        profile: { select: { id: true, name: true } }, 
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: { select: { id: true, name: true } } }
        },
        _count: { select: { messages: true } } 
      },
      orderBy: { lastMessageAt: 'desc' }
    });
    res.json(chats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching chats' });
  }
};

exports.getProfileChats = async (req, res) => {
  try {
    const { profileId } = req.params;
    const { role, agencyId } = req.user;
    const isAppOwner = role?.isAppOwner;
    if (isAppOwner) return res.status(403).json({ message: 'App Owner cannot access messages' });

    // Verify the profile belongs to the user's agency
    const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { agencyId: true } });
    if (!profile || profile.agencyId !== agencyId) {
      return res.status(403).json({ message: 'Access denied: profile does not belong to your agency' });
    }

    if (!(await smiNaProfil(req.user, profileId))) {
      return res.status(403).json({ message: 'Access denied: profile not assigned to you' });
    }

    const whereClause = { profileId, agencyId };
    const chats = await prisma.chat.findMany({
      where: whereClause,
      include: { 
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: { select: { id: true, name: true } } }
        },
        _count: { select: { messages: true } } 
      },
      orderBy: { lastMessageAt: 'desc' }
    });
    res.json(chats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching profile chats' });
  }
};

exports.syncChatHistory = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { agencyId } = req.user;
    
    const chat = await prisma.chat.findUnique({ 
      where: { id: chatId },
      include: { profile: true }
    });

    if (!chat) return res.status(404).json({ message: 'Chat not found' });
    if (chat.agencyId !== agencyId) return res.status(403).json({ message: 'Access denied' });

    // Send command via Socket for speed
    try {
      const io = require('../services/socket').getIO();
      io.to(`agency_${agencyId}`).emit('relay_command', {
        targetType: 'relay_command',
        type: 'sync_chat',
        externalId: chat.externalId,
        profileId: chat.profileId,
        chatId: chat.id
      });
    } catch (e) {
      console.warn('[Socket] Relay sync emission failed:', e.message);
    }

    // Also send via Push for reliability
    const { sendRelaySyncPush } = require('../services/pushService');
    await sendRelaySyncPush({
      agencyId,
      profileId: chat.profileId,
      externalId: chat.externalId
    });

    res.json({ ok: true, message: 'Sync command dispatched' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error dispatching sync command' });
  }
};
