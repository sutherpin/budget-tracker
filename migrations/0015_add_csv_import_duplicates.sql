-- CSV imports (both the manual "Import CSV" button and the unattended
-- watch_downloads.py systemd service) used to silently auto-skip anything
-- flagged as a possible duplicate, with no way to review or override it
-- afterward — especially bad for the headless watcher, which has no UI at
-- all. Instead, queue flagged rows here for later review (push-notified),
-- and let the user Skip or Import each one from the app whenever they get
-- to it, regardless of which path triggered the import.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0015_add_csv_import_duplicates.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0015_add_csv_import_duplicates.sql

CREATE TABLE csv_import_duplicates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_data TEXT NOT NULL UNIQUE,
    merchant TEXT,
    amount REAL,
    occurred_at TEXT,
    transaction_type TEXT,
    existing_transaction_id INTEGER REFERENCES transactions(id),
    status TEXT NOT NULL DEFAULT 'pending_review',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
);

CREATE INDEX idx_csv_import_duplicates_status ON csv_import_duplicates(status);
