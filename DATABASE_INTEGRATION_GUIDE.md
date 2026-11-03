# Database Integration Guide - Nexus Hub

## Overview

Kód **JE připraven** pro produkční databázi, ale vyžaduje malou konfiguraci. Systém je navržen na **abstraktní vrstvě**, která odděluje business logic od databáze.

---

## ✅ Co Je Připraveno

### 1. **API-First Architecture**
```javascript
import { API_BASE } from '../constants/config'; // jediný zdroj adresy API
```
- NexusContext má centrální `API_BASE` URL
- Všechny HTTP requesty jdou přes axios
- Token je automaticky přidán do headeru
- Health check a error handling jsou připraveny

### 2. **Database Service Layer**
```
src/services/database/
├── DatabaseService.js      - APIClient + Repositories
├── DatabaseAdapters.js     - Enhanced channel adapters
└── index.js               - Exports
```

**Repositories:**
- `MessageRepository` - CRUD pro zprávy
- `ConversationRepository` - Konverzace management
- `AnalyticsRepository` - Event tracking
- `ProfileRepository` - Profily & galerie

### 3. **Channel Adapters s DB**
```javascript
DatabaseBackedWhatsAppAdapter  // WhatsApp + DB
DatabaseBackedSMSAdapter       // SMS + DB
DatabaseBackedWebChatAdapter   // WebChat + DB
```

---

## 🔌 Integration Setup

### Step 1: Initialize DatabaseService in NexusContext

```javascript
import { DatabaseService } from '@/services/database';

export const NexusProvider = ({ children }) => {
  import { API_BASE } from '../constants/config'; // jediný zdroj adresy API
  const token = /* get from auth */;

  // Create database service
  const db = useMemo(() => 
    new DatabaseService(API_BASE, token),
    [API_BASE, token]
  );

  // Provide to context
  const value = { db, /* ... rest */ };

  return <NexusContext.Provider value={value}>{children}</NexusContext.Provider>;
};
```

### Step 2: Use in CommunicationService

```javascript
import {
  CommunicationService,
  DatabaseBackedWhatsAppAdapter,
  DatabaseBackedSMSAdapter,
  DatabaseBackedWebChatAdapter
} from '@/services';

const db = useNexus().db;

const commService = new CommunicationService();
commService.registerAdapter('whatsapp', new DatabaseBackedWhatsAppAdapter(config, db));
commService.registerAdapter('sms', new DatabaseBackedSMSAdapter(config, db));
commService.registerAdapter('webchat', new DatabaseBackedWebChatAdapter(config, db));
```

### Step 3: Connect Analytics to DB

```javascript
import { AnalyticsService } from '@/services/analytics';

const analytics = new AnalyticsService(nexusContext);

// Events are tracked in local memory
analytics.trackEvent('message.sent', { operatorId: 'op_123' });

// Save to DB asynchronously
const db = useNexus().db;
await db.analytics.trackEvent(event);
```

---

## 📊 API Endpoints Required

### Messages Endpoints
```
POST   /api/messages              - Create message
GET    /api/messages/:id          - Get message
PATCH  /api/messages/:id/read     - Mark as read
GET    /api/messages/search       - Search messages
DELETE /api/messages/:id          - Delete message
```

### Conversations Endpoints
```
POST   /api/conversations                      - Create conversation
GET    /api/conversations                      - List conversations
GET    /api/conversations/:id                  - Get conversation
PATCH  /api/conversations/:id                  - Update conversation
POST   /api/conversations/:id/close            - Close conversation
GET    /api/conversations/:id/messages         - Get messages
POST   /api/conversations/:id/assign           - Assign operator
```

### Analytics Endpoints
```
POST   /api/analytics/events                   - Track event
GET    /api/analytics/operators/:id/kpis       - Operator KPIs
GET    /api/analytics/talents/:id/kpis         - Talent KPIs
GET    /api/analytics/agencies/:id             - Agency analytics
GET    /api/analytics/agencies/:id/realtime    - Real-time dashboard
```

### Profiles Endpoints
```
GET    /api/profiles/:id                       - Get profile
PATCH  /api/profiles/:id                       - Update profile
GET    /api/profiles/:id/gallery               - Get gallery
POST   /api/profiles/:id/gallery               - Upload photo
DELETE /api/profiles/:id/gallery/:photoId      - Delete photo
GET    /api/profiles/:id/sync-status           - Sync status
```

---

## 🗄️ Database Schema Requirements

