import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  TZ, parisToMs, msToParis, addDays, weekday, isValidDate, isValidTime,
  computeDaySlots, normalizeRanges, fmtDuration, fmtPrice,
} from "./lib/schedule.js";
import { otpEmail, confirmationEmail, reminderEmail } from "./lib/emails.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

// =======================================================
// 1. CONFIGURATION
// =======================================================

const ADMIN_KEY = env.ADMIN_KEY || "";
if (ADMIN_KEY.length < 8) {
  console.error("❌ ADMIN_KEY manquante ou trop courte (8 caractères minimum). Définissez-la dans les variables d'environnement.");
  process.exit(1);
}

const SALON_NAME = env.SALON_NAME || "Maison Sépia";
const PUBLIC_LOCATION = env.PUBLIC_LOCATION || "Avenue du Puy-de-Dôme, Clermont-Ferrand"; // seule adresse affichée publiquement
const CALENDAR_ID = env.CALENDAR_ID || "";
const REQUIRE_OTP = env.REQUIRE_EMAIL_OTP !== "false";
const BREVO_KEY = env.BREVO_API_KEY || env.MAIL_PASS || "";
const MAIL_FROM_EMAIL = env.MAIL_FROM_EMAIL || "";
const MAIL_FROM_NAME = env.MAIL_FROM_NAME || SALON_NAME;
const MAX_ACTIVE_BOOKINGS = Number(env.MAX_ACTIVE_BOOKINGS_PER_CLIENT || 3);
const SYNC_INTERVAL_MS = Math.max(30, Number(env.CALENDAR_SYNC_SECONDS || 120)) * 1000;
const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // vérifier les rappels toutes les 30 min suffit largement (pas de gain à le faire plus souvent)
const APPOINTMENT_RETENTION_MONTHS = Math.max(1, Number(env.APPOINTMENT_RETENTION_MONTHS || 6));
const EVENT_SOURCE = "maison-sepia";
const BLOCK_EVENT_SOURCE = "maison-sepia-block";
const MAX_APPT_MS = 12 * 3600 * 1000; // durée max d'un rendez-vous (sert aux requêtes de chevauchement)
const DAY_MS = 86400000;
const CLEANUP_INTERVAL_MS = 24 * 3600 * 1000;

let serviceAccount;
try {
  serviceAccount = JSON.parse(env.SERVICE_ACCOUNT_KEY || fs.readFileSync("./google-service-account.json", "utf8"));
} catch {
  console.error("❌ Clé de compte de service introuvable : définissez SERVICE_ACCOUNT_KEY ou ajoutez google-service-account.json.");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const { FieldPath } = admin.firestore;
const col = (name) => db.collection(name);

let calendar = null;
if (CALENDAR_ID) {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  calendar = google.calendar({ version: "v3", auth });
} else {
  console.warn("⚠️  CALENDAR_ID absent : la synchronisation Google Agenda est désactivée.");
}

const app = express();
app.set("trust proxy", true);
const origins = (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));
// Réponse simple à la racine, utile pour un moniteur de disponibilité (UptimeRobot, etc.) — ne s'active
// que si aucun fichier public/index.html n'est déployé ici (le site étant hébergé séparément sur Netlify).
app.get("/", (req, res) => res.type("text/plain").send(`${SALON_NAME} — serveur de réservation opérationnel.`));

// =======================================================
// 2. OUTILS
// =======================================================

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
    console.error("❌", req.method, req.path, err);
    res.status(500).json({ success: false, message: "Une erreur est survenue sur le serveur." });
  });

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(req.ip, h); }
    if (++h.n > max) return res.status(429).json({ success: false, message: "Trop de tentatives. Réessayez dans quelques minutes." });
    next();
  };
}

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+()\d\s.-]{8,20}$/;
const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);

function cleanClient(b = {}, { requireAll = true } = {}) {
  const c = {
    firstName: str(b.firstName, 60),
    lastName: str(b.lastName, 60),
    phone: str(b.phone, 25),
    email: str(b.email, 120).toLowerCase(),
  };
  if (requireAll) {
    if (!c.firstName || !c.lastName) throw new HttpError(400, "Merci d'indiquer votre prénom et votre nom.");
    if (!PHONE_RE.test(c.phone)) throw new HttpError(400, "Numéro de téléphone invalide.");
    if (!EMAIL_RE.test(c.email)) throw new HttpError(400, "Adresse e-mail invalide.");
  } else {
    if (c.phone && !PHONE_RE.test(c.phone)) throw new HttpError(400, "Numéro de téléphone invalide.");
    if (c.email && !EMAIL_RE.test(c.email)) throw new HttpError(400, "Adresse e-mail invalide.");
  }
  return c;
}

function clientKey(c) {
  if (c.email) return c.email.toLowerCase();
  const digits = String(c.phone || "").replace(/\D/g, "");
  return digits ? `tel-${digits}` : `anon-${crypto.randomUUID()}`;
}

const clientLabel = (a) => `${a.client?.firstName || ""} ${a.client?.lastName || ""}`.trim() || "Rendez-vous";
const isActive = (a) => (a.status || "confirmed") === "confirmed";
const todayParis = () => msToParis(Date.now()).date;

// =======================================================
// 3. RÉGLAGES, HORAIRES ET CATALOGUE
// =======================================================

const DEFAULTS = {
  general: { is_open: true, slotStep: 30, minNoticeHours: 2, maxAdvanceDays: 90 },
  salon: {
    addressFull: PUBLIC_LOCATION,
    policy:
      "Merci d'arriver à l'heure : un retard important peut raccourcir la prestation ou entraîner son report.\nToute annulation ou modification doit être signalée au moins 24 h à l'avance.",
    extraInfo: "",
  },
  // 0 = dimanche … 6 = samedi
  hours: {
    0: [], 1: [],
    2: [{ start: "09:00", end: "19:00" }],
    3: [{ start: "09:00", end: "19:00" }],
    4: [{ start: "09:00", end: "19:00" }],
    5: [{ start: "09:00", end: "19:00" }],
    6: [{ start: "09:00", end: "17:00" }],
  },
};

let settingsCache = null;
async function getSettings() {
  if (settingsCache && Date.now() - settingsCache.at < 60000) return settingsCache.data;
  const [g, s, h] = await db.getAll(col("settings").doc("general"), col("settings").doc("salon"), col("settings").doc("hours"));
  const data = {
    general: { ...DEFAULTS.general, ...(g.data() || {}) },
    salon: { ...DEFAULTS.salon, ...(s.data() || {}) },
    hours: { ...DEFAULTS.hours, ...((h.data() || {}).days || {}) },
  };
  settingsCache = { at: Date.now(), data };
  return data;
}

let catalogCache = null;
async function getCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < 60000) return catalogCache.data;
  const [c, s] = await Promise.all([col("categories").get(), col("services").get()]);
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name), "fr");
  const data = {
    categories: c.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byOrder),
    services: s.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byOrder),
  };
  catalogCache = { at: Date.now(), data };
  return data;
}

const invalidateCaches = () => { settingsCache = null; catalogCache = null; };

