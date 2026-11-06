const { VYCHOZI_ROLE, dataRole } = require('../config/vychoziRole');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../services/db');
const { logAction } = require('./auditController');
const { isAppOwnerRole } = require('../utils/authz');
const { sendPasswordReset, sendWelcomeEmail, sendAgencyRegistrationEmail } = require('../services/emailService');

const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_DAYS = 7;

// httpOnly refresh-token cookie (web). Native/Capacitor clients keep using the
// body token because cross-origin cookies are unreliable in a WebView.
const REFRESH_COOKIE = 'nexus_rt';
// Cross-origin refresh cookie must be Secure + SameSite=None. Treat anything that
// isn't explicit development as prod so an unset NODE_ENV on an HTTPS host still works.
const IS_PROD = process.env.NODE_ENV !== 'development';
function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  });
}
function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? 'none' : 'lax', path: '/api/auth' });
}
const DUMMY_PASSWORD_HASH = '$2a$10$8DCENsW0fuhKRpdFa9GBa.NtIh1ZHWzPBWWcNU8ZTBfNxHyhaDK9W';

// ── Security-PIN brute-force lockout ──────────────────────────────────────────
// A 4-digit PIN má jen 10 000 kombinací, takže bez omezení pokusů je uhádnutelný.
// Lockout je in-memory (per-instance) — pro víc instancí je vhodné přesunout do
// Redis, ale i takto zásadně zvedá laťku (endpoint navíc vyžaduje platnou session).
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const pinAttempts = new Map(); // userId -> { count, lockedUntil }

function pinLockRemaining(userId, now = Date.now()) {
  const e = pinAttempts.get(userId);
  if (e && e.lockedUntil > now) return e.lockedUntil - now;
  return 0;
}
function registerPinFailure(userId, now = Date.now()) {
  const e = pinAttempts.get(userId) || { count: 0, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= PIN_MAX_ATTEMPTS) {
    e.lockedUntil = now + PIN_LOCK_MS;
    e.count = 0; // reset počítadla, lockout běží podle času
  }
  pinAttempts.set(userId, e);
}
function clearPinFailures(userId) {
  pinAttempts.delete(userId);
}

async function comparePassword(password, hash) {
  const candidateHash = typeof hash === 'string' && hash ? hash : DUMMY_PASSWORD_HASH;

  try {
    const matches = await bcrypt.compare(String(password || ''), candidateHash);
    return typeof hash === 'string' && hash.length > 0 && matches;
  } catch {
    return false;
  }
}

async function withAssignedProfile(user) {
  if (!user?.id) return user;

  try {
    // Profil, který uživatel VLASTNÍ (modelka), nebo který má přiřazený
    // (operátorka). Vlastnictví je první v pořadí, protože modelka není
    // ničí assignee — bez toho by `profileId` vyšlo null a relay telefon
    // by se nespároval.
    const assignedProfiles = await prisma.profile.findMany({
      where: {
        OR: [
          { ownerId: user.id },
          { assignees: { some: { id: user.id } } }
        ]
      },
      orderBy: { ownerId: 'desc' },   // vlastněný profil první
      take: 1,
      select: { id: true }
    });
    return { ...user, assignedProfiles: assignedProfiles || [] };
  } catch (error) {
    console.error('[Auth] Assigned profile lookup failed:', error.message);
    return { ...user, assignedProfiles: [] };
  }
}

async function withAuthContext(user, options = {}) {
  if (!user?.id) return user;
  const includeProfile = options.includeProfile !== false;
  const context = { ...user };

  if (!context.role && context.roleId) {
    try {
      context.role = await prisma.role.findUnique({ where: { id: context.roleId } });
    } catch (error) {
      console.error('[Auth] Role lookup failed:', error.message);
      context.role = null;
    }
  }

  if (context.agency === undefined) {
    if (context.agencyId) {
      try {
        context.agency = await prisma.agency.findUnique({
          where: { id: context.agencyId },
          select: { id: true, name: true }
        });
      } catch (error) {
        console.error('[Auth] Agency lookup failed:', error.message);
        context.agency = null;
      }
    } else {
      context.agency = null;
    }
  }

  return includeProfile ? withAssignedProfile(context) : context;
}

