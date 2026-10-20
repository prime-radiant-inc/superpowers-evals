import argparse
import sys

from ledger import db
from ledger.parse import ParseError, parse_statement


def cmd_import(args):
    try:
        rows = list(parse_statement(args.csv))
    except ParseError as exc:
        print(f"error: {args.csv}: {exc}", file=sys.stderr)
        return 1
    conn = db.connect(args.db)
    inserted, skipped = db.insert_transactions(conn, rows)
    print(f"imported {inserted} transactions ({skipped} duplicates skipped)")
    return 0


def cmd_report(args):
    conn = db.connect(args.db)
    rows = conn.execute(
        "SELECT COALESCE(category, 'uncategorized'), SUM(amount_cents)"
        " FROM transactions WHERE posted_on LIKE ? GROUP BY 1 ORDER BY 2",
        (f"{args.month}%",),
    ).fetchall()
    for category, cents in rows:
        print(f"{category:20} {cents / 100:>10.2f}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ledger")
    sub = parser.add_subparsers(dest="command", required=True)

    p_import = sub.add_parser("import", help="import a bank-export CSV")
    p_import.add_argument("csv")
    p_import.add_argument("--db", default="ledger.db")
    p_import.set_defaults(func=cmd_import)

    p_report = sub.add_parser("report", help="monthly spending by category")
    p_report.add_argument("--month", required=True)
    p_report.add_argument("--db", default="ledger.db")
    p_report.set_defaults(func=cmd_report)

    args = parser.parse_args(argv)
    return args.func(args)
