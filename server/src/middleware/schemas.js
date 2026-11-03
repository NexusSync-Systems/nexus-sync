const { z } = require('zod');
const { VOLITELNE: VOLITELNE_DUVODY } = require('../config/blacklistReasons');

// Reusable atoms
const cuid = z.string().min(1).max(128);
const phone = z.string().max(32).optional();
const text = z.string().min(1).max(10000);
const optionalText = z.string().max(10000).optional().nullable();
const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime());
const severity = z.enum(['warning', 'danger']);
const locationType = z.enum(['incall', 'outcall']);
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const latitudeInput = z.coerce.number().min(-90).max(90);
const longitudeInput = z.coerce.number().min(-180).max(180);
const trackerIdentifier = z.preprocess(
  value => (typeof value === 'string' ? value.replace(/\s+/g, '') : value),
  z.string().min(4).max(64).regex(/^[A-Za-z0-9:_-]+$/, 'IMEI / tracker ID contains unsupported characters')
);
// SIP identifier — vkládá se do Asterisk konfigurace (endpoint/auth/exten). Musí být
// striktně alfanumerické, aby nešlo injektovat config direktivy / rozbít SSH heredoc.
const sipUserId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'sipUser contains unsupported characters');
// Zobrazované jméno — volný text, ale bez nových řádků / řídicích znaků (ochrana
// proti config injection přes profile.name, které se vkládá do Asterisk callerid).
// eslint-disable-next-line no-control-regex -- řídicí znaky odmítáme záměrně
const displayName = z.string().min(1).max(200).regex(/^[^\r\n\x00-\x1f]+$/, 'name contains control characters');

// ── Messages ─────────────────────────────────────────────────────────────────
const createMessage = z.object({
  chatId: cuid,
  text: text,
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  status: z.enum(['sent', 'delivered', 'read']).optional().default('sent'),
  transport: z.enum(['SMS', 'RCS', 'SIP', 'API', 'WEB']).optional().nullable(),
  senderId: cuid.optional().nullable()
});

const updateMessageStatus = z.object({
  status: z.enum(['sent', 'delivered', 'read', 'failed'])
});

// ── Bookings ─────────────────────────────────────────────────────────────────
const createBooking = z.object({
  profileId: cuid,
  title: z.string().min(1).max(500),
  startTime: isoDate,
  endTime: isoDate,
  locationType: locationType.optional().default('incall'),
  clientPhone: phone,
  clientName: z.string().max(200).optional().nullable(),
  price: z.coerce.number().min(0).max(1000000).optional(),
  source: z.string().max(50).optional().nullable()
});

