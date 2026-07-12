-- Tracks possible duplicate transactions surfaced during Plaid sync so they
-- can be reviewed manually instead of being silently discarded.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0004_add_duplicate_flags.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0004_add_duplicate_flags.sql

CREATE TABLE IF NOT EXISTS duplicate_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    matched_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    created_at TEXT DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_duplicate_flags_resolved ON duplicate_flags(resolved);
