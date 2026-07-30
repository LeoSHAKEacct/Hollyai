// Holly.ai agenda engine — the single source of truth for availability.
//
// Slots come from the clinic's own operating_hours plus its booked
// appointments and schedule_blocks. No external calendar is consulted:
// Holly's database IS the agenda, which is what the SmileWeb integration
// pitch assumes (SmileWeb pulls from us; we never read their calendar).
//
// clinics.calendar_provider is the seam for a future SmileWeb-backed
// implementation — today only 'internal' exists.

const { createClient } = require('@supabase/supabase-js');

// America/Bogota = UTC-5 (no DST)
const BOGOTA_OFFSET_MS = -5 * 3600000;
const SLOT_MINUTES = 30;

// Used when a clinic has no operating_hours configured yet.
const DEFAULT_HOURS = {
  mon: ['08:00', '17:00'], tue: ['08:00', '17:00'], wed: ['08:00', '17:00'],
  thu: ['08:00', '17:00'], fri: ['08:00', '17:00'], sat: null, sun: null,
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL || 'https://lgnfiveyqlehnxlvspqb.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ── Bogota time helpers (moved verbatim from get-availability.js) ─────────

// Get today's date in Bogota as [year, month(1-12), day]
function bogotaToday(nowMs) {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
  }).format(new Date(nowMs));
  return s.split('-').map(Number); // [YYYY, M, D]
}

// Short weekday string in Bogota (Sun/Mon/Tue/...)
function bogotaDow(utcMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    weekday: 'short',
  }).format(new Date(utcMs));
}

