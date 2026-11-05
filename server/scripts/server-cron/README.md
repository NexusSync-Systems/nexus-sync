# Co běží na serveru z cronu

**Pozor, dvě skupiny souborů s různým režimem.**

## Zálohy: kopie toho, co si server drží sám

`nocni-zaloha.sh`, `sifrovana-kopie.sh`, `kontrola-veku.sh` jsou **kopie toho,
co leží na serveru** v `/root/nexus-zalohy/`. V repozitáři jsou proto, že
3. 11. 2026 jsme o server přišli a s ním by zmizely i ony — tedy přesně ta
chyba, kterou zálohy řeší.

Tyhle se **z repozitáře nespouštějí**. Server si je drží sám, protože musí
fungovat i ve chvíli, kdy na něm žádný klon repozitáře není.

| Soubor | Kdy běží | Co dělá |
| --- | --- | --- |
| `nocni-zaloha.sh` | 3:17 UTC | zavolá `backup-postgres.sh`, pak `sifrovana-kopie.sh` |
| `sifrovana-kopie.sh` | z nočního běhu | GPG AES256 + zkušební rozšifrování |
| `kontrola-veku.sh` | 9:05 UTC | selže, když nejnovější záloha je starší než 36 h |

## Údržba instance: běží PŘÍMO odsud

`udrzuj-instanci.sh` a `instaluj-udrzbu.sh` naopak server spouští z místa, kam
je doručil rsync (`/root/nexus-backend/scripts/server-cron/`). Cron na ně
ukazuje tam, takže se aktualizují s každým nasazením.

| Soubor | Kdy běží | Co dělá |
| --- | --- | --- |
| `udrzuj-instanci.sh` | min. 4 a 34 každou hodinu | 5 min zátěže na jednom vlákně, aby Oracle instanci nezabavil za nečinnost |
| `instaluj-udrzbu.sh` | z nasazení | idempotentně nastaví `/etc/cron.d/nexus-udrzba` |

Vypínač zátěže: `touch /etc/nexus-udrzba-vypnuto` (nasazení ho nepřepíše).

Proč to vůbec existuje, měření a co to **neřeší**: `docs/jak-neprijit-o-server.md`.

## Nasazení na čistý server

```bash
install -d -m 700 /root/nexus-zalohy
install -m 700 server/scripts/server-cron/*.sh /root/nexus-zalohy/
touch /var/log/nexus-zaloha.log && chmod 600 /var/log/nexus-zaloha.log
openssl rand -base64 48 | head -n 1 > /root/zaloha-heslo.txt && chmod 600 /root/zaloha-heslo.txt
```

Pak do root crontabu:

```cron
17 3 * * * /root/nexus-zalohy/nocni-zaloha.sh
5 9 * * * /root/nexus-zalohy/kontrola-veku.sh
```

**Heslo z `/root/zaloha-heslo.txt` okamžitě ulož mimo server.** Bez něj
odvezené `.gpg` archivy neotevře nikdo. Zadní vrátka nejsou.

Postup, pravidla a co zůstává otevřené: `docs/database-backup-restore-runbook.md`,
oddíl „What is actually configured".

## Když se tyhle soubory změní

**Skripty údržby instance** se na server dostanou samy — rsync je doručí při
nasazení a cron na ně ukazuje do doručeného adresáře. Ověřuje je úloha
`Test údržby instance` v CI, která je opravdu spustí a změří, že zátěž vznikla.

**Skripty záloh** se na server samy nedostanou. Cron na ně ukazuje do
`/root/nexus-zalohy/`, kam rsync nesahá — a to je záměr, mají fungovat i bez
klonu repozitáře. Po úpravě je tedy potřeba je na server znovu nakopírovat
a ověřit, že noční řetěz proběhne celý (`/root/nexus-zalohy/nocni-zaloha.sh`
ručně, v logu musí být i řádek o zašifrování).

Dřív tu stálo, že změna se na server nedostane sama, protože „nasazování z CI
zatím nefunguje". Od PR #155 funguje — ale pro skripty záloh platí dál, že je
nasazení nepřenáší, protože leží mimo doručovaný adresář.
