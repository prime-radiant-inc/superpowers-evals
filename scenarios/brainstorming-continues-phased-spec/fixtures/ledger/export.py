import csv
import sys

COLUMNS = ("posted_on", "description", "amount", "category")


def fetch_month(conn, month):
    return conn.execute(
        "SELECT posted_on, description, amount_cents, category"
        " FROM transactions WHERE posted_on LIKE ? ORDER BY posted_on, id",
        (f"{month}%",),
    ).fetchall()


def format_amount(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"


def write_csv(rows, out=sys.stdout):
    writer = csv.writer(out)
    writer.writerow(COLUMNS)
    for posted_on, description, cents, category in rows:
        writer.writerow((posted_on, description, format_amount(cents), category or ""))
