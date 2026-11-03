# Uživatelský Manuál: Nexus Hub (Demo)

<div style="text-align: center; margin-bottom: 30px;">
  <img src="/nexus_icon.png" width="120" style="border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);" />
</div>

Vítejte v systému **Nexus Hub (AW Nexus)** – centrálním bodu pro správu profilů, automatizaci komunikace a efektivní škálování vaší agentury. Tento dokument slouží jako průvodce funkcemi, které můžete vidět v naší interaktivní demo aplikaci.

---

### 1. Role-Specifické Dashboardy
Po přihlášení systém automaticky rozpozná vaši roli a zobrazí přizpůsobenou domovskou stránku (Dashboard):

- **Super Admin**: Globální přehled sítě, celkové příjmy, počet aktivních uzlů a zdraví infrastruktury.
- **Agency Manager**: Metriky portfolia agentury, aktivita týmu a výkon jednotlivých profilů.
- **Operator (Senior/Regular)**: Osobní pracovní plocha se statistikami vyřízených zpráv, hovorů a provizí.
- **Model (Profile)**: Denní agenda, přehled rezervací, hodnocení a kumulativní výdělky.

*Tip: Kliknutím na logo NEXUS se kdykoliv vrátíte na svůj dashboard.*

---

### 2. Přihlášení (Login Screen)
Demo začíná premium přihlašovací obrazovkou se simulovanou bezpečnostní autentizací.

#### Přihlašovací údaje pro Demo

| Role | Email | Heslo |
| :--- | :--- | :--- |
| **Super Admin** | `admin@nexus.ai` | `password123` |
| **Agency Manager** | `mark@nexus.sync` | `password123` |
| **Senior Operator** | `alice@nexus.sync` | `password123` |
| **Operator** | `sarah@nexus.sync` | `password123` |
| **Model** | `diana@nexus.sync` | `password123` |

---

### 3. Inbox a Chytré Zprávy (AI Suggestions)
Hlavní modul pro komunikaci se zákazníky.

- **Jednotná schránka:** Všechny zprávy z AdultWork, SMS i Telegramu na jednom místě.
- **AI Smart Replies:** Systém analyzuje kontext zpráv a navrhuje rychlé odpovědi v češtině i angličtině.
- **Automatický překlad:** Zprávy jsou automaticky překládány do jazyka operátora/klienta.

---

### 4. Nastavení zařízení (Nexus Relay)

<div style="display: flex; align-items: center; gap: 15px; margin-bottom: 20px;">
  <img src="/nexus_relay_icon.png" width="60" style="border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.3);" />
  <div style="font-size: 1.25rem; font-weight: 800; color: #10b981;">NEXUS RELAY APP</div>
</div>

Aplikace Nexus Relay slouží jako most mezi vašimi zařízeními a cloudovým systémem Nexus Hub. Pro správné fungování je nutné aplikaci nainstalovat na stabilní zařízení Android.

- **Stáhnout APK**: v aplikaci v sekci **Aplikace ke stažení** *(Doporučený způsob pro stabilitu)*. Odkaz tu není zapsaný schválně — skládá ho server z vlastní adresy, takže se stěhováním backendu nepřestane platit.
- **Vlastnosti**: 
  - Integrované zachytávání SMS
  - Real-time notifikace stavu hovorů
  - Nízká spotřeba baterie
- **Nastavení**:
  1. Nainstalujte APK a povolte všechna oprávnění (SMS, Telefon, Poloha).
  2. V aplikaci přepněte do režimu **NEXUS RELAY**.
  3. Ujistěte se, že stav serveru je **CONNECTED**.

---

### 5. Kvalita a QA Hub
Nástroj pro kontrolu kvality a správu poznámek o klientech.
- **QA Centrum**: Přehled všech poznámek operátorů a historie interakcí s klienty napříč celou agenturou.
- **Auditní Log**: Každá akce (odeslání zprávy, změna nastavení) je zaznamenána a opatřena kryptografickým hashem pro maximální transparentnost.

---

### 6. Partnerský Program (Referrals)
Zabudovaný systém pro doporučování nových agentur nebo modelek.
- Unikátní referenční odkazy.
- Sledování kliknutí, registrací a čekajících odměn v reálném čase.

---

### 7. Správa Webových Profilů (Web Profiles Sync)
- **Synchronizace**: Změna fotek nebo biografie se jedním kliknutím rozešle na všechny inzertní weby (AdultWork, EuroGirlsEscort aj.).
- **Proxy Brána**: Systém využívá residenční proxy uzly pro eliminaci rizika banů.

---
### 8. Architektura a Platformy (Web vs. Mobile)
Pro zajištění optimálního uživatelského zážitku a bezpečnosti Nexus Hub striktně rozlišuje mezi funkcionalitou dostupnou na webu a v mobilní aplikaci:

- **Mobilní Aplikace (Nativní)**: Určena pro modelky a operátory v terénu. Obsahuje nativní funkce jako:
  - **Onboarding**: Úvodní zaškolení (zobrazuje se pouze v aplikaci).
  - **Guardian Suite**: Hlasové SOS, diskrétní Audio Sentinel (pípání/vibrace) a senzory.
  - **Push Notifikace**: Okamžité systémové a bezpečnostní výstrahy.
- **Webový Portál (Prohlížeč)**: Určen pro administrativu, marketing a správu agentur.
  - **Absence nativních prvků**: Webové rozhraní je zbaveno mobilních prvků (onboarding, senzory), aby nepůsobilo rušivě a bylo optimalizováno pro desktopovou práci.

---
**Nexus Hub** – Váš nástroj pro absolutní kontrolu a automatizaci v adult managementu.
