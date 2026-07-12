-- Caches the live Plaid account balance so the dashboard doesn't have to
-- make a live Plaid API call on every page load. Refreshed by a Cron
-- Trigger (see scheduled() in src/index.js) instead.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0005_add_balance_cache.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0005_add_balance_cache.sql

CREATE TABLE IF NOT EXISTS balance_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    checking REAL,
    savings REAL,
    updated_at TEXT
);