const updateBooking = z.object({
  title: z.string().min(1).max(500).optional(),
  startTime: isoDate.optional(),
  endTime: isoDate.optional(),
  locationType: locationType.optional(),
  source: z.string().max(50).optional().nullable()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

// ── Safety Sessions ──────────────────────────────────────────────────────────
const createSafetySession = z.object({
  profileId: cuid,
  bookingId: cuid.optional().nullable(),
  locationType: locationType.optional().default('incall'),
  plannedEndAt: isoDate.optional().nullable(),
  graceMinutes: z.number().int().min(1).max(1440).optional()
});

const safetyLocation = z.object({
  lat: latitude,
  lng: longitude,
  accuracy: z.number().min(0).max(10000).optional().nullable(),
  capturedAt: isoDate.optional()
});

// ── External GPS Trackers ───────────────────────────────────────────────────
const pairGpsTracker = z.object({
  imei: trackerIdentifier,
  profileId: cuid.optional().nullable(),
  label: z.string().max(120).optional().nullable()
});

// Self-pair: Model provisions their own phone. installationId slouží jako pseudo-IMEI.
const pairSelfGpsTracker = z.object({
  installationId: z.string().regex(/^[A-Za-z0-9_.:-]{6,128}$/, 'Invalid installationId'),
  profileId: cuid.optional().nullable()
});

const trackerLocationIngest = z.object({
  token: z.string().max(256).optional(),
  trackerId: z.string().max(128).optional(),
  secret: z.string().max(256).optional(),
  imei: trackerIdentifier.optional(),
  lat: latitudeInput.optional(),
  lng: longitudeInput.optional(),
  accuracy: z.coerce.number().min(0).max(10000).optional().nullable(),
  speedKph: z.coerce.number().min(0).max(1000).optional().nullable(),
  speed: z.coerce.number().min(0).max(1000).optional().nullable(),
  heading: z.coerce.number().min(0).max(360).optional().nullable(),
  battery: z.coerce.number().int().min(0).max(100).optional().nullable(),
  capturedAt: isoDate.optional(),
  gprmc: z.string().max(500).optional(),
  nmea: z.string().max(500).optional(),
  raw: z.string().max(2000).optional()
}).refine(data => {
  const hasCoords = data.lat !== undefined && data.lng !== undefined;
  return hasCoords || data.gprmc || data.nmea;
}, {
  message: 'Either lat/lng or gprmc/nmea must be provided'
});

// ── Blacklist ────────────────────────────────────────────────────────────────
// Důvod je kategorie z číselníku, ne volný text. Proč: config/blacklistReasons.js.
// Neznámý kód se odmítne — kdyby se propustil, vrátil by se volný text zadními
// vrátky a navíc by ho klient neuměl zobrazit.
const blacklistReason = z.enum(VOLITELNE_DUVODY);

const createBlacklist = z.object({
  phone: phone,
  licensePlate: z.string().max(20).optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  reason: blacklistReason,
  severity: severity.optional().default('warning')
}).refine(data => data.phone || data.licensePlate || data.name, {
  message: 'At least one identifier (phone, licensePlate, or name) is required'
});

const updateBlacklist = z.object({
  phone: phone,
  licensePlate: z.string().max(20).optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  reason: blacklistReason.optional(),
  severity: severity.optional()
});

const blacklistReport = z.object({
  reason: blacklistReason.optional()
});

// ── SOS ──────────────────────────────────────────────────────────────────────
const triggerSOS = z.object({
  profileId: cuid.optional().nullable(),
  type: z.enum(['manual', 'voice', 'timer_expired']).optional().default('manual'),
  lat: latitude.optional().nullable(),
  lng: longitude.optional().nullable(),
  accuracy: z.number().min(0).optional().nullable()
});

const sosLocation = z.object({
  lat: latitude,
  lng: longitude,
  accuracy: z.number().min(0).max(10000).optional().nullable(),
  capturedAt: isoDate.optional()
});

// ── Profiles ─────────────────────────────────────────────────────────────────
const createProfile = z.object({
  name: displayName,
  phoneNumber: phone,
  targetAgencyId: cuid.optional().nullable()
});

const patchProfile = z.object({
  name: displayName.optional(),
  phone: phone,
  phoneNumber: phone,
  bio: z.string().max(5000).optional().nullable(),
  description: z.string().max(10000).optional().nullable(),
  sampleMessages: z.string().max(20000).optional().nullable(),
  commission: z.number().min(0).max(100).optional(),
  quickReplies: z.array(z.string().max(500)).max(50).optional(),
  gallery: z.union([
    z.string().max(100000),
    z.array(z.record(z.string(), z.any())).max(100)
  ]).optional(),
  data: z.record(z.string(), z.any()).optional()
});

const assignUsers = z.object({
  userIds: z.array(cuid).max(100)
});

// ── Client Notes ─────────────────────────────────────────────────────────────
const createNote = z.object({
  profileId: cuid,
  clientPhone: z.string().min(1).max(32),
  text: text
});

// ── QA Records ───────────────────────────────────────────────────────────────
const createQaRecord = z.object({
  profileId: cuid,
  rating: z.number().int().min(1).max(5),
  comment: optionalText,
  category: z.string().max(100).optional().nullable()
});

// ── Call Logs ────────────────────────────────────────────────────────────────
const createCallLog = z.object({
  profileId: cuid,
  from: z.string().min(1).max(64),
  duration: z.number().int().min(0).optional().default(0),
  status: z.enum(['missed', 'answered', 'rejected', 'ringing'])
});

const updateCallLog = z.object({
  duration: z.number().int().min(0).optional(),
  status: z.enum(['missed', 'answered', 'rejected', 'ringing']).optional()
}).refine(data => data.duration !== undefined || data.status !== undefined, {
  message: 'At least one field is required'
});

// ── Inventory ────────────────────────────────────────────────────────────────
const createInventoryItem = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(0).optional().default(0),
  threshold: z.number().int().min(0).optional().default(10),
  locationId: cuid
});

