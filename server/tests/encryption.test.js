const { encrypt, decrypt } = require('../src/utils/encryption');

describe('Encryption Utils', () => {
    it('should encrypt and decrypt a valid string', async () => {
        const text = 'hello secret world';
        const encrypted = await encrypt(text);
        expect(encrypted).toBeDefined();
        expect(encrypted).not.toEqual(text);

        const decrypted = await decrypt(encrypted);
        expect(decrypted).toEqual(text);
    });

    it('should handle null or empty inputs gracefully', async () => {
        expect(await encrypt(null)).toBeNull();
        expect(await decrypt(null)).toBeNull();
        expect(await encrypt('')).toBeNull();
        expect(await decrypt('')).toBeNull();
    });

    it('should return null when decrypting invalid format', async () => {
        const invalidData = 'invalid:format:data';
        const decrypted = await decrypt(invalidData);
        expect(decrypted).toBeNull();
    });
});

// ── Délka ověřovací značky u AES-GCM ────────────────────────────────────────
//
// Nalezeno statickou analýzou (semgrep, pravidlo gcm-no-tag-length) 5. 11. 2026.
// Bez `authTagLength` přijme Node u GCM značku dlouhou i čtyři bajty. Značka se
// přitom čte z uloženého řetězce, tedy z databáze: kdo by do profile.credentials
// dokázal zapsat, mohl by podstrčit zkrácenou značku a padělek uhodnout
// s pravděpodobností jedna ku čtyřem miliardám místo jedna ku 2^128.
describe('Ověřovací značka AES-GCM', () => {
    const crypto = require('crypto');
    const util = require('util');
    const pbkdf2Async = util.promisify(crypto.pbkdf2);
    const { encrypt, decrypt } = require('../src/utils/encryption');

    // Postaví platný zápis přesně tak, jak ho dělal kód PŘED opravou, tedy
    // bez `authTagLength`. Slouží ke dvěma věcem: ke zkrácení značky a k důkazu
    // zpětné kompatibility.
    const zasifrujStare = async (text) => {
        const iv = crypto.randomBytes(12);
        const salt = crypto.randomBytes(64);
        const key = await pbkdf2Async(process.env.ENCRYPTION_KEY, salt, 100000, 32, 'sha512');
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let enc = cipher.update(text, 'utf8', 'hex');
        enc += cipher.final('hex');
        return { salt, iv, tag: cipher.getAuthTag(), enc };
    };

    it('STARÁ data zašifrovaná bez authTagLength se dají pořád přečíst', async () => {
        // Nejdůležitější test ze všech: oprava, která zneplatní existující
        // zašifrovaná data, by byla horší než ta slabina, kterou řeší.
        const { salt, iv, tag, enc } = await zasifrujStare('tajemstvi z minulosti');
        const zapis = `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${enc}`;

        expect(tag.length).toBe(16);
        expect(await decrypt(zapis)).toBe('tajemstvi z minulosti');
    });

    it('zkrácená značka se odmítne a vrátí null', async () => {
        const { salt, iv, tag, enc } = await zasifrujStare('tajna data');
        const kratka = tag.subarray(0, 4);   // 4 bajty místo 16
        const zapis = `${salt.toString('hex')}:${iv.toString('hex')}:${kratka.toString('hex')}:${enc}`;

        expect(await decrypt(zapis)).toBeNull();
    });

    it('běžné kolečko zašifruj/rozšifruj dál funguje a značka má 16 bajtů', async () => {
        const text = 'prihlasovaci udaje profilu';
        const zapis = await encrypt(text);
        const [, , tagHex] = zapis.split(':');

        expect(Buffer.from(tagHex, 'hex').length).toBe(16);
        expect(await decrypt(zapis)).toBe(text);
    });

    it('změna v šifrovaných datech se pozná i s platnou délkou značky', async () => {
        const zapis = await encrypt('puvodni obsah');
        const [s, i, t, enc] = zapis.split(':');
        const zmeneny = enc.slice(0, -2) + (enc.slice(-2) === 'ff' ? '00' : 'ff');

        expect(await decrypt(`${s}:${i}:${t}:${zmeneny}`)).toBeNull();
    });
});
