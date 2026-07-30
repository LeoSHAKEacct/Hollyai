-- Holly.ai — Agenda + SmileWeb API (Phase 2a)
-- Run in the Supabase SQL editor AFTER crm-schema.sql.
--
-- Makes Holly's own agenda the source of truth for availability (no Google
-- Calendar), and adds the fields the SmileWeb pull API was pitched with:
-- status, source, starts_at semantics. Safe to re-run.

-- ── appointments: status / source / duration ────────────────────────────
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS source       TEXT NOT NULL DEFAULT 'call';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS duration_min INT  NOT NULL DEFAULT 30;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW();

-- Existing rows are historical Retell bookings — treat them as settled so the
-- agenda doesn't open with 10 fake "pending" items awaiting action.
UPDATE appointments SET status = 'confirmed' WHERE status = 'pending' AND created_at < NOW();
UPDATE appointments SET updated_at = COALESCE(updated_at, created_at) WHERE updated_at IS NULL;

-- Constraints added separately so the backfill above runs first.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_status_check') THEN
    ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
      CHECK (status IN ('pending','confirmed','rejected','cancelled','completed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_source_check') THEN
    ALTER TABLE appointments ADD CONSTRAINT appointments_source_check
      CHECK (source IN ('call','whatsapp','manual','import','api'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS appointments_clinic_date_idx ON appointments (clinic_id, appointment_date);
CREATE INDEX IF NOT EXISTS appointments_updated_at_idx  ON appointments (updated_at);

-- Keep updated_at fresh so the SmileWeb API's ?since= cursor is trustworthy.
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_touch_updated_at ON appointments;
CREATE TRIGGER appointments_touch_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── patients: email (the pitched contract returns patient.email) ─────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS email TEXT;

-- ── clinics: provider seam for a future SmileWeb calendar adapter ────────
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS calendar_provider TEXT NOT NULL DEFAULT 'internal';

-- ── schedule_blocks: lunch, vacation, doctor-blocked time ───────────────
CREATE TABLE IF NOT EXISTS schedule_blocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at   TIMESTAMPTZ NOT NULL,
  reason    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS schedule_blocks_clinic_idx ON schedule_blocks (clinic_id, starts_at);

-- ── api_keys: bearer auth for the SmileWeb pull API ─────────────────────
-- Only SHA-256 hashes are stored; the plaintext key is shown once at creation
-- and is unrecoverable afterwards.
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id  UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Reuses is_clinic_member() defined in crm-schema.sql.
ALTER TABLE schedule_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read blocks" ON schedule_blocks;
CREATE POLICY "members read blocks" ON schedule_blocks FOR SELECT USING (is_clinic_member(clinic_id));
DROP POLICY IF EXISTS "members write blocks" ON schedule_blocks;
CREATE POLICY "members write blocks" ON schedule_blocks FOR INSERT WITH CHECK (is_clinic_member(clinic_id));
DROP POLICY IF EXISTS "members delete blocks" ON schedule_blocks;
CREATE POLICY "members delete blocks" ON schedule_blocks FOR DELETE USING (is_clinic_member(clinic_id));

-- Members may list their clinic's keys (hash is one-way, so exposure is inert)
-- and revoke them. Creation happens server-side with the service role.
DROP POLICY IF EXISTS "members read api keys" ON api_keys;
CREATE POLICY "members read api keys" ON api_keys FOR SELECT USING (is_clinic_member(clinic_id));
DROP POLICY IF EXISTS "members revoke api keys" ON api_keys;
CREATE POLICY "members revoke api keys" ON api_keys FOR UPDATE USING (is_clinic_member(clinic_id));

-- Appointments: members of the clinic may create/update from the CRM agenda.
DROP POLICY IF EXISTS "members write appointments" ON appointments;
CREATE POLICY "members write appointments" ON appointments FOR INSERT WITH CHECK (is_clinic_member(clinic_id));
DROP POLICY IF EXISTS "members update appointments" ON appointments;
CREATE POLICY "members update appointments" ON appointments FOR UPDATE USING (is_clinic_member(clinic_id));
