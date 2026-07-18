-- Adds a per-category toggle so unused budget in a category carries forward
-- into next month (and overspending carries forward as a deficit) instead of
-- resetting to the flat budgeted amount every month. Off by default — most
-- categories (Groceries, Utilities, Gas) are meant to reset monthly; this is
-- for the lumpy/discretionary ones (Clothing, Health, Home Improvement,
-- Entertainment) where spending isn't evenly distributed.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0017_add_category_rollover.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0017_add_category_rollover.sql

ALTER TABLE categories ADD COLUMN rollover INTEGER NOT NULL DEFAULT 0;
