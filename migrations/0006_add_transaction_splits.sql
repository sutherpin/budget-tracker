-- Allows a single transaction to be divided across up to 3 categories
-- (e.g. a Walmart trip that's part groceries, part household goods).
-- When a transaction is split, transactions.category_id is cleared and
-- transactions.is_split is set to 1; the per-category amounts live here.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0006_add_transaction_splits.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0006_add_transaction_splits.sql

ALTER TABLE transactions ADD COLUMN is_split INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS transaction_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    amount REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_splits_transaction ON transaction_splits(transaction_id);
