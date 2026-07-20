-- 0019 set synced_account_masks to '2250,8842' based on a mask that turned
-- out to be wrong (no such account exists). The actual credit card account
-- is mask 4417 — Plaid mislabels it as a "Wise" loan/subtype, but it's the
-- real credit card the user wants tracked.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0020_fix_gesa_synced_masks.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0020_fix_gesa_synced_masks.sql

UPDATE plaid_items SET synced_account_masks = '2250,4417' WHERE institution_name = 'Gesa Credit Union - Personal';
