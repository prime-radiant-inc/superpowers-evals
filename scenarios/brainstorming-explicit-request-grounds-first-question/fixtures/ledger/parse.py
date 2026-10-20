import csv
from decimal import Decimal, InvalidOperation

REQUIRED_COLUMNS = ("Date", "Description", "Amount")


class ParseError(Exception):
    def __init__(self, line, message):
        super().__init__(f"line {line}: {message}")
        self.line = line


def parse_statement(path):
    """Yield normalized rows from a bank-export CSV. Raises ParseError."""
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise ParseError(1, f"missing columns: {', '.join(missing)}")
        for line, record in enumerate(reader, start=2):
            try:
                cents = int(Decimal(record["Amount"].replace(",", "")) * 100)
            except InvalidOperation:
                raise ParseError(line, f"bad amount {record['Amount']!r}")
            yield {
                "posted_on": record["Date"],
                "description": record["Description"].strip(),
                "amount_cents": cents,
                "category": (record.get("Category") or "").strip() or None,
            }
