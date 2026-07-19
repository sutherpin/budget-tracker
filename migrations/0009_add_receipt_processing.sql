-- Tracks Gmail messages seen by the Walmart receipt auto-categorization job so
-- nothing is reprocessed, and stores the parsed+categorized result so it can be
-- reused later if the matching Plaid transaction hasn't arrived yet (or vice
-- versa — a Plaid transaction can look this up if its receipt arrived first).
--
-- status values: 'matched' | 'needs_review' | 'no_transaction_match' |
--                 'sum_mismatch' | 'parse_error' | 'no_attachment' | 'not_a_receipt' |
--                 'already_complete' | 'duplicate_receipt'
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0009_add_receipt_processing.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0009_add_receipt_processing.sql

CREATE TABLE IF NOT EXISTS processed_receipt_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_message_id TEXT NOT NULL UNIQUE,
    received_at TEXT,
    receipt_total REAL,
    receipt_date TEXT,
    parsed_json TEXT,
    matched_transaction_id INTEGER REFERENCES transactions(id),
    status TEXT NOT NULL,
    detail TEXT,
    processed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_processed_receipt_emails_message ON processed_receipt_emails(gmail_message_id);
