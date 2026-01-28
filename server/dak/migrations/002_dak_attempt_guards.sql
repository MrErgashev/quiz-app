-- =====================================================
-- DAK Attempt Guards (Reliability)
-- =====================================================
-- Purpose:
-- 1) Prevent a student from having multiple ACTIVE (unfinished) attempts
--    for the same program/group/exam_date.
--
-- Notes:
-- - Safe to run multiple times.
-- - Backward compatible: adds indexes only.
-- =====================================================

-- Enforce single active attempt per student per exam
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dak_attempts_active_per_student
ON dak_attempts (program_id, group_name, student_fullname, exam_date)
WHERE finished_at IS NULL;

