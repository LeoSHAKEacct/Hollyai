const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// America/Bogota = UTC-5 (no DST)
const BOGOTA_OFFSET_MS = -5 * 3600000;

// ── helpers ───────────────────────────────────────────────────────────────

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
    'domingo','lunes','martes','miércoles',
    'jueves','viernes','sábado',
  ];
  const MONTHS = [
    'enero','febrero','marzo','abril','mayo','junio',
    'julio','agosto','septiembre','octubre','noviembre','diciembre',
  ];
  const hour = b.getUTCHours();
  const min  = b.getUTCMinutes();
  const h12  = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const period =
    hour >= 18 ? 'de la noche' : hour >= 12 ? 'de la tarde' : 'de la mañana';
  const time =
    min === 0  ? `a las ${h12} ${period}` :
    min === 30 ? `a las ${h12} y media ${period}` :
                 `a las ${h12}:${String(min).padStart(2, '0')} ${period}`;
  return `${DAYS[b.getUTCDay()]} ${b.getUTCDate()} de ${MONTHS[b.getUTCMonth()]} ${time}`;
}

// True if a 30-min slot starting at slotMs overlaps any busy period
function isBusy(slotMs, busyPeriods) {
  const end = slotMs + 30 * 60000;
  return busyPeriods.some(p => slotMs < p.end && end > p.start);
}

// All Mon-Fri 8:00-16:30 Bogota slots for the next 7 days (future only)
function generateSlots(nowMs) {
  const [y, m, d] = bogotaToday(nowMs);
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const slots = [];

  for (let offset = 0; offset < 8; offset++) {
    // Reference at 11:00 Bogota (16:00 UTC) to get the correct weekday
    const refUTC = Date.UTC(y, m - 1, d + offset, 16, 0, 0);
    const dow = DOW.indexOf(bogotaDow(refUTC));
    if (dow === 0 || dow === 6) continue; // skip weekends

    // Midnight of this Bogota day in UTC (UTC-5 → midnight local = 05:00 UTC)
    const midnightUTC = Date.UTC(y, m - 1, d + offset, 5, 0, 0);

    for (let h = 8; h < 17; h++) {
      for (let min = 0; min < 60; min += 30) {
        const slotMs = midnightUTC + h * 3600000 + min * 60000;
        if (slotMs <= nowMs) continue; // skip past
        slots.push(slotMs);
      }
    }
  }
  return slots;
}

// ── handler ───────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const preference = req.query?.preference || null; // 'morning' | 'afternoon' | null
  const nowMs   = Date.now();
  const timeMin = new Date(nowMs).toISOString();
  const timeMax = new Date(nowMs + 7 * 86400000).toISOString();

  // ── 1. Google Calendar freebusy ──────────────────────────────────────────
  const gcalBusy = [];
  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const cal = google.calendar({ version: 'v3', auth });
    const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';

    const fbRes = await cal.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: 'America/Bogota',
        items: [{ id: calId }],
      },
    });

    const periods = fbRes.data.calendars?.[calId]?.busy || [];
    periods.forEach(p => {
      gcalBusy.push({
        start: new Date(p.start).getTime(),
        end:   new Date(p.end).getTime(),
      });
    });
    console.log(`[availability] Google Calendar: ${gcalBusy.length} busy period(s)`);
    gcalBusy.forEach(p => console.log(`  gcal busy: ${new Date(p.start).toISOString()} → ${new Date(p.end).toISOString()}`));
  } catch (e) {
    console.warn('[availability] Google Calendar error (non-fatal):', e.message);
  }

  // ── 2. Supabase appointments (treat each as 30-min busy) ─────────────────
  const supaBusy = [];
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL || 'https://lgnfiveyqlehnxlvspqb.supabase.co',
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxnbmZpdmV5cWxlaG54bHZzcHFiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTQ5MTgxNiwiZXhwIjoyMDkxMDY3ODE2fQ.lHDXNcg6Q9Ds9G4NKUR2l3duVnri26dGOiVaGMc_cSc'
    );
    const { data, error } = await supabase
      .from('appointments')
      .select('appointment_date')
      .not('appointment_date', 'is', null)
      .gte('appointment_date', timeMin)
      .lte('appointment_date', timeMax);

    if (error) throw new Error(error.message);
    (data || []).forEach(row => {
      const start = new Date(row.appointment_date).getTime();
      supaBusy.push({ start, end: start + 30 * 60000 });
    });
    console.log(`[availability] Supabase: ${supaBusy.length} busy appointment(s)`);
    supaBusy.forEach(p => console.log(`  supa busy: ${new Date(p.start).toISOString()}`));
  } catch (e) {
    console.warn('[availability] Supabase error (non-fatal):', e.message);
  }

  const allBusy = [...gcalBusy, ...supaBusy];

  // ── 3. Filter slots ──────────────────────────────────────────────────────
  const freeSlots = [];

  for (const slotMs of generateSlots(nowMs)) {
    // Preference filter
    if (preference) {
      const bogotaHour = new Date(slotMs + BOGOTA_OFFSET_MS).getUTCHours();
      if (preference === 'morning'   && bogotaHour >= 12) continue;
      if (preference === 'afternoon' && bogotaHour <  12) continue;
    }

    if (isBusy(slotMs, allBusy)) {
      const src = gcalBusy.some(p => slotMs < p.end && slotMs + 30*60000 > p.start)
        ? 'gcal' : 'supabase';
      console.log(`[busy:${src}] ${toISO(slotMs)}`);
      continue;
    }

    freeSlots.push({ iso: toISO(slotMs), spoken: toSpoken(slotMs) });
    if (freeSlots.length >= 4) break;
  }

  console.log(`[availability] Returning ${freeSlots.length} slot(s):`,
    freeSlots.map(s => s.iso));

  res.status(200).json({ slots: freeSlots });
};