/** Valide les prestations choisies et fige nom / prix / durée dans le rendez-vous. */
async function resolveServices(ids, { activeOnly = true } = {}) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!ids.length) throw new HttpError(400, "Sélectionnez au moins une prestation.");
  if (ids.length > 12) throw new HttpError(400, "Trop de prestations sélectionnées.");
  const { categories, services } = await getCatalog();
  const okCats = new Set(categories.filter((c) => c.active !== false).map((c) => c.id));
  return ids.map((id) => {
    const s = services.find((x) => x.id === id);
    if (!s || (activeOnly && (s.active === false || !okCats.has(s.categoryId)))) {
      throw new HttpError(400, "Une prestation sélectionnée n'est plus disponible. Merci d'actualiser la page.");
    }
    return {
      id: s.id, name: s.name, price: Number(s.price) || 0, priceFrom: !!s.priceFrom,
      duration: Number(s.duration) || 0, categoryId: s.categoryId,
    };
  });
}

async function seedIfEmpty() {
  const snap = await col("categories").limit(1).get();
  if (!snap.empty) return;
  console.log("🌱 Premier démarrage : ajout de catégories et prestations d'exemple (modifiables depuis la gestion).");
  const batch = db.batch();
  const cats = {};
  ["Beauté des mains", "Nail art", "Beauté des pieds", "Épilation"].forEach((name, i) => {
    const ref = col("categories").doc();
    cats[name] = ref.id;
    batch.set(ref, { name, active: true, order: i });
  });
  [
    ["Beauté des mains", "Manucure russe · complément", "Préparation ultra-précise des cuticules, à ajouter à une prestation.", 10, 15],
    ["Beauté des mains", "Manucure russe seule", "Soin précis des cuticules et de l'ongle naturel, sans pose.", 25, 30],
    ["Beauté des mains", "Pose complète", "Rallongement au papier ou au chablon, selon la forme et le résultat souhaité.", 60, 120],
    ["Beauté des mains", "Renforcement", "Renforcement de l'ongle naturel avec une finition colorée.", 40, 70],
  ].forEach(([cat, name, description, price, duration], i) => {
    batch.set(col("services").doc(), { categoryId: cats[cat], name, description, price, priceFrom: false, duration, active: true, order: i });
  });
  await batch.commit();
}

// =======================================================
// 4. DISPONIBILITÉS
// =======================================================

/** Rendez-vous + blocages enregistrés sur le site. */
async function loadInternalBusy(startMs, endMs, { tx = null, excludeIds = [] } = {}) {
  const run = (q) => (tx ? tx.get(q) : q.get());
  const [aSnap, bSnap] = await Promise.all([
    run(col("appointments").where("startMs", ">=", startMs - MAX_APPT_MS).where("startMs", "<", endMs)),
    run(col("blocks").where("endMs", ">", startMs)),
  ]);
  const busy = [];
  aSnap.forEach((d) => {
    const a = d.data();
    if (!isActive(a) || excludeIds.includes(d.id) || a.endMs <= startMs) return;
    busy.push({ startMs: a.startMs, endMs: a.endMs, kind: "appointment", id: d.id, label: clientLabel(a) });
  });
  bSnap.forEach((d) => {
    const b = d.data();
    if (b.startMs >= endMs) return;
    busy.push({ startMs: b.startMs, endMs: b.endMs, kind: "block", id: d.id, label: b.label || "Indisponible" });
  });
  return busy;
}

/** Événements Google Agenda qui occupent du temps (mis en cache 30 s). */
const gcalCache = new Map();
async function getExternalBusy(startMs, endMs) {
  if (!calendar) return [];
  const key = `${Math.floor(startMs / 3600000)}-${Math.floor(endMs / 3600000)}`;
  const hit = gcalCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.data;
  try {
    const busy = [];
    let pageToken;
    do {
      const r = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: new Date(startMs).toISOString(),
        timeMax: new Date(endMs).toISOString(),
        singleEvents: true,
        showDeleted: false,
        maxResults: 250,
        pageToken,
      });
      for (const ev of r.data.items || []) {
        if (ev.status === "cancelled") continue;
        const allDay = !!ev.start?.date;
        if (ev.transparency === "transparent" && !allDay) continue; // marqué « disponible »
        const s = allDay ? parisToMs(ev.start.date, "00:00") : Date.parse(ev.start?.dateTime);
        const e = allDay ? parisToMs(ev.end.date, "00:00") : Date.parse(ev.end?.dateTime);
        if (Number.isFinite(s) && Number.isFinite(e)) busy.push({ startMs: s, endMs: e, kind: "gcal", label: ev.summary || "Google Agenda" });
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);
    gcalCache.set(key, { at: Date.now(), data: busy });
    if (gcalCache.size > 60) gcalCache.delete(gcalCache.keys().next().value);
    return busy;
  } catch (e) {
    console.error("❌ Lecture Google Agenda :", e.message);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.data; // repli sur le cache récent
    throw new HttpError(503, "Les disponibilités sont momentanément indisponibles. Réessayez dans un instant.");
  }
}

async function availabilityRange(from, nDays, durationMin) {
  const { general, hours } = await getSettings();
  const dates = Array.from({ length: nDays }, (_, i) => addDays(from, i));
  if (!general.is_open) return { closed: true, days: dates.map((date) => ({ date, slots: [] })) };

  const to = addDays(from, nDays);
  const startMs = parisToMs(from, "00:00");
  const endMs = parisToMs(to, "00:00");
  const nowMs = Date.now();
  const maxMs = nowMs + general.maxAdvanceDays * DAY_MS;

  const [internal, external, exSnap] = await Promise.all([
    loadInternalBusy(startMs, endMs),
    getExternalBusy(startMs, endMs),
    col("exceptions").where(FieldPath.documentId(), ">=", from).where(FieldPath.documentId(), "<", to).get(),
  ]);
  const busy = [...internal, ...external];
  const overrides = new Map(exSnap.docs.map((d) => [d.id, d.data().ranges || []]));

  const days = dates.map((date) => ({
    date,
    slots: computeDaySlots({
      date,
      ranges: overrides.has(date) ? overrides.get(date) : hours[String(weekday(date))] || [],
      durationMin,
      stepMin: general.slotStep,
      nowMs,
      minNoticeMs: general.minNoticeHours * 3600000,
      maxMs,
      busy,
    }),
  }));
  return { closed: false, days };
}

async function assertSlotAvailable(date, time, durationMin) {
  const { closed, days } = await availabilityRange(date, 1, durationMin);
  if (closed) throw new HttpError(409, "Les réservations en ligne sont momentanément fermées.");
  if (!days[0].slots.includes(time)) {
    throw new HttpError(409, "Ce créneau n'est plus disponible. Merci d'en choisir un autre.", { slotTaken: true });
  }
}

// =======================================================
// 5. E-MAILS (Brevo)
// =======================================================