const updateInventoryItem = z.object({
  name: z.string().min(1).max(200).optional(),
  quantity: z.number().int().min(0).optional(),
  threshold: z.number().int().min(0).optional(),
  locationId: cuid.optional()
});

const createInventoryLocation = z.object({
  name: z.string().min(1).max(200)
});

// ── Auth ─────────────────────────────────────────────────────────────────────
const login = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256)
});

const strongPassword = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(256)
  .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Must contain at least one number');

const registerAgency = z.object({
  fullName: z.string().min(1).max(200),
  agencyName: z.string().min(1).max(200),
  email: z.string().email().max(320),
  password: strongPassword,
  referralCode: z.string().max(64).optional()
});

const registerUser = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email().max(320),
  password: strongPassword,
  inviteCode: z.string().min(1).max(64),
  roleName: z.enum(['Operator', 'Model']).optional()
});

const resetPasswordRequest = z.object({
  email: z.string().email().max(320)
});

const refreshToken = z.object({
  refreshToken: z.string().min(1).max(128)
});

const updateAgencySettings = z.object({
  agencyId: cuid.optional(),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(320).optional().nullable(),
  region: z.string().min(1).max(100).optional(),
  aiInstructions: z.string().max(10000).optional().nullable(),
  safetyAlertMode: z.enum(['MANAGERS_AND_ASSIGNED', 'ASSIGNED_ONLY']).optional(),
  defaultGraceMinutes: z.number().int().min(1).max(1440).optional(),
  currency: z.string().max(3).optional(),
  timezone: z.string().max(64).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

const updateRolePermissions = z.object({
  // Zod 4 bere u z.record() první argument jako typ KLÍČE. Jednoargumentové
  // z.record(z.boolean()) tedy vyžadovalo boolean klíče — klíč je vždy string,
  // takže endpoint vracel 400 na každý požadavek. Mapa je název → boolean.
  permissions: z.record(z.string(), z.boolean())
});

const purchaseAddon = z.object({
  addonId: z.string().min(1).max(128),
  quantity: z.number().int().min(1).max(100).optional().default(1)
});

const createAgency = z.object({
  name: z.string().min(1).max(200),
  region: z.string().min(1).max(100),
  tier: z.string().max(50).optional().default('Standard'),
  plan: z.string().max(50).optional().default('Standard'),
  email: z.string().email().max(320).optional(),
  ownerEmail: z.string().email().max(320).optional(),
  ownerName: z.string().max(200).optional()
});

const addUser = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  password: strongPassword,
  roleId: cuid.optional(),
  roleName: z.string().max(100).optional(),
  role: z.string().max(100).optional(),
  agencyId: cuid.optional()
});

// ── Subscriptions ────────────────────────────────────────────────────────────
const startSubscription = z.object({
  plan: z.enum(['Starter', 'Professional', 'Agency']),
  paymentRef: z.string().max(256).optional().nullable(),
  amountPaid: z.number().min(0).optional().nullable(),
  currency: z.enum(['CZK', 'EUR', 'GBP', 'USD']).optional().default('CZK'),
  note: z.string().max(1000).optional().nullable()
});