function hasUsableRole(user) {
  return Boolean(user?.role?.name);
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return 'Password is required';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}

function generateAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      agencyId: user.agencyId,
      role: {
        name: user.role.name,
        isManager: user.role.isManager,
        isAppOwner: user.role.isAppOwner
      }
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

function generateRelayToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      agencyId: user.agencyId,
      role: {
        name: user.role.name,
        isManager: user.role.isManager,
        isAppOwner: user.role.isAppOwner
      },
      type: 'relay',
      tv: user.tokenVersion || 0 // revokace: musí sedět s user.tokenVersion
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' } // Long-lived for automation (revokovatelné přes tokenVersion)
  );
}

async function generateRefreshToken(userId) {
  const token = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_DAYS);

  await prisma.refreshToken.create({
    data: { token, userId, expiresAt }
  });

  return token;
}

function buildUserResponse(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role.name,
    isManager: user.role.isManager,
    isAppOwner: user.role.isAppOwner,
    agencyId: user.agencyId,
    agencyName: user.agency?.name || 'System',
    profileId: user.assignedProfiles?.[0]?.id || null,
    hasPin: !!user.securityPin
  };
}

exports.login = async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body;
    const email = rawEmail?.toLowerCase();
    
    const user = await prisma.user.findUnique({
      where: { email }
    });

    const passwordMatches = await comparePassword(password, user?.password);
    if (!user || !passwordMatches) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const userWithProfile = await withAuthContext(user);
    if (!hasUsableRole(userWithProfile)) {
      return res.status(403).json({ message: 'User role is not configured' });
    }

    const accessToken = generateAccessToken(userWithProfile);
    const refreshToken = await generateRefreshToken(userWithProfile.id);
    setRefreshCookie(res, refreshToken);

    logAction(userWithProfile.agencyId, userWithProfile.id, 'LOGIN', `User ${userWithProfile.email} logged in`);

    res.json({
      token: accessToken,
      refreshToken,
      expiresIn: 3600,
      user: buildUserResponse(userWithProfile)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.refresh = async (req, res) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE] || req.body.refreshToken;
    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' });
    }

    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true }
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      return res.status(401).json({ message: 'Invalid or expired refresh token' });
    }

    // Rotate: revoke old, issue new pair
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() }
    });

    const userWithProfile = await withAuthContext(stored.user);
    if (!hasUsableRole(userWithProfile)) {
      return res.status(403).json({ message: 'User role is not configured' });
    }

    const accessToken = generateAccessToken(userWithProfile);
    const newRefreshToken = await generateRefreshToken(stored.userId);
    setRefreshCookie(res, newRefreshToken);

    res.json({
      token: accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 3600,
      user: buildUserResponse(userWithProfile)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.logout = async (req, res) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE] || req.body.refreshToken;
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { token: refreshToken, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    }
    clearRefreshCookie(res);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.registerAgency = async (req, res) => {
  try {
    const { agencyName, fullName, email: rawEmail2, password, referralCode } = req.body;
    const email = rawEmail2?.toLowerCase();
    
    // Validate password
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }
    
    // 1. Check if user exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 12);

    // 2. Create Agency, Admin Role, and User in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const agency = await tx.agency.create({
        data: {
          name: agencyName,
          region: 'Global',
          plan: 'Standard',
          inviteCode: `NEXUS-${crypto.randomBytes(6).toString('hex').toUpperCase()}`
        }
      });

      const globalTemplate = await tx.role.findFirst({
        where: { name: 'Agency Admin', agencyId: null }
      });

      const defaultPerms = JSON.stringify({
        permissions: true, hierarchy: true, analytics: true, messaging: true,
        calendar: true, profiles: true, web_profiles: true, device_setup: true,
        audit_logs: true, qa_hub: true, settings: true, inventory: false
      });

      // Zakládají se VŠECHNY tři role, ne jen admin. Dřív vznikla jen
      // „Agency Admin" a ostatní se dotvářely až při pozvánce — agentura
      // tedy neměla vedoucí operátorku, dokud si o ni někdo nepřišel.
      await tx.role.createMany({
        data: VYCHOZI_ROLE.map((r) =>
          dataRole(r.name, agency.id, r.name === 'Agency Admin' ? globalTemplate : null))
      });
      const role = await tx.role.findFirst({
        where: { agencyId: agency.id, name: 'Agency Admin' }
      });

      const user = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name: fullName,
          roleId: role.id,
          agencyId: agency.id
        }
      });

      return { agency, user };
    });

    // Track referral if code provided
    if (referralCode) {
      const { applyReferral } = require('./referralController');
      await applyReferral(referralCode, result.agency.id);
    }

    logAction(result.agency.id, result.user.id, 'AGENCY_REGISTERED', `Agency "${agencyName}" created`);

    // Send registration confirmation email (non-blocking)
    sendAgencyRegistrationEmail(email, agencyName).catch(err => {
      console.error('[Email] Agency registration email failed:', err.message);
    });

    res.status(201).json({ 
      message: 'Agency registered successfully',
      agencyId: result.agency.id,
      inviteCode: result.agency.inviteCode
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Registration failed' });
  }
};

