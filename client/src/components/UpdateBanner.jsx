import React, { useState, useEffect } from 'react';
import { Download, X, Sparkles, RefreshCw } from 'lucide-react';
import axios from 'axios';
import { App } from '@capacitor/app';
import { CapacitorUpdater } from '@capgo/capacitor-updater';


import { API_BASE } from '../constants/config';
const UpdateBanner = () => {
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    const checkVersion = async () => {
      try {
        // Verzi bereme z nainstalované aplikace, ne z build konstanty: porovnáváme
        // versionCode (číslo), takže banner naskočí jen když je na serveru opravdu
        // novější build. Dřív se porovnávaly různě formátované řetězce a nabídka
        // se ukazovala i na aktuální verzi.
        const info = await App.getInfo().catch(() => null);
        if (!info) return;   // web — aktualizace APK se ho netýká

        const variant = info.id === 'com.nexushub.relay' ? 'relay' : 'full';
        const { data } = await axios.get(`${API_BASE}/vultr/latest-version`, { params: { variant } });

        const localCode = Number(info.build);
        const remoteCode = Number(data?.versionCode);

        // Nová APK — vyžaduje ruční instalaci.
        const jeNoveApk = Boolean(localCode && remoteCode && remoteCode > localCode);

        // Nový webový balík — dá se vyměnit bleskově.
        //
        // Tohle se posuzuje ZVLÁŠŤ. Dřív se banner řídil jen versionCode, který
        // se mění jedině při nahrání APK, takže po nahrání samotného webového
        // balíku se nenabídlo nic a bleskový update nešlo udělat vůbec.
        let jeNovyBalik = false;
        if (data?.otaVersion && data?.otaUrl) {
          try {
            const soucasny = await CapacitorUpdater.current();
            const bezici = soucasny?.bundle?.version;
            // 'builtin' znamená, že zařízení jede na balíku z APK a žádný OTA
            // zatím nepřevzalo — pak je každý ohlášený balík novinka.
            jeNovyBalik = !bezici || bezici === 'builtin' || bezici !== data.otaVersion;
          } catch (e) {
            console.warn('[Update] Nepodařilo se zjistit běžící balík:', e.message);
          }
        }

        if (jeNoveApk || jeNovyBalik) {
          console.log(`[Update] Dostupné: apk=${jeNoveApk} balík=${jeNovyBalik}`);
          setUpdateInfo(data);
          setIsVisible(true);
        }
      } catch (err) {
        console.warn('[Update] Failed to check for updates:', err.message);
      }
    };

    // Check once on mount
    checkVersion();
    
    // Then every hour
    const interval = setInterval(checkVersion, 3600000);
    return () => clearInterval(interval);
  }, []);

  // OTA (Capgo) umí vyměnit jen webový balík — nativní změny se takhle doručit
  // nedají. Server navíc žádný OTA balík nepublikuje a URL se dřív "odhadovala"
  // záměnou .apk → .zip, což vedlo na neexistující adresu a hlášku
  // „Aktualizace selhala". Bleskovou cestu proto nabízíme jen tehdy, když server
  // OTA balík opravdu ohlásí (otaUrl); jinak posíláme uživatele na instalaci APK.
  const hasOta = Boolean(updateInfo?.otaUrl && updateInfo?.otaVersion);

  const handleOTAUpdate = async () => {
    if (isUpdating || !hasOta) return;
    setIsUpdating(true);
    try {
      console.log('[OTA] Starting update for version:', updateInfo.version);
      const version = await CapacitorUpdater.download({
        url: updateInfo.otaUrl,
        // Verze BALÍKU, ne aplikace. Kdyby se sem dala `version` (z APK),
        // Capgo by si běžící balík označil číslem, které se nikdy nezmění,
        // a další bleskový update by se už nenabídl.
        version: updateInfo.otaVersion
      });
      await CapacitorUpdater.set(version);
      console.log('[OTA] Update applied successfully!');
    } catch (err) {
      console.error('[OTA] Update failed:', err.message);
      alert('Aktualizace selhala: ' + err.message);
      setIsUpdating(false);
    }
  };

  if (!isVisible || !updateInfo) return null;

  return (
    <div className="update-banner-fixed" style={{
      position: 'fixed',
      bottom: '2rem',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 9999,
      width: '90%',
      maxWidth: '500px',
      background: 'rgba(15, 17, 23, 0.95)',
      backdropFilter: 'blur(12px)',
      border: '1px solid var(--accent-color)',
      borderRadius: '20px',
      padding: '1.25rem',
      boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem',
      animation: 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div style={{ 
            width: '44px', 
            height: '44px', 
            borderRadius: '12px', 
            background: 'rgba(99, 102, 241, 0.1)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            color: 'var(--accent-color)'
          }}>
            <Sparkles size={24} />
          </div>
          <div>
            <div style={{ fontSize: '1rem', fontWeight: '900', color: 'white' }}>Nová verze k dispozici!</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Verze {updateInfo.version} přináší vylepšení stability a nové funkce.
            </div>
          </div>
        </div>
        <button onClick={() => setIsVisible(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px' }}>
          <X size={20} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <a 
          href={updateInfo.downloadUrl} 
          target="_blank" 
          rel="noreferrer"
          style={{ 
            flex: 1, 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            gap: '0.5rem', 
            padding: '0.8rem', 
            background: 'var(--accent-color)', 
            color: 'white', 
            borderRadius: '12px', 
            fontSize: '0.85rem', 
            fontWeight: '800', 
            textDecoration: 'none' 
          }}
        >
          <Download size={16} /> STÁHNOUT APK
        </a>
        {hasOta && (
        <button
          onClick={handleOTAUpdate}
          disabled={isUpdating}
          style={{
            flex: 1,
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            gap: '0.5rem', 
            padding: '0.8rem', 
            background: 'rgba(255,255,255,0.05)', 
            border: '1px solid var(--card-border)',
            color: 'white', 
            borderRadius: '12px', 
            fontSize: '0.85rem', 
            fontWeight: '800',
            cursor: isUpdating ? 'not-allowed' : 'pointer'
          }}
        >
          <RefreshCw size={16} className={isUpdating ? 'animate-spin' : ''} /> 
          {isUpdating ? 'AKTUALIZUJI...' : 'BLESKOVÝ UPDATE'}
        </button>
        )}
      </div>

      {isUpdating && (
        <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
          <div className="update-progress-bar" style={{ height: '100%', background: 'var(--accent-color)', width: '0%', animation: 'loading 3s linear forwards' }}></div>
        </div>
      )}
    </div>
  );
};

export default UpdateBanner;
