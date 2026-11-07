const admin = require('firebase-admin');
const prisma = require('./db');
const { JEN_RELAY } = require('../utils/deviceVariants');

const path = require('path');

let firebaseApp = null;

const getFirebaseApp = () => {
  if (firebaseApp) {
    return firebaseApp;
  }

  try {
    if (admin.apps.length > 0) {
      firebaseApp = admin.app();
      return firebaseApp;
    }

    const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (inlineJson) {
      const credentials = JSON.parse(inlineJson);
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(credentials)
      });
      return firebaseApp;
    }

    // Explicitly handle GOOGLE_APPLICATION_CREDENTIALS if it's a relative path
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath && !path.isAbsolute(credPath)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(process.cwd(), credPath);
    }

    // Falls back to GOOGLE_APPLICATION_CREDENTIALS when running on server.
    firebaseApp = admin.initializeApp();
    return firebaseApp;
  } catch (error) {
    console.warn('[Push] Firebase init failed:', error.message);
    return null;
  }
};

const getMessaging = () => {
  const app = getFirebaseApp();
  if (!app) {
    return null;
  }
  return admin.messaging(app);
};

const ensureString = (value) => (value == null ? '' : String(value));

const buildChatPushPayload = ({ profileId, chatId, from, messagePreview, profileName }) => ({
  notification: {
    title: 'New message',
    body: `${profileName || 'Chat'}: ${messagePreview || ''}`.trim()
  },
  data: {
    type: 'new_message',
    targetType: 'inbox',
    profileId: ensureString(profileId),
    chatId: ensureString(chatId),
    from: ensureString(from),
    messagePreview: ensureString(messagePreview),
    notificationId: `msg-${ensureString(chatId) || Date.now()}`,
    timestamp: new Date().toISOString()
  },
  android: {
    priority: 'high',
    notification: {
      channelId: 'nexus-events',
      clickAction: 'OPEN_CHAT'
    }
  }
});

const buildCallPushPayload = ({ profileId, from, caller, profileName, callState }) => ({
  notification: {
    title: 'Incoming Call',
    body: `${profileName || 'Profile'} · ${caller || from || 'Unknown caller'}`
  },
  data: {
    type: 'incoming_call',
    targetType: 'call',
    profileId: ensureString(profileId),
    from: ensureString(from),
    caller: ensureString(caller || from),
    callState: ensureString(callState || 'RINGING'),
    notificationId: `call-${Date.now()}`,
    timestamp: new Date().toISOString()
  },
  android: {
    priority: 'high',
    notification: {
      channelId: 'nexus-events',
      clickAction: 'OPEN_CALL'
    }
  }
});

