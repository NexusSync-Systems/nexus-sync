const crypto = require('crypto');
const util = require('util');

const pbkdf2Async = util.promisify(crypto.pbkdf2);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard pro GCM
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;

// V produkci musí být ENCRYPTION_KEY v .env! (min 32 bajtů v hexu)
const SECRET = process.env.ENCRYPTION_KEY;

async function encrypt(text) {
    if (!text) return null;
    
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    
    // Odvození klíče pomocí PBKDF2 pro vyšší bezpečnost
    const key = await pbkdf2Async(SECRET, salt, 100000, 32, 'sha512');
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();
    
    // Výsledek obsahuje sůl, iv, tag a samotná data pro pozdější dešifrování
    return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

async function decrypt(encryptedData) {
    if (!encryptedData) return null;
    
    try {
        const [saltHex, ivHex, tagHex, encryptedText] = encryptedData.split(':');
        
        const salt = Buffer.from(saltHex, 'hex');
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        
        // ── Délka ověřovací značky se MUSÍ vynutit ──────────────────────────
        //
        // Bez `authTagLength` přijme Node u GCM značku dlouhou i čtyři bajty.
        // Značka se přitom čte z uloženého řetězce, tedy z databáze. Kdo by
        // do `profile.credentials` dokázal zapsat, mohl by podstrčit značku
        // zkrácenou na čtyři bajty — a padělek uhodnout s pravděpodobností
        // jedna ku čtyřem miliardám místo jedna ku 2^128.
        //
        // Zpětná kompatibilita je v pořádku: šifrování vždy ukládalo plných
        // 16 bajtů (výchozí délka GCM v Node), takže stávající data projdou.
        // Co neprojde, je značka zkrácená útočníkem — a to je smysl.
        if (tag.length !== TAG_LENGTH) {
            console.error(`Decryption failed: ověřovací značka má ${tag.length} B místo ${TAG_LENGTH} B — možný pokus o podvržení.`);
            return null;
        }

        const key = await pbkdf2Async(SECRET, salt, 100000, 32, 'sha512');

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
        decipher.setAuthTag(tag);
        
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        console.error('Decryption failed:', error);
        return null;
    }
}

module.exports = {
    encrypt,
    decrypt
};
