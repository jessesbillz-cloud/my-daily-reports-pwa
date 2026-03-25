-- ============================================================
-- 20260311_soft_delete.sql
-- Add soft-delete columns to inspection_requests
-- and index on status for faster filtering.
-- Paste into Supabase SQL Editor and run.
-- ============================================================

ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ir_status ON inspection_requests(status);
