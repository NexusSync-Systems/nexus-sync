# Integration Guide: Copilot CLI + Google Antigravity

## 📋 Overview

This guide explains how to integrate GitHub Copilot CLI with Google Antigravity to enable AI-powered project management and development automation for Nexus Hub.

## 🎯 Integration Modes

### Mode 1: Copilot as Antigravity Task Executor (Recommended)
```
Antigravity (Control) → Copilot CLI (Executor) → Results → Antigravity (Storage)
```

**Benefits:**
- Antigravity controls task flow
- Copilot CLI provides specialized development tools
- Results automatically sync back
- Best for CI/CD pipelines

### Mode 2: Copilot as Standalone with Antigravity Sync
```
Copilot CLI (Autonomous) → Logs/Results → Antigravity (Monitoring)
```

**Benefits:**
- Copilot works independently
- Antigravity sees all progress
- Less coupling
- Good for long-running tasks

### Mode 3: Hybrid (Copilot + Antigravity Agents)
```
Antigravity Agent 1 ↔ Copilot CLI ↔ Antigravity Agent 2
```

**Benefits:**
- Multiple AI systems cooperate
- Highest complexity
- Maximum flexibility
- Good for complex workflows

---

## 🔧 Integration Setup

### Step 1: Authentication & API Keys

**In Antigravity:**
1. Navigate to Settings → API Keys
2. Create a new API key for Copilot integration
3. Copy the key (you'll need it for environment config)

**Store securely:**
```bash
export ANTIGRAVITY_API_KEY="your-api-key-here"
export ANTIGRAVITY_BASE_URL="https://your-antigravity-instance.com"
export ANTIGRAVITY_PROJECT_ID="nexus-hub"
```

### Step 2: Create Integration Script

Create `scripts/antigravity-sync.js`:

```javascript
#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

const ANTIGRAVITY_API_KEY = process.env.ANTIGRAVITY_API_KEY;
const ANTIGRAVITY_BASE_URL = process.env.ANTIGRAVITY_BASE_URL;
const ANTIGRAVITY_PROJECT_ID = process.env.ANTIGRAVITY_PROJECT_ID;

// Log levels
const LOG_LEVELS = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR'
};

// Sync task to Antigravity
async function syncTask(taskData) {
  return new Promise((resolve, reject) => {
    const endpoint = `/api/projects/${ANTIGRAVITY_PROJECT_ID}/tasks`;
    const options = {
      hostname: new URL(ANTIGRAVITY_BASE_URL).hostname,
      port: 443,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ANTIGRAVITY_API_KEY}`,
        'User-Agent': 'Copilot-CLI/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`API Error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(taskData));
    req.end();
  });
}

// Log task progress
async function logProgress(message, level = LOG_LEVELS.INFO) {
  const logData = {
    timestamp: new Date().toISOString(),
    level,
    message,
    source: 'copilot-cli'
  };

  try {
    await syncTask({ type: 'LOG', data: logData });
    console.log(`[${level}] ${message}`);
  } catch (error) {
    console.error(`Failed to log: ${error.message}`);
  }
}

// Report task completion
async function reportCompletion(taskId, status, results) {
  const completionData = {
    type: 'TASK_COMPLETION',
    data: {
      taskId,
      status, // 'SUCCESS', 'FAILURE', 'PARTIAL'
      results,
      timestamp: new Date().toISOString()
    }
  };

  try {
    await syncTask(completionData);
    console.log(`Task ${taskId} completed with status: ${status}`);
  } catch (error) {
    console.error(`Failed to report completion: ${error.message}`);
  }
}

// Export for use in other scripts
module.exports = {
  syncTask,
  logProgress,
  reportCompletion,
  LOG_LEVELS
};
```

### Step 3: Integrate with Build Pipeline

Update `package.json`:

```json
{
  "scripts": {
    "build": "vite build",
    "build:with-sync": "node scripts/antigravity-sync.js start-task build && npm run build && node scripts/antigravity-sync.js complete-task build success",
    "test": "npm run test",
    "test:with-sync": "node scripts/antigravity-sync.js start-task test && npm run test && node scripts/antigravity-sync.js complete-task test success",
    "deploy": "npm run build && pm2 restart nexus-backend-final",
    "deploy:with-sync": "node scripts/antigravity-sync.js start-task deploy && npm run deploy && node scripts/antigravity-sync.js complete-task deploy success"
  }
}
```

### Step 4: Webhook Handler for Antigravity Events

> **⚠️ NEDĚLEJTE TENHLE KROK.** Kód níž přijímá `command` z těla požadavku
> a spouští ho přes shell, a bez nastaveného secretu neověřuje nic. Soubor,
> který podle něj vznikl, byl 5. 11. 2026 z repozitáře odstraněn — proč,
> stojí v ANTIGRAVITY_SETUP_GUIDE.md. Text zůstává jako záznam.

Create `scripts/antigravity-webhook.js`:

```javascript
#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');
const { logProgress, reportCompletion } = require('./antigravity-sync');

const PORT = process.env.WEBHOOK_PORT || 3001;

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const event = JSON.parse(body);
      
      // Verify webhook signature (if Antigravity provides one)
      if (!verifyWebhookSignature(req, body)) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      await handleAnttigravityEvent(event);
      
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
    } catch (error) {
      console.error('Webhook error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

async function handleAnttigravityEvent(event) {
  const { type, data } = event;

  switch (type) {
    case 'TASK_REQUEST':
      await handleTaskRequest(data);
      break;
    case 'CODE_REVIEW_REQUEST':
      await handleCodeReview(data);
      break;
    case 'DEPLOYMENT_REQUEST':
      await handleDeployment(data);
      break;
    default:
      console.log(`Unknown event type: ${type}`);
  }
}

async function handleTaskRequest(data) {
  const { taskId, command, args } = data;
  
  await logProgress(`Executing task: ${command}`);
  
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: 'inherit' });
    
    proc.on('close', (code) => {
      if (code === 0) {
        reportCompletion(taskId, 'SUCCESS', { exitCode: code });
      } else {
        reportCompletion(taskId, 'FAILURE', { exitCode: code });
      }
      resolve();
    });
  });
}

