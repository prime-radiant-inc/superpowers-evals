import os
import tempfile
import unittest

from ledger import db
from ledger.cli import main

CSV = "Date,Description,Amount,Category\n2026-09-01,Coffee,-4.50,food\n2026-09-02,Rent,\"-1,200.00\",housing\n"


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.csv = os.path.join(self.dir, "in.csv")
        self.db = os.path.join(self.dir, "ledger.db")
        with open(self.csv, "w") as fh:
            fh.write(CSV)

    def test_import_inserts_rows(self):
        self.assertEqual(main(["import", self.csv, "--db", self.db]), 0)
        count = db.connect(self.db).execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        self.assertEqual(count, 2)

    def test_reimport_skips_duplicates(self):
        main(["import", self.csv, "--db", self.db])
        main(["import", self.csv, "--db", self.db])
        count = db.connect(self.db).execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        self.assertEqual(count, 2)


if __name__ == "__main__":
    unittest.main()
