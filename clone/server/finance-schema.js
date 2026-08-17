/**
 * 财务模块业务表结构（模式 A：本地权威，数据以本地 SQLite 为准）
 * 由 local-api.js（服务启动）与 migrate-finance.js（数据迁移）共同引用，保证单一来源。
 * 财务模块以公司级快照为主（收款列表/客户汇总/筛选条件），请款写接口宽容落库 finance_globals。
 */
const FINANCE_SCHEMA_SQL = `
-- 财务公司级快照与本地数据：kind = paid_list / paid_filter / finance_crm_list / finance_filter /
--   apply_conditions / financial_conditions / finance_project_list / company_project_list /
--   receivable_detail_<crm_id> / applies（本地请款数组，9 亿号段）/ paid_records（收款记录）
CREATE TABLE IF NOT EXISTS finance_globals (
  kind TEXT PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT ''
);
`;

module.exports = { FINANCE_SCHEMA_SQL };
