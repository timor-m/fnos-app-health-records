// Unnumbered additive migration draft. Assign a schema number only at release authorization.
export const reportNotesSchemaSql = `
CREATE TABLE IF NOT EXISTS report_notes (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS report_note_assets (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES report_notes(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL DEFAULT 'image' CHECK(asset_type = 'image'),
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT NOT NULL,
  preview_path TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size > 0),
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(note_id, sha256)
);
CREATE INDEX IF NOT EXISTS report_notes_report_idx ON report_notes(report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS report_note_assets_note_idx ON report_note_assets(note_id, sort_order, created_at);
`;
