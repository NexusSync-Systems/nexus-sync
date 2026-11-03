# User Manual: Nexus Hub (Demo)

<div style="text-align: center; margin-bottom: 30px;">
  <img src="/nexus_icon.png" width="120" style="border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);" />
</div>

Welcome to the **Nexus Hub (AW Nexus)** – the central point for profile management, communications automation, and efficient agency scaling. This document serves as a guide to the features demonstrated in our interactive demo application.

---

### 1. Role-Specific Dashboards

Upon logging in, the system automatically detects your role and displays a customized home page (Dashboard):

- **Super Admin**: Global network overview, total revenue, number of active nodes, and infrastructure health.
- **Agency Manager**: Agency portfolio metrics, team activity, and individual profile performance.
- **Operator (Senior/Regular)**: Personal workspace with statistics on handled messages, calls, and commissions.
- **Model (Profile)**: Daily agenda, bookings overview, reviews, and cumulative earnings.

*Tip: Click the NEXUS logo at any time to return to your dashboard.*

---

### 2. Authentication (Login Screen)

The demo begins with a premium login screen featuring simulated security authentication.

#### Demo Credentials

| Role | Email | Password |
| :--- | :--- | :--- |
| **Super Admin** | `admin@nexus.ai` | `password123` |
| **Agency Manager** | `mark@nexus.sync` | `password123` |
| **Senior Operator** | `alice@nexus.sync` | `password123` |
| **Operator** | `sarah@nexus.sync` | `password123` |
| **Model** | `diana@nexus.sync` | `password123` |

---

### 3. Inbox & AI Suggestions

The primary module for client communication.

- **Unified Inbox**: All messages from AdultWork, SMS, and Telegram in one place.
- **AI Smart Replies**: The system analyzes message context and suggests quick replies in both English and Czech.
- **Automatic Translation**: Messages are automatically translated into the operator's/client's language.

---

### 4. Device Setup (Nexus Relay)

<div style="display: flex; align-items: center; gap: 15px; margin-bottom: 20px;">
  <img src="/nexus_relay_icon.png" width="60" style="border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.3);" />
  <div style="font-size: 1.25rem; font-weight: 800; color: #10b981;">NEXUS RELAY APP</div>
</div>

The Nexus Relay app acts as a bridge between your devices and the Nexus Hub cloud system. For proper operation, it must be installed on a stable Android device.
Nexus Hub features a proprietary gateway app for 24/7 synchronization without needing third-party tools like Automate or Tasker.

- **Download APK**: from the **Downloads** section inside the app *(Recommended for stability)*. The link is deliberately not written here — the server builds it from its own address, so it survives a backend move.
- **Features**: 
  - Integrated SMS Intercepting
  - Real-time Call State Notifications
  - Low Power Consumption
- **Setup**:
  1. Install the APK and grant all permissions (SMS, Phone, Location).
  2. Switch to **NEXUS RELAY** mode in the app.
  3. Ensure the connection status is **CONNECTED**.

---

### 5. Quality Control & QA Hub

A tool for quality assurance and client note management.

- **QA Hub (QA Centrum)**: Overview of all operator notes and client interaction history across the entire agency.
- **Audit Trail (Auditní Log)**: Every action (message sent, setting changed) is logged and secured with a cryptographic hash for total transparency.

---

### 6. Referral Program (Referrals)

Built-in system for referring new agencies or models.

- Unique referral links.
- Real-time tracking of clicks, sign-ups, and pending rewards.

---

### 7. Web Profiles Sync

- **Synchronization**: Change photos or biographies and push updates to all connected platforms (AdultWork, EuroGirlsEscort, etc.) with one click.
- **Proxy Gateway**: The system utilizes residential proxy nodes to eliminate the risk of scraping bans.

---
### 8. Architecture & Platform Specifics (Web vs. Mobile)
To ensure optimal user experience and security, Nexus Hub strictly distinguishes between features available on the web and in the mobile application:

- **Mobile Application (Native)**: Designed for models and field operators. Includes native features such as:
  - **Onboarding**: Initial guided setup (displayed in-app only).
  - **Guardian Suite**: Voice SOS, discreet Audio Sentinel (pulse beeps/vibrations), and sensor monitoring.
  - **Push Notifications**: Real-time system and security alerts.
- **Web Portal (Browser)**: Designed for administration, marketing, and agency management.
  - **Absence of Native Elements**: The web interface is stripped of mobile-specific elements (onboarding, sensors) to ensure a clean, distraction-free environment optimized for desktop management.

---
**Nexus Hub** – Your tool for absolute control and automation in adult management.
