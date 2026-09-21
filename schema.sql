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

-- =============================================================================
-- SSB performance tracking (added for the SSB integration).
-- One row per completed+analysed SSB test attempt (raw history), plus a rolling
-- per-student tally of Officer-Like Qualities so we can show a running picture.
-- Run this block once in the D1 Console (safe to re-run: IF NOT EXISTS).
-- =============================================================================

-- One row per completed SSB test attempt. We store the summary + the qualities
-- only (not the full word-for-word answers); the student keeps their own PDF.
CREATE TABLE IF NOT EXISTS ssb_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id      INTEGER NOT NULL,          -- who took it (from their login token)
  mode            TEXT NOT NULL,             -- WAT | SRT | SDT | TAT | PPDT | GPE
  created_at      INTEGER NOT NULL,          -- ms timestamp
  items_count     INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  seconds_used    INTEGER NOT NULL DEFAULT 0,
  summary         TEXT,                      -- the personality snapshot (text)
  reflected_keys  TEXT,                      -- JSON array of canonical OLQ keys
  work_keys       TEXT                       -- JSON array of canonical OLQ keys
);
CREATE INDEX IF NOT EXISTS idx_ssb_attempts_student ON ssb_attempts(student_id, created_at);

-- The rolling picture: for each student, how many times each of the 15 OLQs has
-- shown up as a strength (reflected) vs. a thing to work on. Updated on every attempt.
CREATE TABLE IF NOT EXISTS ssb_olq_profile (
  student_id      INTEGER NOT NULL,
  olq             TEXT NOT NULL,             -- one of the 15 canonical OLQ keys
  reflected_count INTEGER NOT NULL DEFAULT 0,
  work_count      INTEGER NOT NULL DEFAULT 0,
  last_seen_at    INTEGER NOT NULL,          -- ms timestamp of the most recent attempt
  PRIMARY KEY (student_id, olq)
);
