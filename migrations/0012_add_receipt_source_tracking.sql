-- Tags each processed receipt email with which merchant pipeline produced it
-- (walmart PDF-attachment receipts vs amazon plain-text order-confirmation
-- emails), so matching/status logic can tell them apart.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0012_add_receipt_source_tracking.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0012_add_receipt_source_tracking.sql

ALTER TABLE processed_receipt_emails ADD COLUMN source TEXT NOT NULL DEFAULT 'walmart';
