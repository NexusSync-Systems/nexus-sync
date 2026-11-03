const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const logger = require('./services/logger');
const { sendAlert } = require('./services/alertService');
const billingController = require('./controllers/billingController');

// ── Startup: enforce required secrets ────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET is missing or too short (min 32 chars). Refusing to start.');
  process.exit(1);
}
if (!process.env.DEVICE_SECRET || process.env.DEVICE_SECRET.length < 16) {
  console.error('[FATAL] DEVICE_SECRET is missing or too short (min 16 chars). Refusing to start.');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  console.error('[FATAL] ENCRYPTION_KEY is missing or too short (min 32 chars). Refusing to start.');
  process.exit(1);
}

// Route imports
const authRoutes = require('./routes/authRoutes');
const profileRoutes = require('./routes/profileRoutes');
const chatRoutes = require('./routes/chatRoutes');
const messageRoutes = require('./routes/messageRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const trackerRoutes = require('./routes/trackerRoutes');
const safetyRoutes = require('./routes/safetyRoutes');
const agencyRoutes = require('./routes/agencyRoutes');
const vultrRoutes = require('./routes/vultrRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const notesRoutes = require('./routes/notesRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const adminRoutes = require('./routes/adminRoutes');
const sipRoutes = require('./routes/sipRoutes');
const trunkRoutes = require('./routes/trunkRoutes');
const blacklistRoutes = require('./routes/blacklistRoutes');
const sosRoutes = require('./routes/sosRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const qaRoutes = require('./routes/qaRoutes');
const callRoutes = require('./routes/callRoutes');
const emergencyRoutes = require('./routes/emergencyRoutes');
const aiRoutes = require('./routes/aiRoutes');
const referralRoutes = require('./routes/referralRoutes');
const auditRoutes = require('./routes/auditRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const clientRoutes = require('./routes/clientRoutes');
const payoutRoutes = require('./routes/payoutRoutes');
const hetznerRoutes = require('./routes/hetznerRoutes');
const apiKeyRoutes = require('./routes/apiKeyRoutes');
const salonKeyRoutes = require('./routes/salonKeyRoutes');
const teamChatRoutes = require('./routes/teamChatRoutes');
const smsRoutes = require('./routes/smsRoutes');
const publicApiRoutes = require('./routes/api/v1/publicApiRoutes');

const app = express();

app.set('trust proxy', 1);

// Redact sensitive query params before any URL is logged
const redactUrl = (url) => String(url).replace(/([?&](?:secret|token|password|api[_-]?key)=)[^&#]*/gi, '$1[REDACTED]');

// Static file serving for downloads with logging
app.use('/downloads', (req, res, next) => {
  console.log(`[Static] Request for: ${redactUrl(req.url)}`);
  next();
}, express.static(path.join(__dirname, '..', 'public', 'downloads')));

// Rate limiting: global 5000 req/15min
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' }
});

// Auth brute-force protection — two independent layers, whichever trips first:
//  1) per-IP: caps total auth attempts from a single source, so password spraying
//     across many accounts from one IP is throttled (dřív se klíčovalo e-mailem,
//     takže různé e-maily nesdílely counter a spraying prošel).
//  2) per-email: caps attempts against a single account, stopping targeted
//     brute-force even from rotating IPs.
const authIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { message: 'Too many auth attempts, please try again later.' }
});

const authEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Bije jen tam, kde je v těle e-mail (login / reset / register); ostatní auth
  // endpointy (refresh, logout, …) se přeskočí a řídí se jen per-IP limitem.
  skip: (req) => !req.body?.email,
  keyGenerator: (req) => `email:${req.body.email.toLowerCase()}`,
  message: { message: 'Too many attempts for this account, please try again later.' }
});

// Write operations (POST/PUT/PATCH/DELETE): 1000 req/15min
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.originalUrl.includes('/webrtc/'),
  message: { message: 'Too many write requests, please try again later.' }
});

// Device endpoints: 3000 req/15min (relay polling every 15s).
// WebRTC signaling is exempt here — it has its own dedicated limiter so bursty
// ICE traffic is isolated from SMS-relay polling on the same IP.
const deviceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.originalUrl.includes('/webrtc/'),
  message: { message: 'Too many device requests, please try again later.' }
});

// Analytics: 600 req/15min
const analyticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many analytics requests, please try again later.' }
});

const positiveIntEnv = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Public Stripe webhook: keep raw body for signature verification, but rate-limit abuse.
const billingWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: positiveIntEnv('BILLING_WEBHOOK_RATE_LIMIT', 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many billing webhook requests, please try again later.' }
});

app.use(helmet({
  contentSecurityPolicy: false, // API server, no HTML pages
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' } // Allow APK downloads
}));

