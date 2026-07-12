-- Personal per-month reminders on a category (e.g. "why is this over budget").
-- Scoped by (category_id, month) rather than actively cleared — a new month
-- simply has no row yet, so the note naturally "resets" without a cron job.
--
-- Apply with:
--   npx wrangler d1 execute budget-tracker-db --local --file=migrations/0008_add_category_notes.sql
--   npx wrangler d1 execute budget-tracker-db --remote --file=migrations/0008_add_category_notes.sql

CREATE TABLE IF NOT EXISTS category_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    month TEXT NOT NULL,
    note TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(category_id, month)
);