const cancelSubscription = z.object({
  note: z.string().max(1000).optional().nullable()
});

const startTrial = z.object({
  agencyId: cuid,
  days: z.number().int().min(1).max(365).optional().default(14),
  note: z.string().max(1000).optional().nullable()
});

// ── Device ───────────────────────────────────────────────────────────────────
const registerPushToken = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(['android', 'ios', 'web']).optional().default('android')
});

const verifyDeviceBinding = z.object({
  installationId: z.string().min(1).max(256),
  profileId: z.string().min(1).max(128).optional().nullable(),
  platform: z.enum(['android', 'ios', 'web']).optional().default('android'),
  model: z.string().max(200).optional().nullable(),
  deviceName: z.string().max(200).optional().nullable(),
  deviceModel: z.string().max(200).optional().nullable(),
  osVersion: z.string().max(50).optional().nullable()
});

const revokeDeviceBinding = z.object({
  installationId: z.string().min(1).max(256)
});

// ── SIP ──────────────────────────────────────────────────────────────────────
const setSipConfig = z.object({
  sipUser: sipUserId.optional(),
  sipPassword: z.string().min(1).max(256).optional(),
  sipDomain: z.string().max(256).optional(),
  sipProxy: z.string().max(256).optional()
});

// ── Admin ────────────────────────────────────────────────────────────────────
const updateGlobalFeature = z.object({
  active: z.boolean()
});

const updateGlobalSetting = z.object({
  key: z.string().min(1).max(100),
  value: z.any()
});

const updateFeatureLock = z.object({
  locked: z.boolean()
});

// ── Device Relay ─────────────────────────────────────────────────────────────
const relayMessage = z.object({
  installationId: z.string().min(1).max(256),
  deviceId: z.string().max(128).optional(),
  userId: z.string().max(128).optional(),
  profileId: z.string().max(128).optional(),
  secret: z.string().max(256).optional(),
  type: z.string().max(32).optional(),
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  body: z.string().max(5000).optional(),
  text: z.string().max(5000).optional(),
  content: z.string().max(5000).optional(),
  transport: z.string().max(16).optional(),
  timestamp: z.union([z.number(), z.string().max(64)]).optional()
});

const mobileMessage = z.object({
  secret: z.string().min(1).max(256),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  body: z.string().max(5000).optional(),
  text: z.string().max(5000).optional(),
  transport: z.string().max(16).optional()
});

const mobileCall = z.object({
  secret: z.string().min(1).max(256),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64).optional(),
  state: z.string().max(32).optional(),
  duration: z.number().int().min(0).optional()
});

// ── QA Update ────────────────────────────────────────────────────────────────
const updateQaRecord = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  comment: optionalText,
  category: z.string().max(100).optional().nullable()
});

module.exports = {
  createMessage,
  updateMessageStatus,
  createBooking,
  updateBooking,
  createSafetySession,
  safetyLocation,
  pairGpsTracker,
  pairSelfGpsTracker,
  trackerLocationIngest,
  createBlacklist,
  updateBlacklist,
  blacklistReport,
  triggerSOS,
  sosLocation,
  createProfile,
  patchProfile,
  assignUsers,
  createNote,
  createQaRecord,
  updateQaRecord,
  createCallLog,
  updateCallLog,
  createInventoryItem,
  updateInventoryItem,
  createInventoryLocation,
  login,
  registerAgency,
  registerUser,
  resetPasswordRequest,
  refreshToken,
  updateAgencySettings,
  updateRolePermissions,
  purchaseAddon,
  createAgency,
  addUser,
  startSubscription,
  cancelSubscription,
  startTrial,
  registerPushToken,
  verifyDeviceBinding,
  revokeDeviceBinding,
  setSipConfig,
  updateGlobalFeature,
  updateGlobalSetting,
  updateFeatureLock,
  relayMessage,
  mobileMessage,
  mobileCall
};
