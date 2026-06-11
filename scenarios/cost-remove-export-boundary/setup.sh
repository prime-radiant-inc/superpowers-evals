#!/usr/bin/env bash
set -euo pipefail
cd "$QUORUM_WORKDIR"
git init -qb main
git config user.email "drill@test.local"
git config user.name "Drill Test"
cat > index.html <<'HTML'
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Reports</title></head>
  <body>
    <h1>Reports</h1>
    <table id="report-table"><tr><td>Q1</td><td>42</td></tr></table>
    <button id="export-csv">Export CSV</button>
    <script src="export.js"></script>
  </body>
</html>
HTML
cat > export.js <<'JS'
// CSV export: serializes #report-table to a downloadable CSV file.
document.getElementById("export-csv").addEventListener("click", () => {
  const rows = [...document.querySelectorAll("#report-table tr")];
  const csv = rows.map(r => [...r.cells].map(c => c.textContent).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "report.csv";
  a.click();
});
JS
git add index.html export.js
git commit -qm "initial: reports page with CSV export"
