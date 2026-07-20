-- Lets a Plaid Item stay linked to accounts Plaid forces into scope (some
-- institutions, like Gesa, have no partial-account-selection support in
-- Link) while this app still only syncs transactions from specific accounts
-- on that Item. NULL means no filter — sync every account, same as before
-- this column existed.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0019_add_plaid_item_account_filter.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0019_add_plaid_item_account_filter.sql

ALTER TABLE plaid_items ADD COLUMN synced_account_masks TEXT;

-- Gesa: only sync the checking account (2250) and the new credit card
-- (8842) — ignore savings (3735), which nobody wants budgeted.
UPDATE plaid_items SET synced_account_masks = '2250,8842' WHERE institution_name = 'Gesa Credit Union - Personal';
