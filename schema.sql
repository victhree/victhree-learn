-- =============================================================================
-- VicThree Learn — D1 database schema
-- Paste this into the Cloudflare D1 "Console" tab once, and click Run.
-- =============================================================================

-- Paying students. One row per person. status='active' means they can log in.
CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,          -- lowercase; how they log in
  name       TEXT NOT NULL,
  product    TEXT NOT NULL DEFAULT 'trial', -- 'trial' or 'course'
  status     TEXT NOT NULL DEFAULT 'active',-- 'active' or 'disabled'
  start_date TEXT NOT NULL,                 -- 'YYYY-MM-DD' (IST); Day 1 = this date
  created_at INTEGER NOT NULL               -- ms timestamp
);

-- Short-lived login codes (email one-time passcodes). One row per email at a time.
CREATE TABLE IF NOT EXISTS login_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,                 -- SHA-256 of the code (never the raw code)
  expires_at INTEGER NOT NULL,              -- ms timestamp
  attempts   INTEGER NOT NULL DEFAULT 0     -- wrong-guess counter (locks at 5)
);

CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
