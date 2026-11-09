import { describe, it, expect, vi } from 'vitest';

/**
 * Pruhy přes celou obrazovku nesmí brát kliknutí.
 *
 * Tahle chyba se v projektu objevila dvakrát. Podruhé v #189, u pruhu
 * o stavu spojení, a chytily ji až E2E testy hlášením
 * „intercepts pointer events" — tedy v okamžiku, kdy už byla zelená
 * pipeline a chyběl krok k nasazení. V produkci by zablokovala horní
 * lištu s tlačítkem SOS právě ve chvíli, kdy je spojení rozbité.
 *
 * E2E sem nedosáhnou: pruh údržby a globální oznámení se zapínají stavem
 * ze serveru, který žádný test nenastavuje. Proto se to hlídá zdola.
 *
 * Nevykresluje se přes DOM — testovací prostředí je `node`, ne jsdom.
 * Komponenta se zavolá jako funkce a projde se vrácený strom elementů.
 * Vnořené komponenty (UpdateBanner, StavSpojeniPruh) se v něm neexpandují,
 * takže tenhle test mluví jen o pruzích psaných přímo tady — což je
 * záměr: UpdateBanner tlačítka MÁ a kliknutí brát musí.
 */

vi.mock('../../context/ContextHook', () => ({
  // Oba pruhy zapnuté zároveň, aby je test viděl v jednom průchodu.
  useNexus: () => ({
    isMaintenanceMode: true,
    globalAnnouncement: 'Zkouška',
    isMobile: true,
    lang: 'cz',
  }),
}));

function posbirejElementy(uzel, nalezene = []) {
  if (Array.isArray(uzel)) {
    for (const d of uzel) posbirejElementy(d, nalezene);
    return nalezene;
  }
  if (!uzel || typeof uzel !== 'object' || !uzel.props) return nalezene;
  nalezene.push(uzel);
  posbirejElementy(uzel.props.children, nalezene);
  return nalezene;
}

describe('systémové pruhy', () => {
  it('žádný pruh přes celou obrazovku nebere kliknutí', async () => {
    const mod = await import('./SystemBanners.jsx');
    const strom = mod.default();

    const prekryvy = posbirejElementy(strom)
      .filter((e) => e.props?.style?.position === 'fixed');

    // Kdyby se pruhy přestaly vykreslovat úplně, test by prošel naprázdno.
    expect(prekryvy.length).toBeGreaterThanOrEqual(2);

    for (const e of prekryvy) {
      expect(
        e.props.style.pointerEvents,
        `pruh ${JSON.stringify(e.props.children)} bere kliknutí`
      ).toBe('none');
    }
  });
});
