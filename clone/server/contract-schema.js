/**
 * 合同模块业务表结构（模式 A：本地权威，数据以本地 SQLite 为准）
 * 由 local-api.js（服务启动）与 migrate-contract.js（数据迁移）共同引用，保证单一来源。
 * 云端合同接口前缀为 /finance/contract/（合同列表按 crm_id 维度、审核列表为公司维度）。
 */
const CONTRACT_SCHEMA_SQL = `
-- 合同主表：一个客户（crm_id）下通常有多个合同（设计/主材/全包/软装等类型）
CREATE TABLE IF NOT EXISTS contracts (
  contract_id INTEGER PRIMARY KEY,      -- 云端真实 id；本地新建为 9 亿号段
  crm_id INTEGER DEFAULT 0,             -- 关联客户
  contract_type INTEGER DEFAULT 0,      -- 0 设计合同 1 主材合同 2 辅材合同 3 软装合同 4 全包合同 ...
  contract_name TEXT DEFAULT '',
  contract_title TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,         -- 云端字段名 order（order 为 SQLite 保留字，映射为 sort_order）
  has_read INTEGER DEFAULT 0,
  update_time TEXT DEFAULT '',
  bad_debt_amount TEXT DEFAULT '0',    -- 坏账金额（/finance/contract/bad_debt/set/ 本地落库）
  list_json TEXT DEFAULT '{}',          -- /finance/contract/list/ 列表项原样
  is_local INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_contracts_crm ON contracts(crm_id);

-- 合同子资源：按 (contract_id, kind) 存每合同维度完整响应 data（kind = budget_price / prepay_list）
CREATE TABLE IF NOT EXISTS contract_payloads (
  contract_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT '',
  PRIMARY KEY (contract_id, kind)
);

-- 合同公司级全局数据：kind = pc_check_list / app_check_list / check_filter_info / reviewer_setting
CREATE TABLE IF NOT EXISTS contract_globals (
  kind TEXT PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT ''
);
`;

module.exports = { CONTRACT_SCHEMA_SQL };
