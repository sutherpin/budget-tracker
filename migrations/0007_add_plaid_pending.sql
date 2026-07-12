-- Tracks Plaid's own "pending" flag (the bank hasn't posted/settled the
-- charge yet) separately from our internal `status` column, which tracks
-- whether *we've* categorized the transaction. These are unrelated
-- concepts that happened to share the word "pending".
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0007_add_plaid_pending.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0007_add_plaid_pending.sql

ALTER TABLE transactions ADD COLUMN plaid_pending INTEGER NOT NULL DEFAULT 0;