// CORS: restrict to known origins
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Bez ALLOWED_ORIGINS projde z prohlizece jen firebase.app/web.app a Capacitor
// localhost — web na vlastni domene dostane 403, ktere v UI vypada jako chyba
// prihlaseni. Tohle se stalo 3. 11. 2026 na novem serveru, tak ted aspon krici.
if (process.env.NODE_ENV === 'production' && !allowedOrigins.some(o => o.startsWith('https://'))) {
  logger.warn(
    'ALLOWED_ORIGINS neobsahuje zadny https origin — web na vlastni domene ' +
    'dostane z API 403 (CORS). Nastav napr. ALLOWED_ORIGINS=https://example.eu'
  );
}

// Capacitor Android/iOS WebView always uses these origins — must be unconditionally allowed.
const CAPACITOR_ORIGINS = [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost'
];

// Dev-only origins (not allowed in production)
if (process.env.NODE_ENV !== 'production') {
  CAPACITOR_ORIGINS.push('http://localhost:5173', 'http://localhost:3000');
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile app, curl)
    if (!origin) return callback(null, true);
    
    // Exact allowlist for Firebase domains
    const FIREBASE_ORIGINS = [
      'https://nexus-hub.firebaseapp.com',
      'https://nexus-hub.web.app',
      'https://nexus-sync-8d50b.firebaseapp.com',
      'https://nexus-sync-8d50b.web.app'
    ];
    
    // Always allow known patterns
    const isAllowed = allowedOrigins.includes(origin) || 
                      FIREBASE_ORIGINS.includes(origin) ||
                      CAPACITOR_ORIGINS.includes(origin);

    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn(`CORS Blocked for origin: ${origin}`);
      callback(new Error(`CORS: Origin ${origin} not allowed`));
    }
  },
  credentials: true
}));

// Fix for Android native plugin sending non-standard "application/json; utf-8" (missing charset=)
app.use((req, res, next) => {
  if (req.headers['content-type'] === 'application/json; utf-8') {
    req.headers['content-type'] = 'application/json; charset=utf-8';
  }
  next();
});

app.post('/api/billing/webhook', billingWebhookLimiter, express.raw({ type: 'application/json' }), (req, res) => billingController.handleWebhook(req, res));

app.use(express.json({ limit: '64kb' }));

// Minimal cookie parser (no extra dependency): populates req.cookies for the
// httpOnly refresh-token cookie. res.cookie/clearCookie are native to Express.
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) {
        const k = part.slice(0, idx).trim();
        if (k) {
          try { req.cookies[k] = decodeURIComponent(part.slice(idx + 1).trim()); }
          catch { req.cookies[k] = part.slice(idx + 1).trim(); }
        }
      }
    }
  }
  next();
});

// Apply global limiter to all API routes
app.use('/api/', limiter);
// Per-route granular limiters
app.use('/api/auth', authIpLimiter, authEmailLimiter);
app.use('/api/device', deviceLimiter);
app.use('/api/trackers', deviceLimiter);
app.use('/api/analytics', analyticsLimiter);
// Write operation limiter for mutation-heavy routes
app.use('/api/profiles', writeLimiter);
app.use('/api/bookings', writeLimiter);
app.use('/api/messages', writeLimiter);
app.use('/api/chats', writeLimiter);
app.use('/api/blacklist', writeLimiter);
app.use('/api/agency', writeLimiter);
app.use('/api/clients', writeLimiter);
app.use('/api/calls', writeLimiter);
// SOS has no extra limiter — safety-critical

