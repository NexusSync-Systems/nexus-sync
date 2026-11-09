import React from 'react';
import { useNexus } from '../../context/ContextHook';
import UpdateBanner from '../UpdateBanner';
import StavSpojeniPruh from './StavSpojeniPruh';

/**
 * Component to handle global UI banners such as Maintenance Mode and Global Announcements.
 * Separates utility UI from main application layout.
 */
const SystemBanners = () => {
  const { isMaintenanceMode, globalAnnouncement, isMobile, lang } = useNexus();

  return (
    <>
      <UpdateBanner />
      <StavSpojeniPruh lang={lang} />
      {/* Maintenance Banner */}
      {isMaintenanceMode && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, padding: '0.2rem',
          background: '#f59e0b', color: 'black', textAlign: 'center',
          fontSize: '0.7rem', fontWeight: '800', zIndex: 10001,
          // NEODSTRAŇOVAT. Pruh je `position: fixed` přes celou šířku, takže
          // bez tohohle polyká kliknutí na všechno, co je pod ním — a protože
          // svítí právě v režimu údržby, zablokoval by horní lištu včetně
          // tlačítka SOS přesně ve chvíli, kdy je něco rozbité. Není v něm
          // nic, na co by se dalo klikat.
          //
          // Tu samou chybu jsem si v #189 vyrobil u pruhu o stavu spojení
          // a chytily ji až E2E testy („intercepts pointer events"). Sem
          // nedosáhnou: pruh se objevuje jen v režimu údržby, který žádný
          // test nezapíná.
          pointerEvents: 'none'
        }}>
          MAINTENANCE MODE ACTIVE
        </div>
      )}

      {/* Global Announcement Popup */}
      {globalAnnouncement && (
        <div style={{
          position: 'fixed', bottom: isMobile ? '70px' : '20px',
          right: '20px', padding: '0.75rem 1.25rem',
          background: 'rgba(59,130,246,0.9)', color: 'white',
          borderRadius: '12px', zIndex: 10000, maxWidth: '300px',
          // Totéž co výš. Tenhle překryv visí v pravém dolním rohu, kde na
          // mobilu leží spodní navigace, a nemá ani tlačítko na zavření —
          // takže kliknutí nemá proč brát.
          pointerEvents: 'none'
        }}>
          {globalAnnouncement}
        </div>
      )}
    </>
  );
};

export default SystemBanners;