async function sendMail({ to, toName, subject, html }) {
  if (!BREVO_KEY || !MAIL_FROM_EMAIL) {
    console.warn(`✉️  E-mail non envoyé (BREVO_API_KEY / MAIL_FROM_EMAIL manquants) : ${subject}`);
    return false;
  }
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { accept: "application/json", "api-key": BREVO_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { name: MAIL_FROM_NAME, email: MAIL_FROM_EMAIL },
        to: [{ email: to, name: toName }],
        subject,
        htmlContent: html,
      }),
    });
    if (!r.ok) {
      console.error("✉️  Brevo :", r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("✉️  Envoi e-mail :", e.message);
    return false;
  }
}

async function sendConfirmation(appt) {
  if (!appt.client?.email) return false;
  const { salon: cfg } = await getSettings();
  return sendMail({
    to: appt.client.email,
    toName: `${appt.client.firstName} ${appt.client.lastName}`,
    subject: `Rendez-vous confirmé – ${SALON_NAME}`,
    html: confirmationEmail({ salon: SALON_NAME, appt, cfg }),
  });
}

// =======================================================
// 6. GOOGLE AGENDA (site ↔ agenda)
// =======================================================

function eventBody(a) {
  const c = a.client || {};
  const lines = [
    `Tél : ${c.phone || "—"}`,
    `E-mail : ${c.email || "—"}`,
    "",
    "Prestations :",
    ...a.services.map((s) => `• ${s.name} (${fmtDuration(s.duration)}, ${fmtPrice(s.price)})`),
    `Total : ${fmtDuration(a.totalDuration)} · ${a.priceFrom ? "dès " : ""}${fmtPrice(a.totalPrice)}`,
  ];
  if (a.clientNote) lines.push("", `Précision de la cliente : ${a.clientNote}`);
  if (a.internalNote) lines.push("", `Note interne : ${a.internalNote}`);
  lines.push("", "Rendez-vous géré par la plateforme de réservation : déplacez-le ici, le site se met à jour automatiquement.");
  return {
    summary: `${clientLabel(a)} · ${a.services.map((s) => s.name).join(" + ")}`,
    description: lines.join("\n"),
    start: { dateTime: new Date(a.startMs).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(a.endMs).toISOString(), timeZone: TZ },
    extendedProperties: { private: { source: EVENT_SOURCE, appointmentId: a.id } },
  };
}

const gcode = (e) => e?.code || e?.response?.status;

/** Site -> Google Agenda. Ne lève jamais d'erreur : en cas d'échec, le rendez-vous reste « à synchroniser ». */
async function pushToCalendar(id, a) {
  if (!calendar) return;
  const ref = col("appointments").doc(id);
  try {
    let eventId = a.calendarEventId || null;
    if (!isActive(a)) {
      if (eventId) {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId }).catch((e) => {
          if (![404, 410].includes(gcode(e))) throw e;
        });
      }
      await ref.update({ calendarEventId: null, calendarDirty: false, calendarError: admin.firestore.FieldValue.delete() });
    } else {
      if (eventId) {
        try {
          await calendar.events.patch({ calendarId: CALENDAR_ID, eventId, requestBody: eventBody({ ...a, id }) });
        } catch (e) {
          if ([404, 410].includes(gcode(e))) eventId = null;
          else throw e;
        }
      }
      if (!eventId) {
        const r = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: eventBody({ ...a, id }) });
        eventId = r.data.id;
      }
      await ref.update({ calendarEventId: eventId, calendarDirty: false, calendarError: admin.firestore.FieldValue.delete() });
    }
    gcalCache.clear();
  } catch (e) {
    console.error(`❌ Google Agenda (rdv ${id}) :`, e.message);
    await ref.update({ calendarDirty: true, calendarError: String(e.message).slice(0, 200) }).catch(() => {});
  }
}

/** Nombre de millisecondes il y a n mois (tient compte de la longueur réelle des mois). */
function monthsAgoMs(n) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.getTime();
}

