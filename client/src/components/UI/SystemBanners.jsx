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
          fontSize: '0.7rem', fontWeight: '800', zIndex: 10001
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
          borderRadius: '12px', zIndex: 10000, maxWidth: '300px'
        }}>
          {globalAnnouncement}
        </div>
      )}
    </>
  );
};

export default SystemBanners;