### Messages Table
```sql
CREATE TABLE messages (
  id STRING PRIMARY KEY,
  channel STRING,                 -- 'whatsapp', 'sms', 'webchat'
  conversationId STRING,
  sender JSON,                    -- { id, name, phone, email }
  recipient JSON,
  content TEXT,
  status STRING,                  -- 'queued', 'sent', 'delivered', 'failed'
  metadata JSON,
  createdAt TIMESTAMP,
  updatedAt TIMESTAMP,
  agencyId STRING,
  operatorId STRING,
  FOREIGN KEY (conversationId) REFERENCES conversations(id)
);

CREATE INDEX idx_conversations ON messages(conversationId);
CREATE INDEX idx_created ON messages(createdAt DESC);
CREATE INDEX idx_agency ON messages(agencyId);
```

### Conversations Table
```sql
CREATE TABLE conversations (
  id STRING PRIMARY KEY,
  channel STRING,
  participants ARRAY<JSON>,       -- [{ id, name, phone }]
  assignedOperator JSON,          -- { id, name }
  status STRING,                  -- 'active', 'waiting', 'closed'
  metadata JSON,
  createdAt TIMESTAMP,
  updatedAt TIMESTAMP,
  closedAt TIMESTAMP,
  agencyId STRING,
  FOREIGN KEY (agencyId) REFERENCES agencies(id)
);

CREATE INDEX idx_channel ON conversations(channel);
CREATE INDEX idx_status ON conversations(status);
CREATE INDEX idx_agency ON conversations(agencyId);
```

### Events Table (Analytics)
```sql
CREATE TABLE events (
  id STRING PRIMARY KEY,
  type STRING,                    -- 'message.sent', 'operator.online', etc.
  operatorId STRING,
  talentId STRING,
  agencyId STRING,
  metadata JSON,
  timestamp TIMESTAMP,
  
  FOREIGN KEY (operatorId) REFERENCES operators(id),
  FOREIGN KEY (agencyId) REFERENCES agencies(id)
);

CREATE INDEX idx_operator ON events(operatorId, timestamp DESC);
CREATE INDEX idx_agency ON events(agencyId, timestamp DESC);
CREATE INDEX idx_type ON events(type);
```

### Profiles Table
```sql
CREATE TABLE profiles (
  id STRING PRIMARY KEY,
  name STRING,
  bio TEXT,
  age INT,
  location STRING,
  languages ARRAY<STRING>,
  specialties ARRAY<STRING>,
  rates JSON,                     -- { base, premium, ... }
  availability JSON,              -- Schedule
  agencyId STRING,
  createdAt TIMESTAMP,
  updatedAt TIMESTAMP,
  
  FOREIGN KEY (agencyId) REFERENCES agencies(id)
);

CREATE INDEX idx_agency ON profiles(agencyId);
```

### Gallery Table
```sql
CREATE TABLE gallery (
  id STRING PRIMARY KEY,
  profileId STRING,
  url STRING,
  caption STRING,
  position INT,
  createdAt TIMESTAMP,
  
  FOREIGN KEY (profileId) REFERENCES profiles(id)
);

CREATE INDEX idx_profile ON gallery(profileId, position);
```

---

## 🔄 Data Flow Examples

### Example 1: Send WhatsApp Message

```javascript
const { sendMessage } = useOmnichannel(config);
const db = useNexus().db;

// User sends message in UI
await sendMessage('whatsapp', {
  to: '+420777123456',
  content: 'Hello!'
});

// Behind the scenes:
// 1. DatabaseBackedWhatsAppAdapter.send()
// 2. db.messages.createMessage() → saved to DB
// 3. Call WhatsApp API
// 4. db.messages.updateMessage() → mark as sent
// 5. db.analytics.trackEvent('whatsapp.sent')
```

### Example 2: Track Operator Performance

```javascript
const db = useNexus().db;

// Operator sends messages
await db.analytics.trackEvent({
  type: 'message.sent',
  operatorId: 'op_123',
  agencyId: 'ag_456'
});

// Get KPIs
const kpis = await db.analytics.getOperatorKPIs('op_123', {
  startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  endDate: new Date()
});

// Returns: {
//   messagesSent: 245,
//   avgResponseTime: 1.2,
//   customerSatisfaction: 4.8,
//   ...
// }
```

### Example 3: Sync Profile to Portals

```javascript
const db = useNexus().db;

// Update profile
const profile = await db.profiles.updateProfile('prof_123', {
  name: 'Jana Updated',
  bio: 'New bio'
});

// Get sync status
const status = await db.profiles.getProfileSyncStatus('prof_123');
// { lastSync: Date, nextSync: Date, status: 'pending', portals: {...} }

// ContentSyncService uses this data
const syncService = new ContentSyncService();
await syncService.deltaSync('prof_123', oldProfile, profile);
```

