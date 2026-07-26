-- The Wise credit card (mask 4417) is now dual-sourced: SMS alerts (fast,
-- already reliable) and Plaid sync (slower, now also pulling the same
-- charges since 0020). Rather than let both sides insert independently and
-- rely on after-the-fact duplicate-flagging + manual cleanup, this marks
-- specific account masks as "SMS is the source of truth" — Plaid only
-- inserts a transaction from these accounts when no matching SMS-sourced
-- transaction already exists, i.e. Plaid acts purely as a fallback for a
-- missed/delayed SMS.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0021_add_plaid_sms_primary_masks.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0021_add_plaid_sms_primary_masks.sql

ALTER TABLE plaid_items ADD COLUMN sms_primary_masks TEXT;

UPDATE plaid_items SET sms_primary_masks = '4417' WHERE institution_name = 'Gesa Credit Union - Personal';
