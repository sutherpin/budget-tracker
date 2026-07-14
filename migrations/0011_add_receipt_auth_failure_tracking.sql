-- Tracks when we last sent a "Gmail connection broken" alert, so a persistently
-- expired refresh token doesn't spam a notification every 30 minutes forever.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0011_add_receipt_auth_failure_tracking.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0011_add_receipt_auth_failure_tracking.sql

ALTER TABLE receipt_job_runs ADD COLUMN last_auth_failure_notified_at TEXT;