/** Supprime tous les documents d'une requête, par lots de 400 (limite Firestore : 500 écritures/lot). */
async function batchDeleteAll(snap) {
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

/**
 * Nettoyage automatique : la collection `clients` n'est **jamais** touchée ici — les fiches
 * clientes sont conservées indéfiniment. Sont supprimés : les codes de vérification expirés,
 * les blocages et jours particuliers désormais passés, et les rendez-vous de plus de
 * `APPOINTMENT_RETENTION_MONTHS` mois (confirmés, annulés ou fusionnés).
 */
async function cleanupOldData() {
  try {
    const now = Date.now();
    const n1 = await batchDeleteAll(await col("temp_verifications").where("createdAtMs", "<", now - DAY_MS).get());
    const pastDate = todayParis();
    const n2 = await batchDeleteAll(await col("blocks").where("endMs", "<", parisToMs(pastDate, "00:00")).get());
    const n3 = await batchDeleteAll(await col("exceptions").where(FieldPath.documentId(), "<", pastDate).get());
    const n4 = await batchDeleteAll(await col("appointments").where("startMs", "<", monthsAgoMs(APPOINTMENT_RETENTION_MONTHS)).get());
    if (n1 || n2 || n3 || n4) {
      console.log(`🧹 Nettoyage : ${n1} code(s) expiré(s), ${n2} blocage(s) passé(s), ${n3} jour(s) particulier(s) passé(s), ${n4} rendez-vous de plus de ${APPOINTMENT_RETENTION_MONTHS} mois.`);
    }
  } catch (e) {
    console.error("❌ Nettoyage :", e.message);
  }
}

let syncing = false;
/**
 * Google Agenda -> site (déplacements / suppressions) + renvoi des modifications en attente.
 * Optimisé pour le plan gratuit de Firestore : ne relit JAMAIS l'ensemble des rendez-vous à
 * chaque cycle. Chaque événement Google Agenda créé par le site porte déjà l'identifiant du
 * rendez-vous (extendedProperties), donc on ne lit que les documents réellement concernés :
 * ceux en attente d'envoi (`calendarDirty`, normalement aucun) et ceux dont l'événement Google
 * a effectivement changé depuis le dernier passage (normalement aucun non plus, la plupart du
 * temps). Un cycle "rien à faire" ne coûte donc que 1 ou 2 lectures Firestore au lieu d'une
 * lecture par rendez-vous à venir.
 */
async function syncCalendar() {
  if (!calendar || syncing) return;
  syncing = true;
  try {
    const now = Date.now();
    const stateRef = col("settings").doc("sync");
    const since = ((await stateRef.get()).data() || {}).lastSyncMs || now - 10 * 60000; // 1 lecture

    // 1) Site -> Agenda : uniquement les rendez-vous marqués "à synchroniser" (normalement aucun,
    //    puisque l'envoi se fait déjà juste après chaque création/modification).
    const dirtySnap = await col("appointments").where("calendarDirty", "==", true).get(); // 1 lecture minimum, ou N si N en attente
    for (const d of dirtySnap.docs) await pushToCalendar(d.id, { id: d.id, ...d.data() });

    // 2) Agenda -> site : on demande à Google ce qui a changé depuis le dernier passage (aucun coût
    //    Firestore), puis on ne va lire QUE les rendez-vous correspondants, un par un, via leur id
    //    stocké dans l'événement — jamais toute la collection.
    let pageToken, changed = 0;
    do {
      const r = await calendar.events.list({
        calendarId: CALENDAR_ID,
        updatedMin: new Date(since - 60000).toISOString(),
        showDeleted: true,
        maxResults: 250,
        pageToken,
      });
      for (const ev of r.data.items || []) {
        const appointmentId = ev.extendedProperties?.private?.source === EVENT_SOURCE ? ev.extendedProperties.private.appointmentId : null;
        if (!appointmentId) continue; // pas un événement créé par le site (ou un blocage) : on l'ignore
        changed++;
        const ref = col("appointments").doc(appointmentId);
        const snap = await ref.get(); // 1 lecture, seulement pour un rendez-vous réellement modifié dans Google Agenda
        if (!snap.exists) continue;
        const a = snap.data();
        if (!isActive(a)) continue; // déjà annulé/fusionné côté site, rien à répercuter

        if (ev.status === "cancelled") {
          await ref.update({ status: "cancelled", cancelledBy: "google-agenda", cancelledAtMs: now, calendarEventId: null, calendarDirty: false });
          console.log(`🗓️  Rendez-vous ${appointmentId} annulé depuis Google Agenda.`);
          continue;
        }
        if (!ev.start?.dateTime || !ev.end?.dateTime) continue;
        const s = Date.parse(ev.start.dateTime);
        const e = Date.parse(ev.end.dateTime);
        if (s !== a.startMs || e !== a.endMs) {
          const p = msToParis(s);
          await ref.update({
            date: p.date, startTime: p.time, endTime: msToParis(e).time,
            startMs: s, endMs: e, totalDuration: Math.round((e - s) / 60000),
            reminderSent: false, updatedAtMs: now,
          });
          console.log(`🗓️  Rendez-vous ${appointmentId} déplacé depuis Google Agenda.`);
        }
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);

    await stateRef.set({ lastSyncMs: now }, { merge: true });
    if (changed || dirtySnap.size) gcalCache.clear();
  } catch (e) {
    console.error("❌ Synchronisation Google Agenda :", e.message);
  } finally {
    syncing = false;
  }
}

// =======================================================
// 7. RENDEZ-VOUS : création, rappels
// =======================================================

async function createAppointment({ date, time, services, client, clientNote = "", internalNote = "", source, force = false, durationMin, totalPrice }) {
  const totalDuration = Number(durationMin) || sum(services, (s) => s.duration);
  if (!(totalDuration >= 5 && totalDuration <= 720)) throw new HttpError(400, "Durée invalide (entre 5 min et 12 h).");
  const price = totalPrice !== undefined && totalPrice !== "" && totalPrice !== null ? Number(totalPrice) : sum(services, (s) => s.price);
  if (!Number.isFinite(price) || price < 0) throw new HttpError(400, "Prix invalide.");

  const startMs = parisToMs(date, time);
  const endMs = startMs + totalDuration * 60000;
  const clientId = clientKey(client);
  const apptRef = col("appointments").doc();
  const clientRef = col("clients").doc(clientId);
  const now = Date.now();
  const doc = {
    date, startTime: time, endTime: msToParis(endMs).time, startMs, endMs,
    services, totalDuration, totalPrice: price, priceFrom: services.some((s) => s.priceFrom),
    client, clientId, clientNote: str(clientNote, 500), internalNote: str(internalNote, 1000),
    status: "confirmed", source, calendarEventId: null, calendarDirty: !!calendar,
    reminderSent: false, createdAtMs: now,
  };

  await db.runTransaction(async (tx) => {
    const [busy, cSnap] = await Promise.all([
      force ? [] : loadInternalBusy(startMs, endMs, { tx }),
      tx.get(clientRef),
    ]);
    const conflict = busy.find((b) => startMs < b.endMs && endMs > b.startMs);
    if (conflict) {
      throw new HttpError(409, source === "site" ? "Ce créneau vient d'être réservé. Merci d'en choisir un autre." : `Ce créneau chevauche : ${conflict.label}.`, { conflict: true, slotTaken: true });
    }
    const fields = Object.fromEntries(Object.entries(client).filter(([, v]) => v));
    tx.set(apptRef, doc);
    tx.set(clientRef, { ...fields, updatedAtMs: now, ...(cSnap.exists ? {} : { createdAtMs: now, internalNote: "" }) }, { merge: true });
  });

  const saved = { id: apptRef.id, ...doc };
  await pushToCalendar(saved.id, saved);
  return saved;
}

const publicSummary = (a) => ({
  date: a.date, time: a.startTime, endTime: a.endTime, services: a.services,
  totalDuration: a.totalDuration, totalPrice: a.totalPrice, priceFrom: a.priceFrom,
});

async function sendReminders() {
  try {
    const now = Date.now();
    const snap = await col("appointments").where("startMs", ">", now).where("startMs", "<=", now + DAY_MS).get();
    const { salon: cfg } = await getSettings();
    for (const doc of snap.docs) {
      const a = { id: doc.id, ...doc.data() };
      if (!isActive(a) || a.reminderSent || !a.client?.email) continue;
      // réservé moins de 24 h avant : pas de rappel (la confirmation vient d'être envoyée)
      if (a.startMs - (a.createdAtMs || 0) <= DAY_MS) { await doc.ref.update({ reminderSent: true }); continue; }
      const ok = await sendMail({
        to: a.client.email,
        toName: `${a.client.firstName} ${a.client.lastName}`,
        subject: `Rappel : votre rendez-vous de demain – ${SALON_NAME}`,
        html: reminderEmail({ salon: SALON_NAME, appt: a, cfg }),
      });
      if (ok) await doc.ref.update({ reminderSent: true });
    }
  } catch (e) {
    console.error("❌ Rappels :", e.message);
  }
}

// =======================================================
// 8. API PUBLIQUE
// =======================================================

app.get("/api/public-config", wrap(async (req, res) => {
  const { general } = await getSettings();
  res.json({
    success: true,
    salonName: SALON_NAME,
    location: PUBLIC_LOCATION,
    isOpen: !!general.is_open,
    maxAdvanceDays: general.maxAdvanceDays,
    requireOtp: REQUIRE_OTP,
  });
}));

app.get("/api/catalog", wrap(async (req, res) => {
  const { categories, services } = await getCatalog();
  const cats = categories.filter((c) => c.active !== false);
  const ok = new Set(cats.map((c) => c.id));
  res.json({
    success: true,
    categories: cats.map((c) => ({ id: c.id, name: c.name })),
    services: services
      .filter((s) => s.active !== false && ok.has(s.categoryId))
      .map((s) => ({ id: s.id, categoryId: s.categoryId, name: s.name, description: s.description || "", price: s.price, priceFrom: !!s.priceFrom, duration: s.duration })),
  });
}));

app.get("/api/availability", rateLimit({ windowMs: 60000, max: 120 }), wrap(async (req, res) => {
  const from = String(req.query.from || "");
  if (!isValidDate(from)) throw new HttpError(400, "Date de début invalide.");
  const nDays = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 14);
  const services = await resolveServices(String(req.query.services || "").split(",").filter(Boolean));
  const duration = sum(services, (s) => s.duration);
  const { closed, days } = await availabilityRange(from, nDays, duration);
  res.json({ success: true, closed, duration, days });
}));

const bookingLimiter = rateLimit({ windowMs: 10 * 60000, max: 20 });

/** Crée le rendez-vous à partir d'une demande validée. */
async function finalizeBooking(p) {
  const services = await resolveServices(p.serviceIds);
  await assertSlotAvailable(p.date, p.time, sum(services, (s) => s.duration));
  const appt = await createAppointment({
    date: p.date, time: p.time, services, client: p.client, clientNote: p.note, source: "site",
  });
  sendConfirmation(appt).catch(() => {});
  return appt;
}

app.post("/api/booking/request", bookingLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const { general } = await getSettings();
  if (!general.is_open) throw new HttpError(403, "Les réservations en ligne sont momentanément fermées.");
  if (!isValidDate(b.date) || !isValidTime(b.time)) throw new HttpError(400, "Créneau invalide.");
  const services = await resolveServices(b.serviceIds);
  const client = cleanClient(b);
  const note = str(b.note, 500);

  if ((await col("blacklist").doc(client.email).get()).exists) {
    throw new HttpError(403, "Les réservations en ligne sont indisponibles pour ce compte.");
  }
  const mine = await col("appointments").where("clientId", "==", clientKey(client)).get();
  const upcoming = mine.docs.filter((d) => isActive(d.data()) && d.data().startMs > Date.now()).length;
  if (upcoming >= MAX_ACTIVE_BOOKINGS) {
    throw new HttpError(409, `Vous avez déjà ${upcoming} rendez-vous à venir. Contactez l'institut pour en ajouter un autre.`);
  }
  await assertSlotAvailable(b.date, b.time, sum(services, (s) => s.duration));

  const payload = { serviceIds: services.map((s) => s.id), date: b.date, time: b.time, client, note };

  if (!REQUIRE_OTP) {
    const appt = await finalizeBooking(payload);
    return res.json({ success: true, otpRequired: false, booking: publicSummary(appt) });
  }

  const vRef = col("temp_verifications").doc(client.email);
  const prev = (await vRef.get()).data();
  if (prev && Date.now() - prev.createdAtMs < 30000) {
    throw new HttpError(429, "Patientez quelques secondes avant de demander un nouveau code.");
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await vRef.set({
    ...payload, attempts: 0, createdAtMs: Date.now(),
    codeHash: crypto.createHash("sha256").update(`${code}:${client.email}`).digest("hex"),
  });
  const sent = await sendMail({
    to: client.email, toName: client.firstName, subject: `Votre code de vérification – ${SALON_NAME}`,
    html: otpEmail({ salon: SALON_NAME, firstName: client.firstName, code }),
  });
  if (!sent) throw new HttpError(502, "Impossible d'envoyer l'e-mail de vérification. Vérifiez l'adresse saisie et réessayez.");
  res.json({ success: true, otpRequired: true });
}));

