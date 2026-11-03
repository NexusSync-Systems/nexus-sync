# Manuál pro nastavení Nexus Relay & Firebase (CZ)

Tento návod tě provede kompletním nastavením propojení mezi tvým serverem a Android zařízeními pomocí Firebase (FCM).

---

## 1. Nastavení Firebase na serveru

Aby mohl server posílat notifikace (příkazy k odeslání SMS) do telefonu, potřebuje přístupové údaje.

### Krok A: Získání JSON souboru
1.  Přejdi do [Firebase Console](https://console.firebase.google.com/).
2.  Vyber svůj projekt (Nexus Hub).
3.  Klikni na **Project Settings** (ozubené kolečko) -> **Service Accounts**.
4.  Klikni na **Generate New Private Key**. Stáhne se ti `.json` soubor.

### Krok B: Konfigurace v `.env`
Otevři soubor `server/.env` a přidej do něj obsah staženého JSONu (vše na jeden řádek bez mezer) nebo ho ulož na server a odkaž na něj:

**Možnost 1 (Doporučeno):**
Vše vlož do jedné proměnné:
`FIREBASE_SERVICE_ACCOUNT_JSON='{"type": "service_account", "project_id": "...", ...}'`

**Možnost 2 (Lokální soubor):**
`GOOGLE_APPLICATION_CREDENTIALS="/cesta/k/souboru/firebase-key.json"`

---

## 2. Ověření registrace zařízení (Push Token)

Jakmile se uživatel přihlásí do aplikace, musí poslat svůj „Push Token“ na server.

### Jak to ověřit v prohlížeči:
1.  Otevři aplikaci a přihlas se.
2.  Stiskni `F12` (DevTools) a jdi na záložku **Network**.
3.  Hledej požadavek `POST /api/device/push-token`.
4.  **Kontrola:**
    *   **Status Code:** musí být `200 OK`.
    *   **Authorization Header:** musí obsahovat `Bearer <tvůj_JWT_token>`.
    *   **Payload:** měl by vypadat takto: `{"token": "fcm-token-string", "platform": "android"}`.

Pokud tento request nevidíš, zkontroluj v logu aplikace (Logcat v Android Studiu), zda se podařilo token vygenerovat.

---

## 3. Testování Inbound Webhooků (SMS / Volání)

Můžeš simulovat, že na telefon přišla SMS a otestovat, zda se zobrazí v Dashboardu.

### Test SMS (simulace Nexus Relay):
Spusť tento příkaz v terminálu (nahraď URL svou adresou a deviceId platným ID operátora):


Adresa API se sem nezapisuje — nastav si ji do proměnné, aby postup platil i po stěhování serveru:

```bash
export NEXUS_API=https://api.vase-domena.cz/api
```

```bash
curl -X POST "$NEXUS_API/device/relay" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "op-01",
    "type": "sms",
    "from": "+420123456789",
    "content": "Ahoj, toto je testovaci zprava skrze Nexus Relay!"
  }'
```

---

## 4. Troubleshooting (Řešení problémů)

*   **Chyba 401 Unauthorized:** Špatný JWT token nebo chybějící/neplatné Firebase credentials.
*   **Zpráva se neobjeví:** Zkontroluj, zda v databázi existuje **Profile** s telefonním číslem, na které testuješ (pole `phoneNumber` musí přesně odpovídat poli `to` v JSONu).
*   **Push notifikace nechodí:** Zkontroluj v logu serveru, zda Firebase nehlásí `messaging/registration-token-not-registered`. To znamená, že token vypršel.
