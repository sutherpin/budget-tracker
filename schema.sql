-- ============================================================
-- Budget Tracker D1 Schema
-- Apply with: wrangler d1 execute budget-tracker-db --local --file=schema.sql
-- ============================================================

-- Categories you spend against (Groceries, Gas, Dining, etc.)
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    icon TEXT DEFAULT '💳',
    color TEXT DEFAULT '#6366f1',
    is_active INTEGER DEFAULT 1,
    included_in_budget INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);

-- One row per category per month = the budget envelope
CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    month TEXT NOT NULL,
    allotted_amount REAL NOT NULL,
    UNIQUE(category_id, month)
);

-- Every parsed transaction, categorized or not
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_sms TEXT NOT NULL,
    amount REAL NOT NULL,
    merchant TEXT,
    card_last4 TEXT,
    transaction_type TEXT DEFAULT 'purchase',
    category_id INTEGER REFERENCES categories(id),
    occurred_at TEXT NOT NULL,
    received_at TEXT DEFAULT (datetime('now')),
    categorized_at TEXT,
    status TEXT DEFAULT 'pending'
);

-- Transaction notes stored separately to avoid schema modification issues
CREATE TABLE IF NOT EXISTS transaction_notes (
    transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id),
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Personal per-month reminders on a category (e.g. "why is this over budget").
-- Scoped by (category_id, month) so a new month naturally starts blank.
CREATE TABLE IF NOT EXISTS category_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    month TEXT NOT NULL,
    note TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(category_id, month)
);

-- Learns merchant -> category mappings over time
CREATE TABLE IF NOT EXISTS merchant_category_map (
    merchant TEXT PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    times_used INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Web Push subscription(s)
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Recurring monthly transactions (e.g., rent, subscriptions)
CREATE TABLE IF NOT EXISTS recurring_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    amount REAL NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    day_of_month INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_status ON
 transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_occurred ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_budgets_month ON budgets(month);

-- Starter categories
INSERT OR IGNORE INTO categories (name, icon, color) VALUES
    ('Groceries',       '🛒', '#22c55e'),
    ('Dining Out',      '🍽️', '#f97316'),
    ('Gas',             '⛽', '#eab308'),
    ('Utilities',       '💡', '#3b82f6'),
    ('Subscriptions',   '📺', '#8b5cf6'),
    ('Shopping',        '🛍️', '#ec4899'),
    ('Health',          '💊', '#14b8a6'),
    ('Entertainment',   '🎮', '#a855f7'),
    ('Home',            '🏠', '#64748b'),
    ('Misc',            '📦', '#94a3b8');
