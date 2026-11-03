const axios = require('axios');
const API_BASE = process.env.API_BASE || 'http://localhost:3000/api';
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const TEST_EMAILS = (process.env.TEST_EMAILS || '')
  .split(',')
  .map(email => email.trim())
  .filter(Boolean);

if (!TEST_PASSWORD || TEST_EMAILS.length === 0) {
  console.error('Usage: TEST_EMAILS="user@example.com,other@example.com" TEST_PASSWORD="..." node scripts/debug-auth.js');
  process.exit(1);
}

async function checkLogin(email) {
  try {
    const res = await axios.post(`${API_BASE}/auth/login`, {
      email: email,
      password: TEST_PASSWORD
    }, { validateStatus: () => true });
    console.log(`Login ${email}: ${res.status} ${res.data?.message || ''}`);
  } catch (err) {
    console.log(`Error ${email}: ${err.message}`);
  }
}

Promise.all(TEST_EMAILS.map(checkLogin));
