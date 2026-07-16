-- receipt_job_runs was a CHECK(id=1) singleton row tracking only the Walmart
-- cron job. Rebuild it keyed by `source` so Walmart and Amazon (plus the
-- shared Gmail auth-failure throttle, source = '_auth') each get their own
-- row without clobbering each other.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0013_generalize_receipt_job_runs.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0013_generalize_receipt_job_runs.sql

CREATE TABLE receipt_job_runs_new (
    source TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_run_count INTEGER,
    last_auth_failure_notified_at TEXT
);

INSERT INTO receipt_job_runs_new (source, last_run_at, last_run_count, last_auth_failure_notified_at)
SELECT 'walmart', last_run_at, last_run_count, last_auth_failure_notified_at FROM receipt_job_runs WHERE id = 1;

DROP TABLE receipt_job_runs;

ALTER TABLE receipt_job_runs_new RENAME TO receipt_job_runs;
