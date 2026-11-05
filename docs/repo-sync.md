# Repo sync — monorepo ↔ produkční backend

> ## ⚠️ PŘEKONÁNO 5. 11. 2026 — tohle už neplatí
>
> Celý postup níž popisuje stav, kdy si server stahoval kód ze zrcadla
> `nexus-backend`. **Od PR #155 ho doručuje rsync** přímo z úlohy
> `deploy-backend` a na serveru `.git` vůbec není.
>
> Úloha `sync-backend`, která do zrcadla tlačila, byla odstraněna. Důvod
> nebyl jen ten, že přestala být potřeba: zrcadlo má vlastní `deploy.yml`,
> který na serveru dělá `git reset --hard` a `git pull`, a každý push ho
> spouštěl. Selhával pokaždé, protože jeho secrety jsou z března 2026 od
> smazaného VPS — jen 5. 11. 2026 tak vzniklo několik červených běhů za sebou.
>
> **Aktuální postup nasazení:** `.github/workflows/ci.yml`, úloha
> `deploy-backend`. Přestavba serveru: `docs/novy-server-runbook.md`.
>
> Text níž zůstává jako záznam, jak to fungovalo dřív. Nepoužívat jako návod.

## Dvě repa
- **`origin` = `NexusSync-Systems/nexus-sync`** — celý **monorepo** (client + server + android). **Zdroj pravdy.**
- **`live` = `NexusSync-Systems/nexus-backend`** — jen složka **`server/`** projektovaná do rootu. Běží na produkci; **push do `master` = deploy** (přes `.github/workflows/deploy.yml` → SSH na VPS → `prisma db push` + pm2 restart).

## Zdroj pravdy pro `server/`
**Monorepo (origin) je zdroj pravdy.** Serverové změny se dělají v monorepu a odtud tečou na produkci. Do `nexus-backend` se **nemá commitovat/mergovat přímo** (viz drift níže).

## Proč se to rozešlo (a proč `git subtree push` selhává)
Historicky `scripts/push-all.sh` posílal `git subtree push --prefix=server live master`. Jenže když se do **nexus-backend mergne PR přímo** (např. automatické „Sentinel" security PR), obě repa se **rozejdou** a subtree push skončí na `non-fast-forward`. Jediná „oprava" by byl **force push**, který na produkci **maže** commity, co v monorepu nejsou. To je nepřijatelné.

## Bezpečný sync (forward-port + PR)
Použij:
```bash
bash scripts/sync-server-to-prod.sh      # jen sync server/ → prod jako PR
# nebo
bash scripts/push-all.sh                 # push origin + sync server/ → prod PR
```
Skript:
1. ověří, že monorepo `server/` je **obsahová nadmnožina** produkce (nic se nesmaže — jinak abortuje a vypíše chybějící soubory),
2. vytvoří commit, jehož **strom = monorepo `server/`**, s rodičem `live/master`,
3. pushne větev na `live` a **otevře PR**. Po review PR **mergneš** → spustí se deploy.

Žádný force push, žádné přepisování historie na produkci.

## Když má prod něco, co monorepo nemá
Pokud skript nahlásí „prod má soubory, které monorepo nemá" (drift opačným směrem — něco se mergnulo přímo do nexus-backend), **nejdřív to backportuj do monorepa** (`git show live/master:<path>` → přenes do `server/<path>`, commit do monorepa), pak spusť sync znovu.

## Jak driftu zamezit
- **Nemergovat PR přímo do `nexus-backend`.** Security/ostatní fixy dělej v monorepu → sync skriptem.
- Pokud automatizace („Sentinel") otevírá PR přímo na nexus-backend, přesměruj ji na monorepo, nebo přidej krok, který její změny backportuje do monorepa.

## Poznámka k seedu
`server/prisma/seed.js` zakládá demo účty se slabými hesly a v produkci se **odmítne spustit** (`NODE_ENV=production`), pokud není `ALLOW_PROD_SEED=true`. Deploy seed nespouští (jen `prisma db push`).
