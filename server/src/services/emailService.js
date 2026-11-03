const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'Nexus Hub <noreply@nexushub.app>';
const { webAppUrl } = require('../utils/publicUrls');

// APP_URL je adresa WEBU, ne API. Dřív tu byla zapsaná adresa API, takže odkaz
// na reset hesla nevedl na formulář ani v době, kdy ten host ještě existoval —
// API žádnou stránku neservíruje. Viz utils/publicUrls.js.
const APP_URL = webAppUrl();

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!SMTP_HOST || !SMTP_USER) {
    console.warn('[Email] SMTP not configured — emails will be logged only');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendEmail({ to, subject, html, text }) {
  const transport = getTransporter();
  if (!transport) {
    console.log(`[Email][DRY] To: ${to} | Subject: ${subject}`);
    return { dry: true, to, subject };
  }
  try {
    const info = await transport.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      html,
      text: text || subject,
    });
    console.log(`[Email] Sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error(`[Email] Failed to send to ${to}:`, err.message);
    throw err;
  }
}

// --- Templates ---

async function sendPasswordReset(email, resetToken) {
  const resetLink = `${APP_URL}/reset-password?token=${resetToken}`;
  return sendEmail({
    to: email,
    subject: 'Nexus Hub — Obnovení hesla / Password Reset',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#6366f1">Nexus Hub</h2>
        <p>Obdrželi jsme žádost o obnovení hesla k vašemu účtu.</p>
        <p>We received a request to reset your password.</p>
        <p style="margin:24px 0">
          <a href="${resetLink}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">
            Obnovit heslo / Reset Password
          </a>
        </p>
        <p style="color:#666;font-size:13px">Odkaz je platný 1 hodinu. / This link expires in 1 hour.</p>
        <p style="color:#666;font-size:13px">Pokud jste tuto žádost nepodali, tento email ignorujte.</p>
      </div>
    `,
  });
}

async function sendWelcomeEmail(email, name, agencyName) {
  return sendEmail({
    to: email,
    subject: `Vítejte v Nexus Hub — ${agencyName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#6366f1">Vítejte v Nexus Hub! 🎉</h2>
        <p>Dobrý den <strong>${name}</strong>,</p>
        <p>Váš účet v agentuře <strong>${agencyName}</strong> byl úspěšně vytvořen.</p>
        <p>Přihlaste se na <a href="${APP_URL}" style="color:#6366f1">${APP_URL}</a></p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#666;font-size:13px">Nexus Hub — Agency Management Platform</p>
      </div>
    `,
  });
}

async function sendAgencyRegistrationEmail(email, agencyName) {
  return sendEmail({
    to: email,
    subject: `Nexus Hub — Registrace agentury ${agencyName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#6366f1">Registrace přijata ✅</h2>
        <p>Agentura <strong>${agencyName}</strong> byla úspěšně zaregistrována.</p>
        <p>Váš účet je aktivní. Přihlaste se a začněte konfigurovat svou agenturu.</p>
        <p style="margin:24px 0">
          <a href="${APP_URL}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">
            Přihlásit se / Login
          </a>
        </p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#666;font-size:13px">Nexus Hub — Agency Management Platform</p>
      </div>
    `,
  });
}

async function sendBookingReminder(email, profileName, clientName, dateTime, notes) {
  return sendEmail({
    to: email,
    subject: `Nexus Hub — Připomenutí rezervace / Booking Reminder`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#6366f1">📅 Připomenutí rezervace</h2>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;color:#666">Profil:</td><td style="padding:8px;font-weight:bold">${profileName}</td></tr>
          <tr><td style="padding:8px;color:#666">Klient:</td><td style="padding:8px;font-weight:bold">${clientName}</td></tr>
          <tr><td style="padding:8px;color:#666">Datum/čas:</td><td style="padding:8px;font-weight:bold">${dateTime}</td></tr>
          ${notes ? `<tr><td style="padding:8px;color:#666">Poznámky:</td><td style="padding:8px">${notes}</td></tr>` : ''}
        </table>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#666;font-size:13px">Nexus Hub — Agency Management Platform</p>
      </div>
    `,
  });
}

module.exports = {
  sendEmail,
  sendPasswordReset,
  sendWelcomeEmail,
  sendAgencyRegistrationEmail,
  sendBookingReminder,
};
