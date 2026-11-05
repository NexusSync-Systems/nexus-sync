# Antigravity Integration - Setup Guide

> ## ⚠️ Webhook listener byl odstraněn (5. 11. 2026)
>
> Všechno, co tenhle návod říká o `scripts/antigravity-webhook.js`, o portu
> 3001, o `ANTIGRAVITY_WEBHOOK_SECRET` a o „Configure Webhook in Antigravity",
> **už neplatí a nespouštějte to.** Ten soubor v repozitáři není.
>
> Důvod: jeho obsluha události `TASK_REQUEST` brala `command` přímo z těla
> HTTP požadavku a volala `spawn(command, args, { shell: true })`. Kontrola
> tajemství byla `if (WEBHOOK_SECRET && token !== WEBHOOK_SECRET)`, takže
> **když se secret nenastavil, neověřovalo se nic** — a návod níž vás vede
> k tomu pustit to pod pm2. Byl to tedy recept na spuštění libovolného
> příkazu kýmkoli, kdo se dostane na ten port. **Repozitář je veřejný.**
>
> Nastavené to nikdy nebylo (`.antigravity.env.example` má pořád
> `demo-key-will-be-updated`), od 5. 4. 2026 se ten soubor nezměnil a nic
> v CI ho nevolalo. Obsluha `DEPLOYMENT_REQUEST` navíc spouštěla
> `npm run deploy`, což je skript, který v `package.json` **neexistuje**.
>
> **Co platí dál:** `scripts/antigravity-sync.js` a npm skripty
> `build:with-sync`, `test:with-sync`, `deploy:with-sync`. Ty jen hlásí stav
> úloh přes HTTPS, žádný příkaz z vnějšku nepřijímají.
>
> Pokud tu zpětnou vazbu z Antigravity opravdu chcete, musí se napsat znovu:
> bez `shell: true`, s povoleným seznamem příkazů místo `command` z požadavku
> a s odmítnutím startu, dokud secret není nastavený.

## 🚀 Quick Start (5 minutes)

### 1. Set Environment Variables

```bash
export ANTIGRAVITY_API_KEY="your-api-key-from-antigravity"
export ANTIGRAVITY_BASE_URL="https://your-antigravity-instance.com"
export ANTIGRAVITY_PROJECT_ID="nexus-hub"
export ANTIGRAVITY_WEBHOOK_SECRET="your-webhook-secret"
export WEBHOOK_PORT=3001
```

**Or create `.antigravity.env`:**

```bash
cat > .antigravity.env << 'EOF'
ANTIGRAVITY_API_KEY=your-api-key
ANTIGRAVITY_BASE_URL=https://your-antigravity-instance.com
ANTIGRAVITY_PROJECT_ID=nexus-hub
ANTIGRAVITY_WEBHOOK_SECRET=your-webhook-secret
WEBHOOK_PORT=3001
EOF

# Load it
source .antigravity.env
```

### 2. Install Dependencies (if needed)

```bash
# Already included in Node.js
# Just verify Node.js is installed:
node --version  # Should be >= 14
```

### 3. Test Connection

```bash
node client/scripts/antigravity-sync.js test
```

**Expected output:**
```
✅ Connected to Antigravity
[SUCCESS] Connected to Antigravity
```

### 4. Start Webhook Handler

```bash
# In terminal 1
node client/scripts/antigravity-webhook.js
```

**Expected output:**
```
╔════════════════════════════════════════════════╗
║   Antigravity Webhook Handler Started         ║
╚════════════════════════════════════════════════╝

Webhook URL: http://localhost:3001
Listening for events from Antigravity...
```

### 5. Configure Webhook in Antigravity

1. In Antigravity UI → Settings → Webhooks
2. Click "Add Webhook"
3. URL: `http://your-server-ip:3001`
4. Secret: (paste your ANTIGRAVITY_WEBHOOK_SECRET)
5. Events: Check BUILD, TEST, DEPLOY, CODE_REVIEW
6. Test webhook → Should see success

---

## 📊 Usage Examples

### Example 1: Manual Build via CLI

```bash
node client/scripts/antigravity-sync.js task create build-1 "Build Nexus Hub" "Building for production"
node client/scripts/antigravity-sync.js log "Build started" INFO
npm run build
node client/scripts/antigravity-sync.js task complete build-1 SUCCESS
```

### Example 2: Automated via Antigravity

1. In Antigravity, create a workflow:
   - Trigger: Manual or on commit
   - Steps:
     - POST to webhook with BUILD event
     - Wait for completion
     - Send notification

2. Webhook payload example:
```json
{
  "type": "BUILD",
  "id": "build-123",
  "data": {
    "args": {
      "target": "client"
    }
  }
}
```

3. Antigravity receives webhook event
4. Webhook handler processes it
5. Build runs, logs sync to Antigravity
6. Results displayed in Antigravity dashboard

### Example 3: Deploy Workflow

**In Antigravity:**

```json
{
  "type": "DEPLOY",
  "id": "deploy-prod-456",
  "data": {
    "args": {
      "environment": "production",
      "service": "nexus-backend-final"
    }
  }
}
```

**Handler will:**
1. Build application
2. Run PM2 restart
3. Report progress to Antigravity
4. Show real-time logs
5. Return success/failure status

---

## 🔧 Integration with package.json

Update `package.json` to include Antigravity scripts:

