#!/usr/bin/env node
/**
 * Složí z výstupů bezpečnostních nástrojů jednu tabulku do shrnutí úlohy.
 *
 * Běží nad `npm audit`, `gitleaks` a `semgrep`. Všechny tři jsou otevřené
 * nástroje spouštěné ve vlastním CI — žádná cizí aplikace nedostává přístup
 * k repozitáři a výsledek nikam neodchází.
 *
 * ZÁSADNÍ VLASTNOST: rozlišuje „nic jsem nenašel" od „nástroj vůbec neběžel".
 * Chybějící report se hlásí jako CHYBA, ne jako čistý výsledek. Nástroj, který
 * tiše nespustil, by jinak vypadal jako dobrá zpráva — a přesně tahle záměna
 * dneska stála několik hodin jinde v tomhle repozitáři.
 *
 * Použití:
 *   node scripts/souhrn-bezpecnosti.js <npm-audit-dir> <gitleaks.json> <semgrep.json>
 *
 * Píše na stdout. Návratový kód je vždy 0 — rozhodnutí, jestli má běh spadnout,
 * patří workflow, ne výpisu.
 */
const fs = require('fs');
const path = require('path');

const [auditDir, gitleaksPath, semgrepPath] = process.argv.slice(2);
const MAX_RADKU = 25;

// Čeština má tři tvary. Hláška, kterou si lidi čtou po každém běhu, nemá
// drhnout na „2 nálezů".
const nalezy = (n) => (n === 1 ? '1 nález' : n < 5 ? `${n} nálezy` : `${n} nálezů`);

const nacti = (p) => {
  if (!p || !fs.existsSync(p)) return { chybi: true };
  try {
    const obsah = fs.readFileSync(p, 'utf8').trim();
    if (!obsah) return { prazdny: true };
    return { data: JSON.parse(obsah) };
  } catch (e) {
    return { vadny: e.message };
  }
};

const radky = [];
let problemu = 0;
let nespustenych = 0;

// ── Zranitelné závislosti ───────────────────────────────────────────────────
// npm audit se pouští zvlášť nad každým package-lock.json: root, server,
// client i local-agent. Jeden společný výsledek neexistuje, stromy závislostí
// jsou oddělené.
const zavislosti = [];
if (auditDir && fs.existsSync(auditDir)) {
  for (const soubor of fs.readdirSync(auditDir).filter((f) => f.endsWith('.json')).sort()) {
    const kde = path.basename(soubor, '.json');
    const r = nacti(path.join(auditDir, soubor));
    if (r.chybi || r.prazdny || r.vadny) {
      zavislosti.push({ kde, chyba: r.vadny || 'report nevznikl' });
      nespustenych++;
      continue;
    }
    const v = (r.data && r.data.metadata && r.data.metadata.vulnerabilities) || {};
    zavislosti.push({
      kde,
      critical: v.critical || 0,
      high: v.high || 0,
      moderate: v.moderate || 0,
      low: v.low || 0,
    });
    problemu += (v.critical || 0) + (v.high || 0);
  }
} else {
  nespustenych++;
  zavislosti.push({ kde: '—', chyba: 'adresář s výsledky nevznikl' });
}

// ── Tajemství v historii ────────────────────────────────────────────────────
// Doplňuje scripts/check-secrets.js, který prohlíží jen pracovní strom.
// Tohle jde do historie — a z té se nic nemaže.
const gl = nacti(gitleaksPath);
let gitleaksNalezu = null;
if (gl.chybi || gl.vadny) {
  nespustenych++;
} else if (gl.prazdny) {
  gitleaksNalezu = 0;
} else {
  gitleaksNalezu = Array.isArray(gl.data) ? gl.data.length : 0;
  problemu += gitleaksNalezu;
}

// ── Statická analýza ────────────────────────────────────────────────────────
const sg = nacti(semgrepPath);
let semgrepNalezy = null;
if (sg.chybi || sg.prazdny || sg.vadny) {
  nespustenych++;
} else {
  const vysledky = (sg.data && sg.data.results) || [];
  semgrepNalezy = { celkem: vysledky.length, vysoke: 0, polozky: [] };
  for (const v of vysledky) {
    const zavaznost = (v.extra && v.extra.severity) || 'INFO';
    if (zavaznost === 'ERROR') semgrepNalezy.vysoke++;
    semgrepNalezy.polozky.push({
      soubor: v.path,
      radek: (v.start && v.start.line) || '?',
      pravidlo: String(v.check_id || '').split('.').slice(-1)[0],
      zavaznost,
    });
  }
  problemu += semgrepNalezy.vysoke;
}

// ── Výpis ───────────────────────────────────────────────────────────────────
radky.push('### Bezpečnostní kontrola');
radky.push('');

if (nespustenych > 0) {
  radky.push(`> **Pozor: ${nespustenych} z kontrol nedoběhlo.** Chybějící výsledek NENÍ čistý výsledek —`);
  radky.push('> nástroj, který se nespustil, nic nenašel jen proto, že nehledal.');
  radky.push('');
}

radky.push('#### Zranitelné závislosti');
radky.push('');
radky.push('| balíček | kritických | vysokých | středních | nízkých |');
radky.push('| --- | --- | --- | --- | --- |');
for (const z of zavislosti) {
  if (z.chyba) radky.push(`| ${z.kde} | — | — | — | ⚠️ ${z.chyba} |`);
  else radky.push(`| ${z.kde} | ${z.critical} | ${z.high} | ${z.moderate} | ${z.low} |`);
}
radky.push('');

radky.push('#### Tajemství v historii gitu');
radky.push('');
if (gitleaksNalezu === null) radky.push('⚠️ Kontrola nedoběhla — výsledek nevznikl.');
else if (gitleaksNalezu === 0) radky.push('Nic nenalezeno.');
else radky.push(`**${nalezy(gitleaksNalezu)}.** Hodnoty jsou ve výpisu začerněné; podrobnosti jsou v artefaktu.`);
radky.push('');

radky.push('#### Statická analýza');
radky.push('');
if (semgrepNalezy === null) {
  radky.push('⚠️ Kontrola nedoběhla — výsledek nevznikl.');
} else if (semgrepNalezy.celkem === 0) {
  radky.push('Nic nenalezeno.');
} else {
  radky.push(`Celkem ${semgrepNalezy.celkem}, z toho ${semgrepNalezy.vysoke} se závažností ERROR.`);
  radky.push('');
  radky.push('| soubor | řádek | pravidlo | závažnost |');
  radky.push('| --- | --- | --- | --- |');
  for (const p of semgrepNalezy.polozky.slice(0, MAX_RADKU)) {
    radky.push(`| ${p.soubor} | ${p.radek} | ${p.pravidlo} | ${p.zavaznost} |`);
  }
  if (semgrepNalezy.polozky.length > MAX_RADKU) {
    radky.push('');
    radky.push(`_a dalších ${semgrepNalezy.polozky.length - MAX_RADKU}; úplný seznam je v artefaktu._`);
  }
}
radky.push('');
radky.push(`_Závažných nálezů celkem: **${problemu}**. Kontrola zatím běh neshazuje — viz komentář ve workflow._`);

console.log(radky.join('\n'));
