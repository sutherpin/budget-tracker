-- Tracks whether each linked Plaid Item is healthy, so a broken bank
-- connection (e.g. ITEM_LOGIN_REQUIRED after a password change) shows up in
-- the UI instead of silently failing every sync/balance refresh.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0018_add_plaid_item_status.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0018_add_plaid_item_status.sql

ALTER TABLE plaid_items ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE plaid_items ADD COLUMN error_code TEXT;
