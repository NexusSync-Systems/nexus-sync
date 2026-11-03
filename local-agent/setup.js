const os = require('os');
const { exec } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ADS_POWER_LINKS = {
    win32: 'https://www.adspower.com/download/win_x64',
    darwin: 'https://www.adspower.com/download/mac_arm64', // Defaulting to ARM, can be improved
    linux: 'https://www.adspower.com/download/linux'
};

async function checkAdsPower() {
    console.log('🔍 Kontroluji instalaci AdsPower...');
    
    const platform = os.platform();
    let command = '';
    
    if (platform === 'win32') {
        command = 'tasklist /FI "IMAGENAME eq AdsPower.exe"';
    } else {
        command = 'pgrep -x "AdsPower"';
    }

    return new Promise((resolve) => {
        exec(command, (error, stdout) => {
            if (stdout && stdout.includes('AdsPower')) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

async function runSetup() {
    console.log('🚀 Nexus Agent - Průvodce instalací');
    console.log('-----------------------------------');

    const isInstalled = await checkAdsPower();
    
    if (isInstalled) {
        console.log('✅ AdsPower je spuštěn a připraven.');
    } else {
        const platform = os.platform();
        const downloadUrl = ADS_POWER_LINKS[platform] || ADS_POWER_LINKS.win32;
        
        console.log('❌ AdsPower nebyl nalezen nebo není spuštěn.');
        console.log(`📥 Prosím, stáhněte a nainstalujte AdsPower z: ${downloadUrl}`);
        
        if (platform === 'win32' || platform === 'darwin') {
            console.log('🌐 Otevírám prohlížeč s odkazem ke stažení...');
            const openCmd = platform === 'win32' ? 'start' : 'open';
            exec(`${openCmd} ${downloadUrl}`);
        }
    }

    // Vytvoření .env pokud neexistuje
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        console.log('📝 Vytvářím konfigurační soubor .env...');
        const examplePath = path.join(__dirname, '.env.example');
        const exampleContent = fs.existsSync(examplePath) 
            ? fs.readFileSync(examplePath, 'utf8')
            : 'BACKEND_URL=https://ADRESA_VASEHO_API\nRELAY_TOKEN=VAŠ_TOKEN_Z_DASHBOARDU\n';
        
        fs.writeFileSync(envPath, exampleContent);
        console.log('✅ Soubor .env vytvořen. Prosím, vložte do něj svůj RELAY_TOKEN.');
    }

    console.log('\n👍 Nastavení hotovo. Nyní můžete spustit Agenta.');
}

if (require.main === module) {
    runSetup();
}

module.exports = { checkAdsPower };