app.post("/api/booking/confirm", bookingLimiter, wrap(async (req, res) => {
  const email = str(req.body?.email, 120).toLowerCase();
  const code = str(req.body?.code, 10);
  const vRef = col("temp_verifications").doc(email || "_");
  const v = (await vRef.get()).data();
  if (!v || Date.now() - v.createdAtMs > 10 * 60000) {
    if (v) await vRef.delete();
    throw new HttpError(400, "Ce code a expiré. Demandez un nouveau code.", { expired: true });
  }
  if (v.attempts >= 5) {
    await vRef.delete();
    throw new HttpError(429, "Trop d'essais. Demandez un nouveau code.", { expired: true });
  }
  const given = crypto.createHash("sha256").update(`${code}:${email}`).digest();
  const stored = Buffer.from(v.codeHash, "hex");
  if (!crypto.timingSafeEqual(given, stored)) {
    await vRef.update({ attempts: admin.firestore.FieldValue.increment(1) });
    throw new HttpError(400, "Code incorrect.");
  }
  const appt = await finalizeBooking(v);
  await vRef.delete();
  res.json({ success: true, booking: publicSummary(appt) });
}));

// =======================================================
// 9. API DE GESTION (protégée par ADMIN_KEY)
// =======================================================

const failedAuth = new Map();
function checkAuth(req, res, next) {
  const f = failedAuth.get(req.ip);
  if (f && f.n >= 10 && f.reset > Date.now()) {
    return res.status(429).json({ success: false, message: "Trop d'essais. Réessayez dans quelques minutes." });
  }
  const a = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    failedAuth.delete(req.ip);
    return next();
  }
  const cur = f && f.reset > Date.now() ? f : { n: 0, reset: Date.now() + 5 * 60000 };
  cur.n++;
  failedAuth.set(req.ip, cur);
  res.status(401).json({ success: false, message: "Accès refusé" });
}

const adminApi = express.Router();
app.use("/api/admin", checkAuth, adminApi);

adminApi.get("/ping", (req, res) => res.json({ success: true }));

// ---------- Catalogue ----------

adminApi.get("/catalog", wrap(async (req, res) => {
  invalidateCaches();
  res.json({ success: true, ...(await getCatalog()) });
}));

const bool = (v, def = true) => (v === undefined ? def : !!v);

adminApi.post("/categories", wrap(async (req, res) => {
  const name = str(req.body.name, 80);
  if (!name) throw new HttpError(400, "Nom de catégorie requis.");
  const ref = await col("categories").add({ name, active: bool(req.body.active), order: Date.now() });
  invalidateCaches();
  res.json({ success: true, id: ref.id });
}));

adminApi.put("/categories/:id", wrap(async (req, res) => {
  const upd = {};
  if (req.body.name !== undefined) { upd.name = str(req.body.name, 80); if (!upd.name) throw new HttpError(400, "Nom de catégorie requis."); }
  if (req.body.active !== undefined) upd.active = !!req.body.active;
  await col("categories").doc(req.params.id).update(upd);
  invalidateCaches();
  res.json({ success: true });
}));

adminApi.delete("/categories/:id", wrap(async (req, res) => {
  const svc = await col("services").where("categoryId", "==", req.params.id).get();
  if (!svc.empty && req.query.cascade !== "1") {
    throw new HttpError(409, `Cette catégorie contient ${svc.size} prestation(s).`, { hasServices: true, count: svc.size });
  }
  const batch = db.batch();
  svc.forEach((d) => batch.delete(d.ref));
  batch.delete(col("categories").doc(req.params.id));
  await batch.commit();
  invalidateCaches();
  res.json({ success: true });
}));

