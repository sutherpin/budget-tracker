-- Rolling audit trail of every transaction that got auto-categorized without
-- a manual tap: merchant-map/keyword-based guesses (CSV/SMS/Plaid insert
-- time) AND the Walmart/Amazon receipt-matching pipeline. Read-side queries
-- filter to the last 10 days; a cron tick also prunes older rows so the
-- table doesn't grow unbounded.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0014_add_auto_categorization_log.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0014_add_auto_categorization_log.sql

CREATE TABLE auto_categorization_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER REFERENCES transactions(id),
    merchant TEXT,
    amount REAL,
    category_id INTEGER REFERENCES categories(id),
    method TEXT NOT NULL,
    source TEXT,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_auto_categorization_log_created_at ON auto_categorization_log(created_at);
