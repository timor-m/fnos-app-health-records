// Unnumbered additive draft; assign a migration number only when release is authorized.
export const trendGroupsSchemaSql = `
CREATE TABLE IF NOT EXISTS indicator_groups (
  id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES indicator_groups(id),
  display_name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'builtin' CHECK(source IN ('builtin', 'user')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS indicator_groups_parent_idx ON indicator_groups(parent_id, sort_order);
CREATE TABLE IF NOT EXISTS indicator_group_members (
  group_id TEXT NOT NULL REFERENCES indicator_groups(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL REFERENCES indicator_catalog(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'builtin' CHECK(source IN ('builtin', 'user')),
  PRIMARY KEY(group_id, indicator_id)
);
CREATE INDEX IF NOT EXISTS indicator_group_members_indicator_idx ON indicator_group_members(indicator_id);
`;