// ISO-8601 with -05:00 offset for a UTC-millisecond value
function toISO(utcMs) {
  const b = new Date(utcMs + BOGOTA_OFFSET_MS); // shift so UTC fields = Bogota local
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())}` +
    `T${p(b.getUTCHours())}:${p(b.getUTCMinutes())}:00-05:00`
  );
}

// Spanish spoken form: "viernes 12 de junio a las 2 de la tarde"
function toSpoken(utcMs) {
  const b = new Date(utcMs + BOGOTA_OFFSET_MS);
  const DAYS = [
    'domingo', 'lunes', 'martes', 'miércoles',
    'jueves', 'viernes', 'sábado',
  ];
  const MONTHS = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const hour = b.getUTCHours();
  const min = b.getUTCMinutes();
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const period =
    hour >= 18 ? 'de la noche' : hour >= 12 ? 'de la tarde' : 'de la mañana';
  const time =
    min === 0 ? `a las ${h12} ${period}` :
    min === 30 ? `a las ${h12} y media ${period}` :
                 `a las ${h12}:${String(min).padStart(2, '0')} ${period}`;
  return `${DAYS[b.getUTCDay()]} ${b.getUTCDate()} de ${MONTHS[b.getUTCMonth()]} ${time}`;
}

// True if [slotMs, slotMs+durationMs) overlaps any busy period
function isBusy(slotMs, durationMs, busyPeriods) {
  const end = slotMs + durationMs;
  return busyPeriods.some(p => slotMs < p.end && end > p.start);
}

// "09:00" → minutes since midnight. Returns null if unparseable.
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return Number.isFinite(mins) ? mins : null;
}

// ── busy periods ─────────────────────────────────────────────────────────

async function loadBusy(supabase, clinicId, timeMinMs, timeMaxMs, excludeAppointmentId = null) {
  const busy = [];

  // Look back a few hours so a long appointment that started earlier but is
  // still running is correctly treated as busy.
  const apptFrom = new Date(timeMinMs - 6 * 3600000).toISOString();
  const apptTo = new Date(timeMaxMs).toISOString();

  let apptQuery = supabase
    .from('appointments')
    .select('id, appointment_date, duration_min')
    .eq('clinic_id', clinicId)
    .not('appointment_date', 'is', null)
    .not('status', 'in', '(cancelled,rejected)')
    .gte('appointment_date', apptFrom)
    .lte('appointment_date', apptTo);

  // When rescheduling, an appointment must not be considered to block itself.
  if (excludeAppointmentId) apptQuery = apptQuery.neq('id', excludeAppointmentId);

  const { data: appts, error: apptErr } = await apptQuery;

  if (apptErr) throw new Error(`appointments: ${apptErr.message}`);
  (appts || []).forEach(row => {
    const start = new Date(row.appointment_date).getTime();
    busy.push({ start, end: start + (row.duration_min || SLOT_MINUTES) * 60000 });
  });

  const { data: blocks, error: blockErr } = await supabase
    .from('schedule_blocks')
    .select('starts_at, ends_at')
    .eq('clinic_id', clinicId)
    .lt('starts_at', new Date(timeMaxMs).toISOString())
    .gt('ends_at', new Date(timeMinMs).toISOString());

  if (blockErr) throw new Error(`schedule_blocks: ${blockErr.message}`);
  (blocks || []).forEach(b => {
    busy.push({
      start: new Date(b.starts_at).getTime(),
      end: new Date(b.ends_at).getTime(),
    });
  });

  return busy;
}

// ── slot generation ──────────────────────────────────────────────────────

// Every in-hours slot for the next `days` days, future-only, driven by the
// clinic's configured operating_hours.
function generateSlots(nowMs, operatingHours, days, slotMinutes) {
  const [y, m, d] = bogotaToday(nowMs);
  const hours = operatingHours && typeof operatingHours === 'object'
    ? operatingHours
    : DEFAULT_HOURS;
  const slots = [];

  for (let offset = 0; offset <= days; offset++) {
    // Reference at 11:00 Bogota (16:00 UTC) to get the correct weekday
    const refUTC = Date.UTC(y, m - 1, d + offset, 16, 0, 0);
    const dowIdx = DOW_SHORT.indexOf(bogotaDow(refUTC));
    if (dowIdx < 0) continue;

    const window = hours[DAY_KEYS[dowIdx]];
    if (!Array.isArray(window) || window.length < 2) continue; // closed that day

    const open = parseHHMM(window[0]);
    const close = parseHHMM(window[1]);
    if (open === null || close === null || close <= open) continue;

    // Bogota midnight for this day, expressed in UTC (UTC-5 → 05:00 UTC)
    const midnightUTC = Date.UTC(y, m - 1, d + offset, 5, 0, 0);

    for (let t = open; t + slotMinutes <= close; t += slotMinutes) {
      const slotMs = midnightUTC + t * 60000;
      if (slotMs <= nowMs) continue; // skip past
      slots.push(slotMs);
    }
  }
  return slots;
}

// ── public API ───────────────────────────────────────────────────────────

async function getClinic(supabase, clinicId) {
  const { data, error } = await supabase
    .from('clinics')
    .select('id, name, operating_hours, calendar_provider')
    .eq('id', clinicId)
    .maybeSingle();
  if (error) throw new Error(`clinic lookup: ${error.message}`);
  if (!data) throw new Error(`clinic not found: ${clinicId}`);
  return data;
}

/**
 * Free appointment slots for a clinic.
 * @returns {Promise<Array<{iso:string, spoken:string}>>}
 */
async function getAvailableSlots({
  clinicId,
  preference = null,      // 'morning' | 'afternoon' | null
  days = 7,
  limit = 4,
  slotMinutes = SLOT_MINUTES,
} = {}) {
  if (!clinicId) throw new Error('clinicId is required');

  const supabase = getSupabase();
  const clinic = await getClinic(supabase, clinicId);

  const nowMs = Date.now();
  const timeMaxMs = nowMs + (days + 1) * 86400000;
  const busy = await loadBusy(supabase, clinicId, nowMs, timeMaxMs);
  const durationMs = slotMinutes * 60000;

  const free = [];
  for (const slotMs of generateSlots(nowMs, clinic.operating_hours, days, slotMinutes)) {
    if (preference) {
      const bogotaHour = new Date(slotMs + BOGOTA_OFFSET_MS).getUTCHours();
      if (preference === 'morning' && bogotaHour >= 12) continue;
      if (preference === 'afternoon' && bogotaHour < 12) continue;
    }
    if (isBusy(slotMs, durationMs, busy)) continue;

    free.push({ iso: toISO(slotMs), spoken: toSpoken(slotMs) });
    if (limit && free.length >= limit) break;
  }

  console.log(`[agenda] clinic=${clinic.name} busy=${busy.length} free=${free.length}`);
  return free;
}

/**
 * Book a slot, re-checking availability immediately before insert so two
 * concurrent bookers can't take the same time.
 * @returns {Promise<{ok:true, appointment:object} | {ok:false, reason:string}>}
 */
async function bookSlot({
  clinicId,
  patientId = null,
  patientName = '',
  phoneNumber = '',
  dob = '',
  service = '',
  doctor = '',
  startsAt,                    // ISO string
  durationMin = SLOT_MINUTES,
  source = 'manual',
  status = 'pending',
} = {}) {
  if (!clinicId) throw new Error('clinicId is required');
  if (!startsAt) throw new Error('startsAt is required');

  const supabase = getSupabase();
  const startMs = new Date(startsAt).getTime();
  if (!Number.isFinite(startMs)) return { ok: false, reason: 'invalid_start' };
  if (startMs <= Date.now()) return { ok: false, reason: 'in_past' };

  const busy = await loadBusy(supabase, clinicId, startMs - 1, startMs + durationMin * 60000 + 1);
  if (isBusy(startMs, durationMin * 60000, busy)) {
    return { ok: false, reason: 'slot_taken' };
  }

  const { data, error } = await supabase
    .from('appointments')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      patient_name: patientName,
      phone_number: phoneNumber,
      dob,
      reason: service,
      doctor,
      appointment_time: toSpoken(startMs),
      appointment_date: new Date(startMs).toISOString(),
      duration_min: durationMin,
      source,
      status,
    })
    .select('*')
    .single();

  if (error) return { ok: false, reason: error.message };
  return { ok: true, appointment: data };
}

module.exports = {
  getAvailableSlots,
  bookSlot,
  getClinic,
  getSupabase,
  loadBusy,
  generateSlots,
  toISO,
  toSpoken,
  isBusy,
  parseHHMM,
  bogotaToday,
  bogotaDow,
  BOGOTA_OFFSET_MS,
  SLOT_MINUTES,
  DEFAULT_HOURS,
};
