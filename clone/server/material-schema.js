// 第五批业务表（crm_material 材料清单 + supplier 销售/退货单 + material_apply 材料申请单）
// 幂等 DDL，local-api.js 启动时 db.exec；迁移脚本可复用同一份 SQL
const MATERIAL_SCHEMA_SQL = `
-- 材料清单分组（crm_material_type 系列）
CREATE TABLE IF NOT EXISTS crm_material_types (
  crm_material_type_id INTEGER PRIMARY KEY AUTOINCREMENT,
  crm_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  order_num INTEGER DEFAULT 0,
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  deleted INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cmt_crm ON crm_material_types(crm_id, deleted);

-- 材料清单行（crm_material 系列）
CREATE TABLE IF NOT EXISTS crm_materials (
  crm_material_id INTEGER PRIMARY KEY AUTOINCREMENT,
  crm_material_type_id INTEGER NOT NULL DEFAULT 0,
  material_id INTEGER DEFAULT 0,
  name TEXT DEFAULT '',
  material_name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  specification TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  num REAL DEFAULT 0,
  unit_name TEXT DEFAULT '',
  sale_price REAL DEFAULT 0,
  total_price REAL DEFAULT 0,
  self_definition INTEGER DEFAULT 0,
  order_num INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cm_type ON crm_materials(crm_material_type_id, deleted);

-- 供应商销售/退货单（supplier/sales/order + refund/order 系列）
CREATE TABLE IF NOT EXISTS supplier_sales_orders (
  order_id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_sn TEXT DEFAULT '',
  order_type INTEGER DEFAULT 11,
  crm_id INTEGER DEFAULT 0,
  project_name TEXT DEFAULT '',
  consignee_name TEXT DEFAULT '',
  consignee_phone TEXT DEFAULT '',
  description TEXT DEFAULT '',
  status INTEGER DEFAULT 0,
  total_amount REAL DEFAULT 0,
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  create_time TEXT,
  deleted INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sso_crm ON supplier_sales_orders(crm_id, deleted);

-- 供应商销售/退货单明细
CREATE TABLE IF NOT EXISTS supplier_sales_order_items (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  commodity_id INTEGER DEFAULT 0,
  material_nick_name TEXT DEFAULT '',
  name TEXT DEFAULT '',
  band_name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  specification TEXT DEFAULT '',
  unit_name TEXT DEFAULT '',
  market_price REAL DEFAULT 0,
  num REAL DEFAULT 0,
  market_price_subtotal REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ssoi_order ON supplier_sales_order_items(order_id);

-- 材料申请单（v3 材料订单 / 快单 / 快退 / 退料单 统一承载）
CREATE TABLE IF NOT EXISTS material_apply_orders (
  material_apply_id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER DEFAULT 0,
  order_sn TEXT DEFAULT '',
  order_type INTEGER DEFAULT 0,
  apply_type INTEGER DEFAULT 0,
  crm_id INTEGER DEFAULT 0,
  project_id INTEGER DEFAULT 0,
  project_name TEXT DEFAULT '',
  supplier_id INTEGER DEFAULT 0,
  supplier_name TEXT DEFAULT '',
  decorator_id INTEGER DEFAULT 0,
  company_id INTEGER DEFAULT 0,
  consignee_name TEXT DEFAULT '',
  consignee_phone TEXT DEFAULT '',
  total_amount REAL DEFAULT 0,
  status INTEGER DEFAULT 0,
  sender_id INTEGER DEFAULT 0,
  sender_name TEXT DEFAULT '',
  pick_user_id INTEGER DEFAULT 0,
  pick_user_name TEXT DEFAULT '',
  reject_reason TEXT DEFAULT '',
  description TEXT DEFAULT '',
  files TEXT DEFAULT '[]',
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  create_time TEXT,
  deleted INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mao_type ON material_apply_orders(order_type, status, deleted);

-- 材料申请单明细
CREATE TABLE IF NOT EXISTS material_apply_items (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_apply_id INTEGER NOT NULL,
  commodity_id INTEGER DEFAULT 0,
  material_name TEXT DEFAULT '',
  band_name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  specification TEXT DEFAULT '',
  unit_name TEXT DEFAULT '',
  market_price REAL DEFAULT 0,
  num REAL DEFAULT 0,
  subtotal REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mai_apply ON material_apply_items(material_apply_id);
`;

module.exports = { MATERIAL_SCHEMA_SQL };
