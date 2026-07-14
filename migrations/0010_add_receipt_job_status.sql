-- Tracks when the Walmart-receipt cron job last ran (regardless of whether it
-- found anything to process), so the UI can show "checked N ago" / a
-- countdown to the next run, similar to the Plaid balance-cache status line.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0010_add_receipt_job_status.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0010_add_receipt_job_status.sql

CREATE TABLE IF NOT EXISTS receipt_job_runs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_run_at TEXT,
    last_run_count INTEGER
);
