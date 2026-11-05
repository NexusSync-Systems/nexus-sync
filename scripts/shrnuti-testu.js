#!/usr/bin/env node
/**
 * Udělá z JSON reportu Playwrightu čitelný souhrn do shrnutí úlohy v Actions.
 *
 * PROČ: `$GITHUB_STEP_SUMMARY` se v tomhle repozitáři používal na třech
 * místech a ani jedno se netýkalo testů. Když úloha zčervenala, bylo vidět
 * jen její jméno — co přesně padlo, se zjišťovalo rozklikáním logu a jeho
 * projetím. (Viz docs/audit-testu-a-ci.md, nález 4.)
 *
 * Nahrazuje scripts/summarize-tests.js, který měl tři vady: počítal celkový
 * počet jako `projects.length * suites.length` s komentářem „Rough estimate",
 * měl vlastní ruční výčet čtyř specifikací a v CI ho nikdo nevolal.
 *
 * Použití:
 *   node scripts/shrnuti-testu.js <report.json> [nadpis]
 *
 * Píše na stdout, takže se dá přesměrovat do $GITHUB_STEP_SUMMARY.
 * Když report neexistuje nebo je nečitelný, řekne to a skončí NULOU —
 * rozbitý souhrn nemá shazovat běh, který testy prošly.
 */
const fs = require('fs');

const cesta = process.argv[2];
const nadpis = process.argv[3] || 'Výsledky testů';
const MAX_RADKU = 40;

if (!cesta) {
  console.log(`### ${nadpis}\n\nSkriptu nebyl předán soubor s reportem.`);
  process.exit(0);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(cesta, 'utf8'));
} catch (e) {
  console.log(`### ${nadpis}\n\nReport \`${cesta}\` se nepodařilo přečíst: ${e.message}`);
  process.exit(0);
}

// Playwright vnořuje suites do sebe, hloubka není pevná. Proto rekurze,
// ne dvě úrovně cyklu — na tom se dřív rozbíjelo počítání.
const testy = [];
const projdi = (suites, cestaSouboru) => {
  for (const s of suites || []) {
    const soubor = s.file || cestaSouboru;
    for (const spec of s.specs || []) {
      for (const test of spec.tests || []) {
        const posledni = (test.results || [])[test.results.length - 1] || {};
        testy.push({
          soubor,
          nazev: spec.title,
          projekt: test.projectName || '',
          stav: posledni.status || 'neznámý',
          ocekavano: test.expectedStatus || 'passed',
          pokusu: (test.results || []).length,
          chyba: (posledni.error && (posledni.error.message || '')) || '',
        });
      }
    }
    projdi(s.suites, soubor);
  }
};
projdi(report.suites, '');

if (testy.length === 0) {
  console.log(`### ${nadpis}\n\nReport neobsahuje žádné testy.`);
  process.exit(0);
}

const je = (t, stav) => t.stav === stav;
const proslo = testy.filter((t) => je(t, 'passed') && t.pokusu === 1).length;
const nestabilni = testy.filter((t) => je(t, 'passed') && t.pokusu > 1).length;
const preskoceno = testy.filter((t) => je(t, 'skipped')).length;
const padlo = testy.filter((t) => !je(t, 'passed') && !je(t, 'skipped'));

console.log(`### ${nadpis}`);
console.log('');
console.log('| | |');
console.log('| --- | --- |');
console.log(`| prošlo napoprvé | ${proslo} |`);
if (nestabilni > 0) {
  console.log(`| prošlo až na druhý pokus | ${nestabilni} |`);
}
console.log(`| **padlo** | **${padlo.length}** |`);
console.log(`| přeskočeno | ${preskoceno} |`);
console.log(`| celkem | ${testy.length} |`);
console.log('');

if (nestabilni > 0) {
  // Čeština má tři tvary. Hláška, kterou si lidi čtou po každém běhu, nemá
  // drhnout na „1 testů".
  const veta =
    nestabilni === 1 ? '1 test prošel'
    : nestabilni < 5 ? `${nestabilni} testy prošly`
    : `${nestabilni} testů prošlo`;
  console.log(`> ${veta} až po opakování. Test, který jednou padne`);
  console.log('> a podruhé projde, je nestabilní — ne zelený.');
  console.log('');
}

if (padlo.length === 0) {
  console.log('Nic nepadlo.');
  process.exit(0);
}

console.log('#### Co padlo');
console.log('');
console.log('| soubor | test | prohlížeč | chyba |');
console.log('| --- | --- | --- | --- |');

for (const t of padlo.slice(0, MAX_RADKU)) {
  // Chybová hláška bývá na desítky řádků a tabulka v markdownu je jednořádková.
  // První řádek nese to podstatné; zbytek je v reportu, na který se dá kliknout.
  const prvni = String(t.chyba)
    .replace(/\u001b\[[0-9;]*m/g, '')   // barvy z terminálu
    .split('\n')[0]
    .replace(/\|/g, '\\|')
    .slice(0, 160);
  const soubor = String(t.soubor).replace(/^tests\//, '');
  console.log(`| ${soubor} | ${t.nazev} | ${t.projekt} | ${prvni || '—'} |`);
}

if (padlo.length > MAX_RADKU) {
  console.log('');
  console.log(`_a dalších ${padlo.length - MAX_RADKU}; úplný seznam je v artefaktu s reportem._`);
}
