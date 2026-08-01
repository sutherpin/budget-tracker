-- Frozen record of a month's category spend/allotted/notes and top merchants,
-- taken automatically at 11pm local time on the last day of each month, so
-- browsing back to a past month later shows what it actually looked like
-- then — not a live recompute that silently changes if a transaction gets
-- re-categorized or a budget edited afterward.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0023_add_budget_snapshots.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0023_add_budget_snapshots.sql

CREATE TABLE IF NOT EXISTS budget_snapshots (
    month TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
