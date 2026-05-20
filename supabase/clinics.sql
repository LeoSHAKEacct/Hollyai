-- Run this in the Supabase SQL editor to create the clinics table
CREATE TABLE clinics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  retell_agent_id TEXT,
  google_calendar_id TEXT,
  google_refresh_token TEXT,
  google_client_id TEXT,
  google_client_secret TEXT,
  phone_number TEXT,
  dashboard_password TEXT,
  plan TEXT DEFAULT 'starter',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add retell_agent_id to the existing appointments table
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS retell_agent_id TEXT;

-- Index for fast filtering of appointments by clinic agent
CREATE INDEX IF NOT EXISTS appointments_retell_agent_id_idx ON appointments (retell_agent_id);
