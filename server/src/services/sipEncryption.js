/**
 * sipEncryption.js — AES-256-GCM šifrování SIP hesel
 *
 * Klíč: SIP_ENCRYPTION_KEY v .env (hex string, 64 znaků = 32 bytů)
 * Generování: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey() {
  const hexKey = process.env.SIP_ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('SIP_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * Zašifruje plaintext heslo.
 * @param {string} plaintext
 * @returns {string} base64 encoded iv:tag:ciphertext
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag       = cipher.getAuthTag();

  // Formát: iv(16) + tag(16) + ciphertext → base64
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Dešifruje uložené heslo.
 * @param {string} encoded base64 iv:tag:ciphertext
 * @returns {string|null}
 */
function decrypt(encoded) {
  if (!encoded) return null;
  try {
    const key  = getKey();
    const data = Buffer.from(encoded, 'base64');

    const iv         = data.slice(0, IV_LENGTH);
    const tag        = data.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = data.slice(IV_LENGTH + TAG_LENGTH);

    // Délka ověřovací značky se musí vynutit. `slice` sice bere pevné pozice,
    // ale u zkráceného vstupu vrátí kratší buffer — a Node bez `authTagLength`
    // přijme u GCM i čtyřbajtovou značku. Padělek by se pak uhodl
    // s pravděpodobností jedna ku čtyřem miliardám místo jedna ku 2^128.
    if (tag.length !== TAG_LENGTH) {
      console.error(`[SIP Encryption] decrypt failed: značka má ${tag.length} B místo ${TAG_LENGTH} B.`);
      return null;
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);

    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch (err) {
    console.error('[SIP Encryption] decrypt failed:', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
