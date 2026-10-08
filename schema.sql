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
  work_keys       TEXT,                      -- JSON array of canonical OLQ keys
  red_flags       TEXT                       -- JSON array of serious integrity concerns (usually [])
);
CREATE INDEX IF NOT EXISTS idx_ssb_attempts_student ON ssb_attempts(student_id, created_at);
-- Migration for an EXISTING database (the CREATE above only applies to a fresh one).
-- Run this once; it errors harmlessly if the column already exists:
--   ALTER TABLE ssb_attempts ADD COLUMN red_flags TEXT;

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

-- =============================================================================
-- Student doubts (asked from a lesson's "Ask a doubt" tab). One row per doubt,
-- tagged with the topic so the owner can read them topic-wise in doubts.html.
-- =============================================================================
CREATE TABLE IF NOT EXISTS doubts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  product    TEXT NOT NULL,                 -- 'trial' or 'course'
  day        INTEGER,                       -- topic/day number (NULL = general)
  topic      TEXT,                          -- topic title snapshot at asking time
  text       TEXT NOT NULL,                 -- the doubt
  status     TEXT NOT NULL DEFAULT 'new',   -- 'new' or 'resolved'
  created_at INTEGER NOT NULL               -- ms timestamp
);
CREATE INDEX IF NOT EXISTS idx_doubts_day ON doubts(day, created_at);
CREATE INDEX IF NOT EXISTS idx_doubts_status ON doubts(status, created_at);

-- =============================================================================
-- Mock test results (sent by the mock-test site when a signed-in student finishes
-- a mock). One row per attempt; the owner reads them per student in the console.
-- =============================================================================
CREATE TABLE IF NOT EXISTS mock_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  test_id    TEXT,                          -- e.g. 'geo-sec-01', 'full-mock-01'
  test_title TEXT,                          -- display title
  score      REAL,                          -- marks obtained
  total      REAL,                          -- max marks
  percent    REAL,                          -- 0-100
  seconds    INTEGER,                        -- time taken (optional)
  created_at INTEGER NOT NULL               -- ms timestamp
);
CREATE INDEX IF NOT EXISTS idx_mock_student ON mock_attempts(student_id, created_at);

-- =============================================================================
-- Free (non-course) SSB users. They gave name/phone/email on the SSB popup
-- (email NOT verified). Identified by normalized email + a signed free token.
-- =============================================================================
CREATE TABLE IF NOT EXISTS free_users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,          -- normalized/lowercase
  name       TEXT,
  phone      TEXT,
  created_at INTEGER NOT NULL
);

-- Minimal record of a free user's completed SSB attempts, for the per-mode / 24h
-- daily limit (one PPDT + one WAT + one SRT per rolling 24h).
CREATE TABLE IF NOT EXISTS ssb_free_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  free_user_id INTEGER NOT NULL,
  mode         TEXT NOT NULL,               -- WAT | SRT | PPDT (allowed free modes)
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ssb_free_attempts ON ssb_free_attempts(free_user_id, mode, created_at);

-- =============================================================================
-- Razorpay payments. One row per captured payment (from the signed webhook).
-- Used to auto-enrol the student and to show revenue on the admin dashboard.
-- payment_id is UNIQUE so a re-delivered webhook can't enrol or count twice.
-- =============================================================================
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  TEXT UNIQUE,                   -- Razorpay payment id (dedupe key)
  order_id    TEXT,
  email       TEXT,
  name        TEXT,
  contact     TEXT,
  amount      INTEGER,                        -- in paise
  currency    TEXT,
  product     TEXT,                           -- 'trial' or 'course'
  status      TEXT,                           -- 'captured'
  created_at  INTEGER NOT NULL                -- ms timestamp
);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

-- =============================================================================
-- SSB DASHBOARD (Elite / Legend only) — tracking layer on the shared engine.
-- Capture flows through the EXISTING POST /api/ssb/attempt: for a signed-in
-- course student the SSB browser now also sends `metrics` + `per_item`, which
-- the engine produced. We store metrics on the attempt (the session row) and
-- each per_item response in ssb_items. No separate sessions table is needed —
-- ssb_attempts IS the per-session record.
-- =============================================================================

-- ssb_attempts gains a metrics column (engine session-level metrics, JSON).
-- Migration for an EXISTING database (run once; harmless error if it exists):
--   ALTER TABLE ssb_attempts ADD COLUMN metrics TEXT;

-- One row per individual response within an attempt (the answer + its structured
-- per-item analysis from the engine). session_id references ssb_attempts.id.
CREATE TABLE IF NOT EXISTS ssb_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,               -- ssb_attempts.id
  student_id  INTEGER NOT NULL,
  mode        TEXT,
  n           INTEGER,                         -- item index within the session
  response    TEXT,                            -- the student's answer
  analysis    TEXT,                            -- JSON: engine per_item entry
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ssb_items_session ON ssb_items(session_id);
CREATE INDEX IF NOT EXISTS idx_ssb_items_student ON ssb_items(student_id, created_at);

-- Weekly report: two JSON outputs from the engine's /analyze/weekly — a simple
-- student-facing report and a detailed admin (Anmol) report. One per week.
CREATE TABLE IF NOT EXISTS ssb_weekly_reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL,
  week_start     TEXT NOT NULL,               -- 'YYYY-MM-DD' (IST, Monday)
  student_report TEXT,                        -- JSON: simple, plain-language
  admin_report   TEXT,                        -- JSON: full technical breakdown
  created_at     INTEGER NOT NULL,
  UNIQUE(student_id, week_start)
);
