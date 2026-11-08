import React from 'react';
import { useStavSpojeni } from '../../services/socketBridge';
import { hlaskaSpojeni } from '../../utils/obnovaSpojeni';

/**
 * Pruh o stavu spojení se serverem.
 *
 * Proč vůbec existuje: když se socket rozpadl, aplikace vypadala úplně
 * normálně — jen do ní nic nepřicházelo. Operátorka neměla jak poznat rozdíl
 * mezi „nikdo nepíše" a „nevidím, co mi píšou", a tak ani důvod obnovit
 * stránku. Co o stavu napsat, rozhoduje `hlaskaSpojeni`, aby to šlo testovat.
 */
const StavSpojeniPruh = ({ lang = 'cz' }) => {
  const stav = useStavSpojeni();
  const hlaska = hlaskaSpojeni(stav, lang);

  if (!hlaska) return null;

  return (
    <div
      data-testid={hlaska.testid}
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        padding: '0.35rem 1rem',
        background: hlaska.barva, color: 'black',
        textAlign: 'center', fontSize: '0.7rem', fontWeight: '800',
        letterSpacing: '0.02em',
        // Nad pruhem údržby: tohle je informace o tom, že UI právě nemusí
        // říkat pravdu, takže ji nemá nic překrývat.
        zIndex: 10002,
      }}
    >
      {hlaska.text}
    </div>
  );
};

export default StavSpojeniPruh;
