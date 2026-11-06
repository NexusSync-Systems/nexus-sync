const prisma = require('../services/db');
const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('../utils/encryption');
const { getIO } = require('../services/socket');
const { isAppOwnerRole, isManagerRole, isModelRole } = require('../utils/authz');
const { povoleneProfily } = require('../utils/rozsahProfilu');
const { normalizePhoneNumber } = require('../utils/phoneNumber');

function parseData(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function parseGallery(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeProfilePhoneNumber(value, referenceNumber) {
  if (value === undefined) return undefined;
  if (value === null || `${value}`.trim() === '') return null;
  return normalizePhoneNumber(value, { referenceNumber });
}

function getApiBaseUrl(req) {
  return (process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`)
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '');
}

function getGalleryFilePath(profileId, filename) {
  return path.join(
    __dirname,
    '..',
    '..',
    'uploads',
    'profile-gallery',
    String(profileId),
    path.basename(filename || '')
  );
}

function withGalleryFileUrls(req, profileId, gallery) {
  const baseUrl = getApiBaseUrl(req);
  return gallery.map(photo => {
    if (!photo?.id || !photo?.filename) return photo;
    return {
      ...photo,
      url: `${baseUrl}/api/profiles/${encodeURIComponent(String(profileId))}/gallery/${encodeURIComponent(String(photo.id))}/file`
    };
  });
}

const logger = require('../services/logger');

const getScopedProfile = async (profileId, req) => {
  const profile = await prisma.profile.findUnique({ where: { id: String(profileId) } });
  if (!profile) return null;
  if (!isAppOwnerRole(req.user?.role) && profile.agencyId !== String(req.user?.agencyId)) {
    return null;
  }
  return profile;
};

const requireProfileManager = (req, res) => {
  if (!isManagerRole(req.user?.role)) {
    res.status(403).json({ message: 'Forbidden' });
    return false;
  }
  return true;
};

exports.getProfiles = async (req, res) => {
  try {
    const { role, agencyId, userId } = req.user;
    const { normalizeRole } = require('../utils/roleUtils');
    const roleNameClean = normalizeRole(role?.name || role);
    const isAppOwner = !!role?.isAppOwner || ['app_owner', 'owner'].includes(roleNameClean);
    const isManager = !!role?.isManager || isAppOwner || 
                     ['manager', 'agency_admin', 'senior_operator', 'senior_manager'].includes(roleNameClean);

    // Senior operators see all agency profiles, just like managers
    const isAgencyLevel = isAppOwner || isManager;
    
    logger.info(`[Profiles] Fetching for User: ${userId}, Role: ${role?.name || role}, Agency: ${agencyId}`);
    logger.info(`[Profiles] roleNameClean: ${roleNameClean}, isAppOwner: ${isAppOwner}, isManager: ${isManager}`);

    if (!agencyId && !isAppOwner) {
      logger.warn(`[Profiles] No agencyId for user ${userId}`);
      return res.json([]);
    }

    // `isAgencyLevel` se tu dřív spočítal a zahodil, takže řadová
    // operátorka viděla všechny modelky agentury. Teď se seznam zúží
    // na přiřazené; manažerce a výš se nezužuje.
    const povoleneIds = isAgencyLevel ? null : await povoleneProfily(req.user);
    const where = isAppOwner
      ? {}
      : povoleneIds === null
        ? { agencyId: String(agencyId) }
        : { agencyId: String(agencyId), id: { in: povoleneIds } };
    const profiles = await prisma.profile.findMany({
      where,
      include: { 
        assignees: { select: { id: true, name: true, email: true } },
        deviceBindings: {
          select: { lastSeenAt: true },
          orderBy: { lastSeenAt: 'desc' },
          take: 1
        },
        bookings: {
          select: { price: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    logger.info(`[Profiles] DB returned ${profiles.length} profiles for agency ${agencyId}`);

    const sanitized = profiles.map(profile => {
      const data = parseData(profile.data);
      const bookings = profile.bookings || [];
      const totalRevenue = bookings.reduce((sum, b) => sum + (b.price || 0), 0);
      const totalBookings = bookings.length;
      const lastOnline = profile.deviceBindings?.[0]?.lastSeenAt || null;
      
      return { 
        ...profile, 
        data, 
        quickReplies: data.quickReplies || [],
        totalRevenue,
        totalBookings,
        lastOnline,
        deviceBindings: undefined,
        bookings: undefined
      };
    });

    res.json(sanitized);
  } catch (error) {
    logger.error('[Profiles] CRITICAL ERROR:', error);
    res.status(500).json({ message: 'Server error while fetching profiles' });
  }
};

exports.patchProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, phoneNumber, quickReplies, bio, description, gallery, commission, sampleMessages, data } = req.body;
    const { agencyId } = req.user;
    const existing = await prisma.profile.findUnique({ where: { id } });
    if (!existing || (existing.agencyId !== agencyId && !req.user.role?.isAppOwner)) return res.status(404).json({ message: 'Not found' });
    const currentData = parseData(existing.data);
    const newData = { ...currentData, ...(data && typeof data === 'object' ? data : {}), ...(quickReplies !== undefined && { quickReplies }) };
    const resolvedPhoneNumber = phoneNumber !== undefined ? phoneNumber : phone;
    const normalizedPhoneNumber = normalizeProfilePhoneNumber(resolvedPhoneNumber, existing.phoneNumber);
    const updated = await prisma.profile.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(resolvedPhoneNumber !== undefined && { phoneNumber: normalizedPhoneNumber }),
        ...(bio !== undefined && { bio }),
        ...(description !== undefined && { description }),
        ...(sampleMessages !== undefined && { sampleMessages }),
        ...(commission !== undefined && { commission: Number(commission) }),
        ...(gallery !== undefined && { gallery: typeof gallery === 'string' ? gallery : JSON.stringify(gallery) }),
        data: JSON.stringify(newData)
      },
      include: { assignees: { select: { id: true, name: true } } }
    });
    res.json({ ...updated, data: newData, quickReplies: newData.quickReplies || [] });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.getGallery = async (req, res) => {
  try {
    const profile = await getScopedProfile(req.params.id, req);
    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    res.json({ photos: withGalleryFileUrls(req, profile.id, parseGallery(profile.gallery)) });
  } catch (error) {
    logger.error('[Profiles] Failed to get gallery:', error);
    res.status(500).json({ message: 'Failed to load gallery' });
  }
};

exports.getGalleryPhoto = async (req, res) => {
  try {
    const profile = await getScopedProfile(req.params.id, req);
    if (!profile) return res.status(404).json({ message: 'Profile not found' });

    const gallery = parseGallery(profile.gallery);
    const photo = gallery.find(item => String(item.id) === String(req.params.photoId));
    if (!photo?.filename) return res.status(404).json({ message: 'Photo not found' });

    const filePath = getGalleryFilePath(profile.id, photo.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Photo file not found' });

    res.type(photo.contentType || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=300');
    return res.sendFile(filePath);
  } catch (error) {
    logger.error('[Profiles] Failed to serve gallery photo:', error);
    return res.status(500).json({ message: 'Failed to load gallery photo' });
  }
};

exports.uploadGalleryPhoto = async (req, res) => {
  try {
    if (!requireProfileManager(req, res)) return;
    const profile = await getScopedProfile(req.params.id, req);
    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    if (!req.file) return res.status(400).json({ message: 'Photo file is required' });

    const gallery = parseGallery(profile.gallery);
    let metadata = {};
    try {
      metadata = req.body?.metadata ? JSON.parse(req.body.metadata) : {};
    } catch {
      metadata = {};
    }

    const photo = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      filename: req.file.filename,
      visibility: metadata.visibility === 'private' ? 'private' : 'public',
      caption: typeof metadata.caption === 'string' ? metadata.caption.slice(0, 500) : '',
      contentType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    const nextGallery = [photo, ...gallery].slice(0, 100);
    await prisma.profile.update({
      where: { id: profile.id },
      data: { gallery: JSON.stringify(nextGallery) }
    });

    const photos = withGalleryFileUrls(req, profile.id, nextGallery);
    res.status(201).json({ photo: photos[0], photos });
  } catch (error) {
    logger.error('[Profiles] Failed to upload gallery photo:', error);
    res.status(500).json({ message: 'Failed to upload gallery photo' });
  }
};

exports.deleteGalleryPhoto = async (req, res) => {
  try {
    if (!requireProfileManager(req, res)) return;
    const profile = await getScopedProfile(req.params.id, req);
    if (!profile) return res.status(404).json({ message: 'Profile not found' });

    const gallery = parseGallery(profile.gallery);
    const photo = gallery.find(item => String(item.id) === String(req.params.photoId));
    if (!photo) return res.status(404).json({ message: 'Photo not found' });

    const nextGallery = gallery.filter(item => String(item.id) !== String(req.params.photoId));
    await prisma.profile.update({
      where: { id: profile.id },
      data: { gallery: JSON.stringify(nextGallery) }
    });

    if (photo.filename) {
      const filePath = getGalleryFilePath(profile.id, photo.filename);
      fs.promises.unlink(filePath).catch(() => {});
    }

    res.json({ photos: withGalleryFileUrls(req, profile.id, nextGallery) });
  } catch (error) {
    logger.error('[Profiles] Failed to delete gallery photo:', error);
    res.status(500).json({ message: 'Failed to delete gallery photo' });
  }
};

exports.assignUsersToProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const { userIds } = req.body;
    if (!requireProfileManager(req, res)) return;

    const existing = await getScopedProfile(id, req);
    if (!existing) return res.status(404).json({ message: 'Profile not found' });

    if (userIds.length > 0) {
      // Dřív tu byl `count`, který uměl ověřit jen počet — tedy agenturu.
      // Roli ověřit neumí, a ta je od #185 potřeba: do té doby modelky
      // ŽÁDNÉ účty neměly, takže „všichni uživatelé agentury" byl personál.
      // Teď tam jejich účty jsou, a bez téhle kontroly by manažerka mohla
      // přes API dát modelce A přístup do chatu modelky B. UI účty modelek
      // odfiltruje, ale filtr v prohlížeči není kontrola.
      const kandidati = await prisma.user.findMany({
        where: {
          id: { in: userIds.map(String) },
          agencyId: String(existing.agencyId)
        },
        select: { id: true, role: { select: { name: true, isManager: true, isAppOwner: true } } }
      });

      if (kandidati.length !== userIds.length) {
        return res.status(400).json({ message: 'All assignees must belong to the profile agency' });
      }

      // Obsluhovat profil smí personál. Modelka k profilu přístup má, ale
      // přes VLASTNICTVÍ (`ownerId`), ne přes přiřazení — tohle je seznam
      // operátorek, které ho obsluhují.
      if (kandidati.some((u) => isModelRole(u.role))) {
        return res.status(400).json({ message: 'Model accounts cannot be assigned as operators' });
      }
    }

    const profile = await prisma.profile.update({ where: { id }, data: { assignees: { set: userIds.map(userId => ({ id: userId })) } }, include: { assignees: { select: { id: true, name: true } } } });
    res.json(profile);
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.createProfile = async (req, res) => {
  try {
    const { role, agencyId } = req.user;
    const { name, phoneNumber, targetAgencyId } = req.body;
    const resolvedAgencyId = (role?.isAppOwner && targetAgencyId) ? targetAgencyId : agencyId;
    const normalizedPhoneNumber = normalizeProfilePhoneNumber(phoneNumber);
    const profile = await prisma.profile.create({ data: { name, phoneNumber: normalizedPhoneNumber === undefined ? null : normalizedPhoneNumber, agencyId: resolvedAgencyId, status: 'offline', data: JSON.stringify({ quickReplies: [] }) }, include: { assignees: { select: { id: true, name: true } } } });
    res.status(201).json({ ...profile, data: { quickReplies: [] }, quickReplies: [] });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.updateCredentials = async (req, res) => {
  try {
    const { id } = req.params;
    const { credentials } = req.body;
    if (!requireProfileManager(req, res)) return;

    const profile = await getScopedProfile(id, req);
    if (!profile) return res.status(404).json({ message: 'Profile not found' });

    const encrypted = await encrypt(JSON.stringify(credentials));
    await prisma.profile.update({ where: { id }, data: { credentials: encrypted } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.syncProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const { bio, name } = req.body;
    if (!requireProfileManager(req, res)) return;

    const profile = await getScopedProfile(id, req);
    if (!profile) return res.status(404).json({ message: 'Not found' });
    await prisma.profile.update({ where: { id }, data: { ...(bio && { bio }), ...(name && { name }) } });
    let decryptedCredentials = null;
    if (profile.credentials) {
      const decryptedString = await decrypt(profile.credentials);
      if (decryptedString) decryptedCredentials = JSON.parse(decryptedString);
    }
    // Platformy odvodíme z nakonfigurovaných credentials (klíč s login objektem),
    // ne z natvrdo daného seznamu — přidání nové stránky pak nevyžaduje změnu serveru
    // (stačí nový adaptér v agentovi + uživatel vyplní přihlašovací údaje). Fallback na
    // původní trojici, když je struktura credentials neočekávaná.
    const KNOWN_PLATFORMS = ['adultwork', 'amateri', 'onlyfans'];
    const configuredPlatforms = decryptedCredentials
      ? Object.keys(decryptedCredentials).filter((k) => {
          const v = decryptedCredentials[k];
          return v && typeof v === 'object' && (v.user || v.username || v.pass);
        })
      : [];
    const platforms = configuredPlatforms.length ? configuredPlatforms : KNOWN_PLATFORMS;
    const io = getIO();
    // POUZE agentovi, ne celé agentuře. Do `agency_<id>` vstupuje každý
    // přihlášený socket včetně prohlížečů operátorek — ty by tak v síťovém
    // provozu dostaly hesla modelky k externím webům, přestože je nepotřebují.
    //
    // POZOR: `sync_chat` a `send_sms` míří na relay TELEFON a musí zůstat
    // v agency_ místnosti. Přesouvají se jen příkazy, které nesou credentials.
    io.to(`agent_${profile.agencyId}`).emit('relay_command', { type: 'SYNC_WEB_PROFILE', profileId: id, payload: { name: name || profile.name, bio: bio || profile.bio, credentials: decryptedCredentials, platforms } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.getCredentials = async (req, res) => {
  try {
    const { id } = req.params;
    const { agencyId, role } = req.user;
    const { normalizeRole } = require('../utils/roleUtils');
    const roleNameClean = normalizeRole(role?.name || role);
    const isAppOwner = !!role?.isAppOwner || ['app_owner', 'owner'].includes(roleNameClean);
    const isManager = !!role?.isManager || isAppOwner || 
                     ['manager', 'agency_admin', 'senior_operator', 'senior_manager'].includes(roleNameClean);

    if (!isManager) return res.status(403).json({ message: 'Forbidden' });

    const profile = await prisma.profile.findUnique({ where: { id } });
    if (!profile || (profile.agencyId !== String(agencyId) && !isAppOwner)) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    let decrypted = null;
    if (profile.credentials) {
      const decryptedString = await decrypt(profile.credentials);
      if (decryptedString) {
        try {
          decrypted = JSON.parse(decryptedString);
        } catch (e) {
          decrypted = { raw: decryptedString }; // Fallback
        }
      }
    }

    res.json({ credentials: decrypted });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

exports.boostProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const { platform } = req.body;
    if (!requireProfileManager(req, res)) return;

    const profile = await getScopedProfile(id, req);
    if (!profile) return res.status(404).json({ message: 'Not found' });

    let decryptedCredentials = null;
    if (profile.credentials) {
      const decryptedString = await decrypt(profile.credentials);
      if (decryptedString) decryptedCredentials = JSON.parse(decryptedString);
    }

    const data = parseData(profile.data);
    const automationSettings = data.awAutomation || {};

    const io = getIO();
    // Taky jen agentovi — nese credentials, viz komentář u SYNC_WEB_PROFILE.
    io.to(`agent_${profile.agencyId}`).emit('relay_command', {
      type: 'BOOST_WEB_PROFILE',
      profileId: id,
      payload: {
        name: profile.name,
        credentials: decryptedCredentials,
        platform,
        settings: automationSettings,
        adsPowerId: decryptedCredentials?.adsPowerId ?? null // adsPowerId žije v credentials; Profile takový sloupec nemá
      }
    });

    res.json({ ok: true, message: 'Boost command sent to local agent' });
  } catch (error) {
    logger.error('[Profiles] Boost error:', error);
    res.status(500).json({ message: 'Failed to start boost' });
  }
};
