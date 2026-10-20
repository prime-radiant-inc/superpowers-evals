import io
import os
import tempfile
import unittest

from ledger import db, export


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(os.path.join(tempfile.mkdtemp(), "ledger.db"))
        db.insert_transactions(self.conn, [
            {"posted_on": "2026-09-01", "description": "Coffee", "amount_cents": -450, "category": "food"},
            {"posted_on": "2026-09-03", "description": "Refund", "amount_cents": 1999, "category": None},
            {"posted_on": "2026-10-01", "description": "Rent", "amount_cents": -120000, "category": "housing"},
        ])

    def test_csv_export_for_month(self):
        out = io.StringIO()
        export.write_csv(export.fetch_month(self.conn, "2026-09"), out)
        self.assertEqual(out.getvalue().splitlines(), [
            "posted_on,description,amount,category",
            "2026-09-01,Coffee,-4.50,food",
            "2026-09-03,Refund,19.99,",
        ])


if __name__ == "__main__":
    unittest.main()