function cleanService(b, partial = false) {
  const s = {};
  if (!partial || b.name !== undefined) { s.name = str(b.name, 100); if (!s.name) throw new HttpError(400, "Nom de prestation requis."); }
  if (!partial || b.description !== undefined) s.description = str(b.description, 300);
  if (!partial || b.price !== undefined) {
    s.price = Number(b.price);
    if (!Number.isFinite(s.price) || s.price < 0 || s.price > 10000) throw new HttpError(400, "Prix invalide.");
  }
  if (!partial || b.duration !== undefined) {
    s.duration = parseInt(b.duration, 10);
    if (!(s.duration >= 5 && s.duration <= 720)) throw new HttpError(400, "Durée invalide (entre 5 min et 12 h).");
  }
  if (!partial || b.priceFrom !== undefined) s.priceFrom = !!b.priceFrom;
  if (!partial || b.active !== undefined) s.active = bool(b.active);
  if (b.categoryId !== undefined) s.categoryId = String(b.categoryId);
  return s;
}

adminApi.post("/services", wrap(async (req, res) => {
  const s = cleanService(req.body);
  if (!s.categoryId || !(await col("categories").doc(s.categoryId).get()).exists) throw new HttpError(400, "Catégorie introuvable.");
  const ref = await col("services").add({ ...s, order: Date.now() });
  invalidateCaches();
  res.json({ success: true, id: ref.id });
}));

adminApi.put("/services/:id", wrap(async (req, res) => {
  const s = cleanService(req.body, true);
  if (s.categoryId && !(await col("categories").doc(s.categoryId).get()).exists) throw new HttpError(400, "Catégorie introuvable.");
  await col("services").doc(req.params.id).update(s);
  invalidateCaches();
  res.json({ success: true });
}));

adminApi.delete("/services/:id", wrap(async (req, res) => {
  await col("services").doc(req.params.id).delete(); // les rendez-vous passés gardent leur copie de la prestation
  invalidateCaches();
  res.json({ success: true });
}));

adminApi.post("/reorder", wrap(async (req, res) => {
  const { type, ids } = req.body || {};
  if (!["categories", "services"].includes(type) || !Array.isArray(ids)) throw new HttpError(400, "Requête invalide.");
  const batch = db.batch();
  ids.forEach((id, i) => batch.update(col(type).doc(String(id)), { order: i }));
  await batch.commit();
  invalidateCaches();
  res.json({ success: true });
}));

// ---------- Rendez-vous ----------

adminApi.get("/appointments", wrap(async (req, res) => {
  const scope = req.query.scope || "upcoming";
  const dayStart = parisToMs(todayParis(), "00:00");
  let docs;
  if (scope === "past") {
    docs = (await col("appointments").where("startMs", "<", dayStart).orderBy("startMs", "desc").limit(200).get()).docs;
  } else if (scope === "cancelled") {
    docs = (await col("appointments").where("status", "in", ["cancelled", "merged"]).limit(300).get()).docs;
  } else {
    docs = (await col("appointments").where("startMs", ">=", dayStart).orderBy("startMs").limit(500).get()).docs;
  }
  let items = docs.map((d) => ({ id: d.id, ...d.data() }));
  items = scope === "cancelled"
    ? items.sort((a, b) => b.startMs - a.startMs)
    : items.filter(isActive);
  res.json({ success: true, appointments: items });
}));

function parseApptBody(b) {
  if (!isValidDate(b.date) || !isValidTime(b.time)) throw new HttpError(400, "Date ou heure invalide.");
  return { date: b.date, time: b.time };
}

adminApi.post("/appointments", wrap(async (req, res) => {
  const b = req.body || {};
  const { date, time } = parseApptBody(b);
  const services = await resolveServices(b.serviceIds, { activeOnly: false });
  const client = cleanClient(b.client, { requireAll: false });
  if (!client.firstName && !client.lastName) throw new HttpError(400, "Indiquez au moins le nom de la cliente.");
  const appt = await createAppointment({
    date, time, services, client, clientNote: b.clientNote, internalNote: b.internalNote,
    source: "admin", force: !!b.force, durationMin: b.durationMin, totalPrice: b.totalPrice,
  });
  if (b.sendEmail && client.email) sendConfirmation(appt).catch(() => {});
  res.json({ success: true, id: appt.id });
}));

adminApi.put("/appointments/:id", wrap(async (req, res) => {
  const id = req.params.id;
  const b = req.body || {};
  const ref = col("appointments").doc(id);
  let result;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, "Rendez-vous introuvable.");
    const a = snap.data();
    if (!isActive(a)) throw new HttpError(409, "Ce rendez-vous n'est plus actif.");

    const services = b.serviceIds ? await resolveServices(b.serviceIds, { activeOnly: false }) : a.services;
    const date = b.date ?? a.date;
    const time = b.time ?? a.startTime;
    if (!isValidDate(date) || !isValidTime(time)) throw new HttpError(400, "Date ou heure invalide.");

    const totalDuration = b.durationMin ? Number(b.durationMin) : b.serviceIds ? sum(services, (s) => s.duration) : a.totalDuration;
    if (!(totalDuration >= 5 && totalDuration <= 720)) throw new HttpError(400, "Durée invalide (entre 5 min et 12 h).");
    const totalPrice = b.totalPrice !== undefined && b.totalPrice !== "" ? Number(b.totalPrice) : b.serviceIds ? sum(services, (s) => s.price) : a.totalPrice;
    if (!Number.isFinite(totalPrice) || totalPrice < 0) throw new HttpError(400, "Prix invalide.");

    const startMs = parisToMs(date, time);
    const endMs = startMs + totalDuration * 60000;
    const client = b.client ? { ...a.client, ...cleanClient(b.client, { requireAll: false }) } : a.client;
    const clientId = clientKey(client);
    const clientRef = col("clients").doc(clientId);

    const [busy, cSnap] = await Promise.all([
      b.force ? [] : loadInternalBusy(startMs, endMs, { tx, excludeIds: [id] }),
      tx.get(clientRef),
    ]);
    const conflict = busy.find((x) => startMs < x.endMs && endMs > x.startMs);
    if (conflict) throw new HttpError(409, `Ce créneau chevauche : ${conflict.label}.`, { conflict: true });

    const upd = {
      date, startTime: time, endTime: msToParis(endMs).time, startMs, endMs,
      services, totalDuration, totalPrice, priceFrom: services.some((s) => s.priceFrom),
      client, clientId,
      clientNote: b.clientNote !== undefined ? str(b.clientNote, 500) : a.clientNote || "",
      internalNote: b.internalNote !== undefined ? str(b.internalNote, 1000) : a.internalNote || "",
      calendarDirty: !!calendar, updatedAtMs: Date.now(),
    };
    if (startMs !== a.startMs) upd.reminderSent = false;

    tx.update(ref, upd);
    const fields = Object.fromEntries(Object.entries(client).filter(([, v]) => v));
    tx.set(clientRef, { ...fields, updatedAtMs: Date.now(), ...(cSnap.exists ? {} : { createdAtMs: Date.now(), internalNote: "" }) }, { merge: true });
    result = { ...a, ...upd };
  });

  await pushToCalendar(id, result);
  res.json({ success: true });
}));

adminApi.delete("/appointments/:id", wrap(async (req, res) => {
  const ref = col("appointments").doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "Rendez-vous introuvable.");
  const a = snap.data();
  const upd = { status: "cancelled", cancelledBy: "site", cancelledAtMs: Date.now(), calendarDirty: !!calendar };
  await ref.update(upd);
  await pushToCalendar(ref.id, { ...a, ...upd });
  res.json({ success: true });
}));

