/**
 * 客户模块业务表结构（模式 A：本地权威，数据以本地 SQLite 为准）
 * 由 local-api.js（服务启动）与 migrate-crm.js（数据迁移）共同引用，保证单一来源。
 */
const CRM_SCHEMA_SQL = `
-- 客户主表：列表项字段展开成列（供分页/筛选/排序），完整对象存 list_json / detail_json
CREATE TABLE IF NOT EXISTS crm_customers (
  crm_id INTEGER PRIMARY KEY,          -- 云端真实 id；本地新建为 9 亿号段
  -- 常用查询/展示字段（对应 /crm/v2/pc/list/ 列表项）
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  customer_gender INTEGER DEFAULT 0,
  gender INTEGER DEFAULT 0,
  room_type TEXT DEFAULT '',
  room_size TEXT DEFAULT '',
  address TEXT DEFAULT '',
  crm_status INTEGER DEFAULT 0,
  status_map_id INTEGER DEFAULT 0,
  status_name TEXT DEFAULT '',
  color_value TEXT DEFAULT '',
  customer_type_id INTEGER DEFAULT 0,
  customer_type_name TEXT DEFAULT '',
  source INTEGER DEFAULT 0,
  source_name TEXT DEFAULT '',
  owner_id INTEGER DEFAULT 0,
  owner_name TEXT DEFAULT '',
  owner_phone TEXT DEFAULT '',
  designer_id INTEGER DEFAULT 0,
  designer_name TEXT DEFAULT '',
  pm_name TEXT DEFAULT '',
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  create_time TEXT DEFAULT '',
  update_time TEXT DEFAULT '',
  is_aborted INTEGER DEFAULT 0,
  crm_sn TEXT DEFAULT '',
  project_id INTEGER DEFAULT 0,
  budget_id INTEGER DEFAULT 0,
  budget_num INTEGER DEFAULT 0,
  contract_num INTEGER DEFAULT 0,
  file_item_uploaded_num INTEGER DEFAULT 0,
  remind_enable INTEGER DEFAULT 0,
  next_remind_date TEXT DEFAULT '',
  tag_ids TEXT DEFAULT '',
  -- 完整对象（读接口直接复用，保证与云端返回结构一致）
  list_json TEXT DEFAULT '{}',
  detail_json TEXT DEFAULT '{}',
  -- 本地属性
  is_local INTEGER DEFAULT 0,          -- 1=本地新建（未迁移到云端）
  deleted INTEGER DEFAULT 0,           -- 1=本地软删
  created_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crm_customers_status ON crm_customers(crm_status);
CREATE INDEX IF NOT EXISTS idx_crm_customers_owner ON crm_customers(owner_id);
CREATE INDEX IF NOT EXISTS idx_crm_customers_create ON crm_customers(create_time);

-- 客户跟进记录
CREATE TABLE IF NOT EXISTS crm_follow_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crm_id INTEGER NOT NULL,
  follow_id INTEGER DEFAULT 0,
  content TEXT DEFAULT '',
  follow_type INTEGER DEFAULT 0,
  follow_type_name TEXT DEFAULT '',
  follow_time TEXT DEFAULT '',
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  extra_json TEXT DEFAULT '{}',
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crm_follow_crm ON crm_follow_records(crm_id);

-- 客户文件项（F1~F6 附件接口数据源；file_id 即列表 item_id）
CREATE TABLE IF NOT EXISTS crm_file_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER DEFAULT 0,           -- 云端真实 id；本地新建为 9 亿号段
  crm_id INTEGER NOT NULL,
  project_id INTEGER DEFAULT 0,        -- 按项目查附件/统计未读（F1/F9）
  file_type INTEGER DEFAULT 0,         -- 文件类型 tab（type）
  name TEXT DEFAULT '',
  url TEXT DEFAULT '',
  description TEXT DEFAULT '',         -- F3/F6 描述
  files TEXT DEFAULT '[]',             -- [{type,name,url,size}] 完整文件列表 JSON
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  create_time TEXT DEFAULT '',
  extra_json TEXT DEFAULT '{}',
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crm_file_crm ON crm_file_items(crm_id);
-- idx_crm_file_project 在 local-api.js ALTER 补列后创建（兼容旧库）

-- 客户状态字典（公司自定义状态，对应 /crm/company/crm/status/ 的 status_map_list）
CREATE TABLE IF NOT EXISTS crm_status (
  status_id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  color_value TEXT DEFAULT '',
  is_selected INTEGER DEFAULT 0,
  aborted INTEGER DEFAULT 0,
  enable INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT ''
);

-- 客户标签字典
CREATE TABLE IF NOT EXISTS crm_tags (
  tag_id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  is_selected INTEGER DEFAULT 0,
  enable INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT ''
);

-- 客户来源字典
CREATE TABLE IF NOT EXISTS crm_sources (
  source_id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  enable INTEGER DEFAULT 1,
  source_type TEXT DEFAULT 'self',   -- 'sys'=系统内置来源 'self'=公司自定义来源
  updated_at TEXT DEFAULT ''
);

-- 迁移断点记录
CREATE TABLE IF NOT EXISTS migration_meta (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

-- 客户模块公司级/用户级全局数据：kind = screen_conditions / status_list / table_header / department_members / department_leaders
-- 对应 /crm/screen/condition/list/、/crm/status/list/、/crm/table/header/list/、/company/v2/department/member/all/、/crm/department_leader/members/ 的完整响应 data
CREATE TABLE IF NOT EXISTS crm_globals (
  kind TEXT PRIMARY KEY,
  payload TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT ''
);

-- 公海线索（潜在客户）：/crm/public/customer/* 系列数据源
CREATE TABLE IF NOT EXISTS crm_public_customers (
  public_customer_id INTEGER PRIMARY KEY,  -- 云端真实 id；本地新建为 9 亿号段
  customer_name TEXT DEFAULT '',
  customer_gender INTEGER DEFAULT 0,
  customer_phone TEXT DEFAULT '',
  source_type_id INTEGER DEFAULT 0,
  province_code TEXT DEFAULT '',
  city_code TEXT DEFAULT '',
  area_code TEXT DEFAULT '',
  community_name TEXT DEFAULT '',
  room_number TEXT DEFAULT '',
  room_size TEXT DEFAULT '',
  address_detail TEXT DEFAULT '',
  status INTEGER DEFAULT 0,            -- 0=待分配 1=已分配 2=已回收
  owner_id INTEGER DEFAULT 0,
  owner_name TEXT DEFAULT '',
  assign_time TEXT DEFAULT '',
  reclaim_time TEXT DEFAULT '',
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  create_time TEXT DEFAULT '',
  update_time TEXT DEFAULT '',
  extra_json TEXT DEFAULT '{}',
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crm_public_status ON crm_public_customers(status);
CREATE INDEX IF NOT EXISTS idx_crm_public_phone ON crm_public_customers(customer_phone);

-- 服务团队（主设计师 + 协办成员）：/crm/service/team/* 系列
CREATE TABLE IF NOT EXISTS crm_service_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crm_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT DEFAULT '',
  team_role INTEGER DEFAULT 0,        -- 0=协办 1=主设计师
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  create_time TEXT DEFAULT '',
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crm_team_crm ON crm_service_team(crm_id);

-- 作废记录（批量作废/撤销）：/crm/batch/disable 系列留痕
CREATE TABLE IF NOT EXISTS crm_aborted_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crm_id INTEGER NOT NULL,
  operator_id INTEGER DEFAULT 0,
  operator_name TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  aborted_time TEXT DEFAULT '',
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crm_aborted_crm ON crm_aborted_records(crm_id);

-- 表头/筛选条件配置：field_type 0=筛选条件 1=列表表头
CREATE TABLE IF NOT EXISTS crm_field_settings (
  field_id INTEGER PRIMARY KEY,
  field_type INTEGER DEFAULT 0,
  name TEXT DEFAULT '',
  enable INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT ''
);

-- 附件操作记录（F7 record/list、F8 record/detail）
CREATE TABLE IF NOT EXISTS crm_file_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER DEFAULT 0,          -- 云端真实 id；本地新建为 9 亿号段
  crm_id INTEGER DEFAULT 0,
  project_id INTEGER DEFAULT 0,
  file_id INTEGER DEFAULT 0,
  action INTEGER DEFAULT 0,             -- 0=上传 1=删除 2=重命名 3=更新
  content TEXT DEFAULT '',              -- 操作内容快照（JSON）
  operator_id INTEGER DEFAULT 0,
  operator_name TEXT DEFAULT '',
  create_time TEXT DEFAULT '',
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crm_file_records_crm ON crm_file_records(crm_id);
CREATE INDEX IF NOT EXISTS idx_crm_file_records_create ON crm_file_records(create_time);
`;

module.exports = { CRM_SCHEMA_SQL };