```json
{
  "scripts": {
    "build": "vite build",
    "build:track": "node scripts/antigravity-sync.js log 'Build started' && npm run build && node scripts/antigravity-sync.js log 'Build complete' SUCCESS",
    "antigravity:webhook": "node scripts/antigravity-webhook.js",
    "antigravity:test": "node scripts/antigravity-sync.js test",
    "antigravity:status": "node scripts/antigravity-sync.js status"
  }
}
```

**Then run:**

```bash
npm run build:track        # Build with Antigravity tracking
npm run antigravity:webhook # Start webhook listener
npm run antigravity:test    # Test connection
```

---

## 🏗️ Architecture Diagram

```
┌──────────────────┐
│   Antigravity    │
│    (Control)     │
└────────┬─────────┘
         │ Webhook event
         │ (POST http://localhost:3001)
         │
         ▼
┌──────────────────────────────────┐
│ Webhook Handler                  │
│ (antigravity-webhook.js)         │
├──────────────────────────────────┤
│ • Validates signature            │
│ • Routes to handler              │
│ • Executes task                  │
└──────────────────────────────────┘
         │
         ├─────────────────┬────────────────┬──────────────┐
         │                 │                │              │
         ▼                 ▼                ▼              ▼
      npm build        npm test       pm2 restart      npm run lint
         │                 │                │              │
         └─────────────────┴────────────────┴──────────────┘
                           │
         ┌─────────────────────────────────────┐
         │ Sync Module (antigravity-sync.js)   │
         │ • Logs progress                     │
         │ • Reports metrics                   │
         │ • Updates task status               │
         └─────────────────────────────────────┘
                           │
                    (HTTPS API calls)
                           │
                           ▼
                    ┌──────────────┐
                    │ Antigravity  │
                    │   (Storage)  │
                    └──────────────┘
```

---

## 🔍 Monitoring & Debugging

### View Logs

```bash
# Real-time webhook handler logs
pm2 logs antigravity-webhook

# View Antigravity project status
node scripts/antigravity-sync.js status

# View in Antigravity dashboard
# Settings → Activity → Logs
```

### Test Webhook Manually

```bash
curl -X POST http://localhost:3001 \
  -H "Content-Type: application/json" \
  -H "X-Signature: $(echo -n '{}' | openssl dgst -sha256 -hmac 'your-webhook-secret' | cut -d' ' -f2)" \
  -d '{
    "type": "BUILD",
    "id": "test-123",
    "data": {"args": {"target": "client"}}
  }'
```

### Check Connection

```bash
curl -H "Authorization: Bearer $ANTIGRAVITY_API_KEY" \
  $ANTIGRAVITY_BASE_URL/api/health
```

---

## 🚨 Troubleshooting

### "Cannot find module" errors

```bash
# Make sure you're in the right directory
cd /path/to/nexus-hub/client

# Check Node version
node --version  # Should be >= 14
```

### "Connection refused" at localhost:3001

```bash
# Check if webhook handler is running
lsof -i :3001

# If not, start it:
node scripts/antigravity-webhook.js

# If port is in use, change it:
WEBHOOK_PORT=3002 node scripts/antigravity-webhook.js
```

### Webhook events not processing

1. Check webhook secret matches in Antigravity settings
2. Verify ANTIGRAVITY_API_KEY is correct
3. Check firewall: `telnet your-server 3001`
4. Review logs: `tail -f ~/.pm2/logs/antigravity-webhook-out.log`

### Metrics not showing in Antigravity

1. Verify API_KEY and BASE_URL are set correctly
2. Check if project exists: `node scripts/antigravity-sync.js status`
3. Ensure network connectivity from server to Antigravity

---

## 📈 Advanced: PM2 Auto-Start

```bash
# Install PM2 globally (if not already)
npm install -g pm2

# Start webhook handler with PM2
pm2 start client/scripts/antigravity-webhook.js --name antigravity-webhook --env "$(cat .antigravity.env)"

# View logs
pm2 logs antigravity-webhook

# Auto-start on reboot
pm2 startup
pm2 save
```

---

## 🔐 Security Checklist

- [ ] API key stored in environment variable (not hardcoded)
- [ ] Webhook secret set and verified
- [ ] HTTPS enabled for Antigravity communication
- [ ] `.antigravity.env` added to `.gitignore`
- [ ] Firewall allows webhook port access
- [ ] Regular API key rotation in place
- [ ] Audit logs enabled in Antigravity

---

## 📝 Next Steps

1. ✅ Set environment variables
2. ✅ Test connection
3. ✅ Start webhook handler
4. ✅ Configure in Antigravity UI
5. ✅ Trigger test workflow
6. ✅ Monitor in dashboard
7. ✅ Set up PM2 auto-start
8. ✅ Integrate with CI/CD

---

## 🎯 What's Tracked in Antigravity

- ✅ Build logs and status
- ✅ Test results
- ✅ Deployment progress
- ✅ Code review findings
- ✅ Performance metrics
- ✅ Error reports
- ✅ Task completion times
- ✅ Team notifications

---

## 💡 Tips & Tricks

### Tip 1: Local Testing
```bash
# Test without Antigravity
ANTIGRAVITY_API_KEY="test" npm run build:track
```

### Tip 2: Custom Metrics
```bash
# Report custom metrics
node scripts/antigravity-sync.js log "Custom event" INFO
```

### Tip 3: Webhook Port Forwarding
```bash
# If behind firewall
ssh -R 3001:localhost:3001 proxy.server.com
# Then use proxy URL in Antigravity
```

---

## 📞 Support

- **Antigravity Docs**: https://docs.antigravity.io
- **GitHub Issues**: Create issue in your repo
- **Slack**: Join Antigravity community

**You're all set! 🚀**
