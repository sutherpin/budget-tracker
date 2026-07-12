-- Adds Plaid integration: one row per linked Plaid Item (bank connection),
-- and a column on transactions to track/dedupe Plaid-sourced rows against
-- their upstream Plaid transaction id.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0003_add_plaid.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0003_add_plaid.sql

CREATE TABLE IF NOT EXISTS plaid_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    institution_name TEXT,
    cursor TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

ALTER TABLE transactions ADD COLUMN plaid_transaction_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_plaid_transaction_id
    ON transactions(plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL;
