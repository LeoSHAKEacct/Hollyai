-- Holly.ai CRM foundation (Phase 1)
-- Run this in the Supabase SQL editor, in order, after clinics.sql and
-- supabase_appointments.sql have already been applied.
--
-- Adds: clinic_members (auth linking), patients, interactions (unified
-- call/WhatsApp/booking timeline), invoices (placeholder for the future
-- PT/DIAN adapter). Backfills clinic_id/patient_id onto the existing
-- appointments table. Enables RLS everywhere it was previously missing.

-- ── clinic_members ──────────────────────────────────────────────────────
-- Links a Supabase Auth user to a clinic. Replaces the plaintext
-- clinics.dashboard_password pattern for new (CRM) logins.
CREATE TABLE IF NOT EXISTS clinic_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff', 'super_admin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, clinic_id)
);

-- ── patients ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  name TEXT,
  dob TEXT,
  doc_id TEXT,
  insurance TEXT,
  tags TEXT[] DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, phone_number)
);

-- ── interactions ─────────────────────────────────────────────────────────
-- Unified timeline: one row per call, WhatsApp message, booking, or manual
-- note. channel/direction are free-ish text rather than enums since new
-- channels (whatsapp) get added as those integrations land.
CREATE TABLE IF NOT EXISTS interactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('call', 'whatsapp', 'booking', 'note')),
  direction TEXT CHECK (direction IN ('inbound', 'outbound')),
  summary TEXT,
  raw JSONB,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS interactions_patient_id_idx ON interactions (patient_id);
CREATE INDEX IF NOT EXISTS interactions_clinic_id_idx ON interactions (clinic_id);

-- ── invoices ─────────────────────────────────────────────────────────────
-- Inert placeholder for the future Proveedor Tecnologico adapter
-- (Factus / Alegra / Siigo). No DIAN/PT integration logic exists yet —
-- this table just gives the CRM a stable place to render an "Invoices" tab.
CREATE TABLE IF NOT EXISTS invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  amount NUMERIC,
  status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured', 'pending', 'issued', 'failed')),
  provider TEXT,
  provider_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── link appointments to the new tables ─────────────────────────────────
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id);

-- Backfill clinic_id on existing appointments via the retell_agent_id link
-- that book-appointment.js already writes.
UPDATE appointments a
SET clinic_id = c.id
FROM clinics c
WHERE a.retell_agent_id = c.retell_agent_id
  AND a.clinic_id IS NULL;

-- Backfill patients from existing appointments (dedupe by clinic + phone),
-- then link appointments.patient_id back to them.
INSERT INTO patients (clinic_id, phone_number, name, dob)
SELECT DISTINCT ON (a.clinic_id, a.phone_number)
  a.clinic_id, a.phone_number, NULLIF(a.patient_name, ''), NULLIF(a.dob, '')
FROM appointments a
WHERE a.clinic_id IS NOT NULL
  AND a.phone_number IS NOT NULL AND a.phone_number <> ''
ORDER BY a.clinic_id, a.phone_number, a.created_at DESC
ON CONFLICT (clinic_id, phone_number) DO NOTHING;

UPDATE appointments a
SET patient_id = p.id
FROM patients p
WHERE a.clinic_id = p.clinic_id
  AND a.phone_number = p.phone_number
  AND a.patient_id IS NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- Membership check: true if the calling user belongs to target_clinic,
-- or holds the 'super_admin' role for any clinic (Leonel's master login).
CREATE OR REPLACE FUNCTION is_clinic_member(target_clinic UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM clinic_members
    WHERE user_id = auth.uid()
      AND (clinic_id = target_clinic OR role = 'super_admin')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- clinics: legacy clinic/index.html reads via the anon key with no auth
-- session (password gate happens client-side), so anon SELECT must stay.
-- Writes are now restricted to clinic members.
DROP POLICY IF EXISTS "anon read clinics" ON clinics;
CREATE POLICY "anon read clinics" ON clinics FOR SELECT USING (true);
DROP POLICY IF EXISTS "members write own clinic" ON clinics;
CREATE POLICY "members write own clinic" ON clinics FOR UPDATE USING (is_clinic_member(id));
DROP POLICY IF EXISTS "super admin insert clinic" ON clinics;
CREATE POLICY "super admin insert clinic" ON clinics FOR INSERT WITH CHECK (is_clinic_member(id));

-- appointments: legacy clinic/index.html reads via anon key, so anon
-- SELECT stays; anon INSERT/UPDATE/DELETE is no longer implicitly open
-- (writes only ever happened server-side via the service_role key, which
-- bypasses RLS entirely, so this doesn't break book-appointment.js).
DROP POLICY IF EXISTS "anon read appointments" ON appointments;
CREATE POLICY "anon read appointments" ON appointments FOR SELECT USING (true);
DROP POLICY IF EXISTS "members read own clinic appointments" ON appointments;
CREATE POLICY "members read own clinic appointments" ON appointments FOR SELECT USING (is_clinic_member(clinic_id));

-- clinic_members: a user can see their own memberships (needed by the CRM
-- login flow to resolve which clinic(s) they belong to).
DROP POLICY IF EXISTS "read own memberships" ON clinic_members;
CREATE POLICY "read own memberships" ON clinic_members FOR SELECT USING (user_id = auth.uid());

-- patients / interactions / invoices: clinic-member only, no anon access.
DROP POLICY IF EXISTS "members read patients" ON patients;
CREATE POLICY "members read patients" ON patients FOR SELECT USING (is_clinic_member(clinic_id));
DROP POLICY IF EXISTS "members write patients" ON patients;
CREATE POLICY "members write patients" ON patients FOR INSERT WITH CHECK (is_clinic_member(clinic_id));
DROP POLICY IF EXISTS "members update patients" ON patients;
CREATE POLICY "members update patients" ON patients FOR UPDATE USING (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS "members read interactions" ON interactions;
CREATE POLICY "members read interactions" ON interactions FOR SELECT USING (is_clinic_member(clinic_id));
DROP POLICY IF EXISTS "members write interactions" ON interactions;
CREATE POLICY "members write interactions" ON interactions FOR INSERT WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS "members read invoices" ON invoices;
CREATE POLICY "members read invoices" ON invoices FOR SELECT USING (is_clinic_member(clinic_id));
DROP POLICY IF EXISTS "members write invoices" ON invoices;
CREATE POLICY "members write invoices" ON invoices FOR INSERT WITH CHECK (is_clinic_member(clinic_id));

-- ── bootstrap: make Leonel's existing admin.html login a super_admin ────
-- admin.html already authenticates via Supabase Auth signInWithPassword.
-- This grants that same account super_admin so /crm is testable immediately,
-- without waiting on Dr. Felix's email for a per-clinic login.
-- Safe to re-run (ON CONFLICT DO UPDATE). If no auth.users row matches this
-- email yet (i.e. you've never signed in with it via Supabase Auth), this
-- is a harmless no-op — sign in once via admin.html or the Supabase Auth
-- dashboard first, then re-run just this block.
INSERT INTO clinic_members (user_id, clinic_id, role)
SELECT u.id, c.id, 'super_admin'
FROM auth.users u, clinics c
WHERE u.email = 'leoneltelesmeneses@gmail.com'
LIMIT 1
ON CONFLICT (user_id, clinic_id) DO UPDATE SET role = 'super_admin';
