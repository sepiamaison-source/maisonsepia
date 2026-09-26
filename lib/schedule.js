// =======================================================
// Logique horaire pure (aucune dépendance) : fuseau Europe/Paris,
// conversions date/heure et calcul des créneaux réservables.
// =======================================================

export const TZ = "Europe/Paris";

const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function parts(ms) {
  const o = {};
  for (const p of dtf.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** Décalage (ms) entre l'heure de Paris et UTC à l'instant donné. */
function tzOffsetMs(ms) {
  const o = parts(ms);
  const asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** "2026-09-24" + "14:30" (heure de Paris) -> timestamp UTC en ms. */
export function parisToMs(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - tzOffsetMs(guess);
  ms = guess - tzOffsetMs(ms); // 2e passe : gère les changements d'heure
  return ms;
}

/** Timestamp UTC -> { date: "YYYY-MM-DD", time: "HH:MM" } à Paris. */
export function msToParis(ms) {
  const o = parts(ms);
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    time: `${String(+o.hour % 24).padStart(2, "0")}:${o.minute}`,
  };
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = dimanche … 6 = samedi */
export function weekday(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(s) {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export const hhmmToMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

export const minToHhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * Valide et trie une liste de plages horaires [{start:"09:00", end:"12:30"}].
 * Lance une Error si une plage est invalide ou si deux plages se chevauchent.
 */
export function normalizeRanges(ranges) {
  if (!Array.isArray(ranges)) throw new Error("Plages horaires invalides.");
  const out = ranges
    .map((r) => ({ start: String(r?.start ?? ""), end: String(r?.end ?? "") }))
    .map((r) => {
      if (!isValidTime(r.start) || !isValidTime(r.end)) throw new Error("Horaire invalide (format HH:MM).");
      if (hhmmToMin(r.end) <= hhmmToMin(r.start)) throw new Error("L'heure de fin doit être après l'heure de début.");
      return r;
    })
    .sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
  for (let i = 1; i < out.length; i++) {
    if (hhmmToMin(out[i].start) < hhmmToMin(out[i - 1].end)) throw new Error("Deux plages horaires se chevauchent.");
  }
  return out;
}

/**
 * Créneaux de départ possibles pour une journée.
 * - ranges : plages de travail du jour
 * - durationMin : durée totale des prestations
 * - busy : [{startMs, endMs}] (rendez-vous, blocages, événements Google Agenda)
 * Un rendez-vous doit tenir entièrement dans une plage de travail.
 */
export function computeDaySlots({ date, ranges, durationMin, stepMin, nowMs, minNoticeMs, maxMs, busy }) {
  const slots = [];
  const durMs = durationMin * 60000;
  for (const r of ranges) {
    const rangeEndMs = parisToMs(date, r.end);
    const endMin = hhmmToMin(r.end);
    for (let t = hhmmToMin(r.start); t < endMin; t += stepMin) {
      const hhmm = minToHhmm(t);
      const s = parisToMs(date, hhmm);
      const e = s + durMs;
      if (e > rangeEndMs) break;
      if (s < nowMs + minNoticeMs || s > maxMs) continue;
      if (busy.some((b) => s < b.endMs && e > b.startMs)) continue;
      slots.push(hhmm);
    }
  }
  return slots;
}

export function fmtDuration(min) {
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

export function fmtPrice(n) {
  const v = Number(n) || 0;
  return `${Number.isInteger(v) ? v : v.toFixed(2).replace(".", ",")} €`;
}
