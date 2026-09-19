CREATE TABLE imported_rows (
    id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL
);

CREATE TABLE import_jobs (
    id TEXT PRIMARY KEY,
    source_locator TEXT NOT NULL
);