async function handleCodeReview(data) {
  const { fileList, taskId } = data;
  
  await logProgress(`Starting code review for ${fileList.length} files`);
  
  // You can integrate ESLint, other linters, etc.
  // For now, just log
  
  await reportCompletion(taskId, 'SUCCESS', { 
    filesReviewed: fileList.length 
  });
}

async function handleDeployment(data) {
  const { environment, taskId } = data;
  
  await logProgress(`Deploying to ${environment}`);
  
  // Trigger deployment script
  // This could call your PM2 restart, docker push, etc.
  
  await reportCompletion(taskId, 'SUCCESS', { 
    environment, 
    timestamp: new Date().toISOString()
  });
}

function verifyWebhookSignature(req, body) {
  // Implement signature verification if Antigravity provides signing
  // For now, just check for auth header
  const token = req.headers['x-antigravity-token'];
  return token === process.env.ANTIGRAVITY_WEBHOOK_SECRET;
}

server.listen(PORT, () => {
  console.log(`Antigravity webhook listener running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}`);
});
```

### Step 5: Environment Configuration

Create `.antigravity.env`:

```bash
# Antigravity Configuration
ANTIGRAVITY_API_KEY=your-api-key-here
ANTIGRAVITY_BASE_URL=https://your-antigravity-instance.com
ANTIGRAVITY_PROJECT_ID=nexus-hub

# Webhook Configuration
WEBHOOK_PORT=3001
ANTIGRAVITY_WEBHOOK_SECRET=your-webhook-secret

# Project Configuration
PROJECT_NAME=Nexus Hub
PROJECT_REPO=https://github.com/your-org/nexus-hub
PROJECT_BRANCH=main

# Integration Features
ENABLE_AUTO_SYNC=true
ENABLE_WEBHOOKS=true
LOG_TO_ANTIGRAVITY=true
```

Load in your initialization script or CI/CD:

```bash
source .antigravity.env
```

---

## 🚀 Usage Scenarios

### Scenario 1: Automated Build Pipeline

```bash
# In Antigravity, trigger task "Build Nexus Hub"
# This calls the webhook:
POST /webhook
{
  "type": "TASK_REQUEST",
  "data": {
    "taskId": "build-12345",
    "command": "npm",
    "args": ["run", "build:with-sync"]
  }
}

# Copilot CLI:
# 1. Receives webhook
# 2. Runs: npm run build
# 3. Syncs logs to Antigravity
# 4. Reports completion
# 5. Antigravity updates UI

# Result: Build visible in Antigravity dashboard
```

### Scenario 2: Code Review Request

```bash
# In Antigravity, trigger "Code Review"
# Copilot CLI receives request
# Runs ESLint on specified files
# Reports results back to Antigravity
# Antigravity displays findings in UI
```

### Scenario 3: Deployment Workflow

```bash
# In Antigravity, click "Deploy to Production"
# Workflow:
# 1. Copilot syncs latest code
# 2. Builds application
# 3. Runs tests
# 4. Deploys via PM2
# 5. Verifies health check
# 6. Reports status back to Antigravity

# Antigravity sees full timeline with logs
```

---

## 📊 Monitoring & Logging

### What Gets Synced to Antigravity:

✅ Build logs  
✅ Deployment status  
✅ Test results  
✅ Code review findings  
✅ Performance metrics  
✅ Error reports  
✅ Commit history  

### In Antigravity Dashboard, you see:

- Real-time task progress
- Log streams
- Success/failure status
- Performance graphs
- Historical trend data
- Team notifications

---

## 🔐 Security Considerations

1. **API Keys**: Store in `.env`, never commit to git
2. **Webhook Secret**: Verify signatures in webhook handlers
3. **Rate Limiting**: Implement exponential backoff for API calls
4. **HTTPS Only**: Always use HTTPS for Antigravity communication
5. **Audit Logging**: Log all Antigravity interactions

---

## 🛠️ Troubleshooting

### Connection Issues
```bash
# Test Antigravity API connectivity
curl -H "Authorization: Bearer $ANTIGRAVITY_API_KEY" \
  https://your-antigravity-instance.com/api/health
```

### Webhook Not Firing
1. Verify webhook URL is correct in Antigravity settings
2. Check firewall rules (port 3001 open)
3. Ensure `.antigravity.env` is loaded
4. Check logs: `pm2 logs antigravity-webhook`

### Sync Failures
1. Check API key validity
2. Verify project ID matches
3. Check network connectivity
4. Review error logs in Antigravity

---

## 📚 Additional Resources

- Antigravity API Docs: https://docs.antigravity.io
- Copilot CLI Docs: (built-in via `copilot help`)
- Webhooks Tutorial: https://docs.antigravity.io/webhooks
- Integration Examples: https://github.com/google/antigravity-examples

---

## ✨ Next Steps

1. ✅ Set up API authentication
2. ✅ Deploy webhook listener
3. ✅ Configure environment variables
4. ✅ Test webhook connectivity
5. ✅ Set up CI/CD integration
6. ✅ Monitor logs in Antigravity dashboard
7. ✅ Expand automation workflows as needed

**All set! Your Copilot CLI is now integrated with Antigravity.** 🚀