---

## 🔐 Security Considerations

### Authentication
```javascript
// Token is automatically added to all requests
headers: {
  'Authorization': `Bearer ${token}`,
}

// Interceptor handles token expiration
client.interceptors.response.use(
  response => response,
  async (error) => {
    if (error.response?.status === 401) {
      // Refresh token or logout
    }
  }
);
```

### Data Isolation
```javascript
// All requests include agency context
const agencyFilter = gateway.buildAgencyFilter();
// { agencyId: 'ag_123' }

// Backend must enforce:
WHERE agencyId = ? AND (
  operatorId = ? OR 
  role IN ('ADMIN', 'OWNER')
)
```

### Audit Logging
```javascript
// Every operation is logged
const log = gateway.formatAuditLog(
  'profile.updated',
  'profile',
  { profileId, changes }
);

// Save to database
await db.audit.log(log);
```

---

## 📝 Environment Configuration

```env
# Required
VITE_API_URL=https://api.nexus-hub.production/api
VITE_API_TOKEN=                    # Set at runtime

# Optional (defaults provided)
VITE_API_TIMEOUT=30000
VITE_API_RETRY=3

# Communication
VITE_WHATSAPP_API_KEY=
VITE_SMS_API_KEY=
```

---

## ✅ Checklist pro Backend implementaci

- [ ] Create Messages table & indexes
- [ ] Create Conversations table & indexes
- [ ] Create Events table & indexes
- [ ] Create Profiles & Gallery tables
- [ ] Implement /messages endpoints
- [ ] Implement /conversations endpoints
- [ ] Implement /analytics/events endpoint
- [ ] Implement /analytics/*/kpis endpoints
- [ ] Implement /profiles endpoints
- [ ] Add authentication middleware
- [ ] Add agency data isolation middleware
- [ ] Setup WebSocket server for real-time updates
- [ ] Implement webhook handlers (WhatsApp, SMS)
- [ ] Setup CORS for frontend
- [ ] Setup database connection pooling
- [ ] Add rate limiting
- [ ] Setup backup & recovery

---

## 🧪 Testing Database Integration

```javascript
// Test database connection
const db = new DatabaseService(API_BASE, token);
const health = await db.healthCheck();
console.log(health); // { status: 'ok', db: true }

// Test message creation
const msg = await db.messages.createMessage({
  channel: 'sms',
  conversationId: 'conv_123',
  sender: { id: 'op_1', name: 'John' },
  recipient: { phone: '+420777123456' },
  content: 'Test message'
});
console.log(msg); // { id: 'msg_...', status: 'queued' }

// Test analytics
await db.analytics.trackEvent({
  type: 'message.sent',
  operatorId: 'op_1',
  agencyId: 'ag_1'
});

const kpis = await db.analytics.getOperatorKPIs('op_1');
console.log(kpis); // { messagesSent: 1, ... }
```

---

## 🚀 Production Deployment Checklist

1. **Database Setup**
   - [ ] Production database provisioned
   - [ ] Tables created with proper indexes
   - [ ] Backups configured
   - [ ] Connection pooling tested

2. **Backend API**
   - [ ] All endpoints implemented
   - [ ] Error handling & validation
   - [ ] Rate limiting configured
   - [ ] CORS configured for frontend domain

3. **Frontend Configuration**
   - [ ] VITE_API_URL set to production
   - [ ] Authentication token setup
   - [ ] Services initialized in NexusContext
   - [ ] Database adapters registered

4. **Monitoring**
   - [ ] API health checks
   - [ ] Database performance monitoring
   - [ ] Error logging & alerting
   - [ ] Request/response logging

5. **Security**
   - [ ] HTTPS enforced
   - [ ] Data isolation verified
   - [ ] API authentication working
   - [ ] Audit logging tested

---

## Summary

**Kód JE PŘIPRAVEN** na produkční databázi:

✅ API abstraction layer hotová  
✅ Repository pattern implementován  
✅ Database adapters vytvořeny  
✅ Chybí jen: Backend API implementace  

**Potřebný čas na backend:** ~2-3 týdny (v závislosti na komplexitě)

Celý frontendový systém je **database-agnostic** a vyhovuje:
- Firebase Firestore
- PostgreSQL
- MongoDB
- DynamoDB
- Jakýkoliv REST API
