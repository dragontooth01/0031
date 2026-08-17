/**
 * 项目模块业务表结构（模式 A：本地权威，数据以本地 SQLite 为准）
 * 由 local-api.js（服务启动）与 migrate-project.js（数据迁移）共同引用，保证单一来源。
 */
const PROJECT_SCHEMA_SQL = `
-- 项目主表：列表项常用字段展开成列（供分页/筛选），完整对象存 list_json / mobile_json / detail_json
CREATE TABLE IF NOT EXISTS projects (
  project_id INTEGER PRIMARY KEY,        -- 云端真实 id；本地新建为 9 亿号段
  -- 常用查询/展示字段（对应 /project/pc/list/ 列表项 + /project/completed/project/list/ 完成项）
  project_name TEXT DEFAULT '',
  status INTEGER DEFAULT 0,
  project_status INTEGER DEFAULT 0,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  completed_date TEXT DEFAULT '',
  delay_status INTEGER DEFAULT 0,
  complete_rate INTEGER DEFAULT 0,
  plan_project_rate INTEGER DEFAULT 0,
  area_name TEXT DEFAULT '',
  room_number TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  customer_gender INTEGER DEFAULT 0,
  phone_number TEXT DEFAULT '',
  room_type TEXT DEFAULT '',
  template_id INTEGER DEFAULT 0,
  template_name TEXT DEFAULT '',
  budget_id INTEGER DEFAULT 0,
  -- 完整对象（读接口直接复用，保证与云端返回结构一致）
  list_json TEXT DEFAULT '{}',           -- /project/pc/list/ 列表项
  mobile_json TEXT DEFAULT '{}',         -- /project/list/ 移动端列表项
  detail_json TEXT DEFAULT '{}',         -- /project/detail/ 完整对象
  -- 本地属性
  is_local INTEGER DEFAULT 0,            -- 1=本地新建（未迁移到云端）
  deleted INTEGER DEFAULT 0,             -- 1=本地软删
  created_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(project_name);

-- 项目子资源：按 kind 存每个项目维度的完整响应 data（kind 见 local-api 项目读接口注释）
CREATE TABLE IF NOT EXISTS project_payloads (
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT '',
  PRIMARY KEY (project_id, kind)
);

-- 公司级项目全局数据（kind = filter_settings / pc_filter_project / pc_filter_role_user / template_list / todo_filter / step_labels / company_project_list / completed_list）
CREATE TABLE IF NOT EXISTS project_globals (
  kind TEXT PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT ''
);
`;

module.exports = { PROJECT_SCHEMA_SQL };
