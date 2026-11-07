CREATE TABLE json_import_runs (
  import_name TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  imported_counts_json TEXT NOT NULL
);
