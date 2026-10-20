import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    posted_on TEXT NOT NULL,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    category TEXT,
    UNIQUE (posted_on, description, amount_cents)
)
"""


def connect(path):
    conn = sqlite3.connect(path)
    conn.execute(SCHEMA)
    return conn


def insert_transactions(conn, rows):
    """Insert rows, skipping exact duplicates. Returns (inserted, skipped)."""
    inserted = 0
    skipped = 0
    for row in rows:
        cur = conn.execute(
            "INSERT OR IGNORE INTO transactions"
            " (posted_on, description, amount_cents, category)"
            " VALUES (?, ?, ?, ?)",
            (row["posted_on"], row["description"], row["amount_cents"], row["category"]),
        )
        if cur.rowcount:
            inserted += 1
        else:
            skipped += 1
    conn.commit()
    return inserted, skipped
