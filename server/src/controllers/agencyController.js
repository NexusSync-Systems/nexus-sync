const prisma = require('../services/db');
const { JEN_RELAY } = require('../utils/deviceVariants');
const logger = require('../services/logger');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { isEffectiveAdmin } = require('./roleController');

exports.getUsers = async (req, res) => {
  try {
    const { agencyId, role, userId } = req.user;
    const { normalizeRole } = require('../utils/roleUtils');
    const roleNameClean = normalizeRole(role?.name || role);
    const isAppOwner = !!role?.isAppOwner || ['app_owner', 'owner'].includes(roleNameClean);
    const isManager = !!role?.isManager || isAppOwner || 
                     ['senior_operator', 'manager', 'agency_admin', 'senior_manager'].includes(roleNameClean);

    logger.info(`[Agency] Fetching Users for: ${userId}, Agency: ${agencyId}, Role: ${role?.name}, IsManager: ${isManager}`);

    if (!isManager) {
      logger.warn(`[Agency] Access denied for user ${userId} with role ${role?.name}`);
      return res.status(403).json({ message: `Access denied: ${role?.name || 'User'} is not a manager role` });
    }

    const users = await prisma.user.findMany({
      where: isAppOwner ? {} : { agencyId: String(agencyId) },
      select: { 
        id: true, 
        email: true, 
        name: true, 
        agencyId: true, 
        role: { select: { name: true } } 
      }
    });
    
    logger.info(`[Agency] Found ${users.length} users for agency ${agencyId}`);

    const mappedUsers = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role?.name || 'User',
      agencyId: u.agencyId,
      avatar: u.name?.charAt(0).toUpperCase() || 'U'
    }));
    
    res.json(mappedUsers);
  } catch (error) {
    logger.error('[Agency] getUsers ERROR:', error);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

exports.getStats = async (req, res) => {
  try {
    const { agencyId, role, userId } = req.user;
    const { normalizeRole } = require('../utils/roleUtils');
    const roleNameClean = normalizeRole(role?.name || role);
    const isAppOwner = !!role?.isAppOwner || ['app_owner', 'owner'].includes(roleNameClean);
    const isManager = !!role?.isManager || isAppOwner || 
                     ['senior_operator', 'manager', 'agency_admin', 'senior_manager'].includes(roleNameClean);

    logger.info(`[Agency] Fetching Stats for: ${userId}, Agency: ${agencyId}, Role: ${role?.name}`);

    if (!isManager) {
      return res.status(403).json({ message: 'Denied' });
    }

    const agencyFilter = isAppOwner ? {} : { agencyId: String(agencyId) };

    // totalBookings se dřív počítalo z safetySession. Jenže plánovaná relace
    // vzniká JEN u výjezdů (`ensurePlannedSafetySession` v bookingController
    // se u incall schválně nespustí), takže dlaždice „Rezervací celkem“ na
    // dashboardu nepočítala žádnou schůzku v provozovně. Agentuře, která dělá
    // převážně incall, ukazovala skoro nulu — číslo bylo prostě špatně pod
    // svým vlastním popiskem.
    const [totalMessages, totalBookings, totalCalls] = await Promise.all([
      prisma.message.count({ where: isAppOwner ? {} : { chat: { agencyId: String(agencyId) } } }),
      prisma.booking.count({ where: agencyFilter }),
      prisma.callLog.count({ where: isAppOwner ? {} : { profile: { agencyId: String(agencyId) } } })
    ]);

    res.json({
      totalMessages,
      totalBookings,
      totalCalls,
      revenue: '0.00', // Simplified for now
      uptime: '100%',
      chartData: [0, 0, 0, 0, 0, 0, 0]
    });
  } catch (error) {
    logger.error('[Agency] getStats ERROR:', error);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
};

exports.updateSettings = async (req, res) => {
    try {
        const { role, agencyId: userAgencyId } = req.user;
        const { safetyAlertMode, agencyId: bodyAgencyId, name, email, region, defaultGraceMinutes, currency, timezone, aiInstructions } = req.body;
        const isAppOwner = role?.isAppOwner;
        const effectiveAdmin = await isEffectiveAdmin(role, userAgencyId);
        if (!isAppOwner && !effectiveAdmin) return res.status(403).json({ message: 'Forbidden' });
        const agencyId = isAppOwner ? bodyAgencyId : userAgencyId;
        const agency = await prisma.agency.update({ where: { id: agencyId }, data: { ...(safetyAlertMode && { safetyAlertMode }), ...(name && { name }), ...(email && { email }), ...(region && { region }), ...(defaultGraceMinutes && { defaultGraceMinutes }), ...(currency && { currency }), ...(timezone && { timezone }), ...(aiInstructions && { aiInstructions }) } });
        res.json(agency);
    } catch (error) {
        res.status(500).json({ message: 'Failed' });
    }
};

exports.getSettings = async (req, res) => {
  try {
    const { role, agencyId: userAgencyId } = req.user;
    const isAppOwner = role?.isAppOwner;
    const agencyId = isAppOwner ? req.query.agencyId : userAgencyId;
    const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true, tier: true, plan: true, safetyAlertMode: true, inviteCode: true, referralCode: true, aiInstructions: true, email: true, region: true } });
    res.json(agency || {});
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.getAgencies = async (req, res) => {
  try {
    const { role } = req.user;
    const isOwner = role?.isAppOwner || String(role?.name || '').toUpperCase() === 'APP OWNER';
    if (!isOwner) return res.status(403).json({ message: 'Access denied' });
    const agencies = await prisma.agency.findMany({ include: { users: { where: { role: { isManager: true } }, take: 1, select: { name: true, email: true } }, _count: { select: { users: true, profiles: true } } } });
    res.json(agencies.map(a => ({ id: a.id, name: a.name, region: a.region, status: 'active', managerName: a.users[0]?.name || 'N/A', usersCount: a._count.users, profilesCount: a._count.profiles })));
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.getAgency = async (req, res) => {
  try {
    const { role } = req.user;
    if (!role?.isAppOwner && String(role?.name || '').toUpperCase() !== 'APP OWNER') return res.status(403).json({ message: 'Access denied' });
    const agency = await prisma.agency.findUnique({ where: { id: req.params.id }, include: { _count: { select: { users: true, profiles: true } } } });
    if (!agency) return res.status(404).json({ message: 'Not found' });
    res.json({ ...agency, usersCount: agency._count.users, profilesCount: agency._count.profiles });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.createAgency = async (req, res) => {
  try {
    const { role } = req.user;
    if (!role?.isAppOwner && String(role?.name || '').toUpperCase() !== 'APP OWNER') return res.status(403).json({ message: 'Access denied' });
    const { name, region, tier } = req.body;
    const inviteCode = `NEXUS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const agency = await prisma.agency.create({ data: { name, region, tier: tier || 'Professional', plan: tier || 'Professional', inviteCode } });
    res.status(201).json(agency);
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.deleteAgency = async (req, res) => {
  try {
    const { role } = req.user;
    if (!role?.isAppOwner && String(role?.name || '').toUpperCase() !== 'APP OWNER') return res.status(403).json({ message: 'Access denied' });
    await prisma.agency.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

exports.addUser = async (req, res) => {
  try {
    const { role, agencyId: userAgencyId } = req.user;
    const isAppOwner = !!role?.isAppOwner;
    const effectiveAdmin = await isEffectiveAdmin(role, userAgencyId);
    if (!isAppOwner && !effectiveAdmin) return res.status(403).json({ message: 'Forbidden' });
    const { name, email, password, roleId, roleName: bodyRoleName, role: bodyRole, agencyId: bodyAgencyId } = req.body;
    const targetAgencyId = isAppOwner ? bodyAgencyId : userAgencyId;
    if (!targetAgencyId) return res.status(400).json({ message: 'Target agency is required' });

    const requestedRoleName = bodyRoleName || bodyRole;
    let targetRole = null;

    if (roleId) {
      targetRole = await prisma.role.findFirst({
        where: { id: String(roleId), agencyId: String(targetAgencyId) }
      });
    } else if (requestedRoleName) {
      targetRole = await prisma.role.findFirst({
        where: { name: String(requestedRoleName), agencyId: String(targetAgencyId) }
      });

      if (!targetRole) {
        const globalTemplate = await prisma.role.findFirst({
          where: { name: String(requestedRoleName), agencyId: null }
        });

        if (globalTemplate && !globalTemplate.isAppOwner) {
          targetRole = await prisma.role.create({
            data: {
              name: globalTemplate.name,
              description: globalTemplate.description,
              permissions: globalTemplate.permissions,
              minTier: globalTemplate.minTier,
              isManager: globalTemplate.isManager,
              isAppOwner: false,
              agencyId: String(targetAgencyId)
            }
          });
        }
      }
    }

    if (!targetRole) return res.status(400).json({ message: 'Valid roleId or roleName is required' });
    if (targetRole.isAppOwner) return res.status(403).json({ message: 'Cannot assign App Owner role from agency user management' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({ data: { name, email, password: hashedPassword, roleId: targetRole.id, agencyId: targetAgencyId }, include: { role: true } });
    res.status(201).json({ id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role.name, agencyId: newUser.agencyId });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};

// Doba, po kterou se relay bere jako připojený. Foreground service se ptá na
// outbox každých 30 s, takže dvě minuty snesou tři zmeškané dotazy — dost na
// krátký výpadek sítě, málo na to, aby vypnutý telefon svítil zeleně dlouho.
const RELAY_ONLINE_MS = 2 * 60 * 1000;

exports.getRelayStatus = async (req, res) => {
  try {
    const { agencyId } = req.user;
    if (!agencyId) return res.json({ online: false, activeRelays: 0 });

    // Dřív se počítala velikost místnosti `agency_<id>`. Do té ale vstupuje
    // KAŽDÝ přihlášený socket včetně prohlížečů operátorek (socket.js), takže
    // odznak „Agent online" svítil zeleně, kdykoli měl někdo otevřený
    // dashboard — i když nebyl připojený žádný relay telefon. U ukazatele,
    // podle kterého se pozná, jestli vůbec chodí SMS, je to horší než nic.
    //
    // Nešlo to spočítat ani podle místnosti `relay:<installationId>`: do ní se
    // hlásí jedině NexusInCall.js, tedy GSM most, který je od #96 výchozí
    // vypnutý. Stav by pak hlásil offline pořád.
    //
    // lastSeenAt je oproti tomu skutečný tep zařízení — obnovuje ho příchozí
    // SMS (handleRelay), dotaz na outbox (getOutbox) i SIP ping.
    const cerstve = new Date(Date.now() - RELAY_ONLINE_MS);
    // `...JEN_RELAY`: počítají se relay telefony, ne všechna spárovaná
    // zařízení. Plná aplikace modelky má od #188 vlastní vazbu a bez
    // tohoto filtru by hlásila „relay je online" i tehdy, když relay
    // telefon leží vybitý doma — tedy přesně v situaci, kvůli které se
    // ten ukazatel sleduje.
    const activeRelays = await prisma.deviceBinding.count({
      where: {
        agencyId: String(agencyId),
        ...JEN_RELAY,
        active: true,
        lastSeenAt: { gte: cerstve },
      },
    });

    res.json({ online: activeRelays > 0, activeRelays });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
};