const registerPushToken = async ({ userId, agencyId, token, platform = 'android' }) => {
  if (!userId || !token) {
    return { ok: false, message: 'Missing userId or token' };
  }

  try {
    await prisma.pushDevice.upsert({
      where: { token },
      update: {
        userId,
        agencyId: agencyId || null,
        platform,
        active: true,
        lastSeenAt: new Date()
      },
      create: {
        userId,
        agencyId: agencyId || null,
        token,
        platform,
        active: true,
        lastSeenAt: new Date()
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
};

const getAgencyTokens = async (agencyId) => {
  const rows = await prisma.pushDevice.findMany({
    where: {
      agencyId: agencyId || null,
      active: true
    },
    select: { token: true }
  });
  return rows.map((row) => row.token).filter(Boolean);
};

const deactivateToken = async (token) => {
  try {
    await prisma.pushDevice.updateMany({
      where: { token },
      data: { active: false }
    });
  } catch (error) {
    console.warn('[Push] Could not deactivate token:', token, error.message);
  }
};

const sendMulticast = async (tokens, payload) => {
  if (!tokens.length) {
    return { sent: 0, failed: 0, details: 'No active tokens for audience' };
  }

  const messaging = getMessaging();
  if (!messaging) {
    return { sent: 0, failed: tokens.length, details: 'Firebase not configured' };
  }

  const response = await messaging.sendEachForMulticast({
    tokens,
    ...payload
  });

  const errorCodes = new Set();
  response.responses.forEach((item, index) => {
    if (item.success) return;
    const code = item.error?.code;
    if (code) errorCodes.add(code);
    if (code === 'messaging/registration-token-not-registered') {
      void deactivateToken(tokens[index]);
    }
  });

  // Bez chybového kódu se nedá poznat, jestli jsou tokeny jen zastaralé, nebo
  // třeba server posílá z jiného Firebase projektu než ze kterého je aplikace.
  if (response.failureCount > 0) {
    console.warn(`[Push] ${response.failureCount}/${tokens.length} failed: ${[...errorCodes].join(', ')}`);
  }

  return {
    sent: response.successCount,
    failed: response.failureCount,
    details: response.failureCount > 0 ? [...errorCodes].join(', ') : undefined
  };
};

const buildSafetyPushPayload = ({ sessionId, profileName, type, profileId }) => ({
  notification: {
    title: '🚨 SAFETY ALERT',
    body: `${profileName || 'Profile'}: Emergency ${type || 'Alert'} triggered!`
  },
  data: {
    type: 'safety_alert',
    targetType: 'safety',
    sessionId: ensureString(sessionId),
    profileId: ensureString(profileId),
    profileName: ensureString(profileName),
    alertType: ensureString(type),
    notificationId: `safety-${ensureString(sessionId)}-${Date.now()}`,
    timestamp: new Date().toISOString()
  },
  android: {
    priority: 'high',
    notification: {
      channelId: 'nexus-emergency',
      clickAction: 'OPEN_SAFETY_INCIDENT',
      color: '#ef4444'
    }
  }
});

const sendChatPush = async ({ agencyId, profileId, chatId, from, messagePreview, profileName }) => {
  const tokens = await getAgencyTokens(agencyId);
  const payload = buildChatPushPayload({ profileId, chatId, from, messagePreview, profileName });
  return sendMulticast(tokens, payload);
};

// Testovací push míří jen na zařízení toho, kdo o test požádal. sendChatPush by
// ho poslal přes getAgencyTokens celé agentuře — tedy rozbzučel telefony všem
// kolegům pokaždé, když si někdo chce ověřit, že mu chodí upozornění.
const sendSelfTestPush = async ({ userId, title, body }) => {
  const rows = await prisma.pushDevice.findMany({
    where: { userId: String(userId), active: true },
    select: { token: true }
  });
  const tokens = rows.map((row) => row.token).filter(Boolean);
  if (!tokens.length) {
    return { sent: 0, failed: 0, details: 'Na tvém účtu není registrované žádné aktivní zařízení' };
  }
  return sendMulticast(tokens, {
    notification: { title, body },
    data: { type: 'push_test' }
  });
};

const sendCallPush = async ({ agencyId, profileId, from, caller, profileName, callState }) => {
  const tokens = await getAgencyTokens(agencyId);
  const payload = buildCallPushPayload({ profileId, from, caller, profileName, callState });
  return sendMulticast(tokens, payload);
};

const getSafetyTokens = async (agencyId, profileId) => {
  // 1. Fetch Agency setting and Profile assignees
  const agency = await prisma.agency.findUnique({
    where: { id: agencyId },
    select: { safetyAlertMode: true }
  });

  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    include: {
      assignees: { select: { id: true } }
    }
  });

  if (!agency || !profile) return [];

  const assignedUserIds = profile.assignees.map(a => a.id);
  const mode = agency.safetyAlertMode;

  let whereClause = {
    agencyId: agencyId,
    active: true
  };

  if (mode === 'ASSIGNED_ONLY') {
    whereClause.userId = { in: assignedUserIds };
  } else if (mode === 'MANAGERS_AND_ASSIGNED') {
    // Get manager user IDs separately, then combine with assigned
    const managerUsers = await prisma.user.findMany({
      where: { agencyId, role: { isManager: true } },
      select: { id: true }
    });
    const managerIds = managerUsers.map(u => u.id);
    const allUserIds = [...new Set([...assignedUserIds, ...managerIds])];
    whereClause.userId = { in: allUserIds };
  }

  const rows = await prisma.pushDevice.findMany({
    where: whereClause,
    select: { token: true }
  });

  return rows.map((row) => row.token).filter(Boolean);
};

const sendSafetyPush = async ({ agencyId, sessionId, profileId, profileName, type }) => {
  const tokens = await getSafetyTokens(agencyId, profileId);
  const payload = buildSafetyPushPayload({ sessionId, profileName, type, profileId });
  return sendMulticast(tokens, payload);
};

const sendRelaySmsPush = async ({ agencyId, profileId, to, text, messageId }) => {
  // 1. Find the bound RELAY device for this profile to get the specific user/tokens.
  //    Plná aplikace modelky má od #188 vlastní vazbu na stejný profil,
  //    ale odeslat SMS přes SIM kartu umí jedině relay.
  const binding = await prisma.deviceBinding.findFirst({
    where: { 
      profileId, 
      ...JEN_RELAY,
      active: true,
      ...(agencyId ? { agencyId } : {})
    },
    select: { userId: true }
  });

  if (!binding) {
    return { ok: false, message: 'No active device binding found for this profile' };
  }

  // 2. Get tokens for the user associated with this relay device
  const tokens = await prisma.pushDevice.findMany({
    where: { userId: binding.userId, active: true, platform: 'android' },
    select: { token: true }
  });

  const tokenList = tokens.map(t => t.token).filter(Boolean);
  if (!tokenList.length) {
    return { ok: false, message: 'No push tokens found for the relay device' };
  }

  // 3. Build the relay command payload
  const payload = {
    data: {
      type: 'send_sms',
      targetType: 'relay_command',
      to: ensureString(to),
      content: ensureString(text),
      profileId: ensureString(profileId),
      messageId: ensureString(messageId),  // ← was 'id' — now consistent with sendSmsFromData
      notificationId: `relay-${messageId || Date.now()}`,
      timestamp: new Date().toISOString()
    },
    android: {
      priority: 'high'
    }
  };

  return sendMulticast(tokenList, payload);
};

/**
 * Push fantomového hovoru — MÍŘÍ NA TELEFON MODELKY.
 *
 * Záměrně nepoužívá sendSafetyPush: ten přes getSafetyTokens cílí na přiřazené
 * operátory/manažery a posílá payload nouzového poplachu. U fantomového hovoru
 * by to znamenalo, že se rozezvoní operátorům poplach, zatímco modelce, které
 * má hovor pomoct odejít, nedorazí nic.
 */
const sendGhostCallPush = async ({ userIds = [], profileId, profileName }) => {
  // Cílíme na uživatele (modelky) navázané na profil — stejné příjemce jako
  // socketová událost. Přes DeviceBinding to nešlo: vazba profilu ukazuje na
  // Relay aplikaci, ne na Hub, kde se hovor zobrazuje.
  if (!userIds.length) return { sent: 0, failed: 0, details: 'No recipients for ghost call' };

  const tokens = await prisma.pushDevice.findMany({
    where: { userId: { in: userIds }, active: true },
    select: { token: true }
  });
  const tokenList = tokens.map(t => t.token).filter(Boolean);
  if (!tokenList.length) return { sent: 0, failed: 0, details: 'No push tokens for the model device' };

  return sendMulticast(tokenList, {
    // Data-only zpráva: vyzvánění vykresluje aplikace (na popředí webové UI,
    // na pozadí nativní full-screen notifikace), ne systémová notifikační lišta.
    data: {
      type: 'ghost_call',
      profileId: ensureString(profileId),
      profileName: ensureString(profileName || ''),
      notificationId: `ghost-${Date.now()}`,
      timestamp: new Date().toISOString()
    },
    android: { priority: 'high' }
  });
};

const sendRelaySyncPush = async ({ agencyId, profileId, externalId }) => {
  // 1. Find the bound RELAY device for this profile (viz sendRelaySmsPush)
  const binding = await prisma.deviceBinding.findFirst({
    where: { 
      profileId, 
      ...JEN_RELAY,
      active: true,
      ...(agencyId ? { agencyId } : {})
    },
    select: { userId: true }
  });

  if (!binding) {
    return { ok: false, message: 'No active device binding found' };
  }

  // 2. Get tokens for the user associated with this relay device
  const tokens = await prisma.pushDevice.findMany({
    where: { userId: binding.userId, active: true, platform: 'android' },
    select: { token: true }
  });

  const tokenList = tokens.map(t => t.token).filter(Boolean);
  if (!tokenList.length) {
    return { ok: false, message: 'No push tokens found' };
  }

  // 3. Build the sync command payload
  const payload = {
    data: {
      type: 'sync_chat',
      targetType: 'relay_command',
      externalId: ensureString(externalId),
      profileId: ensureString(profileId),
      notificationId: `sync-${externalId}-${Date.now()}`,
      timestamp: new Date().toISOString()
    },
    android: {
      priority: 'high'
    }
  };

  return sendMulticast(tokenList, payload);
};

module.exports = {
  registerPushToken,
  buildChatPushPayload,
  buildCallPushPayload,
  buildSafetyPushPayload,
  sendChatPush,
  sendCallPush,
  sendSelfTestPush,
  sendSafetyPush,
  sendGhostCallPush,
  sendRelaySmsPush,
  sendRelaySyncPush
};

