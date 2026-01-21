-- =====================================================
-- DAK Data Persistence Migration
-- =====================================================
-- Purpose: Migrate DAK data from local files to Supabase
-- tables for persistence across Render redeployments
--
-- Tables created:
-- 1. dak_banks - Question banks storage
-- 2. dak_roster - Student roster storage
-- 3. dak_accounts - Student login credentials
-- 4. dak_attempts - Exam attempt records
--
-- Run this SQL in Supabase SQL Editor BEFORE deployment
-- =====================================================

-- 1. dak_banks table
-- Stores question banks (formerly dak_banks.json)
CREATE TABLE IF NOT EXISTS dak_banks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id TEXT UNIQUE NOT NULL,
  subject_name TEXT NOT NULL,
  questions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dak_banks_bank_id ON dak_banks(bank_id);
CREATE INDEX IF NOT EXISTS idx_dak_banks_created ON dak_banks(created_at DESC);

COMMENT ON TABLE dak_banks IS 'DAK question banks storage';
COMMENT ON COLUMN dak_banks.bank_id IS 'Unique identifier for the bank (UUID)';
COMMENT ON COLUMN dak_banks.subject_name IS 'Subject/Fan name for the bank';
COMMENT ON COLUMN dak_banks.questions IS 'Array of question objects with options';

-- 2. dak_roster table
-- Stores student roster (formerly dak_roster.json)
CREATE TABLE IF NOT EXISTS dak_roster (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  roster_data JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_dak_roster_updated ON dak_roster(updated_at DESC);

COMMENT ON TABLE dak_roster IS 'DAK student roster storage (single active roster)';
COMMENT ON COLUMN dak_roster.roster_data IS 'Complete roster JSON with university, programs, groups, students';
COMMENT ON COLUMN dak_roster.updated_by IS 'Email of teacher who last updated roster';

-- 3. dak_accounts table
-- Stores student login credentials (formerly dak_accounts.json)
CREATE TABLE IF NOT EXISTS dak_accounts (
  id UUID PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  full_name TEXT NOT NULL,
  university TEXT NOT NULL,
  program TEXT NOT NULL,
  program_id TEXT NOT NULL,
  "group" TEXT NOT NULL,
  exam_date TEXT NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dak_accounts_login ON dak_accounts(login);
CREATE INDEX IF NOT EXISTS idx_dak_accounts_group ON dak_accounts("group");
CREATE INDEX IF NOT EXISTS idx_dak_accounts_exam_date ON dak_accounts(exam_date);
CREATE INDEX IF NOT EXISTS idx_dak_accounts_active ON dak_accounts(active) WHERE active = TRUE;

COMMENT ON TABLE dak_accounts IS 'DAK student authentication accounts';
COMMENT ON COLUMN dak_accounts.login IS 'Student login (e.g., IQTK-101-001)';
COMMENT ON COLUMN dak_accounts.password_hash IS 'Scrypt hashed password';
COMMENT ON COLUMN dak_accounts.salt IS 'Salt used for password hashing';
COMMENT ON COLUMN dak_accounts.active IS 'Account status (can be disabled by teacher)';

-- 4. dak_attempts table
-- Stores exam attempts (formerly dak_attempts/*.json files)
CREATE TABLE IF NOT EXISTS dak_attempts (
  attempt_id UUID PRIMARY KEY,
  university TEXT NOT NULL,
  program_id TEXT NOT NULL,
  program_name TEXT NOT NULL,
  group_name TEXT NOT NULL,
  student_fullname TEXT NOT NULL,
  exam_date TEXT NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  finished_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  duration_minutes INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  points_per_question INTEGER NOT NULL,
  questions JSONB NOT NULL,
  answers JSONB DEFAULT '{}',
  correct_count INTEGER,
  score_points INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dak_attempts_student ON dak_attempts(program_id, group_name, student_fullname, exam_date);
CREATE INDEX IF NOT EXISTS idx_dak_attempts_finished ON dak_attempts(finished_at);
CREATE INDEX IF NOT EXISTS idx_dak_attempts_exam_date ON dak_attempts(exam_date);
CREATE INDEX IF NOT EXISTS idx_dak_attempts_started ON dak_attempts(started_at DESC);

COMMENT ON TABLE dak_attempts IS 'DAK exam attempts and results';
COMMENT ON COLUMN dak_attempts.attempt_id IS 'Unique attempt identifier (UUID)';
COMMENT ON COLUMN dak_attempts.questions IS 'Shuffled questions with randomized option order';
COMMENT ON COLUMN dak_attempts.answers IS 'Student answers indexed by question number (0-49)';
COMMENT ON COLUMN dak_attempts.finished_at IS 'NULL if attempt in progress, timestamp when finished';

-- =====================================================
-- Verification Queries (optional)
-- =====================================================

-- Check table existence
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name LIKE 'dak_%';

-- Check indexes
-- SELECT indexname, tablename FROM pg_indexes
-- WHERE tablename LIKE 'dak_%' ORDER BY tablename, indexname;

-- =====================================================
-- Migration completed successfully!
-- =====================================================
