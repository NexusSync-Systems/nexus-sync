# Přesun webové aplikace na `hub.nexusstack.eu`

Stav k 3. 11. 2026: aplikace běží na `https://nexus-sync-8d50b.web.app`, což je
výchozí jméno webu ve Firebase projektu `nexus-sync-8d50b`. Doména
`nexusstack.eu` servíruje **prezentační stránku** (Calendly), nasazovanou
odjinud — tenhle repozitář o ní neví.

Cílem je dát aplikaci vlastní adresu `hub.nexusstack.eu`.

## Proč

Adresa aplikace je dnes vázaná na jméno Firebase projektu a je zapsaná
v `server/src/app.js`, `server/src/services/socket.js`, `playwright.config.js`
a jako záloha v `server/src/controllers/billingController.js`. Dokud to tak je,
znamená každá změna hostingu zásah do kódu. S vlastní doménou je to úprava DNS.

Je to tatáž lekce, kterou projekt 3. 11. 2026 zaplatil u API: zaniklá adresa
byla zapsaná na dvaceti místech v klientovi a šesti na serveru.

## Co to NENÍ

**Vlastní doména nevytváří druhé prostředí.** Ve Firebase je to jen další jméno
téhož webu — `nexus-sync-8d50b.web.app` i `hub.nexusstack.eu` budou servírovat
stejné nasazení, stejný build a stejná data. Současnou adresu proto nejde
„nechat jako testovací": byly by to dvoje dveře do produkce.

Testovací prostředí dělá backend a databáze, ne adresa. Postup je
v `docs/testovaci-prostredi.md` a začíná druhým backendem, ne druhým webem.

## Postup

### 1. Firebase

Konzole → Hosting → web `nexus-sync-8d50b` → **Add custom domain** →
`hub.nexusstack.eu`.

Firebase vydá nejdřív `TXT` záznam k ověření vlastnictví, po ověření pak
`A` záznamy (dnes zpravidla `199.36.158.100` a `199.36.158.101`).

### 2. DNS u Spaceshipu

Doplnit, co Firebase vypsal. Apex `nexusstack.eu` a `api.nexusstack.eu`
**nechat být** — prezentační stránka i API běží dál beze změny.

Vydání certifikátu trvá řádově desítky minut až hodiny.

### 3. Server: povolit nový origin

Bez tohohle kroku se zopakuje přesně to, co se 3. 11. 2026 stalo u Socket.IO:
aplikace se načte, ale spojení se nenaváže.

```bash
ssh -i ~/.ssh/nexus_hub_ed25519 ubuntu@api.nexusstack.eu \
  "sudo sed -i 's|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://nexusstack.eu,https://www.nexusstack.eu,https://nexus-sync-8d50b.web.app,https://nexus-sync-8d50b.firebaseapp.com,https://hub.nexusstack.eu|' /root/nexus-backend/.env && sudo pm2 restart nexus-backend-final --update-env"
```

Jedna proměnná stačí na obojí: HTTP CORS v `app.js` i Socket.IO v `socket.js`
ji čtou.

### 4. Ověření

```bash
for O in https://hub.nexusstack.eu https://cizi.example.com; do
  printf "%-32s HTTP %s   Socket.IO %s\n" "$O" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $O" https://api.nexusstack.eu/api/auth/me)" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $O" 'https://api.nexusstack.eu/socket.io/?EIO=4&transport=polling')"
done
```

Nová doména musí dát `401` a `200` (CORS prošel, chybí jen přihlášení);
cizí doména `403` a `400`.

## Co se měnit NEMUSÍ

| | |
| --- | --- |
| build klienta | `VITE_API_URL` je adresa API, ne webu — vlastní hostname aplikace nepoužívá |
| relay APK | mluví na `api.`, ne na web; přestavovat ji netřeba |
| návratové adresy Stripe | klient posílá `successUrl: window.location.href`, takže jdou za prohlížečem; zapsaná hodnota v `billingController` je jen záloha |
| `nexus-sync-8d50b.web.app` | zůstane funkční jako výchozí jméno téhož webu, hodí se jako záloha při potížích s DNS |

Volitelně secret `FRONTEND_URL` pro Playwright, pokud mají E2E testy mířit
na novou adresu. Dnes padají na výchozí `nexus-sync-8d50b.web.app`, která
funguje dál.

## Proč `hub`, a ne něco popisnějšího

Jméno poddomény se **zveřejní**: certifikát se zapíše do Certificate
Transparency logů, které jsou veřejně prohledávatelné (`crt.sh`), takže
poddomény `nexusstack.eu` si může kdokoli vypsat. Jméno proto nemá popisovat,
čím se aplikace zabývá ani pro koho je. `hub` odpovídá jménu produktu
(Nexus Hub), je neutrální a páruje se s `api`.

Z téhož důvodu se vyhnout `admin` — je to magnet na skenery a navíc se tam
přihlašují i operátorky, ne jen správci.
