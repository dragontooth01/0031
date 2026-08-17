/**
 * 预算模块业务表结构（模式 A：本地权威，数据以本地 SQLite 为准）
 * 由 local-api.js（服务启动）与 migrate-budget.js（数据迁移）共同引用，保证单一来源。
 */
const BUDGET_SCHEMA_SQL = `
-- 预算主表：列表项常用字段展开成列，完整对象存 list_json / detail_json
CREATE TABLE IF NOT EXISTS budgets (
  budget_id INTEGER PRIMARY KEY,        -- 云端真实 id；本地新建为 9 亿号段
  crm_id INTEGER DEFAULT 0,             -- 关联客户
  project_id INTEGER DEFAULT 0,
  name TEXT DEFAULT '',
  status INTEGER DEFAULT 0,             -- 0 未提交 1 待审核 2 已通过 3 已拒绝 等
  selected INTEGER DEFAULT 0,
  contract_price TEXT DEFAULT '0',
  total_price TEXT DEFAULT '0',
  create_user_name TEXT DEFAULT '',
  area_num INTEGER DEFAULT 0,
  list_json TEXT DEFAULT '{}',          -- /budget/mine/budget/list/ 列表项
  detail_json TEXT DEFAULT '{}',        -- /budget/detail/ 完整对象（含 areas/extra_items/crm_budgets）
  is_local INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,            -- 1=本地软删
  created_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_budgets_crm ON budgets(crm_id);

-- 预算子资源：按 (budget_id, kind) 存每预算维度的完整响应 data
-- kind: cost_detail / worker_summary / review_record / table_header / summary_item
CREATE TABLE IF NOT EXISTS budget_payloads (
  budget_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT '',
  PRIMARY KEY (budget_id, kind)
);

-- 预算公司级全局数据：kind = mine_budget_list / budget_crm_list / my_budget_crm_list /
--   delete_list / explanation / review_list / reviewer_setting / all_conditions /
--   template_list / specification / commodity_content / budget_list / template_detail_<id>
CREATE TABLE IF NOT EXISTS budget_globals (
  kind TEXT PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT ''
);

-- 预算子资源写操作日志（撤销/恢复用）：random_key 由本地生成返回前端，recover 时反向执行
CREATE TABLE IF NOT EXISTS budget_ops (
  random_key TEXT PRIMARY KEY,
  budget_id INTEGER DEFAULT 0,
  action TEXT DEFAULT '',            -- add / del / batch_del / copy / replace / edit
  payload TEXT DEFAULT '{}',         -- 反向操作所需数据（被删项、新增 id 等）
  created_at TEXT DEFAULT ''
);

-- 预算材料库（/budget/material/list/ 迁移快照，addAreaItem 按 material_ids 建项用）
CREATE TABLE IF NOT EXISTS budget_materials (
  material_id INTEGER PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  commodity_type_id INTEGER DEFAULT 0,
  band TEXT DEFAULT '',
  model TEXT DEFAULT '',
  specification TEXT DEFAULT '',
  name TEXT DEFAULT '',
  supplier_id INTEGER DEFAULT 0,
  sale_price TEXT DEFAULT '0',
  cost_price TEXT DEFAULT '0',
  unit TEXT DEFAULT '',
  created_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_budget_materials_type ON budget_materials(commodity_type_id);
`;

module.exports = { BUDGET_SCHEMA_SQL };