exports.registerUser = async (req, res) => {
  try {
    const { fullName, email: rawEmail3, password, inviteCode, roleName } = req.body;
    const email = rawEmail3?.toLowerCase();

    // Validate password
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    // Only allow self-registration for safe roles
    const allowedRoles = ['Operator', 'Model'];
    const requestedRole = allowedRoles.includes(roleName) ? roleName : 'Operator';
    
    const agency = await prisma.agency.findFirst({ where: { inviteCode } });
    if (!agency) return res.status(404).json({ message: 'Invalid invite code' });

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 12);
    
    const rolePermissions = requestedRole === 'Model'
      ? JSON.stringify({ messaging: true, calendar: true })
      : JSON.stringify({ messaging: true, calendar: true, profiles: true, device_setup: true, settings: true });

    let role = await prisma.role.findFirst({ 
      where: { agencyId: agency.id, name: requestedRole } 
    });

    if (!role) {
      const globalTemplate = await prisma.role.findFirst({
        where: { name: requestedRole, agencyId: null }
      });

      // `isManager` se dřív nenastavoval vůbec → schéma dosadilo `false`,
      // takže „Senior Operator" vznikla jako řadová operátorka.
      role = await prisma.role.create({
        data: dataRole(requestedRole, agency.id, globalTemplate)
      });
    }

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: fullName,
        roleId: role.id,
        agencyId: agency.id
      }
    });

    // Send welcome email (non-blocking)
    sendWelcomeEmail(email, fullName, agency.name).catch(err => {
      console.error('[Email] Welcome email failed:', err.message);
    });

    res.status(201).json({ message: 'Registered successfully', userId: user.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Registration failed' });
  }
};

