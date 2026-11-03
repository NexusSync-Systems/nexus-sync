const { Server } = require('socket.io');

let io;

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('./db');
const logger = require('./logger');
const { originPovolen } = require('../utils/corsOrigins');

// Ověří socket handshake auth a vrátí socket.user context (nebo hodí chybu).
// Dvě cesty:
//   - API klíč (auth.apiKey): local-agent / automatizace — stabilní, revokovatelný,
//     scoped na agenturu, vyžaduje scope 'relay:bridge'. Full-auto: nastavíš jednou,
//     jede navždy (nebo do smazání klíče), žádný expirující token k přegenerování.
//   - JWT (auth.token): operátoři (web) a relay telefon. Relay tokeny jsou
//     revokovatelné přes user.tokenVersion (tv).
async function resolveSocketUser(auth = {}) {
  if (auth.apiKey) {
    const [keyId, secret] = String(auth.apiKey).split('.');
    if (!keyId || !secret) throw new Error('Invalid API key');
    const rec = await prisma.apiKey.findUnique({ where: { keyId } });
    if (!rec || !(await bcrypt.compare(secret, rec.keyHash))) throw new Error('Invalid API key');
    if (rec.expiresAt && rec.expiresAt < new Date()) throw new Error('API key expired');
    const scopes = String(rec.scopes || '').split(',').map(s => s.trim());
    if (!scopes.includes('relay:bridge')) throw new Error('API key missing relay:bridge scope');
    prisma.apiKey.update({ where: { id: rec.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return { agencyId: rec.agencyId, type: 'agent', apiKeyId: rec.id };
  }
  const token = auth.token;
  if (!token) throw new Error('No token provided');
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.type === 'relay') {
    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { tokenVersion: true } });
    if (!user || (decoded.tv || 0) !== (user.tokenVersion || 0)) throw new Error('Relay token revoked');
  }
  return decoded;
}

const init = (server) => {
  // Seznam povolenych originu je spolecny s Expressem (utils/corsOrigins.js).
  // Driv tu byl vlastni a chybely v nem obe domeny `nexus-sync-8d50b.*`, tedy
  // ta, na ktere aplikace bezi: HTTP proslo a Socket.IO vratilo 403.
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (originPovolen(origin)) {
          callback(null, true);
        } else {
          // Driv se blokovany origin nikam nezapsal, takze se o tom nikdo
          // nedozvedel. Express ho loguje odjakziva.
          logger.warn(`Socket.io CORS Blocked for origin: ${origin}`);
          callback(new Error(`Socket.io CORS: Origin ${origin} not allowed`));
        }
      },
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingTimeout: 300000,
    pingInterval: 20000,
    connectTimeout: 45000
  });

  // Authentication Middleware for Socket.io
  io.use(async (socket, next) => {
    const auth = socket.handshake.auth || {};
    try {
      socket.user = await resolveSocketUser({
        apiKey: auth.apiKey,
        token: auth.token || socket.handshake.query.token,
      });
      next();
    } catch (err) {
      next(new Error('Authentication error: ' + err.message));
    }
  });

  io.on('connection', (socket) => {
    const { agencyId, userId } = socket.user;
    
    // Vlastní místnost uživatele — pro události mířené na konkrétní osobu, ne na
    // celou agenturu (fantomový hovor smí zazvonit jen modelce, ne operátorům).
    // Zároveň jde díky ní poznat, jestli je její zařízení opravdu připojené.
    if (userId) {
      socket.join(`user:${userId}`);
    }

    // Automatizační agent (local-agent) má vlastní místnost. Do `agency_<id>`
    // vstupuje KAŽDÝ přihlášený socket včetně prohlížečů operátorek, takže
    // příkazy s přihlašovacími údaji k externím webům by tam dostal každý —
    // operátorka je nepotřebuje a v síťovém provozu je vidět.
    //
    // Agent ověřený API klíčem má type 'agent' (resolveSocketUser). Starší
    // agenti se ale připojují JWT a ten typ nenesou; hlásí se aspoň v
    // handshake jako 'local-bridge', takže bereme i to. Prohlížeč by se za
    // něj sice mohl vydávat, ale dostal by jen data vlastní agentury, která
    // mu dnes stejně chodí — nezhoršuje to nic a nezlomí to starší agenty.
    const jeAgent = socket.user?.type === 'agent'
      || socket.handshake.auth?.type === 'local-bridge';
    if (agencyId && jeAgent) {
      socket.join(`agent_${agencyId}`);
      console.log(`[Socket-DEBUG] Agent připojen do agent_${agencyId}`);
    }

    // Join a room for the specific agency
    if (agencyId) {
      console.log(`[Socket-DEBUG] User ${userId} joining room agency_${agencyId}`);
      socket.join(`agency_${agencyId}`);
    } else {
      console.warn(`[Socket-DEBUG] User ${userId} connected but has NO agencyId in token!`);
    }

    socket.on('relay_event', (data) => {
      console.log(`[Socket-Relay] Event from ${userId} for agency_${agencyId}:`, data);
      // Přeposlat všem v místnosti (operátorům)
      socket.to(`agency_${agencyId}`).emit('relay_event', data);
    });

    // Relay telefon (Android) se přihlásí do své vlastní místnosti podle installationId,
    // aby mohl přijímat WebRTC signaling (answer / ICE / hangup) cílený jen na něj.
    socket.on('join-relay', (data) => {
      const installationId = data && data.installationId;
      if (installationId) {
        socket.join(`relay:${installationId}`);
        console.log(`[Socket-Relay] Socket ${socket.id} (user ${userId}) joined room relay:${installationId}`);
      } else {
        console.warn(`[Socket-Relay] join-relay from ${userId} without installationId`);
      }
    });

    socket.on('disconnect', () => {
      console.log('[Socket-DEBUG] User disconnected:', socket.id);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
};

const getRoomSize = (roomName) => {
  if (!io) return 0;
  const room = io.sockets.adapter.rooms.get(roomName);
  return room ? room.size : 0;
};

module.exports = {
  init,
  getIO,
  getRoomSize,
  resolveSocketUser
};
