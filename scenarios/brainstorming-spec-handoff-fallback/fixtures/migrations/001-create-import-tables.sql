CREATE TABLE imported_rows (
    id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL
);

CREATE TABLE import_jobs (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL
);
