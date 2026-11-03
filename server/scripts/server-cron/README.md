# Co běží na serveru z cronu

Tyhle tři skripty jsou **kopie toho, co leží na backend serveru**
v `/root/nexus-zalohy/`. V repozitáři jsou proto, že 3. 11. 2026 jsme o server
přišli a s ním by zmizely i ony — tedy přesně ta chyba, kterou zálohy řeší.

Nejsou to skripty, které by se spouštěly z repozitáře. Server si je drží sám,
protože musí fungovat i ve chvíli, kdy na něm žádný klon repozitáře není.

| Soubor | Kdy běží | Co dělá |
| --- | --- | --- |
| `nocni-zaloha.sh` | 3:17 UTC | zavolá `backup-postgres.sh`, pak `sifrovana-kopie.sh` |
| `sifrovana-kopie.sh` | z nočního běhu | GPG AES256 + zkušební rozšifrování |
| `kontrola-veku.sh` | 9:05 UTC | selže, když nejnovější záloha je starší než 36 h |

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

Změna v repozitáři se na server **nedostane sama** — nasazování z CI zatím
nefunguje. Po úpravě je potřeba je na server znovu nakopírovat a ověřit, že
noční řetěz proběhne celý (`/root/nexus-zalohy/nocni-zaloha.sh` ručně, v logu
musí být i řádek o zašifrování).