adminApi.post("/appointments/merge", wrap(async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).map(String))];
  if (ids.length < 2) throw new HttpError(400, "Sélectionnez au moins deux rendez-vous à fusionner.");
  const force = !!req.body?.force;
  let keepId, merged, others;

  await db.runTransaction(async (tx) => {
    const snaps = await Promise.all(ids.map((id) => tx.get(col("appointments").doc(id))));
    if (snaps.some((s) => !s.exists)) throw new HttpError(404, "Rendez-vous introuvable.");
    const list = snaps.map((s) => ({ id: s.id, ...s.data() })).sort((x, y) => x.startMs - y.startMs);
    if (list.some((a) => !isActive(a))) throw new HttpError(409, "Seuls des rendez-vous actifs peuvent être fusionnés.");
    if (new Set(list.map((a) => a.clientId)).size > 1) throw new HttpError(400, "Les rendez-vous doivent concerner la même cliente.");

    const base = list[0];
    const services = list.flatMap((a) => a.services);
    const totalDuration = sum(list, (a) => a.totalDuration);
    const startMs = base.startMs;
    const endMs = startMs + totalDuration * 60000;

    const busy = force ? [] : await loadInternalBusy(startMs, endMs, { tx, excludeIds: ids });
    const conflict = busy.find((x) => startMs < x.endMs && endMs > x.startMs);
    if (conflict) throw new HttpError(409, `Le rendez-vous fusionné chevaucherait : ${conflict.label}.`, { conflict: true });

    const join = (k) => [...new Set(list.map((a) => a[k]).filter(Boolean))].join("\n");
    merged = {
      services, totalDuration, totalPrice: sum(list, (a) => a.totalPrice), priceFrom: services.some((s) => s.priceFrom),
      endMs, endTime: msToParis(endMs).time, clientNote: join("clientNote"), internalNote: join("internalNote"),
      calendarDirty: !!calendar, updatedAtMs: Date.now(),
    };
    keepId = base.id;
    others = list.slice(1);
    tx.update(col("appointments").doc(keepId), merged);
    others.forEach((o) => tx.update(col("appointments").doc(o.id), {
      status: "merged", mergedInto: keepId, calendarDirty: !!calendar, updatedAtMs: Date.now(),
    }));
    merged = { ...base, ...merged };
  });

  await pushToCalendar(keepId, merged);
  for (const o of others) await pushToCalendar(o.id, { ...o, status: "merged" });
  res.json({ success: true, id: keepId });
}));

// ---------- Clientes ----------

adminApi.post("/clients", wrap(async (req, res) => {
  const b = req.body || {};
  const client = cleanClient(b, { requireAll: false });
  if (!client.firstName && !client.lastName) throw new HttpError(400, "Indiquez au moins le prénom ou le nom.");
  const id = clientKey(client);
  if (id.startsWith("anon-")) throw new HttpError(400, "Indiquez un téléphone ou un e-mail pour retrouver facilement la fiche.");
  const ref = col("clients").doc(id);
  if ((await ref.get()).exists) throw new HttpError(409, "Une fiche existe déjà pour ce téléphone ou cet e-mail.", { exists: true, id });
  const fields = Object.fromEntries(Object.entries(client).filter(([, v]) => v));
  const now = Date.now();
  await ref.set({ ...fields, internalNote: str(b.internalNote, 2000), createdAtMs: now, updatedAtMs: now });
  res.json({ success: true, id });
}));

adminApi.get("/clients", wrap(async (req, res) => {
  const snap = await col("clients").limit(2000).get();
  const clients = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, "fr"));
  res.json({ success: true, clients });
}));

adminApi.get("/clients/:id", wrap(async (req, res) => {
  const [c, a, bl] = await Promise.all([
    col("clients").doc(req.params.id).get(),
    col("appointments").where("clientId", "==", req.params.id).get(),
    col("blacklist").doc(req.params.id).get(),
  ]);
  if (!c.exists) throw new HttpError(404, "Cliente introuvable.");
  const appointments = a.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => y.startMs - x.startMs);
  res.json({ success: true, client: { id: c.id, ...c.data() }, appointments, blocked: bl.exists });
}));

adminApi.put("/clients/:id", wrap(async (req, res) => {
  const b = req.body || {};
  const upd = { updatedAtMs: Date.now() };
  if (b.firstName !== undefined) upd.firstName = str(b.firstName, 60);
  if (b.lastName !== undefined) upd.lastName = str(b.lastName, 60);
  if (b.phone !== undefined) {
    upd.phone = str(b.phone, 25);
    if (upd.phone && !PHONE_RE.test(upd.phone)) throw new HttpError(400, "Numéro de téléphone invalide.");
  }
  if (b.internalNote !== undefined) upd.internalNote = str(b.internalNote, 2000);
  await col("clients").doc(req.params.id).update(upd);
  res.json({ success: true });
}));

adminApi.delete("/clients/:id", wrap(async (req, res) => {
  const ref = col("clients").doc(req.params.id);
  if (!(await ref.get()).exists) throw new HttpError(404, "Cliente introuvable.");
  await ref.delete(); // les rendez-vous existants gardent leurs propres coordonnées, indépendantes de la fiche
  res.json({ success: true });
}));

// ---------- Blocages (indisponibilités) ----------

adminApi.get("/blocks", wrap(async (req, res) => {
  const snap = await col("blocks").where("endMs", ">", Date.now()).get();
  const blocks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.startMs - b.startMs);
  res.json({ success: true, blocks });
}));

/** Crée (ou supprime) l'événement Google Agenda qui matérialise un blocage. N'échoue jamais : le blocage reste valable côté site même si Google est indisponible. */
async function pushBlockToCalendar(block) {
  if (!calendar) return null;
  try {
    const r = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: block.label ? `Indisponible – ${block.label}` : "Indisponible",
        description: "Période bloquée depuis l'espace de gestion Maison Sépia.",
        start: block.allDay ? { date: block.startDate } : { dateTime: new Date(block.startMs).toISOString(), timeZone: TZ },
        end: block.allDay ? { date: addDays(block.endDate, 1) } : { dateTime: new Date(block.endMs).toISOString(), timeZone: TZ },
        transparency: "opaque",
        extendedProperties: { private: { source: BLOCK_EVENT_SOURCE } },
      },
    });
    gcalCache.clear();
    return r.data.id;
  } catch (e) {
    console.error("❌ Google Agenda (blocage) :", e.message);
    return null;
  }
}

async function removeBlockFromCalendar(eventId) {
  if (!calendar || !eventId) return;
  try {
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
    gcalCache.clear();
  } catch (e) {
    if (![404, 410].includes(gcode(e))) console.error("❌ Google Agenda (suppression blocage) :", e.message);
  }
}

