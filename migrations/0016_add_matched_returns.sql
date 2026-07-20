-- Tracks which specific receipt line item has already been claimed by a
-- vendor return/refund, so the same physical item can't be matched to two
-- different credit transactions.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0016_add_matched_returns.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0016_add_matched_returns.sql

CREATE TABLE matched_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER NOT NULL REFERENCES processed_receipt_emails(id),
    item_index INTEGER NOT NULL,
    return_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(receipt_id, item_index)
);
