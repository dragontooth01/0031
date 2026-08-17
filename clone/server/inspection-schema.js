/**
 * 巡检模块表结构（单一来源：local-api.js 与 migrate-inspection.js 共用）
 */
const INSPECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  project_name TEXT DEFAULT '',
  create_user_name TEXT DEFAULT '',
  inspection_content TEXT DEFAULT '',
  handle_content TEXT DEFAULT '',
  create_time TEXT DEFAULT '',
  deadline TEXT DEFAULT '',
  status INTEGER DEFAULT 0,
  list_json TEXT,
  is_local INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS inspection_globals (
  kind TEXT PRIMARY KEY,
  payload TEXT,
  updated_at TEXT
);
`;

module.exports = { INSPECTION_SCHEMA_SQL };
