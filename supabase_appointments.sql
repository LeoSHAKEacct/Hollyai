-- Run this in the Supabase SQL editor to create the appointments table
CREATE TABLE appointments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_name TEXT,
  dob TEXT,
  reason TEXT,
  doctor TEXT,
  appointment_time TEXT,
  phone_number TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
