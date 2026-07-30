-- Generic key/value store for small app-wide config values that don't
-- warrant their own dedicated column (e.g. the local folder a machine-local
-- watcher script should poll for receipt screenshots) — editable from the
-- Settings tab instead of being hardcoded per machine.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0022_add_app_settings.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0022_add_app_settings.sql

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
