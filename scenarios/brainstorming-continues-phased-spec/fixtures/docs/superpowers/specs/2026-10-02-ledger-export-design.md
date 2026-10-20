# Ledger export

## Why

I hand my monthly transactions to a spreadsheet and, later, to a small
budgeting script. Copying rows out of the report by hand is error-prone.
Export should give me a month of transactions in a form other tools can
read without any cleanup.

## Goals

- Export one month of transactions from the command line.
- Output that other tools read without cleanup: amounts exactly as they
  appear in the bank export, dates as ISO `YYYY-MM-DD`.
- Stdout only. Redirect it if you want a file.

## Non-goals

See `docs/notes/not-doing.md`.

## Phases

### Phase 1: CSV export (done)

`ledger export --month YYYY-MM [--format csv]` writes the month's
transactions to stdout as CSV with a header row:
`posted_on,description,amount,category`. Amounts are decimal strings
(`-4.50`), uncategorized rows have an empty category. Rows are ordered by
date, then by import order.

### Phase 2: JSON output and category filter

- `--format json` writes the same rows as JSON, for the budgeting script.
- `--category NAME` limits the export to one category. It can be given more
  than once.
- Both work together: `--format json --category food --category housing`.

### Phase 3: scheduled export

Not designed yet. Do not start it in phase 2.
