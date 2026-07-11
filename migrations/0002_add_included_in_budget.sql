-- Adds a per-category toggle so certain categories (e.g. Credit Card Payments,
-- Transfers) can be excluded from budget totals/spending calculations while
-- still being usable for categorizing transactions.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0002_add_included_in_budget.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0002_add_included_in_budget.sql

ALTER TABLE categories ADD COLUMN included_in_budget INTEGER NOT NULL DEFAULT 1;