adminApi.post("/blocks", wrap(async (req, res) => {
  const b = req.body || {};
  const allDay = !!b.allDay;
  const endDate = b.endDate || b.startDate;
  if (!isValidDate(b.startDate) || !isValidDate(endDate)) throw new HttpError(400, "Dates invalides.");
  if (!allDay && (!isValidTime(b.startTime) || !isValidTime(b.endTime))) throw new HttpError(400, "Heures invalides.");
  const startMs = parisToMs(b.startDate, allDay ? "00:00" : b.startTime);
  const endMs = allDay ? parisToMs(addDays(endDate, 1), "00:00") : parisToMs(endDate, b.endTime);
  if (endMs <= startMs) throw new HttpError(400, "La fin doit être après le début.");

  const overlapSnap = await col("appointments").where("startMs", ">=", startMs - MAX_APPT_MS).where("startMs", "<", endMs).get();
  const overlaps = overlapSnap.docs.filter((d) => isActive(d.data()) && d.data().endMs > startMs).length;

  const block = {
    startMs, endMs, allDay, label: str(b.label, 80), // motif facultatif
    startDate: b.startDate, endDate, startTime: allDay ? "" : b.startTime, endTime: allDay ? "" : b.endTime,
    createdAtMs: Date.now(),
  };
  block.calendarEventId = await pushBlockToCalendar(block);
  const ref = await col("blocks").add(block);
  res.json({ success: true, id: ref.id, overlaps });
}));

adminApi.delete("/blocks/:id", wrap(async (req, res) => {
  const ref = col("blocks").doc(req.params.id);
  const snap = await ref.get();
  if (snap.exists) await removeBlockFromCalendar(snap.data().calendarEventId);
  await ref.delete();
  res.json({ success: true });
}));

// ---------- Horaires ----------

adminApi.get("/settings", wrap(async (req, res) => {
  invalidateCaches();
  res.json({ success: true, ...(await getSettings()) });
}));

adminApi.put("/settings", wrap(async (req, res) => {
  const { general = {}, salon = {} } = req.body || {};
  const g = {};
  if (general.is_open !== undefined) g.is_open = !!general.is_open;
  if (general.slotStep !== undefined) {
    g.slotStep = Number(general.slotStep);
    if (![10, 15, 20, 30, 45, 60].includes(g.slotStep)) throw new HttpError(400, "Pas de créneau invalide.");
  }
  if (general.minNoticeHours !== undefined) {
    g.minNoticeHours = Number(general.minNoticeHours);
    if (!(g.minNoticeHours >= 0 && g.minNoticeHours <= 168)) throw new HttpError(400, "Délai minimum invalide (0 à 168 h).");
  }
  if (general.maxAdvanceDays !== undefined) {
    g.maxAdvanceDays = Number(general.maxAdvanceDays);
    if (!(g.maxAdvanceDays >= 1 && g.maxAdvanceDays <= 365)) throw new HttpError(400, "Horizon de réservation invalide (1 à 365 jours).");
  }
  const s = {};
  for (const k of ["addressFull", "policy", "extraInfo"]) if (salon[k] !== undefined) s[k] = str(salon[k], 2000);
  if (Object.keys(g).length) await col("settings").doc("general").set(g, { merge: true });
  if (Object.keys(s).length) await col("settings").doc("salon").set(s, { merge: true });
  invalidateCaches();
  res.json({ success: true });
}));

adminApi.put("/hours", wrap(async (req, res) => {
  const days = {};
  try {
    for (let d = 0; d <= 6; d++) days[d] = normalizeRanges(req.body?.days?.[d] ?? []);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  await col("settings").doc("hours").set({ days });
  invalidateCaches();
  res.json({ success: true });
}));

adminApi.get("/exceptions", wrap(async (req, res) => {
  const snap = await col("exceptions").where(FieldPath.documentId(), ">=", todayParis()).get();
  res.json({ success: true, exceptions: snap.docs.map((d) => ({ date: d.id, ranges: d.data().ranges || [] })).sort((a, b) => a.date.localeCompare(b.date)) });
}));

adminApi.put("/exceptions/:date", wrap(async (req, res) => {
  if (!isValidDate(req.params.date)) throw new HttpError(400, "Date invalide.");
  let ranges;
  try { ranges = normalizeRanges(req.body?.ranges ?? []); } catch (e) { throw new HttpError(400, e.message); }
  await col("exceptions").doc(req.params.date).set({ ranges }); // ranges vide = fermé ce jour-là
  res.json({ success: true });
}));

adminApi.delete("/exceptions/:date", wrap(async (req, res) => {
  await col("exceptions").doc(req.params.date).delete();
  res.json({ success: true });
}));

// ---------- Comptes bloqués ----------

adminApi.get("/blacklist", wrap(async (req, res) => {
  const snap = await col("blacklist").get();
  res.json({ success: true, list: snap.docs.map((d) => ({ email: d.id, ...d.data() })) });
}));

adminApi.post("/blacklist", wrap(async (req, res) => {
  const email = str(req.body?.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Adresse e-mail invalide.");
  await col("blacklist").doc(email).set({ blockedAtMs: Date.now(), reason: "Manuel" });
  res.json({ success: true });
}));

adminApi.delete("/blacklist/:email", wrap(async (req, res) => {
  await col("blacklist").doc(req.params.email.toLowerCase()).delete();
  res.json({ success: true });
}));

// ---------- Google Agenda ----------

adminApi.get("/calendar-status", wrap(async (req, res) => {
  if (!calendar) return res.json({ success: true, enabled: false });
  let ok = true, error = "", name = "";
  try {
    const r = await calendar.calendars.get({ calendarId: CALENDAR_ID });
    name = r.data.summary || "";
  } catch (e) {
    ok = false;
    error = e.message;
  }
  const snap = await col("appointments").where("calendarDirty", "==", true).get();
  const pending = snap.docs.filter((d) => isActive(d.data())).length;
  const last = ((await col("settings").doc("sync").get()).data() || {}).lastSyncMs || null;
  res.json({
    success: true, enabled: true, ok, error, name, pending, lastSyncMs: last,
    serviceAccountEmail: serviceAccount.client_email,
  });
}));

adminApi.post("/sync-now", wrap(async (req, res) => {
  await syncCalendar();
  res.json({ success: true });
}));

// =======================================================
// 10. PAGES & DÉMARRAGE
// =======================================================

app.get("/gestion", (req, res) => res.sendFile(path.join(__dirname, "public", "gestion.html")));
app.use("/api", (req, res) => res.status(404).json({ success: false, message: "Route introuvable." }));

const PORT = env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 ${SALON_NAME} – serveur de réservation actif sur le port ${PORT}`);
  try { await seedIfEmpty(); } catch (e) { console.error("❌ Initialisation :", e.message); }
  setTimeout(() => { syncCalendar(); sendReminders(); cleanupOldData(); }, 5000);
  setInterval(syncCalendar, SYNC_INTERVAL_MS);
  setInterval(sendReminders, REMINDER_INTERVAL_MS); // rythme séparé et bien plus lent : pas besoin de vérifier les rappels toutes les 2 min
  setInterval(cleanupOldData, CLEANUP_INTERVAL_MS);
});
