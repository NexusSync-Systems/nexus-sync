import { describe, it, expect } from 'vitest';
import { useSocket } from './useSocket';

/**
 * Pojistka na počet pozičních parametrů.
 *
 * `useSocketBezPosluchacu` doplňuje devět `undefined`, aby se nastavení
 * dostalo na jedenácté místo. Kdyby někdo do seznamu přidal nebo z něj ubral
 * posluchače, to doplnění se rozejde a nastavení by se poslalo JAKO
 * POSLUCHAČ — tedy tiše: socket by fungoval, jen by relay přestal obnovovat
 * token a byl by zpátky tam, kde byl před touhle opravou.
 *
 * `Function.length` počítá parametry před prvním s výchozí hodnotou, a tou je
 * až `options = {}`. Deset je tedy počet posluchačů včetně tokenu.
 */
describe('signatura useSocket', () => {
  it('má před nastavením deset pozičních parametrů', () => {
    expect(useSocket.length).toBe(10);
  });
});
