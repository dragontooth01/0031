/**
 * 企业后台（houtai Next.js 复刻版）业务表结构
 * 后台配置数据以本地 SQLite 为权威，与前端操作端共享同一数据库：
 * - 成员/部门写操作 → 同步重建 crm_globals.department_members（前端部门成员快照）
 * - 材料/定额/预算模板写操作 → 同步 budget_globals.* 快照（前端预算模块直接读取）
 * 由 local-api.js（服务启动）与 seed-company.js（种子迁移）共同引用，保证单一来源。
 */
const COMPANY_SCHEMA_SQL = `
-- 部门（houtai 企业成员-部门树）
CREATE TABLE IF NOT EXISTS company_departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  parent_id TEXT DEFAULT '',
  owner TEXT DEFAULT '',
  data_owner TEXT DEFAULT '',
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT ''
);

-- 成员（houtai 企业成员列表；deleted=1 进回收站）
CREATE TABLE IF NOT EXISTS company_members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  roles_json TEXT DEFAULT '[]',
  tag TEXT DEFAULT '',
  department_id TEXT DEFAULT '',
  department_ids_json TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0,
  deleted_at TEXT DEFAULT '',
  deleted_by TEXT DEFAULT '',
  created_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_company_members_dept ON company_members(department_id);
CREATE INDEX IF NOT EXISTS idx_company_members_deleted ON company_members(deleted);

-- 企业介绍信息（单行 id=1）
CREATE TABLE IF NOT EXISTS company_info (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT ''
);

-- 企业介绍轮播图
CREATE TABLE IF NOT EXISTS company_banners (
  id INTEGER PRIMARY KEY,
  title TEXT DEFAULT '',
  url TEXT DEFAULT '',
  image TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
);

-- 分公司
CREATE TABLE IF NOT EXISTS company_branches (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  name TEXT DEFAULT '',
  city TEXT DEFAULT ''
);

-- 后台管理员 / 应用账号（账号功能权限）
CREATE TABLE IF NOT EXISTS company_admins (
  id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  member_id INTEGER DEFAULT 0,
  type TEXT DEFAULT 'backend',       -- backend=后台管理员 app=应用账号
  account TEXT DEFAULT '',
  permissions_json TEXT DEFAULT '[]'
);

-- 供应商
CREATE TABLE IF NOT EXISTS company_suppliers (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  name TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  type TEXT DEFAULT '',
  status TEXT DEFAULT '合作中',
  cooperation INTEGER DEFAULT 0,
  warehouse_enabled INTEGER DEFAULT 0
);

-- 供应商类型
CREATE TABLE IF NOT EXISTS company_supplier_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

-- 材料库
CREATE TABLE IF NOT EXISTS company_materials (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  name TEXT DEFAULT '',
  category TEXT DEFAULT '',
  sub_category TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  model TEXT DEFAULT '',
  spec TEXT DEFAULT '',
  source TEXT DEFAULT '',
  supplier TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT ''
);

-- 材料分类
CREATE TABLE IF NOT EXISTS company_material_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  children_json TEXT DEFAULT '[]'
);

-- 工程定额类型
CREATE TABLE IF NOT EXISTS company_quota_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER DEFAULT 0,
  children_json TEXT DEFAULT '[]'
);

-- 工程定额条目
CREATE TABLE IF NOT EXISTS company_quotas (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  name TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  quota_type_id INTEGER DEFAULT 0
);

-- 材料成本参考价
CREATE TABLE IF NOT EXISTS company_material_costs (
  id INTEGER PRIMARY KEY,
  type TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  spec TEXT DEFAULT '',
  price REAL DEFAULT 0
);

-- 预算模板
CREATE TABLE IF NOT EXISTS company_budget_templates (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  name TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1
);

-- 模板市场
CREATE TABLE IF NOT EXISTS company_market_templates (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  name TEXT DEFAULT ''
);

-- 我的模板
CREATE TABLE IF NOT EXISTS company_my_templates (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  name TEXT DEFAULT '',
  used INTEGER DEFAULT 0
);

-- 行业常用语
CREATE TABLE IF NOT EXISTS company_terms (
  id INTEGER PRIMARY KEY,
  category TEXT DEFAULT '',
  content TEXT DEFAULT '',
  use_count INTEGER DEFAULT 0
);

-- 常用语分类
CREATE TABLE IF NOT EXISTS company_term_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

-- 角色分组（静态配置）
CREATE TABLE IF NOT EXISTS company_role_groups (
  id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}'
);

-- 权限树（app=前端应用权限 backend=后台管理权限）
CREATE TABLE IF NOT EXISTS company_permission_trees (
  id INTEGER PRIMARY KEY,
  key TEXT DEFAULT 'app',
  payload TEXT DEFAULT '{}'
);
`;

module.exports = { COMPANY_SCHEMA_SQL };