if (process.env.NODE_ENV !== 'test') {
  const { ensureSchemaIntegrity } = require('./services/schemaService');
  ensureSchemaIntegrity().catch(() => {
    // Schema integrity check is best-effort
  });
}

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${redactUrl(req.url)} - ${req.ip}`);
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/trackers', trackerRoutes);
app.use('/api/safety', safetyRoutes);
app.use('/api/agency', agencyRoutes);
app.use('/api/vultr', vultrRoutes);
app.use('/api/hetzner', hetznerRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sip', sipRoutes);
app.use('/api/trunks', trunkRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/blacklist', blacklistRoutes);
app.use('/api/sos', sosRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/emergencies', emergencyRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/payouts', require('./routes/payoutRoutes'));
app.use('/api/billing', require('./routes/billingRoutes'));
app.use('/api/webhooks', require('./routes/webhookRoutes'));
app.use('/api/clients', clientRoutes);
app.use('/api/developer/keys', apiKeyRoutes);
app.use('/api/salon-keys', salonKeyRoutes);
app.use('/api/team-chat', teamChatRoutes);
app.use('/api/v1/public', publicApiRoutes);

// Health check with system status
const healthCheckHandler = async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024)
  };
  
  // Check DB connectivity
  try {
    const prisma = require('./services/db');
    await prisma.$queryRaw`SELECT 1`;
    health.database = 'connected';
  } catch {
    health.database = 'disconnected';
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
};

app.get('/health', healthCheckHandler);
app.get('/api/health', healthCheckHandler);
app.get('/api/admin/health', healthCheckHandler);

// Swagger API documentation (disabled in production for security)
if (process.env.NODE_ENV !== 'production') {
  const swaggerJsdoc = require('swagger-jsdoc');
  const swaggerUi = require('swagger-ui-express');
  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Nexus Hub API',
        version: '1.0.0',
        description: 'Multi-tenant escort agency management platform API'
      },
      servers: [{ url: '/api' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-KEY', description: 'Format nx_live_<ID>.<SECRET>, vydava POST /developer/keys' }
        }
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'Auth', description: 'Authentication & registration' },
        { name: 'Agency', description: 'Agency management & stats' },
        { name: 'Profiles', description: 'Profile management' },
        { name: 'Messaging', description: 'Chats & messages' },
        { name: 'Bookings', description: 'Booking management' },
        { name: 'Safety', description: 'Safety sessions & SOS' },
        { name: 'Device', description: 'Device binding & relay' },
        { name: 'Analytics', description: 'Statistics & reports' },
        { name: 'Admin', description: 'Global admin features' },
        { name: 'Public API', description: 'Externi API na klic (X-API-KEY), tarif Agency' }
      ],
      paths: {
        '/auth/login': { post: { tags: ['Auth'], summary: 'Login', security: [], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } } }, responses: { 200: { description: 'JWT token + refresh token + user data' }, 401: { description: 'Invalid credentials' } } } },
        '/auth/refresh': { post: { tags: ['Auth'], summary: 'Refresh access token', security: [], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } } } } }, responses: { 200: { description: 'New token pair' }, 401: { description: 'Invalid refresh token' } } } },
        '/auth/logout': { post: { tags: ['Auth'], summary: 'Logout (revoke refresh token)', security: [], responses: { 200: { description: 'Logged out' } } } },
        '/auth/register-agency': { post: { tags: ['Auth'], summary: 'Register new agency', security: [], responses: { 201: { description: 'Agency created' } } } },
        '/auth/register-user': { post: { tags: ['Auth'], summary: 'Self-register with invite code', security: [], responses: { 201: { description: 'User created' } } } },
        '/auth/me': { get: { tags: ['Auth'], summary: 'Get current user profile', responses: { 200: { description: 'User profile' } } } },
        '/profiles': { get: { tags: ['Profiles'], summary: 'List profiles for agency', responses: { 200: { description: 'Array of profiles' } } }, post: { tags: ['Profiles'], summary: 'Create new profile', responses: { 201: { description: 'Profile created' } } } },
        '/profiles/{id}': { patch: { tags: ['Profiles'], summary: 'Update profile', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Id profilu z GET /profiles' }], responses: { 200: { description: 'Profile updated' } } } },
        '/chats': { get: { tags: ['Messaging'], summary: 'Get all chats for agency', responses: { 200: { description: 'Array of chats with latest messages' } } } },
        '/messages': { post: { tags: ['Messaging'], summary: 'Send message', responses: { 201: { description: 'Message sent' } } } },
        '/bookings': { get: { tags: ['Bookings'], summary: 'List bookings', responses: { 200: { description: 'Array of bookings' } } }, post: { tags: ['Bookings'], summary: 'Create booking', responses: { 201: { description: 'Booking created' } } } },
        '/safety/sessions': { post: { tags: ['Safety'], summary: 'Start safety session', responses: { 201: { description: 'Session started' } } } },
        '/safety/sessions/active': { get: { tags: ['Safety'], summary: 'Get active safety session', responses: { 200: { description: 'Active session or null' } } } },
        '/sos': { post: { tags: ['Safety'], summary: 'Trigger SOS alert', responses: { 201: { description: 'SOS alert created' } } } },
        '/agency/stats': { get: { tags: ['Agency'], summary: 'Get agency statistics', responses: { 200: { description: 'Stats object with counts and charts' } } } },
        '/agency/settings': { get: { tags: ['Agency'], summary: 'Get agency settings', responses: { 200: { description: 'Agency settings' } } }, patch: { tags: ['Agency'], summary: 'Update agency settings', responses: { 200: { description: 'Settings updated' } } } },
        '/analytics/summary': { get: { tags: ['Analytics'], summary: 'Revenue & booking summary', responses: { 200: { description: 'Summary with period comparison' } } } },
        '/analytics/daily': { get: { tags: ['Analytics'], summary: 'Daily stats for last N days', responses: { 200: { description: 'Array of daily stats' } } } },
        '/device/bindings': { get: { tags: ['Device'], summary: 'List device bindings', responses: { 200: { description: 'Array of bindings' } } } },
        '/blacklist': { get: { tags: ['Safety'], summary: 'Search blacklist entries', responses: { 200: { description: 'Array of entries' } } } },
        '/subscriptions/plans': { get: { tags: ['Agency'], summary: 'Plan options + pricing', security: [], responses: { 200: { description: 'Array of plans' } } } },
        '/subscriptions/current': { get: { tags: ['Agency'], summary: 'Current subscription', responses: { 200: { description: 'Subscription or null' } } } },
        '/subscriptions/history': { get: { tags: ['Agency'], summary: 'Subscription history', responses: { 200: { description: 'Array of subscriptions' } } } },
        '/developer/keys': {
          get: { tags: ['Public API'], summary: 'List API keys', responses: { 200: { description: 'Array of keys (bez tajne casti)' } } },
          post: {
            tags: ['Public API'],
            summary: 'Create API key',
            description: 'Vyzaduje tarif Agency nebo modul api_access — tataz podminka, jakou ma overovani na /v1/public/*. Vynechane scopes se doplni na read:stats, s nimz endpointy /profiles a /messages vraci 403.',
            requestBody: {
              required: false,
              content: { 'application/json': { schema: { type: 'object', properties: {
                name: { type: 'string', maxLength: 120, default: 'Default Key', description: 'Popisek klice' },
                scopes: { type: 'array', default: ['read:stats'], items: { type: 'string', enum: ['read:stats', 'read:profiles', 'read:messages', 'relay:bridge'] }, description: 'Prijima se i jeden retezec oddeleny carkami. relay:bridge neni HTTP endpoint, slouzi pro Socket.IO.' }
              } } } }
            },
            responses: {
              201: { description: 'apiKey (tajna cast, vraci se jen jednou), name, scopes' },
              400: { description: 'Nepodporovany scope — odpoved nese invalidScopes a allowedScopes' },
              403: { description: 'Uzivatel bez agentury, neni admin, nebo tarif bez API' }
            }
          }
        },
        '/developer/keys/{id}': {
          delete: {
            tags: ['Public API'],
            summary: 'Revoke API key',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Databazove id klice, jak ho vraci GET /developer/keys (ne keyId z hlavicky)' }],
            responses: { 200: { description: 'Revoked' }, 403: { description: 'Neni admin agentury' }, 404: { description: 'Klic nenalezen' } }
          }
        },
        '/v1/public/stats': { get: { tags: ['Public API'], summary: 'Metriky agentury', description: 'metrics.revenue je NEIMPLEMENTOVANE a vraci vzdy "0.00".', security: [{ apiKeyAuth: [] }], responses: { 200: { description: 'agencyId, timestamp, metrics' }, 401: { description: 'Chybi nebo neplatny X-API-KEY' }, 403: { description: 'Chybi scope read:stats, klic vyprsel, nebo tarif bez API' }, 429: { description: 'Prekrocen limit 60 pozadavku za minutu' } } } },
        '/v1/public/profiles': { get: { tags: ['Public API'], summary: 'Aktivni profily (max 1000)', security: [{ apiKeyAuth: [] }], responses: { 200: { description: 'Array profilu' }, 403: { description: 'Chybi scope read:profiles' } } } },
        '/v1/public/messages': { get: { tags: ['Public API'], summary: 'Posledni zpravy', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }], security: [{ apiKeyAuth: [] }], responses: { 200: { description: 'Array zprav' }, 403: { description: 'Chybi scope read:messages' } } } },
        '/admin/features': { get: { tags: ['Admin'], summary: 'List global features', responses: { 200: { description: 'Array of features' } } } }
      }
    },
    apis: []
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Nexus Hub API Docs'
  }));
}

// Neznama /api cesta vracela vychozi HTML stranku Expressu. Klient, ktery cte
// JSON, na tom spadne jinde a zdanlive bez souvislosti.
app.use('/api', (req, res) => {
  res.status(404).json({ message: `Endpoint ${req.method} /api${req.path} neexistuje` });
});

// Sentry error handler (must be before custom error handler)
try {
  const Sentry = require('@sentry/node');
  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }
} catch { /* Sentry not configured */ }

// Global Error Handler
app.use((err, _req, res, _next) => {
  // CORS errors
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ message: 'Request blocked by CORS policy' });
  }
  logger.error('Unhandled Error:', err);
  if (!res.headersSent) {
    sendAlert(`Unhandled Server Error: ${err.message}\nStack: ${err.stack?.substring(0, 200)}...`);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = app;