exports.resetPasswordRequest = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    
    if (user) {
      // JWT reset token (1h). Secret = JWT_SECRET + aktuální hash hesla, takže se
      // token po změně hesla sám zneplatní (jednorázový, nelze přehrát).
      const secret = process.env.JWT_SECRET + user.password;
      const resetToken = jwt.sign(
        { userId: user.id, type: 'password_reset' },
        secret,
        { expiresIn: '1h' }
      );
      console.log(`[RESET] Password reset requested for ${email}`);
      await sendPasswordReset(email, resetToken).catch(err => {
        console.error('[RESET] Email send failed:', err.message);
      });
    }

    // Always respond with success for security (don't reveal if email exists)
    res.json({ message: 'If the email exists, a reset link has been sent.' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

exports.resetPasswordConfirm = async (req, res) => {
  try {
    const { token: resetToken, password } = req.body;
    if (!resetToken || !password) {
      return res.status(400).json({ message: 'Token and new password are required' });
    }
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ message: pwError });

    // Dekóduj bez ověření, ať zjistíš uživatele — secret pro ověření závisí na jeho
    // aktuálním hesle (viz resetPasswordRequest).
    const decodedToken = jwt.decode(resetToken);
    if (!decodedToken || decodedToken.type !== 'password_reset' || !decodedToken.userId) {
      return res.status(400).json({ message: 'Invalid token' });
    }

    const user = await prisma.user.findUnique({ where: { id: decodedToken.userId } });
    if (!user) return res.status(400).json({ message: 'Invalid user' });

    let decoded;
    try {
      // Secret = JWT_SECRET + hash hesla → jednorázový token; HS256 zafixované.
      const secret = process.env.JWT_SECRET + user.password;
      decoded = jwt.verify(resetToken, secret, { algorithms: ['HS256'] });
    } catch {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: decoded.userId },
      data: { password: hashedPassword },
    });

    // Po resetu hesla zneplatni všechny existující session — jinak by případný
    // útočník (který účet převzal) zůstal přihlášený přes svůj refresh token.
    await prisma.refreshToken.updateMany({
      where: { userId: decoded.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    res.json({ message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('[RESET] Confirm error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }
    });
    
    if (!user) return res.status(404).json({ message: 'User not found' });
    const userWithProfile = await withAuthContext(user);
    if (!hasUsableRole(userWithProfile)) {
      return res.status(403).json({ message: 'User role is not configured' });
    }
    
    res.json({
      id: userWithProfile.id,
      email: userWithProfile.email,
      name: userWithProfile.name,
      role: userWithProfile.role.name,
      isManager: userWithProfile.role.isManager,
      isAppOwner: userWithProfile.role.isAppOwner,
      agencyId: userWithProfile.agencyId,
      agencyName: userWithProfile.agency?.name || 'System',
      profileId: userWithProfile.assignedProfiles?.[0]?.id || null
    });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getRelayToken = async (req, res) => {
  try {
    // Relay token = full-access 30d pověření pro automatizaci (local-agent/CI).
    // Razit smí jen App Owner — nastavení automatizace je vlastníkova věc, ne
    // Operátora/Modelky (ti by si jinak vygenerovali plnoprávnou propustku).
    if (!isAppOwnerRole(req.user?.role)) {
      return res.status(403).json({ message: 'Only the app owner can generate relay tokens' });
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: { role: true }
    });

    if (!user) return res.status(404).json({ message: 'User not found' });

    const token = generateRelayToken(user);
    res.json({ token });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// POST /api/auth/relay-token/revoke — zneplatní VŠECHNY relay tokeny volajícího
// (bump tokenVersion). Použij, když propustka unikla. Vyžaduje App Ownera.
exports.revokeRelayTokens = async (req, res) => {
  try {
    if (!isAppOwnerRole(req.user?.role)) {
      return res.status(403).json({ message: 'Only the app owner can revoke relay tokens' });
    }
    const updated = await prisma.user.update({
      where: { id: req.user.userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    res.json({ ok: true, tokenVersion: updated.tokenVersion });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

exports.setSecurityPin = async (req, res) => {
  try {
    const { pin, password } = req.body;
    if (!pin || pin.length < 4) return res.status(400).json({ message: 'PIN must be at least 4 digits' });
    
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    // Verify password for extra security when changing PIN
    if (!(await comparePassword(password, user.password))) {
      return res.status(401).json({ message: 'Invalid password' });
    }
    
    const hashedPin = await bcrypt.hash(pin, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: { securityPin: hashedPin }
    });
    
    logAction(user.agencyId, user.id, 'SECURITY_PIN_UPDATE', 'User updated security PIN');
    res.json({ message: 'Security PIN updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.verifySecurityPin = async (req, res) => {
  try {
    const userId = req.user.userId;

    const lockMs = pinLockRemaining(userId);
    if (lockMs > 0) {
      return res.status(429).json({
        message: 'Too many attempts, PIN temporarily locked',
        retryAfterSeconds: Math.ceil(lockMs / 1000),
      });
    }

    const { pin } = req.body;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.securityPin) return res.status(400).json({ message: 'PIN not set' });

    const isValid = await bcrypt.compare(String(pin || ''), user.securityPin);
    if (!isValid) {
      registerPinFailure(userId);
      const stillLocked = pinLockRemaining(userId);
      if (stillLocked > 0) {
        return res.status(429).json({
          message: 'Too many attempts, PIN temporarily locked',
          retryAfterSeconds: Math.ceil(stillLocked / 1000),
        });
      }
      return res.status(401).json({ message: 'Invalid PIN' });
    }

    clearPinFailures(userId);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};
