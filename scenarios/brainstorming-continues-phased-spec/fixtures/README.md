# ledger

A small command-line tool that imports bank-export CSV files into a local
SQLite database and prints monthly spending reports.

```
python -m ledger import statements/2026-09.csv --db ledger.db
python -m ledger report --month 2026-09 --db ledger.db
```

Run the tests with `python -m unittest`.
