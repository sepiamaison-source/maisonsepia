// =======================================================
// Modèles d'e-mails : code de vérification, confirmation, rappel.
// =======================================================
import { fmtDuration, fmtPrice } from "./schedule.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const nl2br = (s) => esc(s).replace(/\r?\n/g, "<br>");

const C = {
  bg: "#f3ece4",
  card: "#ffffff",
  ink: "#3d2b2b",
  muted: "#75625b",
  accent: "#6b2637",
  line: "#e3d7cb",
  sand: "#f7f1ea",
  red: "#c0281c",
};

export function formatDateFr(date) {
  const [y, m, d] = date.split("-").map(Number);
  const s = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function layout({ salon, title, body, footer = "" }) {
  return `
<div style="font-family:'Helvetica Neue',Arial,sans-serif;width:100%;background:${C.bg};padding:24px 0;">
  <div style="max-width:560px;margin:0 auto;background:${C.card};border:1px solid ${C.line};border-radius:14px;overflow:hidden;">
    <div style="background:${C.accent};padding:26px 24px;text-align:center;">
      <div style="color:#f6e9e4;font-size:22px;letter-spacing:1px;font-family:Georgia,'Times New Roman',serif;">${esc(salon)}</div>
    </div>
    <div style="padding:30px 26px;color:${C.ink};line-height:1.6;font-size:15px;">
      <h2 style="margin:0 0 18px;font-size:20px;font-weight:600;color:${C.ink};font-family:Georgia,'Times New Roman',serif;">${esc(title)}</h2>
      ${body}
    </div>
    ${footer ? `<div style="padding:16px 26px;background:${C.sand};color:${C.muted};font-size:12px;text-align:center;">${footer}</div>` : ""}
  </div>
</div>`;
}

const block = (label, html) => `
  <div style="margin:22px 0 0;">
    <div style="font-size:13px;font-weight:700;color:${C.accent};margin-bottom:4px;">${esc(label)}</div>
    <div style="color:${C.ink};">${html}</div>
  </div>`;

function servicesList(appt) {
  const rows = appt.services
    .map(
      (s) => `<tr>
        <td style="padding:4px 0;">${esc(s.name)}</td>
        <td style="padding:4px 0 4px 12px;text-align:right;color:${C.muted};white-space:nowrap;">${fmtDuration(s.duration)}</td>
        <td style="padding:4px 0 4px 12px;text-align:right;white-space:nowrap;">${s.priceFrom ? "dès " : ""}${fmtPrice(s.price)}</td>
      </tr>`
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}
    <tr><td style="padding:8px 0 0;border-top:1px solid ${C.line};font-weight:700;">Total</td>
    <td style="padding:8px 0 0 12px;border-top:1px solid ${C.line};text-align:right;font-weight:700;white-space:nowrap;">${fmtDuration(appt.totalDuration)}</td>
    <td style="padding:8px 0 0 12px;border-top:1px solid ${C.line};text-align:right;font-weight:700;white-space:nowrap;">${appt.priceFrom ? "dès " : ""}${fmtPrice(appt.totalPrice)}</td></tr>
  </table>`;
}

function addressBlock(cfg) {
  return `
  <div style="margin:22px 0 0;padding:16px 18px;background:${C.sand};border:1px solid ${C.line};border-radius:10px;">
    <div style="font-size:13px;font-weight:700;color:${C.accent};margin-bottom:4px;">Adresse</div>
    <div>${nl2br(cfg.addressFull)}</div>
    <div style="margin-top:10px;">Une fois arrivée en bas du bâtiment, merci de m'envoyer un message. Je viendrai vous ouvrir.</div>
  </div>`;
}

function paymentBlock() {
  return `
  <div style="margin:22px 0 0;">
    <div style="color:${C.red};font-weight:700;">Moyen de paiement : espèces uniquement</div>
    <div style="margin-top:2px;color:${C.ink};">Exceptionnellement Wero</div>
  </div>`;
}

export function otpEmail({ salon, firstName, code }) {
  return layout({
    salon,
    title: "Votre code de vérification",
    body: `
      <p>Bonjour ${esc(firstName)},</p>
      <p>Voici le code à saisir pour confirmer votre demande de rendez-vous :</p>
      <div style="margin:20px 0;padding:18px;text-align:center;font-size:32px;letter-spacing:8px;font-weight:700;color:${C.accent};background:${C.sand};border:1px solid ${C.line};border-radius:12px;">${esc(code)}</div>
      <p style="font-size:13px;color:${C.muted};">Ce code est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.</p>`,
  });
}

/** cfg = réglages "salon" : addressFull, policy, extraInfo */
export function confirmationEmail({ salon, appt, cfg }) {
  const body = `
    <p>Bonjour ${esc(appt.client.firstName)},</p>
    <p>Votre rendez-vous est bien confirmé.</p>
    <div style="margin:18px 0 0;padding:16px 18px;border:1px solid ${C.line};border-radius:10px;">
      <div style="font-size:18px;font-weight:700;">${esc(formatDateFr(appt.date))}</div>
      <div style="font-size:16px;color:${C.accent};font-weight:700;">${esc(appt.startTime)} – ${esc(appt.endTime)}</div>
    </div>
    ${block("Prestation(s)", servicesList(appt))}
    ${addressBlock(cfg)}
    ${paymentBlock()}
    ${cfg.policy ? block("Informations importantes", nl2br(cfg.policy)) : ""}
    ${cfg.extraInfo ? block("Informations importantes", nl2br(cfg.extraInfo)) : ""}`;
  return layout({ salon, title: "Votre rendez-vous est confirmé", body, footer: `À très bientôt chez ${esc(salon)}.` });
}

export function reminderEmail({ salon, appt, cfg }) {
  const body = `
    <p>Bonjour ${esc(appt.client.firstName)},</p>
    <p>Nous vous rappelons votre rendez-vous de demain :</p>
    <div style="margin:18px 0 0;padding:16px 18px;border:1px solid ${C.line};border-radius:10px;">
      <div style="font-size:18px;font-weight:700;">${esc(formatDateFr(appt.date))}</div>
      <div style="font-size:16px;color:${C.accent};font-weight:700;">${esc(appt.startTime)} – ${esc(appt.endTime)}</div>
    </div>
    ${block("Prestation(s)", servicesList(appt))}
    ${addressBlock(cfg)}
    ${paymentBlock()}
    ${cfg.policy ? block("Informations importantes", nl2br(cfg.policy)) : ""}`;
  return layout({ salon, title: "Rappel de votre rendez-vous", body });
}
