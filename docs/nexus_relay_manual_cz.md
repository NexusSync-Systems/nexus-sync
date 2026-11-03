# 📑 Nexus Relay: Uživatelský manuál (SMS/Call Forwarder)

Tento manuál vás provede nastavením vašeho vlastního, plně integrovaného forwarderu, který nahrazuje externí aplikace jako "SMS Forwarder" nebo "Automate".

---

## ⚡️ Co je Nexus Relay?
Nexus Relay je speciální režim aplikace Nexus Hub pro Android, který promění váš smartphone na **chytrou komunikační bránu**. Telefon přijímá SMS a hovory na vloženou SIM kartu a okamžitě je přeposílá do webového rozhraní Nexus Hub, kde je může odbavit operátorka.

---

## 🛠 Prerekvizity
1.  **Android Phone**: Verze 8.0 (Oreo) nebo novější.
2.  **Aktivní SIM karta**: Karta s vloženými daty nebo připojením na Wi-Fi.
3.  **Napájení**: Telefon musí být trvale připojen k nabíječce (režim 24/7).
4.  **Nexus APK**: Aplikace sestavená s naším nativním "Relay Bridge" (viz technický manuál).

---

## 👣 Krok za krokem

### 1. Instalace a přihlášení
*   Nainstalujte Nexus Hub APK do telefonu.
*   Přihlaste se pod účtem s oprávněním **Senior Operator** nebo **Manager**.
*   V postranním panelu (Sidebar) klikněte na tlačítko **NEXUS RELAY**.

### 2. Udělení oprávnění (Klíčový krok)
Při prvním spuštění vás systém Android požádá o přístup k:
*   **Příjem a čtení SMS**: Nezbytné pro zachycení zpráv od klientů.
*   **Stav telefonu (Calls)**: Nezbytné pro detekci příchozích hovorů.
*   **Poloha (GPS)**: Nutné pro mapování v rámci Safety Guardu.
*   **Baterie (Optimization)**: Vypněte "Optimalizaci baterie" pro aplikaci Nexus Hub, aby ji systém neukončoval na pozadí.

> [!IMPORTANT]
> Všechna tato oprávnění musí být nastavena na **"Vždy povolit"**.

### 3. Aktivace režimu brány
V rozhraní Nexus Relay uvidíte ovládací panel:
*   Klikněte na zelené tlačítko **PLAY** (Spustit).
*   Indikátor **SERVER** se musí rozsvítit zeleně (**CONNECTED**).
*   Zkontrolujte sílu signálu a stav baterie na displeji.

### 4. Nastavení systému (Settings)
*   **API Endpoint**: Ujistěte se, že je nastavena adresa vašeho backendu (dnes `https://api.nexusstack.eu`). Zapéká se do APK při buildu — v telefonu se přepsat nedá.
*   **Device ID**: Každý telefon má unikátní ID (např. RELAY-01), podle kterého operátorka pozná, o kterou modelku se jedná.

---

## 📈 Monitoring a logy
V dolní části obrazovky vidíte **FORWARDING LOGS**:
*   **Zelený text (FORWARDED)**: Zpráva byla úspěšně odeslána na server.
*   **Červený text (FAILED)**: Problém s připojením (zkontrolujte Wi-Fi/Data).

---

## 💡 Doporučení pro provoz 24/7
1.  **Vždy na nabíječce**: Forwarder nesmí vybít baterii.
2.  **Display Timeout**: V nastavení Androidu nastavte, aby obrazovka v režimu nabíjení nikdy nezhasínala (nebo použijte "Stay Awake" v možnostech pro vývojáře).
3.  **Tichý režim**: Vypněte zvonění, aby telefon nerušil operátorku doma, ale nechte zapnutá data.

---
> [!TIP]
> Pokud systém přestane přeposílat, zkuste tlačítko **PAUSE** a znovu **PLAY** pro restartování spojení se serverem.

---

## Terénní ověření

Pro pilotní nasazení a řešení chyb typu "SMS je vidět v telefonu, ale není ve webu" použijte checklist:

- [Android Relay field-test checklist](./android-relay-field-test.md)
