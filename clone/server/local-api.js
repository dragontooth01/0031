/**
 * 亮宅本地 API 实现（阶段一）
 * - SQLite 本地数据库（用户 / 会话）
 * - 本地登录 + 会话管理（响应格式与云端一致）
 * - A 类静态接口本地化：area_info / smscode / version / emoji / terminology / permission
 * - 未实现的接口由 server.js 继续代理云端（混合模式，渐进式切换）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { CRM_SCHEMA_SQL } = require('./crm-schema');
const { PROJECT_SCHEMA_SQL } = require('./project-schema');
const { BUDGET_SCHEMA_SQL } = require('./budget-schema');
const { CONTRACT_SCHEMA_SQL } = require('./contract-schema');
const { INSPECTION_SCHEMA_SQL } = require('./inspection-schema');
const { FINANCE_SCHEMA_SQL } = require('./finance-schema');
// 商品 + 库存模块（commodity/stock/*：入库/出库/仓库/货位/批次/记录）
const { COMMODITY_STOCK_SCHEMA_SQL, seedCommodityStock, createCommodityStockApi } = require('./commodity-stock');
// crm 客户管理模块（crm/*：废单/公司列表/分配/作废/查重/公海）
const { createCrmApi } = require('./crm-api');
// 第五批：材料库 + 供应商/采购（material_apply/crm_material/*、supplier/*）
const { MATERIAL_SCHEMA_SQL } = require('./material-schema');
const { createMaterialApi } = require('./material-api');
const logger = require('./logger');
// 企业后台（houtai）接口 + 种子数据：后台配置落共享 SQLite，写操作联动主站快照
const { COMPANY_SCHEMA_SQL, createCompanyApi } = require('./company-api');
const { seedCompany } = require('./seed-company');

const ROOT = path.join(__dirname, '..');
const MOCK_DIR = path.join(ROOT, 'data', 'mock');
const DB_PATH = path.join(ROOT, 'data', 'local.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// ---------------- 数据库初始化 ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  password_plain TEXT DEFAULT '',
  name TEXT DEFAULT '',
  company_id INTEGER DEFAULT 0,
  company_name TEXT DEFAULT '',
  is_administrator INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  cloud_session_id TEXT DEFAULT '',
  cloud_user_id INTEGER DEFAULT 0,
  cloud_company_id INTEGER DEFAULT 0,
  cloud_phone TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS local_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  record_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  deleted INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
`);
// 客户模块业务表（幂等；见 crm-schema.js，迁移脚本复用同一份 SQL）
db.exec(CRM_SCHEMA_SQL);
// 项目模块业务表（幂等；见 project-schema.js，迁移脚本复用同一份 SQL）
db.exec(PROJECT_SCHEMA_SQL);
// 预算模块业务表（幂等；见 budget-schema.js，迁移脚本复用同一份 SQL）
db.exec(BUDGET_SCHEMA_SQL);
// 合同模块业务表（幂等；见 contract-schema.js，迁移脚本复用同一份 SQL）
db.exec(CONTRACT_SCHEMA_SQL);
// 巡检模块业务表（幂等；见 inspection-schema.js，迁移脚本复用同一份 SQL）
db.exec(INSPECTION_SCHEMA_SQL);
// 财务模块业务表（幂等；见 finance-schema.js，迁移脚本复用同一份 SQL）
db.exec(FINANCE_SCHEMA_SQL);
// 商品 + 库存模块业务表（幂等；见 commodity-stock.js）
db.exec(COMMODITY_STOCK_SCHEMA_SQL);
// 第五批业务表：材料清单 / 供应商销售退货单 / 材料申请单（幂等；见 material-schema.js）
db.exec(MATERIAL_SCHEMA_SQL);
// 兼容已建库：crm_sources 补充来源类型列（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
try { db.exec('ALTER TABLE crm_sources ADD COLUMN source_type TEXT DEFAULT \'self\''); } catch {}
// 兼容已建库：contracts 补充坏账金额列
try { db.exec("ALTER TABLE contracts ADD COLUMN bad_debt_amount TEXT DEFAULT '0'"); } catch {}
// 兼容已建库：crm_file_items 补充 project_id/description/files 列（第三批附件接口）
try { db.exec('ALTER TABLE crm_file_items ADD COLUMN project_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE crm_file_items ADD COLUMN description TEXT DEFAULT \'\''); } catch {}
try { db.exec("ALTER TABLE crm_file_items ADD COLUMN files TEXT DEFAULT '[]'"); } catch {}
// project_id 补列后再建索引（crm-schema.js 中不建，避免旧库缺列报错）
try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_file_project ON crm_file_items(project_id)'); } catch {}

// 初始化本地管理员账号（本地口令 123456，密码存 MD5；password_plain 存云端密码 123456789 用于云端凭证刷新）
function seedAdmin() {
  const admin = db.prepare('SELECT id FROM users WHERE phone = ?').get('18300000001');
  if (!admin) {
    db.prepare('INSERT INTO users (phone, password, password_plain, name, company_id, company_name, is_administrator) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('18300000001', md5('123456'), '123456789', '管理员', 6808, '本地企业', 1);
  }
}
seedAdmin();

// 企业后台（houtai）业务表 + 首次启动自动迁移种子数据（真实快照优先，回退 mock 转录）
db.exec(COMPANY_SCHEMA_SQL);
try {
  const seeded = db.prepare('SELECT COUNT(*) AS c FROM company_departments').get();
  if (!seeded || !seeded.c) {
    seedCompany(db);
    logger.info('[company-api] 企业后台种子数据已迁移（api_data 真实快照优先）');
  }
} catch (e) {
  logger.error('[company-api] 种子数据迁移失败: ' + e.message);
}

// 商品 + 库存种子：真实商品快照（api_data/commodity_list.json）优先，失败回退默认仓库
try {
  seedCommodityStock(db);
} catch (e) {
  logger.error('[commodity-stock] 种子数据迁移失败: ' + e.message);
}

// ---------------- 工具函数 ----------------
function md5(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

function mock(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(MOCK_DIR, name + '.json'), 'utf8'));
  } catch {
    return { code: 1, msg: '本地数据缺失: ' + name, data: {} };
  }
}

const ok = (data, msg = '成功') => ({ code: 0, msg, data: data === undefined ? {} : data });

// 从请求头解析会话
function getSession(headers) {
  const sid = headers['session-id'] || '';
  if (!sid) return null;
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid) || null;
}

// 按本地 session_id 直接查会话（登录等场景响应数据里才有 session_id）
function getSessionById(sid) {
  if (!sid) return null;
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid) || null;
}

// ---------------- 本地记录层（B 类深化：断网增删改落库） ----------------
// entity: project / customer 等；record_id 为业务主键；payload 保存完整 JSON 数据
function localUpsert(entity, recordId, payload) {
  const now = new Date().toISOString();
  const rid = String(recordId);
  const exists = db.prepare('SELECT id FROM local_records WHERE entity = ? AND record_id = ?').get(entity, rid);
  if (exists) {
    db.prepare('UPDATE local_records SET payload = ?, deleted = 0, updated_at = ? WHERE entity = ? AND record_id = ?')
      .run(JSON.stringify(payload), now, entity, rid);
  } else {
    db.prepare('INSERT INTO local_records (entity, record_id, payload, deleted, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(entity, rid, JSON.stringify(payload), now, now);
  }
  return rid;
}

function localGet(entity, recordId) {
  const row = db.prepare('SELECT * FROM local_records WHERE entity = ? AND record_id = ? AND deleted = 0').get(entity, String(recordId));
  if (!row) return null;
  try { row.payload = JSON.parse(row.payload); } catch {}
  return row;
}

function localList(entity) {
  const rows = db.prepare('SELECT * FROM local_records WHERE entity = ? AND deleted = 0 ORDER BY id ASC').all(entity);
  return rows.map((row) => {
    try { row.payload = JSON.parse(row.payload); } catch {}
    return row;
  });
}

function localMarkDeleted(entity, recordId) {
  db.prepare('UPDATE local_records SET deleted = 1, updated_at = ? WHERE entity = ? AND record_id = ?')
    .run(new Date().toISOString(), entity, String(recordId));
}

// 本地新纪录主键：使用 9 亿号段，跨实体全局递增，避免与云端真实 id 冲突（record_id 全局 UNIQUE）
function localNextId(entity) {
  const row = db.prepare('SELECT MAX(CAST(record_id AS INTEGER)) AS m FROM local_records').get();
  const m = row && row.m ? Number(row.m) : 0;
  return Math.max(900000001, m + 1);
}

// 角色名称查找表（复用 sys_role_type/list 硬编码数据，懒加载缓存）
let _roleNameMap = null;
function getRoleNameMap() {
  if (_roleNameMap) return _roleNameMap;
  _roleNameMap = {};
  try {
    const h = handlers['POST /company/role/sys_role_type/list/'];
    if (h) {
      const r = h();
      const types = (r && r.data && r.data.sys_role_types) || [];
      for (const t of types) {
        for (const role of (t.roles || [])) {
          _roleNameMap[Number(role.role_id)] = role.role_name;
        }
      }
    }
  } catch {}
  return _roleNameMap;
}

// 角色全量表（role_id → {role_type_id, role_type_name, role_name}），供 role/add 归类使用
let _sysRoleMap = null;
function getSysRoleMap() {
  if (_sysRoleMap) return _sysRoleMap;
  _sysRoleMap = {};
  try {
    const h = handlers['POST /company/role/sys_role_type/list/'];
    if (h) {
      const r = h();
      const types = (r && r.data && r.data.sys_role_types) || [];
      for (const t of types) {
        for (const role of (t.roles || [])) {
          _sysRoleMap[Number(role.role_id)] = {
            role_type_id: Number(t.role_type_id),
            role_type_name: t.role_type_name || '',
            role_name: role.role_name || '',
          };
        }
      }
    }
  } catch {}
  return _sysRoleMap;
}

// 角色快照存储（role_store.json：角色页左树 + 角色详情）
let _roleStore = null;
function roleStoreJson() {
  if (_roleStore) return _roleStore;
  try {
    _roleStore = JSON.parse(fs.readFileSync(path.join(MOCK_DIR, 'role_store.json'), 'utf8'));
  } catch (e) {
    _roleStore = { role_types: [], details: {} };
  }
  if (!Array.isArray(_roleStore.role_types)) _roleStore.role_types = [];
  if (!_roleStore.details || typeof _roleStore.details !== 'object') _roleStore.details = {};
  return _roleStore;
}
function saveRoleStoreJson() {
  try {
    fs.writeFileSync(path.join(MOCK_DIR, 'role_store.json'), JSON.stringify(_roleStore));
  } catch (e) { /* 忽略 */ }
}

// 角色系统默认配置（role/detail 原站返回全员默认岗位职责+默认权限组；抓取自云端真实接口）
let _roleDetailDefaults = null;
function roleDetailDefault(rid) {
  if (_roleDetailDefaults === null) {
    _roleDetailDefaults = {};
    try {
      _roleDetailDefaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'role_detail_defaults.json'), 'utf8'));
    } catch (e) { _roleDetailDefaults = {}; }
  }
  const d = _roleDetailDefaults[rid];
  if (d) return { role_id: Number(d.role_id), role_name: d.role_name || '', description: d.description || '', permission_groups: Array.isArray(d.permission_groups) ? d.permission_groups : [] };
  return { role_id: rid, role_name: '', description: '', permission_groups: [] };
}
// 角色是否在公司角色配置中（role/add 添加后进入配置，sys_role_type selected / member_list 展示以此为准）
function roleInConfig(rid) {
  const s = roleStoreJson();
  return s.role_types.some(rt => (rt.roles || []).some(r => Number(r.role_id) === rid));
}

// 成员基础表（快照 + 本地成员合并），与部门成员列表同源；云端成员表按 user_id 倒序
function roleMemberBase() {
  const rows = db.prepare('SELECT payload FROM company_member_snapshot ORDER BY user_id DESC').all();
  const base = rows.map(r => JSON.parse(r.payload)).map(u => ({
    user_id: Number(u.user_id || 0), user_name: u.user_name || '', phone_number: u.user_phone || u.phone_number || '',
    user_avatar: u.user_avatar || '', user_accid: u.user_accid || '', roles: u.roles || [],
    is_leader: u.is_leader || 0, department_id: Number(u.department_id || 0),
    department_ids: u.department_ids || [Number(u.department_id || 0)]
  }));
  return applyLocalMembers(base);
}
function memberHasRole(u, rid) {
  return Array.isArray(u.roles) && u.roles.some(r => Number(r && typeof r === 'object' ? r.role_id : r) === rid);
}
function roleCountMap(users) {
  const m = {};
  for (const u of users) {
    if (!Array.isArray(u.roles)) continue;
    for (const r of u.roles) {
      const rid = Number(r && typeof r === 'object' ? r.role_id : r);
      if (rid) m[rid] = (m[rid] || 0) + 1;
    }
  }
  return m;
}

// 按部门 id 查部门名称（从 crm_globals department_members 快照）
function getDeptName(deptId) {
  try {
    const row = db.prepare("SELECT payload FROM crm_globals WHERE kind='department_members'").get();
    if (row) {
      const d = JSON.parse(row.payload);
      const depts = d.department_list || d.list || [];
      const dept = depts.find((dp) => Number(dp.department_id || dp.id) === Number(deptId));
      return dept ? (dept.department_name || dept.name || '') : '';
    }
  } catch {}
  return '';
}

// 构造客户列表项（字段与 /crm/v2/pc/list/ 返回的 crm_list 项一致，缺失字段给默认值）
function localCrmItem(row) {
  const p = row.payload || {};
  const day = (s) => (s ? String(s).slice(0, 10) : '');
  return {
    crm_id: Number(row.record_id),
    crm_house_count: 0,
    arriving_icon: 0,
    budgets: [],
    crm_status: p.crm_status || 1,
    status_map_id: 0,
    status_name: p.status_name || '潜在客户',
    color_value: '',
    create_time: day(row.created_at),
    create_user_name: p.create_user_name || '本地用户',
    customer_name: p.customer_name || p.name || '',
    customer_phone: p.customer_phone || p.phone_number || p.phone || '',
    customer_gender: p.customer_gender || 0,
    customer_type_id: 0,
    customer_type_name: p.customer_type_name || '',
    address: p.address || '',
    room_type: p.room_type || '',
    room_size: p.room_size || '0',
    source: p.source || 0,
    source_name: p.source_name || '',
    other_content: '',
    channel_number: '',
    owner_name: p.owner_name || p.create_user_name || '本地用户',
    owner_accid: '',
    owner_avatar: '',
    designer_id: 0,
    designer_name: p.designer_name || '',
    designer_accid: '',
    pm_id: 0,
    pm_name: '未设定',
    pm_accid: '',
    update_time: day(row.updated_at),
    remind_enable: 0,
    next_remind_date: '',
    next_remind_date_color: '',
    tag_ids: '',
    tag_name: '',
    is_aborted: 0,
    file_item_uploaded_num: 0,
    project_id: 0,
    project_create_time: '',
    project_completed_time: '',
    budget_num: 0,
    budget_id: 0,
    contract_num: 0,
    material_type_num: 0,
    total_receive_payment: '0',
    total_paid_amount: '0',
    follow_type: 0,
    follow_type_id: 0,
    follow_type_name: '',
    follow_content: '',
    permission_group: 0,
    crm_sn: '',
    status_switch_time: '',
    first_visit_time: '',
    unfollow_days: 0,
    measuring_time: '',
    second_arriving_time: '',
    total_contract_amount: '0'
  };
}

// 构造项目列表项（字段与 /project/pc/list/ 返回的 project_list 项一致，缺失字段给默认值）
function localProjectItem(row) {
  const p = row.payload || {};
  const day = (s) => (s ? String(s).slice(0, 10) : '');
  const name = p.project_name || [p.area_name, p.room_number].filter(Boolean).join('') || ('本地项目' + row.record_id);
  return {
    project_id: Number(row.record_id),
    project_name: name,
    address_detail: p.address_detail || '',
    status: p.status || 1,
    project_status: p.status || 1,
    plan_step_name: p.plan_step_name || '',
    real_step_name: p.real_step_name || '',
    budget_id: p.budget_id || 0,
    company_name: p.company_name || '',
    template_id: p.template_id || 0,
    template_name: p.template_name || '',
    get_project_detail_num: 0,
    create_date: day(row.created_at),
    start_date: p.start_date || '',
    end_date: p.end_date || '',
    completed_date: '未完工',
    plan_project_rate: 0,
    complete_rate: 0,
    remain_days: 0,
    delay_days: 0,
    role_name: p.role_name || '本地用户',
    is_owner: 0,
    delay_status: 0,
    roll_images: [],
    chat_groups: [],
    permissions: [],
    crm_id: p.crm_id || 0,
    owner_name: p.owner_name || '',
    owner_phone: p.owner_phone || '',
    camera_visible: 0
  };
}

// 构造预算列表项（字段与 /budget/mine/budget/list/ 的 budgets 项、/budget/detail/ 的 crm_budgets 项一致）
function localBudgetItem(row) {
  const p = row.payload || {};
  return {
    id: Number(row.record_id),
    name: p.name || p.budget_name || '新预算',
    crm_id: Number(p.crm_id || 0),
    project_id: Number(p.project_id || 0),
    status: p.status || 0,
    selected: p.selected || 0,
    checked: 0,
    contract_price: String(p.contract_price || '0'),
    total_price: String(p.total_price || '0'),
    create_user_name: p.create_user_name || '本地用户',
    reviewer_info_list: p.reviewer_info_list || []
  };
}

// 本地预算详情：以 /budget/detail/ 响应结构为模板，从本地 payload 还原
function localBudgetDetail(row) {
  const p = row.payload || {};
  const crmId = Number(p.crm_id || 0);
  const siblings = localList('budget').filter((b) => Number((b.payload || {}).crm_id) === crmId).map(localBudgetItem);
  return {
    budget_id: Number(row.record_id),
    name: p.name || p.budget_name || '新预算',
    crm_id: crmId,
    project_id: Number(p.project_id || 0),
    customer_name: p.customer_name || '',
    customer_gender: p.customer_gender || 0,
    room_size: p.room_size || '',
    room_type: p.room_type || '',
    description: p.description || '',
    contract_price: String(p.contract_price || '0'),
    gift: String(p.gift || '0'),
    selected: p.selected || 0,
    status: p.status || 0,
    crm_budgets: siblings,
    areas: p.areas || [],
    extra_items: p.extra_items || []
  };
}

// 列表/详情接口返回前合并本地记录（本地新建的项目/客户/预算在离线/在线都能显示）
// ================ 客户模块读接口本地化（模式 A：本地 SQLite 为唯一权威，前端零改动） ================
const dbNow = () => new Date().toISOString();

// 写入/更新 crm_customers 一行（row 的 key 即列名，动态对齐避免手写错误）
function upsertCustomerRow(row, opts) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols.map((c) => c + '=excluded.' + c).join(',');
  db.prepare('INSERT INTO crm_customers (' + cols.join(',') + ') VALUES (' + placeholders + ') ON CONFLICT(crm_id) DO UPDATE SET ' + updates)
    .run(...cols.map((c) => (row[c] === undefined ? '' : row[c])));
}

// 增量归并 local_records 本地客户 → crm_customers：
// 读接口本地化后，本地新建/编辑/删除的客户必须即时可见，这里在每次查询前轻量同步
function ensureLocalCustomersMerged() {
  const rows = db.prepare("SELECT * FROM local_records WHERE entity = 'customer'").all();
  let merged = 0, deleted = 0;
  for (const row of rows) {
    const crmId = Number(row.record_id);
    if (row.deleted) {
      db.prepare('UPDATE crm_customers SET deleted = 1, updated_at = ? WHERE crm_id = ?').run(dbNow(), crmId);
      deleted++;
      continue;
    }
    if (db.prepare('SELECT crm_id FROM crm_customers WHERE crm_id = ?').get(crmId)) continue;
    let p = {};
    try { p = JSON.parse(row.payload || '{}'); } catch {}
    if (!p || typeof p !== 'object') p = {}; // 异常 payload（null/数字等）兜底，避免属性访问崩溃
    const day = (s) => (s ? String(s).slice(0, 10) : '');
    upsertCustomerRow({
      crm_id: crmId,
      customer_name: p.customer_name || p.name || '',
      customer_phone: p.customer_phone || p.phone_number || p.phone || '',
      customer_gender: p.customer_gender || p.gender || 0,
      gender: p.customer_gender || p.gender || 0,
      room_type: p.room_type || '',
      room_size: p.room_size || '0',
      address: p.address || '',
      crm_status: p.crm_status || 1,
      status_name: p.status_name || '潜在客户',
      customer_type_name: p.customer_type_name || '',
      source: p.source || 0,
      source_name: p.source_name || '',
      create_user_name: p.create_user_name || '本地用户',
      create_time: day(row.created_at),
      update_time: day(row.updated_at),
      owner_name: p.owner_name || p.create_user_name || '本地用户'
    }, { is_local: true });
    merged++;
  }
  if (merged || deleted) logger.info('客户归并', '本地客户增量归并', { merged, deleted, total: rows.length });
}

// 由 crm_customers 行构造客户列表项（列兜底 + list_json 原样覆盖，保证与云端返回结构一致）
function buildCrmItem(row) {
  const day = (s) => (s ? String(s).slice(0, 10) : '');
  const parseTags = (v) => {
    if (typeof v === 'string' && v.startsWith('[')) { try { v = JSON.parse(v); } catch {} }
    return Array.isArray(v) ? v : (v ? String(v).split(',') : []);
  };
  const base = {
    crm_id: Number(row.crm_id), crm_house_count: 0, arriving_icon: 0, budgets: [],
    crm_status: row.crm_status, status_map_id: row.status_map_id, status_name: row.status_name,
    color_value: row.color_value, create_time: day(row.create_time) || day(row.created_at),
    create_user_name: row.create_user_name, customer_name: row.customer_name, customer_phone: row.customer_phone,
    customer_gender: row.customer_gender, customer_type_id: row.customer_type_id, customer_type_name: row.customer_type_name,
    address: row.address, room_type: row.room_type, room_size: row.room_size,
    source: row.source, source_name: row.source_name, other_content: '', channel_number: '',
    owner_id: row.owner_id, owner_name: row.owner_name, owner_phone: row.owner_phone, owner_accid: '', owner_avatar: '',
    designer_id: row.designer_id, designer_name: row.designer_name, designer_accid: '',
    pm_id: 0, pm_name: row.pm_name || '未设定', pm_accid: '',
    update_time: day(row.update_time) || day(row.updated_at),
    remind_enable: row.remind_enable, next_remind_date: row.next_remind_date, next_remind_date_color: '',
    tag_ids: parseTags(row.tag_ids), tag_name: [], tab_name: [], is_aborted: row.is_aborted, file_item_uploaded_num: row.file_item_uploaded_num,
    project_id: row.project_id, project_create_time: '', project_completed_time: '',
    budget_num: row.budget_num, budget_id: row.budget_id, contract_num: row.contract_num,
    material_type_num: 0, total_receive_payment: '0', total_paid_amount: '0',
    follow_type: 0, follow_type_id: 0, follow_type_name: '', follow_content: '',
    permission_group: 0, crm_sn: row.crm_sn, status_switch_time: '', first_visit_time: '',
    unfollow_days: 0, measuring_time: '', second_arriving_time: '', total_contract_amount: '0'
  };
  let j = {};
  try { j = JSON.parse(row.list_json || '{}'); } catch {}
  const item = { ...base, ...j, crm_id: Number(row.crm_id) };
  item.tag_ids = parseTags(item.tag_ids);
  if (!Array.isArray(item.tag_name)) item.tag_name = [];
  if (!Array.isArray(item.tab_name)) item.tab_name = [];
  return item;
}

// 客户列表通用查询：/crm/v2/pc/list/（个人）与 /crm/v2/pc/company/crm/list/（公司）共用
function queryCrmList(body, company) {
  ensureLocalCustomersMerged();
  const b = body || {};
  const page_index = Math.max(1, Number(b.page_index || 1));
  const page_size = Math.max(1, Number(b.page_size || 20));
  const where = ['deleted = 0'];
  const params = [];
  const kw = b.search_word || b.search || b.keyword;
  if (kw) { where.push('(customer_name LIKE ? OR customer_phone LIKE ?)'); params.push('%' + kw + '%', '%' + kw + '%'); }
  const st = b.status;
  if (st !== undefined && st !== '' && st !== null) {
    const ids = (Array.isArray(st) ? st : String(st).split(',')).map(Number).filter((x) => x > 0);
    if (ids.length) { where.push('status_map_id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
  }
  const owner = b.owner_id || b.owner;
  if (owner) { where.push('owner_id = ?'); params.push(Number(owner)); }
  const designer = b.designer_id || b.designer;
  if (designer) { where.push('designer_id = ?'); params.push(Number(designer)); }
  const cu = b.create_user_id;
  if (cu) { where.push('create_user_id = ?'); params.push(Number(cu)); }
  const src = b.source;
  if (src) { where.push('source = ?'); params.push(Number(src)); }
  if (b.aborted === 1 || b.aborted === '1') where.push('is_aborted = 1');
  if (b.follow === 1 || b.follow === '1') where.push("next_remind_date <> ''");
  const whereSql = where.join(' AND ');
  const total = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE ' + whereSql).get(...params).c;
  const rows = db.prepare('SELECT * FROM crm_customers WHERE ' + whereSql + ' ORDER BY create_time DESC, crm_id DESC LIMIT ? OFFSET ?')
    .all(...params, page_size, (page_index - 1) * page_size);
  const d = { total_num: total, crm_list: rows.map(buildCrmItem) };
  // 负责人/设计师/创建人下拉（从本地客户数据聚合，供前端筛选）
  const agg = (idCol, nameCol) => db.prepare('SELECT DISTINCT ' + idCol + ' AS user_id, ' + nameCol + ' AS user_name FROM crm_customers WHERE deleted = 0 AND ' + idCol + ' > 0').all();
  d.owners = agg('owner_id', 'owner_name');
  d.designers = agg('designer_id', 'designer_name');
  d.create_users = agg('create_user_id', 'create_user_name');
  if (company) {
    // 公司版统计字段（本地权威：权限全开；项目完成数本地暂无项目数据，置 0）
    d.intended_num = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE deleted = 0 AND is_aborted = 0').get().c;
    d.project_completed_num = 0;
    d.aborted_num = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE deleted = 0 AND is_aborted = 1').get().c;
    d.budget_permission = 1; d.contract_permission = 1; d.receive_amount_permission = 1;
    d.paid_permission = 1; d.can_create_project = 1; d.can_export_crm = 1;
  }
  return ok(d);
}

// 筛选条件数据：从本地客户数据聚合负责人/设计师/创建人下拉（resign_designers 本地无离职概念，置空）
function crmScreenConditions() {
  const agg = (idCol, nameCol) => db.prepare(
    'SELECT ' + idCol + ' AS user_id, ' + nameCol + ' AS user_name, COUNT(*) AS crm_count FROM crm_customers WHERE deleted = 0 AND ' + idCol + ' > 0 GROUP BY ' + idCol + ' ORDER BY crm_count DESC').all();
  return {
    owners: agg('owner_id', 'owner_name'),
    create_users: agg('create_user_id', 'create_user_name'),
    designers: agg('designer_id', 'designer_name'),
    resign_designers: []
  };
}

// 客户模块公司级/用户级全局数据读取（kind 对应 crm_globals 分类：screen_conditions/status_list/table_header/department_members/department_leaders）；缺失返回 null（回退代理）
function crmGlobal(kind) {
  return () => {
    const row = db.prepare('SELECT payload FROM crm_globals WHERE kind = ?').get(kind);
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  };
}

// 由 crm_customers 行构造客户详情对象：detail_json 非空则原样返回，否则用列字段构造云端同构结构
function buildCustomerDetail(row) {
  let detail = {};
  try { detail = JSON.parse(row.detail_json || '{}'); } catch {}
  let base;
  if (detail && Object.keys(detail).length > 0) base = detail;
  else {
    base = {
      company_id: 0, show_update_customer: 1, create_user_name: row.create_user_name,
      name: row.customer_name, phone_number: row.customer_phone, edit_permission: 1,
      gender: row.customer_gender, address: row.address, source: row.source, source_name: row.source_name,
      other_content: '', channel_number: '', type: row.crm_status,
      customer_type_id: row.customer_type_id, customer_type_name: row.customer_type_name,
      status_map_id: row.status_map_id, status_name: row.status_name, color_value: row.color_value,
      description: '', room_size: row.room_size, house_type: '', room_type: row.room_type,
      bedroom_num: 0, hall_num: 0, bathroom_num: 0, kitchen_num: 0, balcony_num: 0,
      room_description: '', province_code: '', province: '', city_code: '', city: '',
      area_code: '', area: '', address_detail: '', area_name: '', room_number: '',
      crm_sn: row.crm_sn, family_members: [], create_time: row.create_time
    };
  }
  // 详情面板（前台"我的客户/全部客户"点击客户）依赖字段兜底：
  // follow_records 必须为数组（前端 forEach 渲染跟进记录），project_id/customer_info 等缺失会白屏/崩溃
  const crmId = Number(row.crm_id);
  if (!Array.isArray(base.follow_records)) {
    const frs = db.prepare('SELECT * FROM crm_follow_records WHERE crm_id = ? AND deleted = 0 ORDER BY follow_time DESC, id DESC').all(crmId);
    base.follow_records = frs.map((r) => ({
      record_id: r.follow_id, create_user_id: r.create_user_id, create_user_name: r.create_user_name,
      create_time: r.follow_time, content: r.content || '', follow_type: r.follow_type,
      notify_user_info: [], files: []
    }));
  }
  if (base.project_id === undefined || base.project_id === null) {
    const pr = db.prepare('SELECT project_id FROM projects WHERE crm_id = ? AND deleted = 0 LIMIT 1').get(crmId);
    base.project_id = pr ? Number(pr.project_id) : 0;
  }
  if (!base.customer_info || typeof base.customer_info !== 'object') {
    base.customer_info = {
      name: base.name || row.customer_name || '',
      gender: base.gender || row.customer_gender || 0,
      room_size: base.room_size || row.room_size || '',
      room_type: base.room_type || row.room_type || ''
    };
  }
  if (!Array.isArray(base.contracts)) base.contracts = [];
  if (!Array.isArray(base.budgets)) base.budgets = [];
  if (base.crm_id === undefined) base.crm_id = crmId;
  return base;
}

// 编辑表单字段（列表风格 customer_name/...）归一化到详情结构字段（name/phone_number/...）
function mapBodyToDetail(b) {
  const r = { ...b };
  if (b.customer_name !== undefined && b.name === undefined) r.name = b.customer_name;
  if (b.customer_phone !== undefined && b.phone_number === undefined) r.phone_number = b.customer_phone;
  if (b.customer_gender !== undefined && b.gender === undefined) r.gender = b.customer_gender;
  return r;
}

// 更新 crm_customers 一行客户：合并 list_json/detail_json + 更新常用列；
// 本地新建客户同步 local_records（保持归并源一致）。返回是否更新成功。
function updateCustomerRecord(crmId, body) {
  const row = db.prepare('SELECT * FROM crm_customers WHERE crm_id = ?').get(crmId);
  if (!row) return false;
  let lj = {};
  try { lj = JSON.parse(row.list_json || '{}'); } catch {}
  const lmerged = { ...lj, ...body, crm_id: crmId };
  const dmerged = { ...buildCustomerDetail(row), ...mapBodyToDetail(body) };
  const tagIds = Array.isArray(body.tag_ids)
    ? JSON.stringify(body.tag_ids)
    : (body.tag_ids !== undefined ? String(body.tag_ids) : row.tag_ids);
  db.prepare(`UPDATE crm_customers SET
      customer_name=?, customer_phone=?, customer_gender=?, gender=?, room_type=?, room_size=?, address=?,
      source=?, source_name=?, customer_type_id=?, customer_type_name=?, status_map_id=?, status_name=?,
      color_value=?, tag_ids=?, list_json=?, detail_json=?, updated_at=? WHERE crm_id=?`)
    .run(
      body.customer_name || body.name || row.customer_name || '',
      body.customer_phone || body.phone_number || body.phone || row.customer_phone || '',
      body.customer_gender !== undefined ? Number(body.customer_gender) : (row.customer_gender || 0),
      body.gender !== undefined ? Number(body.gender) : (row.gender || 0),
      body.room_type !== undefined ? body.room_type : row.room_type,
      body.room_size !== undefined ? String(body.room_size) : row.room_size,
      body.address !== undefined ? (body.address || '') : row.address,
      body.source !== undefined ? Number(body.source) : row.source,
      body.source_name !== undefined ? body.source_name : row.source_name,
      body.customer_type_id !== undefined ? Number(body.customer_type_id) : row.customer_type_id,
      body.customer_type_name !== undefined ? body.customer_type_name : row.customer_type_name,
      body.status_map_id !== undefined ? Number(body.status_map_id) : row.status_map_id,
      body.status_name !== undefined ? body.status_name : row.status_name,
      body.color_value !== undefined ? body.color_value : row.color_value,
      tagIds, JSON.stringify(lmerged), JSON.stringify(dmerged), dbNow(), crmId);
  // 本地新建客户同步 local_records（本地删除标记也在该表维护）
  const local = localGet('customer', crmId);
  if (local) localUpsert('customer', crmId, { ...local.payload, ...body });
  logger.info('客户写接口', '编辑客户落库', { crm_id: crmId, fields: Object.keys(body).filter((k) => k !== 'crm_id'), syncedLocal: !!local });
  return true;
}

// 本地软删客户（crm_customers + local_records）。模式 A 本地权威：即使本地无记录也不回云端
function deleteCustomerRecord(crmId) {
  db.prepare('UPDATE crm_customers SET deleted = 1, updated_at = ? WHERE crm_id = ?').run(dbNow(), crmId);
  const local = localGet('customer', crmId);
  if (local) localMarkDeleted('customer', crmId);
  logger.info('客户写接口', '客户软删落库', { crm_id: crmId, wasLocal: !!local });
  return { code: 0, msg: '成功', data: {} };
}

function mergeLocalRecords(apiPath, respObj, reqBodyStr) {
  if (!respObj || respObj.code !== 0 || !respObj.data || typeof respObj.data !== 'object') return respObj;
  const d = respObj.data;
  // 客户列表
  if (apiPath === '/crm/v2/pc/list/' || apiPath === '/crm/v2/pc/company/crm/list/') {
    const locals = localList('customer');
    if (locals.length) {
      d.crm_list = [...locals.map(localCrmItem), ...(Array.isArray(d.crm_list) ? d.crm_list : [])];
      d.total_num = d.crm_list.length;
    }
  }
  // 项目列表
  if (apiPath === '/project/pc/list/' || apiPath === '/project/list/') {
    const locals = localList('project');
    if (locals.length) {
      d.project_list = [...locals.map(localProjectItem), ...(Array.isArray(d.project_list) ? d.project_list : [])];
      d.total_num = d.project_list.length;
    }
  }
  // 我的预算模板列表
  if (apiPath === '/budget/mine/budget/list/') {
    const locals = localList('budget');
    if (locals.length) {
      d.budgets = [...locals.map(localBudgetItem), ...(Array.isArray(d.budgets) ? d.budgets : [])];
      d.total_num = d.budgets.length;
    }
  }
  // 预算详情侧栏：把同一客户本地创建的预算并入 crm_budgets
  if (apiPath === '/budget/detail/' && Array.isArray(d.crm_budgets)) {
    const locals = localList('budget').filter((b) => Number((b.payload || {}).crm_id) === Number(d.crm_id));
    if (locals.length) d.crm_budgets = [...locals.map(localBudgetItem), ...d.crm_budgets];
  }
  // 企业成员列表（按部门查询）：合并本地新增成员到 users 数组（字段对照线上真实响应）
  if (apiPath === '/company/v2/department/member/list/' && Array.isArray(d.users)) {
    let reqDeptId = 0;
    try { const b = JSON.parse(reqBodyStr || '{}'); reqDeptId = Number(b.id) || 0; } catch {}
    const locals = localList('member');
    if (locals.length) {
      for (const m of locals) {
        const p = m.payload || {};
        const deptIds = Array.isArray(p.department_ids) ? p.department_ids : (p.department_id ? [p.department_id] : []);
        // 按请求的部门 id 过滤：只把属于当前部门的本地成员合并进来
        if (reqDeptId && !deptIds.includes(reqDeptId)) continue;
        if (!d.users.some((u) => Number(u.user_id) === Number(p.user_id))) {
          d.users.push({
            user_id: Number(p.user_id), user_name: p.user_name || '', phone_number: p.phone_number || '',
            user_avatar: p.user_avatar || 'https://cdn.e-shigong.com/brief_default_avatar.png',
            user_accid: p.user_accid || '', roles: p.roles || [], department_ids: deptIds,
            is_leader: 0, department_num: (p.department_info || []).length || deptIds.length,
            department_info: p.department_info || []
          });
        }
      }
    }
  }
  // 财务详情：本地设置的坏账金额覆盖云端返回（本地权威），并重算汇总
  if (apiPath === '/finance/detail/' && d.contract_info && Array.isArray(d.contract_info.contracts)) {
    const rows = db.prepare('SELECT contract_id, bad_debt_amount FROM contracts WHERE bad_debt_amount IS NOT NULL AND bad_debt_amount != ?').all('0');
    if (rows.length) {
      let sum = 0;
      for (const c of d.contract_info.contracts) {
        const hit = rows.find((r) => Number(r.contract_id) === Number(c.finance_contract_id));
        if (hit) { c.bad_debt_amount = hit.bad_debt_amount; c.show_bad_debt_amount = hit.bad_debt_amount; }
        sum += Number(c.bad_debt_amount || 0);
      }
      d.total_bad_debt_amount = (Math.round(sum * 100) / 100).toFixed(2);
    }
  }
  return respObj;
}

// ================ 项目模块读接口本地化（模式 A：本地 SQLite 为唯一权威，前端零改动） ================

// 增量归并 local_records 本地项目 → projects（本地新建项目即时可见）
function ensureLocalProjectsMerged() {
  const rows = db.prepare("SELECT * FROM local_records WHERE entity = 'project'").all();
  let merged = 0, deleted = 0;
  for (const row of rows) {
    const pid = Number(row.record_id);
    if (row.deleted) {
      db.prepare('UPDATE projects SET deleted = 1, updated_at = ? WHERE project_id = ?').run(dbNow(), pid);
      deleted++;
      continue;
    }
    if (db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(pid)) continue;
    let p = {};
    try { p = JSON.parse(row.payload || '{}'); } catch {}
    if (!p || typeof p !== 'object') p = {}; // 异常 payload 兜底
    // 动态列插入（projects 表列名与值对齐）
    const r = {
      project_id: pid,
      project_name: p.project_name || [p.area_name, p.room_number].filter(Boolean).join('') || ('本地项目' + pid),
      status: p.status || 1,
      project_status: p.status || 1,
      start_date: p.start_date || String(row.created_at || '').slice(0, 10),
      end_date: p.end_date || '',
      area_name: p.area_name || '',
      room_number: p.room_number || '',
      is_local: 1,
      created_at: dbNow(),
      updated_at: dbNow()
    };
    const cols = Object.keys(r);
    const placeholders = cols.map(() => '?').join(',');
    const updates = cols.filter((c) => c !== 'project_id').map((c) => c + '=excluded.' + c).join(',');
    db.prepare('INSERT INTO projects (' + cols.join(',') + ') VALUES (' + placeholders + ') ON CONFLICT(project_id) DO UPDATE SET ' + updates)
      .run(...cols.map((c) => r[c]));
    merged++;
  }
  if (merged || deleted) logger.info('项目归并', '本地项目增量归并', { merged, deleted, total: rows.length });
}

// 由 projects 行构造 PC 列表项（list_json 原样覆盖 + 列兜底）
function buildProjectItem(row) {
  let lj = {};
  try { lj = JSON.parse(row.list_json || '{}'); } catch {}
  if (!lj || typeof lj !== 'object') lj = {}; // list_json=null 兜底
  const item = { ...lj, project_id: Number(row.project_id), project_name: lj.project_name || row.project_name };
  // 兼容旧快照：select_role_users 缺失/非数组时兜底为空数组（项目进度页 getMemberStr 直接 .map 会抛错卡 loading）
  if (!Array.isArray(item.select_role_users)) item.select_role_users = [];
  // 日期/工期/进度率兜底：project-schedule 页前端用 start_date/end_date/total_duration 计算时间轴宽度，
  // 缺失任意一个都会算出 NaNpx（scheduleWidth/totalWidth/planWidth），整体兜底防止旧快照与新数据复发
  const day10 = (s) => (s ? String(s).slice(0, 10) : '');
  let sd = day10(item.start_date);
  if (!sd || isNaN(new Date(sd).getTime())) sd = day10(row.created_at) || '2024-01-01';
  const edRaw = day10(item.end_date);
  let ed = (!edRaw || isNaN(new Date(edRaw).getTime())) ? '' : edRaw;
  // 工期天数：优先快照 total_duration，否则按起止日期差值，再否则默认 90 天
  let dur = Number(item.total_duration);
  if (!(dur > 0)) dur = ed ? Math.max(1, Math.round((new Date(ed) - new Date(sd)) / 864e5)) : 90;
  // end_date 缺失时按工期顺延（避免 time2=NaN 导致整条时间轴 NaN）
  if (!ed) {
    const d = new Date(sd);
    d.setDate(d.getDate() + dur);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    ed = y + '-' + m + '-' + dd;
  }
  item.start_date = sd;
  item.end_date = ed;
  item.total_duration = dur;
  item.plan_project_rate = Number(item.plan_project_rate) || 0;
  item.complete_rate = Number(item.complete_rate) || 0;
  return item;
}

// 查询项目列表（/project/pc/list/ 同构）：search_word/status 过滤 + 分页
function queryProjectList(body) {
  ensureLocalProjectsMerged();
  const page_index = Number((body && body.page_index) || 1);
  const page_size = Number((body && body.page_size) || 20);
  let where = 'deleted = 0';
  const params = [];
  if (body && body.search_word) {
    where += ' AND (project_name LIKE ? OR area_name LIKE ?)';
    const kw = '%' + String(body.search_word) + '%';
    params.push(kw, kw);
  }
  if (body && body.status !== undefined && body.status !== '' && Number(body.status) !== 0) {
    where += ' AND status = ?';
    params.push(Number(body.status));
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE ' + where).get(...params).n;
  const rows = db.prepare('SELECT * FROM projects WHERE ' + where + ' ORDER BY project_id DESC LIMIT ? OFFSET ?')
    .all(...params, page_size, (page_index - 1) * page_size);
  return { code: 0, msg: '成功', data: { project_list: rows.map(buildProjectItem), total_num: total } };
}

// 移动端列表项（/project/list/ 的 projects 项结构）
function buildProjectMobileItem(row) {
  let mj = {};
  try { mj = JSON.parse(row.mobile_json || '{}'); } catch {}
  const day = (s) => (s ? String(s).slice(0, 10) : '');
  return {
    project_id: Number(row.project_id),
    name: mj.name || row.project_name,
    project_identify: mj.project_identify || 0,
    area_name: mj.area_name || row.area_name || '',
    image_index: mj.image_index || 0,
    status: mj.status !== undefined ? mj.status : row.status,
    delay_status: mj.delay_status !== undefined ? mj.delay_status : row.delay_status,
    plan_rate: mj.plan_rate || row.plan_project_rate || 0,
    complete_rate: mj.complete_rate !== undefined ? mj.complete_rate : row.complete_rate,
    days: mj.days || 0,
    create_date: day(mj.create_date || row.created_at),
    start_date: day(mj.start_date || row.start_date),
    end_date: day(mj.end_date || row.end_date),
    completed_date: (mj.completed_date !== undefined ? mj.completed_date : row.completed_date) || '未完工'
  };
}

// 移动端项目列表（/project/list/ 同构：normal/delay/complete 计数 + projects）
function queryProjectMobileList() {
  ensureLocalProjectsMerged();
  const rows = db.prepare('SELECT * FROM projects WHERE deleted = 0 ORDER BY project_id DESC').all();
  const projects = rows.map(buildProjectMobileItem);
  const complete = projects.filter((p) => Number(p.status) === 4 || (p.completed_date && p.completed_date !== '未完工' && p.completed_date !== ''));
  const delay = projects.filter((p) => Number(p.delay_status) === 1 && !complete.includes(p));
  return {
    code: 0, msg: '成功',
    data: {
      normal_project_num: projects.length - complete.length,
      delay_project_num: delay.length,
      complete_project_num: complete.length,
      projects
    }
  };
}

// 项目详情：detail_json 优先，本地项目按列构造；无记录返回 null（回退代理）
function getProjectDetail(pid) {
  const row = db.prepare('SELECT * FROM projects WHERE project_id = ? AND deleted = 0').get(Number(pid));
  if (!row) return null;
  try {
    const dj = JSON.parse(row.detail_json || '{}');
    if (dj && Object.keys(dj).length > 0) return dj;
  } catch {}
  return {
    project_id: Number(row.project_id),
    project_name: row.project_name,
    status: row.status,
    project_status: row.project_status,
    start_date: row.start_date,
    end_date: row.end_date,
    completed_date: row.completed_date || '未完工',
    plan_project_rate: row.plan_project_rate || 0,
    complete_rate: row.complete_rate,
    area_name: row.area_name,
    room_number: row.room_number,
    template_id: row.template_id,
    template_name: row.template_name,
    budget_id: row.budget_id,
    roll_images: [],
    chat_groups: [],
    permissions: [],
    camera_visible: 0
  };
}

// 项目子资源读取（kind 对应迁移时的 project_payloads 分类）；未迁移返回 null（回退代理）
function projectPayload(kind) {
  return ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT payload FROM project_payloads WHERE project_id = ? AND kind = ?').get(Number(pid), kind);
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  };
}

// 公司级全局数据读取（kind 对应 project_globals 分类）；缺失返回 null（回退代理）
function projectGlobal(kind) {
  return () => {
    const row = db.prepare('SELECT payload FROM project_globals WHERE kind = ?').get(kind);
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  };
}

// ================ 预算模块读接口本地化（模式 A：本地 SQLite 为唯一权威，前端零改动） ================

// 增量归并 local_records 本地预算 → budgets（本地新建预算即时可见）
function ensureLocalBudgetsMerged() {
  const rows = db.prepare("SELECT * FROM local_records WHERE entity = 'budget'").all();
  let merged = 0, deleted = 0;
  for (const row of rows) {
    const bid = Number(row.record_id);
    if (row.deleted) {
      db.prepare('UPDATE budgets SET deleted = 1, updated_at = ? WHERE budget_id = ?').run(dbNow(), bid);
      deleted++;
      continue;
    }
    if (db.prepare('SELECT budget_id FROM budgets WHERE budget_id = ?').get(bid)) continue;
    let p = {};
    try { p = JSON.parse(row.payload || '{}'); } catch {}
    if (!p || typeof p !== 'object') p = {}; // 异常 payload 兜底
    db.prepare(`INSERT OR IGNORE INTO budgets (budget_id, crm_id, project_id, name, status, contract_price, total_price, create_user_name, list_json, is_local, deleted, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)`)
      .run(bid, Number(p.crm_id || 0), Number(p.project_id || 0), p.name || p.budget_name || '新预算', Number(p.status || 0),
        String(p.contract_price || '0'), String(p.total_price || p.total_sale_price || '0'), p.create_user_name || '本地用户',
        JSON.stringify({ id: bid, name: p.name || p.budget_name || '新预算', area_num: (p.areas || []).length }), dbNow(), dbNow());
    merged++;
  }
  if (merged || deleted) logger.info('预算归并', '本地预算增量归并', { merged, deleted, total: rows.length });
}

// 预算列表项（list_json 原样 + 列兜底）
function buildBudgetItem(row) {
  let lj = {};
  try { lj = JSON.parse(row.list_json || '{}'); } catch {}
  if (!lj || typeof lj !== 'object') lj = {}; // list_json=null 兜底
  return { ...lj, id: Number(row.budget_id), name: lj.name || row.name };
}

// 当前登录用户的预算可见身份：
// - 管理员：全部预算可见（isAdmin=true）
// - 普通成员：仅本人（designer_name / create_user_name 命中 users.name 或 company_members 关联名）
function currentUserBudgetScope(headers) {
  const s = getSession(headers);
  if (!s) return { isAdmin: false, names: [] };
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u) return { isAdmin: false, names: [] };
  const names = new Set();
  if (u.name) names.add(u.name);
  try {
    // 后台成员以手机号关联：管理员本地名"管理员" → 云端/预算快照真实姓名"小君"
    const m = db.prepare('SELECT name FROM company_members WHERE phone = ? AND deleted = 0').get(u.phone);
    if (m && m.name) names.add(m.name);
  } catch {}
  return { isAdmin: !!u.is_administrator, names: [...names] };
}

// 我的/全部预算列表（/budget/mine/budget/list/ 与 /budget/list/ 同构：{budgets,total_num}）
// isMine=true（我的预算）时普通成员只返回本人预算；/budget/list/（全部）不受限
function queryBudgetList(body, headers, isMine) {
  ensureLocalBudgetsMerged();
  const scope = currentUserBudgetScope(headers);
  let where = 'deleted = 0';
  const params = [];
  if (body && body.crm_id) { where += ' AND crm_id = ?'; params.push(Number(body.crm_id)); }
  if (body && body.name) { where += ' AND name LIKE ?'; params.push('%' + String(body.name) + '%'); }
  let rows = db.prepare('SELECT * FROM budgets WHERE ' + where + ' ORDER BY budget_id DESC').all(...params);
  if (isMine && !scope.isAdmin) {
    // 迁移预算无 create_user_name，用 my_budget_crm_list 快照的 budget_id → designer_name 映射归属
    let map = {};
    try {
      const g = budgetGlobal('my_budget_crm_list')();
      const items = (g && g.data && g.data.budget_crms) || [];
      for (const x of items) if (x.budget_id) map[Number(x.budget_id)] = String(x.designer_name || '');
    } catch {}
    rows = rows.filter((r) => {
      const d = map[Number(r.budget_id)];
      return (d && scope.names.includes(d)) || scope.names.includes(String(r.create_user_name || ''));
    });
  }
  return { code: 0, msg: '成功', data: { budgets: rows.map(buildBudgetItem), total_num: rows.length } };
}

// 预算详情：detail_json 优先；本地预算按 payload 构造；无记录返回 null（回退代理）
function getBudgetDetail(bid) {
  ensureLocalBudgetsMerged();
  const row = db.prepare('SELECT * FROM budgets WHERE budget_id = ? AND deleted = 0').get(Number(bid));
  if (!row) {
    const local = localGet('budget', bid);
    if (local) return localBudgetDetail(local);
    return null;
  }
  try {
    const dj = JSON.parse(row.detail_json || '{}');
    if (dj && Object.keys(dj).length > 0) return dj;
  } catch {}
  const local = localGet('budget', bid);
  if (local) return localBudgetDetail(local);
  // 迁移时未拉到详情：按列表行构造最小同构结构
  return { budget_id: Number(row.budget_id), name: row.name, crm_id: Number(row.crm_id || 0), project_id: Number(row.project_id || 0),
    contract_price: row.contract_price, gift: '0', selected: row.selected, status: row.status,
    crm_budgets: [], areas: [], extra_items: [], manage_fee_info: { rate: '0', total_amount: '0', description: '' }, tax_fee_info: { rate: '0', total_amount: '0', description: '' } };
}

// 预算子资源读取（kind 对应 budget_payloads 分类）；未迁移返回 null（回退代理）
function budgetPayload(kind) {
  return ({ body }) => {
    const bid = body && (body.budget_id || body.id);
    if (!bid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT payload FROM budget_payloads WHERE budget_id = ? AND kind = ?').get(Number(bid), kind);
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  };
}

// 预算公司级全局数据读取（kind 对应 budget_globals 分类）；缺失返回 null（回退代理）
function budgetGlobal(kind) {
  return () => {
    const row = db.prepare('SELECT payload FROM budget_globals WHERE kind = ?').get(kind);
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  };
}

// 按客户预算列表（/budget/app/company/budget/crm/list/ 与 /budget/app/budget/crm/list/ 同构）：
// 迁移快照 + 本地预算按 crm_id 归并（已有客户条目则累加 budget_num，否则补一条最小条目）。
// my_budget_crm_list（我的预算）与 budget_crm_list（预算汇总）都按当前用户过滤：
// 管理员看全量，普通成员只看本人（designer_name/main_designer_name 命中本人姓名）。
function queryBudgetCrmList(kind, headers) {
  ensureLocalBudgetsMerged();
  const scope = currentUserBudgetScope(headers);
  const g = budgetGlobal(kind)();
  let list = g ? ((g.data && g.data.budget_crms) || []) : [];
  if (!scope.isAdmin) {
    const mine = scope.names.filter((n) => n && n !== '未设定');
    if (mine.length) {
      list = list.filter((x) => mine.includes(String(x.designer_name || x.main_designer_name || '')));
    } else {
      list = [];
    }
  }
  const localBudgets = db.prepare('SELECT * FROM budgets WHERE deleted = 0 AND is_local = 1').all();
  for (const r of localBudgets) {
    const crmId = Number(r.crm_id || 0);
    if (!crmId) continue;
    if (!scope.isAdmin) {
      // 我的预算视图：只合并本人创建的本地预算，避免把别人的预算带进来
      const owner = String(r.create_user_name || '');
      if (!owner || !scope.names.includes(owner)) continue;
    }
    const hit = list.find((x) => Number(x.crm_id) === crmId);
    if (hit) {
      hit.budget_num = Number(hit.budget_num || 0) + 1;
      if (!hit.budget_id) hit.budget_id = Number(r.budget_id);
    } else {
      list.unshift({
        budget_id: Number(r.budget_id), crm_id: crmId, customer_name: r.name || '本地客户', customer_gender: 0,
        address: '', crm_status: 31, source: 0, source_name: '', other_content: '', room_size: '0',
        room_area: '0', total_sale: '0', other_rate: '0', budget_num: 1, intended_num: 0, completed_num: 0, aborted_num: 0,
        designer_name: scope.isAdmin ? '' : String(r.create_user_name || '')
      });
    }
  }
  return { code: 0, msg: '成功', data: { ...((g && g.data) || {}), budget_crms: list, total_num: list.length } };
}

// ================ 合同模块读接口本地化（模式 A：本地 SQLite 为唯一权威，前端零改动） ================

// 增量归并 local_records 本地合同 → contracts（本地新建合同即时可见）
function ensureLocalContractsMerged() {
  const rows = db.prepare("SELECT * FROM local_records WHERE entity = 'contract'").all();
  let merged = 0, deleted = 0;
  for (const row of rows) {
    const cid = Number(row.record_id);
    if (row.deleted) {
      db.prepare('UPDATE contracts SET deleted = 1, updated_at = ? WHERE contract_id = ?').run(dbNow(), cid);
      deleted++;
      continue;
    }
    if (db.prepare('SELECT contract_id FROM contracts WHERE contract_id = ?').get(cid)) continue;
    let p = {};
    try { p = JSON.parse(row.payload || '{}'); } catch {}
    if (!p || typeof p !== 'object') p = {}; // 异常 payload（null/数组/数字/坏JSON）兜底，避免属性访问崩溃
    db.prepare(`INSERT OR IGNORE INTO contracts (contract_id, crm_id, contract_type, contract_name, contract_title, contact_name, sort_order, has_read, update_time, list_json, is_local, deleted, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,0,?,?)`)
      .run(cid, Number(p.crm_id || 0), Number(p.contract_type || 0), p.contract_name || p.contract_title || '新合同', p.contract_title || p.contract_name || '新合同',
        p.contact_name || '', Number(p.order || 0), Number(p.has_read || 0), p.update_time || '',
        JSON.stringify(p), dbNow(), dbNow());
    merged++;
  }
  if (merged || deleted) logger.info('合同归并', '本地合同增量归并', { merged, deleted, total: rows.length });
}

// 合同列表项（list_json 原样 + 列兜底：异常 payload 归并的合同 list_json 为空，用列字段补名）
function buildContractItem(row) {
  let lj = {};
  try { lj = JSON.parse(row.list_json || '{}'); } catch {}
  if (!lj || typeof lj !== 'object') lj = {}; // list_json=null/数字 兜底，避免 lj.order 崩溃
  return {
    ...lj,
    contract_id: Number(row.contract_id),
    contract_name: lj.contract_name !== undefined ? lj.contract_name : (row.contract_name || ''),
    contract_title: lj.contract_title !== undefined ? lj.contract_title : (row.contract_title || ''),
    order: lj.order !== undefined ? lj.order : row.sort_order
  };
}

// 构造巡检列表项（list_json 原样优先，无则列字段构造同构结构）
function buildInspectionItem(row) {
  const lj = parseJson(row.list_json, {});
  if (lj && typeof lj === 'object' && lj.id !== undefined) {
    return { ...lj, status: lj.status !== undefined ? Number(lj.status) : Number(row.status) };
  }
  return {
    id: Number(row.id),
    project_name: row.project_name || '',
    create_user_name: row.create_user_name || '',
    inspection_content: row.inspection_content || '',
    inspection_files: [],
    handle_content: row.handle_content || '',
    handle_files: [],
    create_time: row.create_time || '',
    deadline: row.deadline || '',
    status: Number(row.status || 0)
  };
}

// 巡检新记录 id：9 亿号段，跨巡检递增（本地权威新建，与云端 id 不冲突）
function nextInspectionId() {
  const row = db.prepare('SELECT MAX(id) AS m FROM inspections WHERE id >= 900000000').get();
  return Math.max(900000001, (row && row.m ? Number(row.m) : 900000000) + 1);
}

// ---------------- 项目子资源写辅助（tasks/areas 统一操作 project_payloads；本地项目同步 local_records） ----------------
// 读取/更新项目子资源 payload（不存在则初始化默认结构），调用 fn 修改后写回
function updateProjectSub(pid, kind, fn) {
  const defaults = { tasks: { show_edit_button: 1, show_create_button: 1, show_array_id: 0, task_num: 0, tasks: [] }, areas: { areas: [] }, todos: { total_num: 0, todos: [], create_button: 1 }, weekly_plans: { total_num: 0, weekly_planes: [] } }[kind] || {};
  const row = db.prepare('SELECT payload FROM project_payloads WHERE project_id = ? AND kind = ?').get(Number(pid), kind);
  let data = row ? parseJson(row.payload, null) : null;
  if (!data || typeof data !== 'object') data = JSON.parse(JSON.stringify(defaults));
  fn(data);
  db.prepare('INSERT INTO project_payloads (project_id, kind, payload, updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .run(Number(pid), kind, JSON.stringify(data), dbNow());
  // 本地项目同步 local_records（保证本地权威完整对象一致）
  const proj = db.prepare('SELECT is_local FROM projects WHERE project_id = ?').get(Number(pid));
  if (proj && proj.is_local) {
    const lr = localGet('project', pid);
    if (lr) localUpsert('project', pid, { ...lr.payload, [kind]: data });
  }
}

// 生成子资源 id（9 亿号段，跨 tasks/areas 递增，避免与云端 id 冲突）
function nextLocalSubId(kind, idField) {
  const rows = db.prepare('SELECT payload FROM project_payloads WHERE kind = ?').all(kind);
  let m = 900000000;
  const scan = (d, k) => {
    if (!d || typeof d !== 'object') return;
    const arr = d[k] || d.tasks || d.areas;
    if (Array.isArray(arr)) for (const it of arr) m = Math.max(m, Number(it[idField]) || 0);
  };
  for (const r of rows) { try { scan(JSON.parse(r.payload), kind); } catch {} }
  const lrs = db.prepare("SELECT payload FROM local_records WHERE entity = 'project'").all();
  for (const r of lrs) { try { const p = JSON.parse(r.payload); scan(p.tasks, 'tasks'); scan(p.areas, 'areas'); } catch {} }
  return m + 1;
}

// 按任务 id 查找所属项目
function findProjectByTask(taskId) {
  const rows = db.prepare("SELECT project_id, payload FROM project_payloads WHERE kind = 'tasks'").all();
  for (const r of rows) {
    try {
      const d = JSON.parse(r.payload);
      if ((d.tasks || []).some((t) => Number(t.project_task_id) === Number(taskId))) return { project_id: r.project_id };
    } catch {}
  }
  const lrs = db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'project'").all();
  for (const r of lrs) {
    try {
      const p = JSON.parse(r.payload);
      if ((p.tasks || []).some((t) => Number(t.project_task_id) === Number(taskId))) return { project_id: r.record_id };
    } catch {}
  }
  return null;
}

// 按区域 id 查找所属项目
function findProjectByArea(areaId) {
  const rows = db.prepare("SELECT project_id, payload FROM project_payloads WHERE kind = 'areas'").all();
  for (const r of rows) {
    try {
      const d = JSON.parse(r.payload);
      if ((d.areas || []).some((a) => Number(a.area_id) === Number(areaId))) return { project_id: r.project_id };
    } catch {}
  }
  const lrs = db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'project'").all();
  for (const r of lrs) {
    try {
      const p = JSON.parse(r.payload);
      if ((p.areas || []).some((a) => Number(a.area_id) === Number(areaId))) return { project_id: r.record_id };
    } catch {}
  }
  return null;
}

// 任务保存/编辑/状态类操作：按 project_task_id 合并字段，不存在返回 null
function saveProjectTask(body) {
  const taskId = body && (body.project_task_id || body.task_id || body.id);
  if (!taskId) return { code: 10011, msg: '参数错误', data: {} };
  const proj = findProjectByTask(taskId);
  if (!proj) { logger.warn('项目写接口', '任务保存未命中', { task_id: taskId }); return { code: 10828, msg: '项目任务状态映射记录不存在', data: {} }; }
  let found = false;
  updateProjectSub(proj.project_id, 'tasks', (d) => {
    for (const t of d.tasks) {
      if (Number(t.project_task_id) === Number(taskId)) {
        Object.assign(t, body);
        t.project_task_id = Number(taskId); // 防止 body 中 id 字段污染
        found = true;
      }
    }
  });
  if (!found) return { code: 10828, msg: '项目任务状态映射记录不存在', data: {} };
  logger.info('项目写接口', '任务保存落库', { project_id: Number(proj.project_id), task_id: Number(taskId), fields: Object.keys(body) });
  return { code: 0, msg: '成功', data: {} };
}

// ---------------- 项目模块扩展写辅助（todo/周计划/角色成员，统一操作 project_payloads / project_globals） ----------------
// 生成子资源 id（9 亿号段，按 kind 扫描 project_payloads + 本地项目 local_records 递增）
function nextProjectPayloadId(kind, arrKey, idField) {
  let m = 900000000;
  const scan = (d, k, key) => {
    if (!d || typeof d !== 'object') return;
    let arr = d[key];
    if (Array.isArray(arr)) for (const it of arr) m = Math.max(m, Number(it[idField]) || 0);
  };
  const rows = db.prepare('SELECT payload FROM project_payloads WHERE kind = ?').all(kind);
  for (const r of rows) { try { scan(JSON.parse(r.payload), kind, arrKey); } catch {} }
  const lrs = db.prepare("SELECT payload FROM local_records WHERE entity = 'project'").all();
  for (const r of lrs) {
    try {
      const p = JSON.parse(r.payload);
      const d = p[kind] || {};
      scan(d, kind, arrKey);
    } catch {}
  }
  return m + 1;
}

// 按子资源 id 查找所属项目与对象（遍历 project_payloads + local_records），返回 {project_id, item} 或 null
function findProjectPayloadItem(kind, arrKey, idField, id) {
  const find = (arr) => (Array.isArray(arr) ? arr.find((it) => Number(it[idField]) === Number(id)) : undefined);
  const rows = db.prepare('SELECT project_id, payload FROM project_payloads WHERE kind = ?').all(kind);
  for (const r of rows) {
    try {
      const d = JSON.parse(r.payload);
      const item = find(d[arrKey]);
      if (item) return { project_id: r.project_id, item };
    } catch {}
  }
  const lrs = db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'project'").all();
  for (const r of lrs) {
    try {
      const p = JSON.parse(r.payload);
      const d = p[kind] || {};
      const item = find(d[arrKey]);
      if (item) return { project_id: r.record_id, item };
    } catch {}
  }
  return null;
}

// 待办提交/重提/审核：按 todo_id 合并 body（status 等字段透传），未命中 10032
function updateProjectTodo(body, action) {
  const todoId = body && (body.todo_id || body.id);
  if (!todoId) return { code: 10011, msg: '参数错误', data: {} };
  const hit = findProjectPayloadItem('todos', 'todos', 'todo_id', todoId);
  if (!hit) { logger.warn('项目写接口', '待办' + action + '未命中', { todo_id: todoId }); return { code: 10032, msg: '数据不存在', data: {} }; }
  let found = false;
  updateProjectSub(hit.project_id, 'todos', (d) => {
    if (!Array.isArray(d.todos)) d.todos = [];
    for (const t of d.todos) {
      if (Number(t.todo_id) === Number(todoId)) {
        Object.assign(t, body);
        t.todo_id = Number(todoId); // 防止 body 中 id 字段污染
        found = true;
      }
    }
  });
  if (!found) return { code: 10032, msg: '数据不存在', data: {} };
  logger.info('项目写接口', '待办' + action + '落库', { project_id: Number(hit.project_id), todo_id: Number(todoId), fields: Object.keys(body) });
  return { code: 0, msg: '成功', data: {} };
}

// 项目角色成员增删：更新公司级快照 project_globals kind=project_role_members 的 roles[].members
function updateProjectRoleMember(body, isAdd) {
  const roleId = body && (body.role_id || body.roleId);
  const user = body && (body.user_id || body.userId);
  if (!roleId || user === undefined || user === null) return { code: 10011, msg: '参数错误', data: {} };
  const row = db.prepare('SELECT payload FROM project_globals WHERE kind = ?').get('project_role_members');
  const data = row ? parseJson(row.payload, null) : null;
  const roles = (data && Array.isArray(data.roles)) ? data.roles : [];
  const role = roles.find((r) => Number(r.role_id) === Number(roleId));
  if (!role) return { code: 10032, msg: '数据不存在', data: {} };
  if (!Array.isArray(role.members)) role.members = [];
  if (isAdd) {
    if (!role.members.some((m) => Number(m.user_id) === Number(user))) {
      role.members.push({ user_id: Number(user), name: body.name || '', user_accid: body.user_accid || '', user_avatar: body.user_avatar || '' });
    }
  } else {
    role.members = role.members.filter((m) => Number(m.user_id) !== Number(user));
  }
  db.prepare('INSERT INTO project_globals (kind, payload, updated_at) VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .run('project_role_members', JSON.stringify({ roles }), dbNow());
  logger.info('项目写接口', isAdd ? '角色成员新增落库' : '角色成员删除落库', { role_id: Number(roleId), user_id: Number(user) });
  return { code: 0, msg: '成功', data: {} };
}

// ---------------- 预算子资源写接口辅助（区域/明细项/附加项/汇总项，落 budget.detail_json） ----------------
// 读取预算完整对象（detail_json 优先，本地预算回退 local_records payload）；不存在返回 null
function getBudgetDetailObj(bid) {
  const row = db.prepare('SELECT * FROM budgets WHERE budget_id = ?').get(Number(bid));
  if (row) {
    const dj = parseJson(row.detail_json, null);
    if (dj && typeof dj === 'object' && Object.keys(dj).length) return { row, budget_id: Number(bid), detail: dj };
  }
  const lr = localGet('budget', bid);
  if (lr && lr.payload && typeof lr.payload === 'object' && Object.keys(lr.payload).length) return { row: row || null, budget_id: Number(bid), detail: lr.payload };
  return null;
}

// 保存预算完整对象回 detail_json + 同步本地记录（本地权威完整对象一致）
function saveBudgetDetail(bid, detail) {
  const nid = Number(bid);
  const row = db.prepare('SELECT * FROM budgets WHERE budget_id = ?').get(nid);
  const dj = JSON.stringify(detail);
  if (row) {
    db.prepare('UPDATE budgets SET detail_json = ?, area_num = ?, updated_at = ? WHERE budget_id = ?')
      .run(dj, (detail.areas || []).length, dbNow(), nid);
    if (row.is_local) {
      const lr = localGet('budget', nid);
      if (lr) localUpsert('budget', nid, { ...lr.payload, ...detail });
    }
    return true;
  }
  const lr = localGet('budget', nid);
  if (lr) { localUpsert('budget', nid, { ...lr.payload, ...detail }); return true; }
  return false;
}

// 提交审核/撤销审核/审核：更新预算 status（budgets 行 + detail_json.crm_budgets 按钮 + 本地记录）
// 语义：0=草稿（可发起审核）1=待审核（可撤销）2=已审核（审核人可见）
function updateBudgetStatus(body, status, action) {
  const bid = body && body.budget_id;
  if (!bid) return { code: 10011, msg: '参数错误', data: {} };
  const row = db.prepare('SELECT * FROM budgets WHERE budget_id = ?').get(Number(bid));
  const lr = localGet('budget', bid);
  if (!row && !lr) return { code: 20029, msg: '预算不存在', data: {} };
  if (row) {
    db.prepare('UPDATE budgets SET status = ?, updated_at = ? WHERE budget_id = ?').run(status, dbNow(), Number(bid));
    const dj = parseJson(row.detail_json, null);
    if (dj && typeof dj === 'object') {
      for (const c of (dj.crm_budgets || [])) {
        if (Number(c.id) === Number(bid)) {
          c.status = status;
          c.commit_button = status === 0 ? 1 : 0;
          c.cancel_review_button = status === 1 ? 1 : 0;
          c.review_button = status === 2 ? 1 : 0;
        }
      }
      db.prepare('UPDATE budgets SET detail_json = ? WHERE budget_id = ?').run(JSON.stringify(dj), Number(bid));
    }
  }
  if (lr) localUpsert('budget', bid, { ...lr.payload, status });
  logger.info('预算写接口', action + '落库', { budget_id: Number(bid), status });
  return { code: 0, msg: '成功', data: {} };
}

// 公司级设置宽容落库（审核规则/审核人设置/分析设置共用；isDel 时移除 body 中字段）
function setBudgetGlobalAny(kind, body, isDel) {
  const row = db.prepare('SELECT payload FROM budget_globals WHERE kind = ?').get(kind);
  const d = row ? parseJson(row.payload, {}) : {};
  if (!d || typeof d !== 'object') d = {};
  if (isDel) { for (const k of Object.keys(body || {})) delete d[k]; }
  else Object.assign(d, body || {});
  db.prepare('INSERT INTO budget_globals (kind, payload, updated_at) VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .run(kind, JSON.stringify(d), dbNow());
  logger.info('预算写接口', '公司级设置落库', { kind, fields: Object.keys(body || {}) });
  return { code: 0, msg: '成功', data: {} };
}

// 预算子资源 id（9 亿号段，跨区域/明细/附加/汇总递增，避免与云端 id 冲突）
function nextBudgetSubId() {
  let m = 900000000;
  const scan = (d) => {
    if (!d || typeof d !== 'object') return;
    for (const a of d.areas || []) {
      m = Math.max(m, Number(a.id) || 0);
      for (const it of a.area_items || []) m = Math.max(m, Number(it.id) || 0);
    }
    for (const e of d.extra_items || []) m = Math.max(m, Number(e.id) || 0);
    for (const s of d.summary_list || []) m = Math.max(m, Number(s.id) || 0);
  };
  for (const r of db.prepare('SELECT detail_json FROM budgets').all()) scan(parseJson(r.detail_json, null));
  for (const r of db.prepare("SELECT payload FROM local_records WHERE entity = 'budget'").all()) scan(parseJson(r.payload, null));
  return m + 1;
}

// 按区域 id 反查所属预算（返回 {budget_id, detail, area_index}）
function findBudgetByArea(areaId) {
  for (const r of db.prepare('SELECT budget_id, detail_json FROM budgets').all()) {
    const d = parseJson(r.detail_json, null);
    if (!d || !Array.isArray(d.areas)) continue;
    const idx = d.areas.findIndex((a) => Number(a.id) === Number(areaId));
    if (idx >= 0) return { budget_id: r.budget_id, detail: d, area_index: idx };
  }
  for (const r of db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'budget'").all()) {
    const d = parseJson(r.payload, null);
    if (!d || !Array.isArray(d.areas)) continue;
    const idx = d.areas.findIndex((a) => Number(a.id) === Number(areaId));
    if (idx >= 0) return { budget_id: r.record_id, detail: d, area_index: idx };
  }
  return null;
}

// 按明细项 id 反查所属预算（返回 {budget_id, detail, area_index, item_index}）
function findBudgetByItem(itemId) {
  for (const r of db.prepare('SELECT budget_id, detail_json FROM budgets').all()) {
    const d = parseJson(r.detail_json, null);
    if (!d || !Array.isArray(d.areas)) continue;
    for (let i = 0; i < d.areas.length; i++) {
      const j = (d.areas[i].area_items || []).findIndex((it) => Number(it.id) === Number(itemId));
      if (j >= 0) return { budget_id: r.budget_id, detail: d, area_index: i, item_index: j };
    }
  }
  for (const r of db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'budget'").all()) {
    const d = parseJson(r.payload, null);
    if (!d || !Array.isArray(d.areas)) continue;
    for (let i = 0; i < d.areas.length; i++) {
      const j = (d.areas[i].area_items || []).findIndex((it) => Number(it.id) === Number(itemId));
      if (j >= 0) return { budget_id: r.record_id, detail: d, area_index: i, item_index: j };
    }
  }
  return null;
}

// 按附加项 id 反查所属预算（返回 {budget_id, detail, extra_index}）
function findBudgetByExtra(extraId) {
  for (const r of db.prepare('SELECT budget_id, detail_json FROM budgets').all()) {
    const d = parseJson(r.detail_json, null);
    if (!d || !Array.isArray(d.extra_items)) continue;
    const idx = d.extra_items.findIndex((e) => Number(e.id) === Number(extraId));
    if (idx >= 0) return { budget_id: r.budget_id, detail: d, extra_index: idx };
  }
  for (const r of db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'budget'").all()) {
    const d = parseJson(r.payload, null);
    if (!d || !Array.isArray(d.extra_items)) continue;
    const idx = d.extra_items.findIndex((e) => Number(e.id) === Number(extraId));
    if (idx >= 0) return { budget_id: r.record_id, detail: d, extra_index: idx };
  }
  return null;
}

// 写操作日志（撤销用）：返回 random_key
function logBudgetOp(budgetId, action, payload) {
  const key = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO budget_ops (random_key, budget_id, action, payload, created_at) VALUES (?,?,?,?,?)')
    .run(key, Number(budgetId || 0), action, JSON.stringify(payload || {}), dbNow());
  return key;
}

// 撤销操作：add=删新增项 / del·batch_del=还原被删项 / copy=删复制项 / replace=还原原项
function undoBudgetOp(key) {
  const op = db.prepare('SELECT * FROM budget_ops WHERE random_key = ?').get(key);
  if (!op) { logger.warn('预算写接口', '撤销未命中操作日志', { random_key: key }); return false; }
  const p = parseJson(op.payload, {});
  const ok = (() => {
    if (op.action === 'add' || op.action === 'copy') {
      const ids = p.item_ids || [];
      const hit = findBudgetByArea(p.area_id || p.dest_area_id);
      if (!hit) return false;
      hit.detail.areas[hit.area_index].area_items = (hit.detail.areas[hit.area_index].area_items || [])
        .filter((it) => !ids.some((x) => Number(x) === Number(it.id)));
      return saveBudgetDetail(hit.budget_id, hit.detail);
    }
    if (op.action === 'del' || op.action === 'batch_del') {
      const items = p.items || [];
      // 优先按 budget_id 还原（记录 area_index，跨区域安全）
      if (p.budget_id) {
        const hit = getBudgetDetailObj(p.budget_id);
        if (!hit) return false;
        for (const it of items) {
          const ai = it && it.area_index !== undefined && hit.detail.areas[it.area_index] ? it.area_index : null;
          if (ai !== null) hit.detail.areas[ai].area_items.push(it.item);
          else if (it && it.area_id) {
            const fi = findBudgetByArea(it.area_id);
            if (fi) fi.detail.areas[fi.area_index].area_items.push(it.item);
          }
        }
        return saveBudgetDetail(hit.budget_id, hit.detail);
      }
      const hit = findBudgetByArea(p.area_id);
      if (!hit) return false;
      const list = hit.detail.areas[hit.area_index].area_items || [];
      for (const it of items) list.push(it); // 追加到末尾（order 由前端二次排序）
      hit.detail.areas[hit.area_index].area_items = list;
      return saveBudgetDetail(hit.budget_id, hit.detail);
    }
    if (op.action === 'replace') {
      const hit = findBudgetByItem(p.item_id);
      if (!hit) return false;
      hit.detail.areas[hit.area_index].area_items[hit.item_index] = p.original_item;
      return saveBudgetDetail(hit.budget_id, hit.detail);
    }
    if (op.action === 'edit') {
      const hit = findBudgetByItem(p.item_id);
      if (!hit) return false;
      hit.detail.areas[hit.area_index].area_items[hit.item_index] = { ...hit.detail.areas[hit.area_index].area_items[hit.item_index], ...p.restore_fields };
      return saveBudgetDetail(hit.budget_id, hit.detail);
    }
    return false;
  })();
  if (ok) db.prepare('DELETE FROM budget_ops WHERE random_key = ?').run(key);
  return ok;
}

// 默认明细项结构（与迁移数据对齐，缺失字段给默认值）
function defaultAreaItemFields() {
  return {
    order: 0, type: 1, type_name: '', name: '', material_id: 0, material_nick_name: '', band: '', model: '',
    description: '', specification_name: '', main_material_sale_price: '0', assist_material_sale_price: '0',
    worker_sale_price: '0', main_material_cost_price: '0', assist_material_cost_price: '0', worker_cost_price: '0',
    unit: '', length: '0', width: '0', depth: '0', budget_num: '1', real_num: '1', change_num: '0',
    loss_rate: '0', increase_decrease_price: '0', all_cost: '0', all_sale: '0', single_price: '0',
    formula_list: [], modify: 0, mark: 0, item_name: '', brand_name: '', material_sale_price: '0',
    total_sale_price: '0', custom_field_info: {}, file_info: { id: 0, type: 0, name: '', url: '', origin_url: '' }
  };
}

// 由材料库条目构造明细项（addAreaItem material_ids 用）
function buildAreaItemFromMaterial(m, order) {
  const it = defaultAreaItemFields();
  it.order = order; it.type = 1; it.type_name = m.band || '';
  it.name = m.name || ''; it.material_id = Number(m.id || 0); it.band = m.band || ''; it.model = m.model || '';
  it.description = m.description || ''; it.specification_name = m.specification || '';
  it.main_material_sale_price = String(m.sale_price || '0'); it.worker_sale_price = '0';
  it.main_material_cost_price = String(m.cost_price || '0'); it.worker_cost_price = '0';
  it.unit = m.sale_unit || m.cost_unit || ''; it.loss_rate = String(m.loss_rate || '0');
  it.all_cost = String(m.cost_price || '0'); it.all_sale = String(m.sale_price || '0');
  it.single_price = String(m.sale_price || '0'); it.item_name = it.name; it.brand_name = it.band;
  it.material_sale_price = it.main_material_sale_price; it.total_sale_price = it.main_material_sale_price;
  it.id = nextBudgetSubId();
  return it;
}

// 由规范/定额条目构造明细项（addAreaItem specification_ids 用；规范存 budget_globals kind=specification）
function buildAreaItemFromSpec(sp, order) {
  const it = defaultAreaItemFields();
  it.order = order; it.type = 0; it.type_name = '';
  it.name = sp.name || ''; it.description = sp.description || ''; it.specification_name = '';
  it.main_material_sale_price = String(sp.main_material_sale_price || '0');
  it.assist_material_sale_price = String(sp.assist_material_sale_price || '0');
  it.worker_sale_price = String(sp.worker_sale_price || '0');
  it.main_material_cost_price = String(sp.main_material_cost_price || '0');
  it.assist_material_cost_price = String(sp.assist_material_cost_price || '0');
  it.worker_cost_price = String(sp.worker_cost_price || '0');
  it.unit = sp.unit || ''; it.loss_rate = String(sp.loss_rate || '0');
  const sum = (Number(it.main_material_sale_price) + Number(it.assist_material_sale_price) + Number(it.worker_sale_price)).toFixed(2);
  const sumCost = (Number(it.main_material_cost_price) + Number(it.assist_material_cost_price) + Number(it.worker_cost_price)).toFixed(2);
  it.all_cost = sumCost; it.all_sale = sum; it.single_price = sum; it.total_sale_price = sum;
  it.item_name = it.name; it.id = nextBudgetSubId();
  return it;
}

// 大写金额转换（人民币，标准算法：亿/万/元 分段 + 角/分）
function rmbUpper(num) {
  const n = Math.round(Number(num || 0) * 100);
  if (n === 0) return '零元整';
  const neg = n < 0;
  const v = Math.abs(n);
  const intPart = Math.floor(v / 100);
  const frac = v % 100;
  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const groupToCn = (g) => { // 0-9999
    if (g === 0) return '';
    const units = ['', '拾', '佰', '仟'];
    let s = '';
    const str = String(g);
    for (let i = 0; i < str.length; i++) {
      const d = Number(str[i]);
      if (d === 0) { if (s && !s.endsWith('零')) s += '零'; }
      else s += digits[d] + units[str.length - 1 - i];
    }
    return s.replace(/零+$/, '');
  };
  const yi = Math.floor(intPart / 1e8);
  const wan = Math.floor((intPart % 1e8) / 1e4);
  const ge = intPart % 1e4;
  let intCn = '';
  if (yi) {
    intCn += groupToCn(yi) + '亿';
    if (wan === 0 && ge !== 0) intCn += '零';
  }
  if (wan) {
    intCn += groupToCn(wan) + '万';
    if (ge !== 0 && ge < 1000) intCn += '零';
  } else if (yi && ge !== 0 && intPart % 1e8 >= 1000) {
    intCn += '零';
  }
  if (ge) intCn += groupToCn(ge);
  if (!intCn) intCn = '零';
  const jiao = Math.floor(frac / 10);
  const fen = frac % 10;
  let fracCn = '';
  if (jiao) fracCn += digits[jiao] + '角';
  if (fen) fracCn += digits[fen] + '分';
  if (!fracCn) fracCn = '整';
  return (neg ? '负' : '') + intCn + '元' + fracCn;
}

// 预算汇总计算（与云端公式对齐：主材=type1/3 主材价；辅材=其余项主材+全部辅材；人工=全部人工）
function calcBudgetSummary(detail) {
  const areas = detail.areas || [];
  let main = 0, assist = 0, worker = 0;
  const areaSet = new Set();
  for (const area of areas) {
    const items = area.area_items || [];
    if (items.length) areaSet.add(Number(area.id));
    for (const it of items) {
      const num = Number(it.budget_num !== undefined && it.budget_num !== '' ? it.budget_num : (it.real_num || 0));
      const t = Number(it.type);
      const m = Number(it.main_material_sale_price || 0) * num;
      const a = Number(it.assist_material_sale_price || 0) * num;
      const w = Number(it.worker_sale_price || 0) * num;
      if (t === 1 || t === 3) { main += m; assist += a; }
      else { assist += m + a; worker += w; }
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  main = r2(main); assist = r2(assist); worker = r2(worker);
  const noTax = r2(main + assist + worker);
  const manageRate = Number((detail.manage_fee_info && detail.manage_fee_info.rate) || 0);
  const taxRate = Number((detail.tax_fee_info && detail.tax_fee_info.rate) || 0);
  const manage = r2(noTax * manageRate / 100);
  const tax = r2((noTax + manage) * taxRate / 100);
  const total = r2(noTax + manage + tax);
  const order = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const rows = [
    { id: 0, order: order[0], name: '主材费', description: '1.关联范围: 主材; 2.关联空间: ' + areaSet.size + '个; 3.费用比例: 100%', total_price: String(main), can_edit: 1, is_bold: 0 },
    { id: 0, order: order[1], name: '辅材费', description: '1.关联范围: 辅材; 2.关联空间: ' + areaSet.size + '个; 3.费用比例: 100%', total_price: String(assist), can_edit: 1, is_bold: 0 },
    { id: 0, order: order[2], name: '人工费', description: '1.关联范围: 人工; 2.关联空间: ' + areaSet.size + '个; 3.费用比例: 100%', total_price: String(worker), can_edit: 1, is_bold: 0 },
    { id: 0, order: order[3], name: '不含税造价', description: '一+二+三', total_price: String(noTax), can_edit: 0, is_bold: 1 },
    { id: 0, order: order[4], name: '综合项', description: '', total_price: '0', can_edit: 0, is_bold: 0 },
    { id: 0, order: order[5], name: '管理费', description: '四 * 管理费率' + manageRate + '%', total_price: String(manage), can_edit: 0, is_bold: 0 },
    { id: 0, order: order[6], name: '税金', description: '(四+五+六) * 税率' + taxRate + '%', total_price: String(tax), can_edit: 0, is_bold: 0 },
    { id: 0, order: order[7], name: '工程总造价', description: '四+五+六+七', total_price: String(total), can_edit: 0, is_bold: 1 },
    { id: 0, order: order[8], name: '大写(人民币)', description: rmbUpper(total), total_price: String(total), can_edit: 0, is_bold: 1 }
  ];
  // 追加本地自定义汇总项（budget_payloads kind=summary_item 的 custom 数组）
  const prow = db.prepare('SELECT payload FROM budget_payloads WHERE budget_id = ? AND kind = ?').get(Number(detail.budget_id), 'summary_item');
  const custom = prow ? (parseJson(prow.payload, {}).custom || []) : [];
  return rows.concat(custom);
}

// 按客户合同列表（/finance/contract/list/ 同构：{show_history_button, contracts}）
function queryContractList(body) {
  ensureLocalContractsMerged();
  const crmId = body && (body.crm_id || body.cid);
  if (!crmId) return { code: 13001, msg: 'CRM不存在', data: {} };
  const rows = db.prepare('SELECT * FROM contracts WHERE crm_id = ? AND deleted = 0 ORDER BY sort_order ASC, contract_id ASC').all(Number(crmId));
  return { code: 0, msg: '成功', data: { show_history_button: 0, contracts: rows.map(buildContractItem) } };
}

// 合同子资源读取（kind 对应 contract_payloads 分类）；未迁移返回 null（回退代理）
function contractPayload(kind) {
  return ({ body }) => {
    const cid = body && (body.contract_id || body.id);
    if (!cid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT payload FROM contract_payloads WHERE contract_id = ? AND kind = ?').get(Number(cid), kind);
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  };
}

// 合同公司级全局数据读取（kind 对应 contract_globals 分类）；缺失返回 null（回退代理）
function contractGlobal(kind) {
  return () => {
    const row = db.prepare('SELECT payload FROM contract_globals WHERE kind = ?').get(kind);
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  };
}

// ---------------- 财务模块辅助（收款/请款，公司级快照 + 请款宽容落库 finance_globals） ----------------
function financeGlobal(kind) {
  return () => {
    const row = db.prepare('SELECT payload FROM finance_globals WHERE kind = ?').get(kind);
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  };
}

// 财务收款客户列表快照（/finance/list/ 原站结构，抓取自云端真实接口）
let _financeListSnap = null;
function financeListSnapshot() {
  if (_financeListSnap) return _financeListSnap;
  _financeListSnap = { items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'finance_list_snapshot.json'), 'utf8'));
    if (Array.isArray(parsed)) _financeListSnap = { items: parsed };
    else {
      _financeListSnap = parsed;
      if (!Array.isArray(_financeListSnap.items)) _financeListSnap.items = [];
    }
  } catch (e) { _financeListSnap = { items: [] }; }
  return _financeListSnap;
}

// 收款客户列表（原站 /finance/list/）：{following_num, completed_num, aborted_num, items}
// 快照 items 自带 status（0=跟进中 1=已完成 2=已中止）；请求 status=-1/缺省返回全部
function financeListHandler({ body }) {
  const b = body || {};
  const snap = financeListSnapshot();
  let all = snap.items || [];
  // 本地删除（del_finance）的客户从列表移除
  const delIds = new Set(financeOpsList().filter(o => !o.deleted && o.p.op === 'del_finance').map(o => Number(o.p.crm_finance_id)));
  if (delIds.size) all = all.filter(x => !delIds.has(Number(x.id)));
  const following = all.filter(x => Number(x.status) === 0).length;
  const completed = all.filter(x => Number(x.status) === 1).length;
  const aborted = all.filter(x => Number(x.status) === 2).length;
  let items = all;
  if (b.status !== undefined && b.status !== null && Number(b.status) !== -1) {
    items = all.filter(x => Number(x.status) === Number(b.status));
  }
  if (b.search_word) {
    const w = String(b.search_word);
    items = items.filter(x => (x.customer_name || '').includes(w) || (x.address || '').includes(w));
  }
  const total = items.length;
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) items = items.slice((pi - 1) * ps, pi * ps);
  return { code: 0, msg: '成功', data: { following_num: following, completed_num: completed, aborted_num: aborted, items } };
}

// 付款申请及审批列表快照（/finance/company/project/apply/list/，按 status 快照 1:1）
// 云端 status 语义：0=空、1=已审核21、2=已付款20、3=空、4/5=全部41、-1=我的32（计数器恒为 32/0/21/20/0）
let _applyListSnap = null;
function applyListSnapshot() {
  if (_applyListSnap) return _applyListSnap;
  _applyListSnap = {};
  try {
    _applyListSnap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'finance_apply_list_snapshots.json'), 'utf8'));
  } catch (e) { _applyListSnap = {}; }
  return _applyListSnap;
}
function financeApplyList({ body }) {
  const b = body || {};
  const status = b.status === undefined || b.status === null ? -1 : Number(b.status);
  const snaps = applyListSnapshot();
  const snap = snaps[String(status)] || snaps['-1'] || {
    applied_num: 0, reviewing_num: 0, reviewed_num: 0, paid_num: 0, rejected_num: 0,
    total_applied_amount: '0.00', total_reviewing_amount: '0.00', total_reviewed_amount: '0.00',
    total_paid_apply_amount: '0.00', total_paid_amount: '0.00', total_reject_amount: '0.00',
    paid_button: 1, items: []
  };
  const ops = financeOpsList().filter(o => !o.deleted);
  // -1（我的）保留存储池快照（云端语义与状态池不同）；其余按状态动态重建
  let items;
  if (status === -1) {
    items = ((snaps['-1'] && snaps['-1'].items) || []).map(x => Object.assign({}, x));
  } else {
    const byId = new Map();
    for (const x of ((snaps['4'] && snaps['4'].items) || [])) byId.set(Number(x.apply_id), Object.assign({}, x));
    items = [...byId.values()];
    if (status !== 4 && status !== 5) items = items.filter(x => Number(x.status) === status);
  }
  // 本地新增（finance_globals applies）→ 加入"我的"（-1）
  try {
    const row = db.prepare("SELECT payload FROM finance_globals WHERE kind='applies'").get();
    if (row) {
      const localItems = JSON.parse(row.payload).applies || [];
      if (status === -1) {
        for (const it of localItems) {
          if (!items.some(x => Number(x.apply_id || x.project_apply_id) === Number(it.apply_id || it.project_apply_id))) {
            items.push(Object.assign({}, it, { apply_id: Number(it.apply_id || it.project_apply_id) }));
          }
        }
      }
    }
  } catch (e) {}
  // 本地状态/置顶/删除操作
  for (const o of ops) {
    const p = o.p;
    if (p.op === 'apply_del') {
      items = items.filter(x => Number(x.apply_id) !== Number(p.apply_id));
      continue;
    }
    const it = items.find(x => Number(x.apply_id) === Number(p.apply_id));
    if (!it) continue;
    if (p.op === 'apply_status') {
      if (status === -1) it.status = Number(p.status); // 我的视图保留成员，仅更新状态
      else if (Number(it.status) === status) it.status = Number(p.status); // 状态池：更新后移出（下轮不再命中）
    } else if (p.op === 'apply_top') it.set_to_top = Number(p.set_to_top);
  }
  if (b.project_id && Number(b.project_id) > 0) items = items.filter(x => Number(x.project_id) === Number(b.project_id));
  if (b.search_key) {
    const w = String(b.search_key);
    items = items.filter(x => (x.project_name || '').includes(w) || (x.crm_sn || '').includes(w) || (x.applier_name || '').includes(w) || (x.child_apply_type || '').includes(w));
  }
  if (b.start_date) items = items.filter(x => !x.create_time || String(x.create_time).slice(0, 10) >= String(b.start_date));
  if (b.end_date) items = items.filter(x => !x.create_time || String(x.create_time).slice(0, 10) <= String(b.end_date));
  if (Array.isArray(b.creator_ids) && b.creator_ids.length) {
    const cond = financeGlobal('apply_conditions')();
    const creators = (cond && cond.data && cond.data.creators) || [];
    const ids = b.creator_ids.map(Number);
    const names = creators.filter(c => ids.includes(Number(c.id))).map(c => c.name);
    items = items.filter(x => names.includes(x.create_user_name));
  }
  if (b.expedited !== undefined && b.expedited !== null && Number(b.expedited) >= 0) {
    items = items.filter(x => Number(x.expedited) === Number(b.expedited));
  }
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) items = items.slice((pi - 1) * ps, pi * ps);
  // 键序与云端一致：...total_reject_amount, items, paid_button
  return {
    code: 0, msg: '成功',
    data: {
      applied_num: snap.applied_num, reviewing_num: snap.reviewing_num, reviewed_num: snap.reviewed_num,
      paid_num: snap.paid_num, rejected_num: snap.rejected_num,
      total_applied_amount: snap.total_applied_amount, total_reviewing_amount: snap.total_reviewing_amount,
      total_reviewed_amount: snap.total_reviewed_amount, total_paid_apply_amount: snap.total_paid_apply_amount,
      total_paid_amount: snap.total_paid_amount, total_reject_amount: snap.total_reject_amount,
      items, paid_button: snap.paid_button
    }
  };
}

// 项目应收汇总快照（/finance/project/receivable/summary/list/，按 is_bad 快照 1:1）
// 云端当前状态：默认日期窗口（近一年）contents 为空、all_projects 为空、all_owners/all_pms 为筛选下拉
let _recvSummarySnap = null;
function recvSummarySnapshot() {
  if (_recvSummarySnap) return _recvSummarySnap;
  _recvSummarySnap = {
    0: { normal_num: 0, bad_num: 0, total_num: 0, total_prepay_amount: '0.00', total_paid_amount: '0.00', total_uncollected_amount: '0.00', all_projects: [], all_owners: [], all_pms: [], contents: [] },
    1: { normal_num: 0, bad_num: 0, total_num: 0, total_prepay_amount: '0.00', total_paid_amount: '0.00', total_uncollected_amount: '0.00', all_projects: [], all_owners: [], all_pms: [], contents: [] }
  };
  try {
    _recvSummarySnap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'finance_receivable_summary_snapshots.json'), 'utf8'));
  } catch (e) { /* keep defaults */ }
  return _recvSummarySnap;
}
function financeReceivableSummary({ body }) {
  const b = body || {};
  const isBad = b.is_bad === undefined || b.is_bad === null ? 0 : Number(b.is_bad);
  const snap = recvSummarySnapshot()[String(isBad)] || recvSummarySnapshot()['0'] || {};
  return {
    code: 0, msg: '成功',
    data: {
      normal_num: snap.normal_num, bad_num: snap.bad_num, total_num: snap.total_num,
      total_prepay_amount: snap.total_prepay_amount, total_paid_amount: snap.total_paid_amount,
      total_uncollected_amount: snap.total_uncollected_amount,
      all_projects: Array.isArray(snap.all_projects) ? snap.all_projects : [],
      all_owners: Array.isArray(snap.all_owners) ? snap.all_owners : [],
      all_pms: Array.isArray(snap.all_pms) ? snap.all_pms : [],
      contents: Array.isArray(snap.contents) ? snap.contents : []
    }
  };
}

// 收付款分析（/finance/v2/analysis/paid/ 快照；云端当前 rows 为空 + summary 合计）
let _analysisPaidSnap = null;
function analysisPaidSnapshot() {
  if (_analysisPaidSnap) return _analysisPaidSnap;
  _analysisPaidSnap = { total_count: 0, rows: [], summary: {}, can_export: 1 };
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'finance_analysis_paid_snapshot.json'), 'utf8'));
    if (p && p.data) _analysisPaidSnap = p.data;
  } catch (e) { /* keep defaults */ }
  return _analysisPaidSnap;
}
function financeAnalysisPaid({ body }) {
  const b = body || {};
  const snap = analysisPaidSnapshot();
  const rows = Array.isArray(snap.rows) ? snap.rows : [];
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  let page = rows;
  if (ps > 0) page = rows.slice((pi - 1) * ps, pi * ps);
  return { code: 0, msg: '成功', data: { total_count: snap.total_count, rows: page, summary: snap.summary || {}, can_export: snap.can_export } };
}

// 项目流水（/finance/v2/financial/record/list/ 快照；record_list + 汇总金额）
let _journalSnap = null;
function journalSnapshot() {
  if (_journalSnap) return _journalSnap;
  _journalSnap = { total_received_amount: '0.00', total_refund_amount: '0.00', payment_total_apply_amount: '0.00', payment_total_paid_amount: '0.00', payment_total_material_fee: '0.00', payment_total_work_fee: '0.00', payment_total_management_fee: '0.00', payment_total_service_fee: '0.00', payment_total_settlement_amount: '0.00', payment_total_other_fee: '0.00', total_balance_amount: '0.00', total_num: 0, record_list: [] };
  try { _journalSnap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'finance_journal_snapshot.json'), 'utf8')); } catch (e) { /* keep defaults */ }
  return _journalSnap;
}
function financeJournal({ body }) {
  const b = body || {};
  const snap = journalSnapshot();
  let recs = Array.isArray(snap.record_list) ? snap.record_list : [];
  if (b.fund_type !== undefined && b.fund_type !== null && Number(b.fund_type) !== -1) {
    recs = recs.filter(x => Number(x.fund_type) === Number(b.fund_type));
  }
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) recs = recs.slice((pi - 1) * ps, pi * ps);
  const out = Object.assign({}, snap);
  out.record_list = recs;
  return { code: 0, msg: '成功', data: out };
}

// 公司账户管理（/company/account/list/ 快照）
let _accountSnap = null;
function accountSnapshot() {
  if (_accountSnap) return _accountSnap;
  _accountSnap = { total_num: 0, total_amount: '0.00', company_account_list: [], can_add_sub_account: 0 };
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'finance_account_snapshot.json'), 'utf8'));
    if (p && p.data) _accountSnap = p.data;
  } catch (e) { /* keep defaults */ }
  return _accountSnap;
}
function financeAccountList({ body }) {
  const b = body || {};
  const snap = accountSnapshot();
  let list = Array.isArray(snap.company_account_list) ? snap.company_account_list : [];
  if (Array.isArray(b.account_type_names) && b.account_type_names.length) {
    list = list.filter(x => b.account_type_names.includes(x.account_type_name));
  }
  if (Array.isArray(b.account_user_names) && b.account_user_names.length) {
    list = list.filter(x => b.account_user_names.includes(x.account_user_name));
  }
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) list = list.slice((pi - 1) * ps, pi * ps);
  return { code: 0, msg: '成功', data: { total_num: snap.total_num, total_amount: snap.total_amount, company_account_list: list, can_add_sub_account: snap.can_add_sub_account } };
}

// 财务收款详情（/finance/detail/ 按客户快照；请求参数 crm_id 或 crm_finance_id）
let _financeDetailSnaps = null;
function financeDetailSnapshots() {
  if (_financeDetailSnaps) return _financeDetailSnaps;
  _financeDetailSnaps = {};
  try {
    _financeDetailSnaps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'finance_detail_snapshots.json'), 'utf8'));
  } catch (e) { _financeDetailSnaps = {}; }
  return _financeDetailSnaps;
}
function financeDetailHandler({ body }) {
  const b = body || {};
  let cid = Number(b.crm_id || 0);
  const fid = Number(b.crm_finance_id || 0);
  const snaps = financeDetailSnapshots();
  if (!cid && fid) {
    // crm_finance_id → crm_id 映射（finance_crm_list 快照）
    const g = financeGlobal('finance_crm_list')();
    if (g) {
      const it = (g.data.items || []).find(x => Number(x.id) === fid);
      if (it) cid = Number(it.crm_id);
    }
  }
  let d = null;
  if (cid && snaps[cid]) d = JSON.parse(JSON.stringify(snaps[cid]));
  // 本地写操作合并（收款/退款/合同/凭证/预付款/坏账/基础信息/删除）
  if (d) d = applyFinanceOps(d, cid, fid);
  if (d) return { code: 0, msg: '成功', data: d };
  if (cid) return { code: 0, msg: '成功', data: { data_exist: 0, crm_finance_id: fid, edit_users: [], read_users: [] } };
  return { code: 10011, msg: '参数错误', data: {} };
}

// ---------------- 财务写操作（模式 A：local_records entity='finance' 宽容落库，读时合并进快照） ----------------
function finFmt(num) {
  const n = Number(num || 0);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function financeOpsList() {
  return db.prepare("SELECT record_id, payload, deleted FROM local_records WHERE entity = 'finance'").all()
    .map(r => ({ record_id: Number(r.record_id), deleted: !!r.deleted, p: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })() }));
}
function financeOpAdd(payload) {
  const id = localNextId('finance');
  localUpsert('finance', id, payload);
  return id;
}
// 收款方式 id → 名称（从详情快照 paid_records 收集，回退常见映射）
function financePaidTypeName(typeId) {
  try {
    const snaps = financeDetailSnapshots();
    const seen = {};
    for (const cid of Object.keys(snaps)) {
      const ci = snaps[cid] && snaps[cid].contract_info;
      if (!ci) continue;
      for (const c of (ci.contracts || [])) {
        for (const r of (c.paid_records || [])) {
          if (Number(r.paid_type) === Number(typeId) && r.paid_type_name) return r.paid_type_name;
        }
      }
    }
  } catch (e) {}
  return { 9: '微信', 10: '支付宝', 11: '银行卡', 12: '现金', 13: '转账' }[Number(typeId)] || '';
}
// 构造云端形态收款/退款记录（fid = 已解析的 crm_finance_id，供 phase 反查收款名）
function buildFinanceRecord(b, rid, fid) {
  const type = Number(b.type) || 0;
  const amt = String(b.paid_amount !== undefined && b.paid_amount !== null ? b.paid_amount : (b.amount || '0'));
  // paid_type：company_account_id → 账号类型（从详情快照记录推断），回退 body.paid_type
  let paidType = Number(b.paid_type || 0);
  let paidTypeName = financePaidTypeName(b.paid_type);
  const accId = Number(b.company_account_id || 0);
  if (accId) {
    try {
      const snaps = financeDetailSnapshots();
      for (const cid of Object.keys(snaps)) {
        const ci = snaps[cid] && snaps[cid].contract_info;
        if (!ci) continue;
        for (const c of (ci.contracts || [])) {
          for (const r of (c.paid_records || [])) {
            if (Number(r.company_account_id) === accId && r.paid_type !== undefined) {
              paidType = Number(r.paid_type);
              paidTypeName = r.paid_type_name || '';
              break;
            }
          }
        }
      }
    } catch (e) {}
  }
  // paid_name：缺省时按 phase_no 从合同期数取（v2 路径只传 phase_no）
  let paidName = b.paid_name || '';
  if (!paidName && Number(b.phase_no || 0) > 0) {
    try {
      const g = financeGlobal('finance_crm_list')();
      let fid2 = Number(fid || b.crm_finance_id || 0);
      let cid2 = 0;
      if (g) { const it = (g.data.items || []).find(x => Number(x.id) === fid2); if (it) cid2 = Number(it.crm_id); }
      const snaps = financeDetailSnapshots();
      const ci = cid2 && snaps[cid2] && snaps[cid2].contract_info;
      if (ci) {
        const c = (ci.contracts || []).find(x => Number(x.finance_contract_id) === Number(b.finance_contract_id || 0)) || (ci.contracts || [])[0];
        const it = c && (c.items || []).find(x => Number(x.phase_no) === Number(b.phase_no));
        if (it) paidName = it.name || '';
      }
    } catch (e) {}
  }
  const r = {
    id: rid,
    type,
    paid_amount: String(Number(amt) || 0),
    show_paid_amount: finFmt(Number(amt) || 0),
    discount_amount: b.discount_amount !== undefined ? String(Number(b.discount_amount) || 0) : '0',
    show_discount_amount: b.discount_amount ? finFmt(b.discount_amount) : '0.00',
    paid_date: b.paid_date || b.date || '',
    paid_name: paidName,
    phase_no: Number(b.phase_no || 0),
    paid_biz_type: Number(b.paid_biz_type || 0),
    paid_type: paidType,
    paid_type_name: paidTypeName,
    description: b.description || '',
    create_user_name: '小君',
    create_user_phone: '18300000001',
    review_user_name: '',
    status: 0,
    files: Array.isArray(b.files) ? b.files : [],
    edit_permission: 1,
    company_account_id: accId,
    company_bank_name: '',
    company_account_type_name: paidTypeName,
    company_account_user_name: '',
    company_account_number: ''
  };
  return r;
}
// 本地财务操作合并进详情快照（深拷贝后的对象上原地修改）
function applyFinanceOps(detail, cid, fid) {
  const ops = financeOpsList().filter(o => !o.deleted);
  const rel = ops.filter(o => o.p.op === 'contract_order' || Number(o.p.crm_finance_id) === Number(fid) || Number(o.p.crm_id) === Number(cid));
  if (!rel.length) return detail;
  const ci = detail.contract_info;
  const contracts = ci && Array.isArray(ci.contracts) ? ci.contracts : [];
  const findContract = (fcid) => contracts.find(x => Number(x.finance_contract_id) === Number(fcid));
  for (const o of rel) {
    const p = o.p;
    switch (p.op) {
      case 'income_add': {
        // 云端按收款名匹配合同期数；无匹配挂第一个合同
        let c = findContract(p.finance_contract_id);
        if (!c && p.record && p.record.paid_name) {
          c = contracts.find(x => (x.items || []).some(it => it.name === p.record.paid_name)) || contracts[0];
        }
        if (c) {
          if (!Array.isArray(c.paid_records)) c.paid_records = [];
          c.paid_records.unshift(p.record);
        }
        break;
      }
      case 'income_edit': {
        for (const c of contracts) {
          if (Array.isArray(c.paid_records)) {
            const idx = c.paid_records.findIndex(x => Number(x.id) === Number(p.paid_record_id));
            if (idx >= 0) c.paid_records[idx] = Object.assign({}, c.paid_records[idx], p.record, { id: Number(p.paid_record_id) });
          }
        }
        break;
      }
      case 'income_del': {
        for (const c of contracts) {
          if (Array.isArray(c.paid_records)) c.paid_records = c.paid_records.filter(x => Number(x.id) !== Number(p.paid_record_id));
        }
        break;
      }
      case 'contract_add': {
        contracts.push(p.contract);
        break;
      }
      case 'contract_modify': {
        const idx = contracts.findIndex(x => Number(x.finance_contract_id) === Number(p.finance_contract_id));
        if (idx >= 0) contracts[idx] = Object.assign({}, contracts[idx], p.contract, { finance_contract_id: Number(p.finance_contract_id) });
        break;
      }
      case 'contract_del': {
        const idx = contracts.findIndex(x => Number(x.finance_contract_id) === Number(p.finance_contract_id));
        if (idx >= 0) contracts.splice(idx, 1);
        break;
      }
      case 'contract_order': {
        const items = Array.isArray(p.contract_items) ? p.contract_items : [];
        // 仅当该详情的合同命中排序项才应用（op 无客户上下文）
        if (!contracts.some(c => items.some(x => Number(x.id) === Number(c.finance_contract_id)))) break;
        contracts.sort((a, b) => {
          const oa = items.find(x => Number(x.id) === Number(a.finance_contract_id));
          const ob = items.find(x => Number(x.id) === Number(b.finance_contract_id));
          return (oa ? Number(oa.order) : 999) - (ob ? Number(ob.order) : 999);
        });
        break;
      }
      case 'file_add': {
        const c = findContract(p.finance_contract_id);
        if (c) {
          if (!Array.isArray(c.files)) c.files = [];
          c.files.push(p.file);
        }
        break;
      }
      case 'file_del': {
        for (const c of contracts) {
          if (Array.isArray(c.files)) c.files = c.files.filter(f => Number(f.file_id) !== Number(p.file_id));
        }
        break;
      }
      case 'bad_debt': {
        const c = findContract(p.finance_contract_id);
        if (c) {
          const v = Number(p.bad_debt_amount || 0);
          c.bad_debt_amount = String(v);
          c.show_bad_debt_amount = finFmt(v);
        }
        break;
      }
      case 'prepay_add': {
        const c = findContract(p.finance_contract_id);
        if (c) {
          if (!Array.isArray(c.add_prepay_items)) c.add_prepay_items = [];
          c.add_prepay_items.push(p.item);
          const sum = c.add_prepay_items.reduce((a, x) => a + (parseFloat(String(x.amount).replace(/,/g, '')) || 0), 0);
          c.add_prepay = String(sum);
          c.show_add_prepay = finFmt(sum);
        }
        break;
      }
      case 'prepay_del': {
        const c = findContract(p.finance_contract_id);
        if (c && Array.isArray(c.add_prepay_items)) {
          c.add_prepay_items = c.add_prepay_items.filter(x => Number(x.id) !== Number(p.item_id));
          const sum = c.add_prepay_items.reduce((a, x) => a + (parseFloat(String(x.amount).replace(/,/g, '')) || 0), 0);
          c.add_prepay = String(sum);
          c.show_add_prepay = finFmt(sum);
        }
        break;
      }
      case 'basic_edit': {
        if (detail.base_info && p.base_info) detail.base_info = Object.assign({}, detail.base_info, p.base_info);
        break;
      }
      case 'del_finance': {
        detail.data_exist = 0;
        break;
      }
    }
  }
  return detail;
}

// 财务详情所属客户解析：crm_finance_id 优先，其次 finance_contract_id 反查（v2 写接口只传合同 id）
function financeFidOf(b) {
  let fid = Number(b && (b.crm_finance_id || b.finance_id || 0));
  if (fid) return fid;
  const fcid = Number(b && (b.finance_contract_id || b.contract_id || 0));
  if (!fcid) return 0;
  try {
    const snaps = financeDetailSnapshots();
    for (const cid of Object.keys(snaps)) {
      const ci = snaps[cid] && snaps[cid].contract_info;
      if (ci && (ci.contracts || []).some(c => Number(c.finance_contract_id) === fcid)) {
        // crm_id → crm_finance_id（finance_crm_list 快照）
        const g = financeGlobal('finance_crm_list')();
        if (g) {
          const it = (g.data.items || []).find(x => Number(x.crm_id) === Number(cid));
          if (it) return Number(it.id);
        }
        return Number(cid);
      }
    }
  } catch (e) {}
  return 0;
}

// ---------------- 财务写接口（本地落库，云端零污染） ----------------
function financeWriteAdd(opName) {
  return ({ body }) => {
    const b = body || {};
    const fid = financeFidOf(b);
    const fcid = Number(b.finance_contract_id || b.contract_id || 0);
    if (!fid) return { code: 10011, msg: '参数错误', data: {} };
    const rid = financeOpAdd({ op: opName, crm_finance_id: fid, finance_contract_id: fcid, record: buildFinanceRecord(b, 0, fid) });
    // record 的 id 需在落库后回填（rid 为 9 亿号段）
    const rows = financeOpsList();
    const row = rows.find(x => x.record_id === rid);
    if (row) {
      row.p.record.id = rid;
      row.p.record.show_paid_amount = finFmt(row.p.record.paid_amount);
      localUpsert('finance', rid, row.p);
    }
    return { code: 0, msg: '成功', data: { paid_record_id: rid } };
  };
}
function financeWriteEdit() {
  return ({ body }) => {
    const b = body || {};
    const pid = Number(b.paid_record_id || b.id || 0);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    // 找到该记录所属的 finance op（新增记录在本地；云端记录需 crm_finance_id）
    const rows = financeOpsList().filter(x => !x.deleted && x.p.op === 'income_add' && Number(x.p.record.id) === pid);
    const fid = rows.length ? Number(rows[0].p.crm_finance_id) : financeFidOf(b);
    if (!fid) return { code: 10011, msg: '参数错误', data: {} };
    const record = buildFinanceRecord(b, pid, fid);
    financeOpAdd({ op: 'income_edit', crm_finance_id: fid, paid_record_id: pid, record });
    return { code: 0, msg: '成功', data: {} };
  };
}
function financeWriteDel() {
  return ({ body }) => {
    const b = body || {};
    const pid = Number(b.paid_record_id || b.id || 0);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const rows = financeOpsList().filter(x => !x.deleted && x.p.op === 'income_add' && Number(x.p.record.id) === pid);
    const fid = rows.length ? Number(rows[0].p.crm_finance_id) : financeFidOf(b);
    if (!fid) return { code: 10011, msg: '参数错误', data: {} };
    financeOpAdd({ op: 'income_del', crm_finance_id: fid, paid_record_id: pid });
    return { code: 0, msg: '成功', data: {} };
  };
}
// 合同新增（云端形态最小合同对象）
function financeContractAdd({ body }) {
  const b = body || {};
  const fid = Number(b.crm_finance_id || b.finance_id || 0);
  if (!fid) return { code: 10011, msg: '参数错误', data: {} };
  const fcid = localNextId('finance');
  const price = Number(b.contract_price !== undefined ? b.contract_price : (b.price || 0));
  const budget = Number(b.budget_price || 0);
  const rate = b.discount_rate !== undefined && b.discount_rate !== null ? String(b.discount_rate) : '10';
  const contract = {
    finance_contract_id: fcid,
    total_prepay_price: '0.00', total_paid_price: '0.00', total_discount_amount: '0.00', total_unpay_price: finFmt(price),
    add_prepay: '0', show_add_prepay: '0.00', total_receive: '0.00', total_refund: '0.00',
    pay_times: Number(b.pay_times || 0),
    name: b.name || b.contract_name || '', contract_title: b.contract_title || b.contract_name || '',
    name_description: '', type: Number(b.type || 0),
    budget_price: String(budget), show_budget_price: finFmt(budget),
    contract_price: String(price), show_contract_price: finFmt(price),
    bad_debt_amount: '0', show_bad_debt_amount: '0.00',
    discount_rate: rate, no_gift_discount_rate: rate,
    gift: b.gift || '', gift_price: b.gift_price !== undefined ? String(b.gift_price) : '0', format_gift_price: b.gift_price ? finFmt(b.gift_price) : '0.00',
    sign_date: b.sign_date || '', description: b.description || '',
    create_user_name: '小君', review_user_name: '', status: 0,
    edit_permission: 1, del_permission: 1, files: [], items: [], paid_records: []
  };
  financeOpAdd({ op: 'contract_add', crm_finance_id: fid, finance_contract_id: fcid, contract });
  return { code: 0, msg: '成功', data: { finance_contract_id: fcid } };
}
// 合同编辑（字段合并进快照合同）
function financeContractModify({ body }) {
  const b = body || {};
  const fcid = Number(b.finance_contract_id || b.contract_id || 0);
  if (!fcid) return { code: 10011, msg: '参数错误', data: {} };
  const fid = Number(b.crm_finance_id || b.finance_id || 0);
  const contract = Object.assign({}, b);
  delete contract.crm_finance_id; delete contract.finance_id;
  if (contract.contract_price !== undefined && contract.contract_price !== null) {
    const v = Number(contract.contract_price);
    contract.contract_price = String(v);
    contract.show_contract_price = finFmt(v);
  }
  if (contract.budget_price !== undefined && contract.budget_price !== null) {
    const v = Number(contract.budget_price);
    contract.budget_price = String(v);
    contract.show_budget_price = finFmt(v);
  }
  if (contract.discount_rate !== undefined && contract.discount_rate !== null) contract.no_gift_discount_rate = String(contract.discount_rate);
  financeOpAdd({ op: 'contract_modify', crm_finance_id: fid, finance_contract_id: fcid, contract });
  return { code: 0, msg: '成功', data: {} };
}
// 合同删除 / 排序 / 坏账
function financeContractDel({ body }) {
  const b = body || {};
  const fcid = Number(b.finance_contract_id || b.contract_id || 0);
  if (!fcid) return { code: 10011, msg: '参数错误', data: {} };
  financeOpAdd({ op: 'contract_del', crm_finance_id: Number(b.crm_finance_id || 0), finance_contract_id: fcid });
  return { code: 0, msg: '成功', data: {} };
}
function financeContractOrder({ body }) {
  const b = body || {};
  const items = Array.isArray(b.contract_items) ? b.contract_items : [];
  if (!items.length) return { code: 0, msg: '成功', data: {} };
  financeOpAdd({ op: 'contract_order', contract_items: items });
  return { code: 0, msg: '成功', data: {} };
}
function financeBadDebt({ body }) {
  const b = body || {};
  const fcid = Number(b.finance_contract_id || b.contract_id || 0);
  if (!fcid) return { code: 10011, msg: '参数错误', data: {} };
  const v = Number(b.bad_debt_amount !== undefined ? b.bad_debt_amount : (b.amount || 0));
  financeOpAdd({ op: 'bad_debt', crm_finance_id: Number(b.crm_finance_id || 0), finance_contract_id: fcid, bad_debt_amount: v });
  return { code: 0, msg: '成功', data: {} };
}
// 合同预付款增删
function financePrepayAdd({ body }) {
  const b = body || {};
  const fcid = Number(b.finance_contract_id || b.contract_id || 0);
  const fid = Number(b.crm_finance_id || b.finance_id || 0);
  if (!fcid || !fid) return { code: 10011, msg: '参数错误', data: {} };
  const item = {
    id: localNextId('finance'),
    amount: String(b.amount !== undefined ? b.amount : (b.add_prepay_amount || 0)),
    paid_type: Number(b.paid_type || 0),
    paid_type_name: financePaidTypeName(b.paid_type),
    paid_date: b.paid_date || fmtLocalTime().slice(0, 10),
    description: b.description || '',
    create_user_name: '小君'
  };
  financeOpAdd({ op: 'prepay_add', crm_finance_id: fid, finance_contract_id: fcid, item });
  return { code: 0, msg: '成功', data: {} };
}
function financePrepayDel({ body }) {
  const b = body || {};
  const fcid = Number(b.finance_contract_id || b.contract_id || 0);
  const fid = Number(b.crm_finance_id || b.finance_id || 0);
  financeOpAdd({ op: 'prepay_del', crm_finance_id: fid, finance_contract_id: fcid, item_id: Number(b.id || b.add_prepay_id || 0) });
  return { code: 0, msg: '成功', data: {} };
}
// 合同凭证增删
function financeFileAdd({ body }) {
  const b = body || {};
  const fcid = Number(b.finance_contract_id || b.contract_id || 0);
  const fid = Number(b.crm_finance_id || b.finance_id || 0);
  const file = {
    file_id: localNextId('finance'),
    name: b.name || '',
    url: b.url || b.origin_url || '',
    origin_url: b.origin_url || b.url || '',
    size: Number(b.size || 0),
    type: Number(b.type || 0),
    create_time: fmtLocalTime().slice(0, 10),
    create_user_name: '小君'
  };
  financeOpAdd({ op: 'file_add', crm_finance_id: fid, finance_contract_id: fcid, file });
  return { code: 0, msg: '成功', data: { file_id: file.file_id } };
}
function financeFileDel({ body }) {
  const b = body || {};
  financeOpAdd({ op: 'file_del', crm_finance_id: Number(b.crm_finance_id || 0), file_id: Number(b.file_id || b.id || 0) });
  return { code: 0, msg: '成功', data: {} };
}
// 基础信息编辑（/finance/set/）
function financeBasicSet({ body }) {
  const b = body || {};
  const fid = Number(b.crm_finance_id || b.finance_id || 0);
  if (!fid) return { code: 10011, msg: '参数错误', data: {} };
  const base_info = Object.assign({}, b);
  delete base_info.crm_finance_id; delete base_info.finance_id;
  financeOpAdd({ op: 'basic_edit', crm_finance_id: fid, base_info });
  return { code: 0, msg: '成功', data: {} };
}
// 删除项目收款（/finance/crm/del/）：详情 data_exist=0 + 列表移除
function financeCrmDel({ body }) {
  const b = body || {};
  const fid = Number(b.crm_finance_id || b.finance_id || 0);
  if (!fid) return { code: 10011, msg: '参数错误', data: {} };
  financeOpAdd({ op: 'del_finance', crm_finance_id: fid });
  return { code: 0, msg: '成功', data: {} };
}
// 其余财务写接口安全兜底（模式 A：宽容落库，云端零污染）
function financeWriteSafe(opName) {
  return ({ body }) => {
    const b = body || {};
    financeOpAdd({ op: 'misc_' + opName, crm_finance_id: Number(b.crm_finance_id || b.finance_id || b.project_id || 0), body: b });
    return { code: 0, msg: '成功', data: {} };
  };
}

// 请款详情快照（/finance/project/apply/detail/，按 apply_id）
let _applyDetailSnaps = null;
function applyDetailSnapshots() {
  if (_applyDetailSnaps) return _applyDetailSnaps;
  _applyDetailSnaps = {};
  try {
    _applyDetailSnaps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'finance_apply_detail_snapshots.json'), 'utf8'));
  } catch (e) { _applyDetailSnaps = {}; }
  return _applyDetailSnaps;
}
// 请款详情：快照优先 + 本地新增回退 + 本地状态操作合并
function financeApplyDetail2({ body }) {
  const b = body || {};
  const aid = Number(b.project_apply_fee_id || b.project_apply_id || b.apply_id || b.id || 0);
  if (!aid) return { code: 10011, msg: '参数错误', data: {} };
  const snaps = applyDetailSnapshots();
  let d = snaps[aid] ? JSON.parse(JSON.stringify(snaps[aid])) : null;
  if (!d) {
    try {
      const row = db.prepare("SELECT payload FROM finance_globals WHERE kind='applies'").get();
      if (row) {
        const it = (JSON.parse(row.payload).applies || []).find(x => Number(x.apply_id || x.project_apply_id) === aid);
        if (it) d = Object.assign({}, it, { apply_id: aid });
      }
    } catch (e) {}
  }
  if (!d) return { code: 21006, msg: '申请人已撤回', data: {} };
  // 本地状态/置顶/删除操作
  const ops = financeOpsList().filter(o => !o.deleted && Number(o.p.apply_id) === aid);
  for (const o of ops) {
    const p = o.p;
    if (p.op === 'apply_status') d.status = Number(p.status);
    else if (p.op === 'apply_top') d.set_to_top = Number(p.set_to_top);
    else if (p.op === 'apply_del') return { code: 21006, msg: '申请人已撤回', data: {} };
  }
  return { code: 0, msg: '成功', data: d };
}
// 请款状态写接口（本地落库）：review/reject/paid/withdraw/resubmit
function financeApplyStatusOp(statusVal) {
  return ({ body }) => {
    const b = body || {};
    const aid = Number(b.project_apply_fee_id || b.project_apply_id || b.apply_id || 0);
    if (!aid) return { code: 10011, msg: '参数错误', data: {} };
    financeOpAdd({ op: 'apply_status', apply_id: aid, status: statusVal });
    return { code: 0, msg: '成功', data: {} };
  };
}
// 请款置顶 / 删除（本地落库）
function financeApplyTop({ body }) {
  const b = body || {};
  const aid = Number(b.project_fee_apply_id || b.project_apply_fee_id || b.project_apply_id || b.apply_id || 0);
  if (!aid) return { code: 10011, msg: '参数错误', data: {} };
  financeOpAdd({ op: 'apply_top', apply_id: aid, set_to_top: Number(b.set_to_top || 0) });
  return { code: 0, msg: '成功', data: {} };
}
function financeApplyDel({ body }) {
  const b = body || {};
  const aid = Number(b.project_apply_fee_id || b.project_apply_id || b.apply_id || 0);
  if (!aid) return { code: 10011, msg: '参数错误', data: {} };
  financeOpAdd({ op: 'apply_del', apply_id: aid });
  return { code: 0, msg: '成功', data: {} };
}

// ---------------- 商品展厅（原站 /company/showroom/*，云端快照 1:1） ----------------
let _showroomContent = null;
let _showroomMaterial = null;
function showroomContentSnapshot() {
  if (_showroomContent) return _showroomContent;
  _showroomContent = [];
  try { _showroomContent = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'showroom_content_snapshot.json'), 'utf8')); } catch (e) {}
  return _showroomContent;
}
function showroomMaterialSnapshot() {
  if (_showroomMaterial) return _showroomMaterial;
  _showroomMaterial = [];
  try { _showroomMaterial = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'showroom_material_snapshot.json'), 'utf8')); } catch (e) {}
  return _showroomMaterial;
}
// 商品展厅内容分类（4 类快照）
function showroomContentList() {
  return { code: 0, msg: '成功', data: { contents: showroomContentSnapshot() } };
}
// 商品展厅材料列表：{total_num, materials} 分页
function showroomMaterialList({ body }) {
  const b = body || {};
  let list = showroomMaterialSnapshot();
  if (b.content_id) list = list.filter(x => Number(x.content_id) === Number(b.content_id));
  if (b.search_key) {
    const w = String(b.search_key);
    list = list.filter(x => (x.name || '').includes(w) || (x.band || '').includes(w) || (x.model || '').includes(w) || (x.specification || '').includes(w));
  }
  const total = list.length;
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) list = list.slice((pi - 1) * ps, pi * ps);
  return { code: 0, msg: '成功', data: { total_num: total, materials: list } };
}

// ---------------- 汇总类读接口（云端快照 1:1：材料订单/老板看板/巡检/考勤/部门排名） ----------------
function snapLoader(name, fallback) {
  let cache = null;
  return () => {
    if (cache !== null) return cache;
    cache = fallback;
    try { cache = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', name), 'utf8')); } catch (e) {}
    return cache;
  };
}
const materialOrderSnap = snapLoader('material_order_snapshot.json', { order_num: 0, total_order_amount: '0.00', order_permission: 1, add_order_permission: 1, show_button: 0, bottom_button: 0, orders: [], order_ids: [], all_projects: [], all_suppliers: [], all_appliers: [] });
const overviewSnap = snapLoader('overview_snapshot.json', {});
const statisticsSnap = snapLoader('statistics_snapshot.json', {});
const inspectionSnap = snapLoader('inspection_snapshot.json', { projects: [], create_users: [], total_num: 0, inspection_list: [], roles: [] });
const attendanceSnap = snapLoader('attendance_snapshot.json', { check_user_num: 0, total_num: 0, record_list: [], roles: [] });
const oaAttendanceSnap = snapLoader('oa_attendance_snapshot.json', {});
const deptRankingSnap = snapLoader('dept_ranking_snapshot.json', {});

// 材料订单列表（v3）：orders 分页 + order_ids 全量 + 筛选项
function materialOrderList({ body }) {
  const b = body || {};
  const s = materialOrderSnap();
  let orders = Array.isArray(s.orders) ? s.orders : [];
  if (b.project_id && Number(b.project_id) > 0) orders = orders.filter(x => Number(x.project_id) === Number(b.project_id));
  if (b.supplier_id && Number(b.supplier_id) > 0) orders = orders.filter(x => Number(x.supplier_id) === Number(b.supplier_id));
  if (b.applier_id && Number(b.applier_id) > 0) orders = orders.filter(x => Number(x.applier_id) === Number(b.applier_id));
  if (b.status !== undefined && b.status !== null && Number(b.status) !== -1) orders = orders.filter(x => Number(x.status) === Number(b.status));
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) orders = orders.slice((pi - 1) * ps, pi * ps);
  return {
    code: 0, msg: '成功',
    data: {
      order_num: s.order_num, total_order_amount: s.total_order_amount, order_permission: s.order_permission,
      add_order_permission: s.add_order_permission, show_button: s.show_button, bottom_button: s.bottom_button,
      orders, order_ids: Array.isArray(s.order_ids) ? s.order_ids : [],
      all_projects: Array.isArray(s.all_projects) ? s.all_projects : [],
      all_suppliers: Array.isArray(s.all_suppliers) ? s.all_suppliers : [],
      all_appliers: Array.isArray(s.all_appliers) ? s.all_appliers : []
    }
  };
}
// 老板看板概览 / 统计
function companyOverview() {
  return { code: 0, msg: '成功', data: overviewSnap() };
}
function companyStatistics() {
  return { code: 0, msg: '成功', data: statisticsSnap() };
}
// 巡检汇总：inspection_list 分页 + 筛选项
function inspectionCompanyList({ body }) {
  const b = body || {};
  const s = inspectionSnap();
  let list = Array.isArray(s.inspection_list) ? s.inspection_list : [];
  if (b.create_user_id && Number(b.create_user_id) > 0) list = list.filter(x => Number(x.create_user_id) === Number(b.create_user_id));
  if (b.status !== undefined && b.status !== null && Number(b.status) !== -1) list = list.filter(x => Number(x.status) === Number(b.status));
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) list = list.slice((pi - 1) * ps, pi * ps);
  return {
    code: 0, msg: '成功',
    data: {
      projects: Array.isArray(s.projects) ? s.projects : [], create_users: Array.isArray(s.create_users) ? s.create_users : [],
      total_num: s.total_num, inspection_list: list, roles: Array.isArray(s.roles) ? s.roles : []
    }
  };
}
// 工地考勤汇总：record_list 分页
function attendanceCompanyList({ body }) {
  const b = body || {};
  const s = attendanceSnap();
  let list = Array.isArray(s.record_list) ? s.record_list : [];
  if (b.user_id && Number(b.user_id) > 0) list = list.filter(x => Number(x.user_id) === Number(b.user_id));
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) list = list.slice((pi - 1) * ps, pi * ps);
  return {
    code: 0, msg: '成功',
    data: {
      check_user_num: s.check_user_num, total_num: s.total_num, record_list: list, roles: Array.isArray(s.roles) ? s.roles : []
    }
  };
}
// 考勤报表（月度统计）
function oaAttendanceStatistic() {
  return { code: 0, msg: '成功', data: oaAttendanceSnap() };
}
// 部门业务排名
function deptRanking() {
  return { code: 0, msg: '成功', data: deptRankingSnap() };
}

// ---------------- 后台财务设置（个性化设置页·财务管理 tab，云端快照 1:1） ----------------
const bfPaymentSettingSnap = snapLoader('backend_finance_payment_setting.json', {});
const bfApplyContractTypesSnap = snapLoader('backend_finance_apply_contract_types.json', {});
const bfApplyCommodityContentsSnap = snapLoader('backend_finance_apply_commodity_contents.json', {});
const bfSubCompanyAccountSnap = snapLoader('backend_finance_sub_company_account.json', {});
const bfReimbursementModeSnap = snapLoader('backend_finance_reimbursement_mode.json', {});
const bfCompanyListSnap = snapLoader('backend_finance_company_list.json', {});
const bfApplyTypeListSnap = snapLoader('backend_finance_apply_type_list.json', {});
const bfAnalysisSettingSnap = snapLoader('backend_finance_analysis_setting.json', {});
// 读接口：公司维度全局配置快照（参数 company_id/phase/contract_type 不影响整体结构）
function bfRead(snap, dflt) {
  return () => {
    const s = snap();
    return { code: 0, msg: '成功', data: s && typeof s === 'object' && s.data ? s.data : dflt };
  };
}

// 收款列表：快照 + 筛选（project_id/pm_id/designer_id/status/search_word）+ 分页
function financePaidList({ body }) {
  const g = financeGlobal('paid_list')();
  if (!g) return null;
  const b = body || {};
  let list = g.data.items || [];
  if (b.project_id) list = list.filter((x) => Number(x.project_id) === Number(b.project_id));
  if (b.pm_id) list = list.filter((x) => Number(x.pm_id) === Number(b.pm_id));
  if (b.designer_id) list = list.filter((x) => Number(x.designer_id) === Number(b.designer_id));
  if (b.status !== undefined && b.status !== null && Number(b.status) !== -1) list = list.filter((x) => Number(x.status) === Number(b.status));
  if (b.search_word) { const w = String(b.search_word); list = list.filter((x) => (x.customer_name || '').includes(w) || (x.area_name || '').includes(w) || (x.room_number || '').includes(w)); }
  const total = list.length;
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) list = list.slice((pi - 1) * ps, pi * ps);
  return { code: 0, msg: '成功', data: { total_count: total, items: list } };
}

// 财务客户汇总列表：快照 + 分页 + 汇总金额透传
function financeCrmList({ body }) {
  const g = financeGlobal('finance_crm_list')();
  if (!g) return null;
  const b = body || {};
  let list = g.data.items || [];
  if (b.search_word) { const w = String(b.search_word); list = list.filter((x) => (x.customer_name || '').includes(w) || (x.address || '').includes(w)); }
  const total = list.length;
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) list = list.slice((pi - 1) * ps, pi * ps);
  const out = { total_count: total, items: list };
  for (const k of Object.keys(g.data)) if (k.startsWith('total_')) out[k] = g.data[k];
  return { code: 0, msg: '成功', data: out };
}

// 请款入口项目列表：快照 + 分页
function financeProjectList({ body }) {
  const g = financeGlobal('finance_project_list')();
  if (!g) return null;
  const b = body || {};
  let list = g.data.items || [];
  if (b.search_word) { const w = String(b.search_word); list = list.filter((x) => (x.project_name || '').includes(w)); }
  const total = list.length;
  const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
  if (ps > 0) list = list.slice((pi - 1) * ps, pi * ps);
  return { code: 0, msg: '成功', data: { total_num: total, items: list } };
}

// 收款明细：按 crm_id 快照（kind=receivable_detail_<crm_id>；缺失回退代理）
function financeReceivableDetail({ body }) {
  const cid = body && (body.crm_id !== undefined ? body.crm_id : body.crmId);
  if (cid === undefined || cid === null) return { code: 10011, msg: '参数错误', data: {} };
  const row = db.prepare('SELECT payload FROM finance_globals WHERE kind = ?').get('receivable_detail_' + cid);
  if (!row) return null;
  return { code: 0, msg: '成功', data: JSON.parse(row.payload) };
}

// 请款 id：9 亿号段跨 finance_globals applies 递增
function nextFinanceApplyId() {
  const row = db.prepare("SELECT payload FROM finance_globals WHERE kind = 'applies'").get();
  let m = 900000000;
  if (row) {
    try { for (const x of (JSON.parse(row.payload).applies || [])) m = Math.max(m, Number(x.project_apply_id) || 0); } catch {}
  }
  return m + 1;
}

// 请款新增：校验 project_id（10805）→ 9 亿号段 apply id 宽容落库
function financeApplyAdd({ body }) {
  const pid = body && (body.project_id !== undefined ? body.project_id : body.pid);
  if (pid === undefined || pid === null) return { code: 10805, msg: '项目不存在', data: {} };
  const proj = db.prepare('SELECT project_id, project_name FROM projects WHERE project_id = ?').get(Number(pid));
  if (!proj) return { code: 10805, msg: '项目不存在', data: {} };
  const applyId = nextFinanceApplyId();
  const row = db.prepare("SELECT payload FROM finance_globals WHERE kind = 'applies'").get();
  const applies = row ? (JSON.parse(row.payload).applies || []) : [];
  const item = { project_apply_id: applyId, project_id: Number(pid), project_name: proj.project_name || '', create_time: fmtLocalTime(), status: 0, ...body };
  applies.unshift(item);
  db.prepare("INSERT INTO finance_globals (kind, payload, updated_at) VALUES ('applies',?,?) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
    .run(JSON.stringify({ applies }), dbNow());
  logger.info('财务写接口', '请款新增落库', { project_apply_id: applyId, project_id: Number(pid) });
  return { code: 0, msg: '成功', data: { project_apply_id: applyId } };
}

// 请款详情：本地 applies 查；无 → 21006 申请人已撤回（与云端一致）
function financeApplyDetail({ body }) {
  const aid = body && (body.project_apply_id !== undefined ? body.project_apply_id : body.id);
  if (aid === undefined || aid === null) return { code: 21006, msg: '申请人已撤回', data: {} };
  const row = db.prepare("SELECT payload FROM finance_globals WHERE kind = 'applies'").get();
  if (!row) return { code: 21006, msg: '申请人已撤回', data: {} };
  const item = (JSON.parse(row.payload).applies || []).find((x) => Number(x.project_apply_id) === Number(aid));
  if (!item) return { code: 21006, msg: '申请人已撤回', data: {} };
  return { code: 0, msg: '成功', data: item };
}

// 请款状态流转/记录合并：review/reject/resubmit/withdraw/paid 更新状态，其余 action 仅合并 body
function financeApplyStatus(action, statusVal) {
  return ({ body }) => {
    const aid = body && (body.project_apply_id !== undefined ? body.project_apply_id : body.id);
    if (aid === undefined || aid === null) return { code: 21006, msg: '申请人已撤回', data: {} };
    const row = db.prepare("SELECT payload FROM finance_globals WHERE kind = 'applies'").get();
    if (!row) return { code: 21006, msg: '申请人已撤回', data: {} };
    const applies = JSON.parse(row.payload).applies || [];
    const item = applies.find((x) => Number(x.project_apply_id) === Number(aid));
    if (!item) return { code: 21006, msg: '申请人已撤回', data: {} };
    if (statusVal !== undefined) item.status = statusVal;
    Object.assign(item, body);
    item.project_apply_id = Number(aid);
    db.prepare("INSERT INTO finance_globals (kind, payload, updated_at) VALUES ('applies',?,?) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .run(JSON.stringify({ applies }), dbNow());
    logger.info('财务写接口', '请款' + action + '落库', { project_apply_id: Number(aid), status: item.status });
    return { code: 0, msg: '成功', data: {} };
  };
}

// ---------------- 合同子资源写接口辅助（预付款/坏账/审核人/付款设置，本地权威落库） ----------------
// 读/写 contract_globals 公司级快照（kind 分类）；缺失返回默认值
function contractGlobalGet(kind, def) {
  const row = db.prepare('SELECT payload FROM contract_globals WHERE kind = ?').get(kind);
  const d = row ? parseJson(row.payload, null) : null;
  return d && typeof d === 'object' ? d : (def === undefined ? null : JSON.parse(JSON.stringify(def)));
}
function contractGlobalSet(kind, data) {
  db.prepare('INSERT INTO contract_globals (kind, payload, updated_at) VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .run(kind, JSON.stringify(data), dbNow());
}

// 合同预付款（增减项）id：9 亿号段，跨合同递增，避免与云端 id 冲突
function nextContractSubId() {
  let m = 900000000;
  const scan = (d) => {
    if (!d || typeof d !== 'object') return;
    for (const it of d.items || []) m = Math.max(m, Number(it.id) || 0);
  };
  for (const r of db.prepare("SELECT payload FROM contract_payloads WHERE kind = 'prepay_list'").all()) scan(parseJson(r.payload, null));
  return m + 1;
}

// 读合同预付款（增减项）列表 {total_amount, items}；未迁移/空返回空结构
function getContractPrepay(cid) {
  const row = db.prepare('SELECT payload FROM contract_payloads WHERE contract_id = ? AND kind = ?').get(Number(cid), 'prepay_list');
  const d = row ? parseJson(row.payload, null) : null;
  if (d && typeof d === 'object' && Array.isArray(d.items)) return d;
  return { total_amount: '0', items: [] };
}
function saveContractPrepay(cid, data) {
  db.prepare('INSERT INTO contract_payloads (contract_id, kind, payload, updated_at) VALUES (?,?,?,?) ON CONFLICT(contract_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .run(Number(cid), 'prepay_list', JSON.stringify(data), dbNow());
}

// 从部门成员快照（crm_globals department_members）按云端 user_id 查用户信息
function findContractUserById(uid) {
  const row = db.prepare("SELECT payload FROM crm_globals WHERE kind = 'department_members'").get();
  if (!row) return null;
  const d = parseJson(row.payload, {});
  for (const m of d.department_member_list || []) {
    for (const u of m.user_info || []) {
      if (Number(u.user_id) === Number(uid)) return u;
    }
  }
  return null;
}

// 本地时间格式化 YYYY-MM-DD HH:mm（与云端预付款 create_time 格式一致）
function fmtLocalTime(d) {
  const p = (x) => String(x).padStart(2, '0');
  const t = d || new Date();
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
}

// 更新审核人设置：check_type 0=合同审核人(contract_reviewers) 1=收款退款审核人(apply_refund_reviewers)
function updateContractReviewer(setting, companyId, checkType, reviewer) {
  let comp = (setting.companies || []).find((c) => Number(c.company_id) === Number(companyId));
  if (!comp) {
    comp = { company_id: Number(companyId), company_name: '', pay_times: 3, contract_reviewers: {}, apply_refund_reviewers: {} };
    if (!Array.isArray(setting.companies)) setting.companies = [];
    setting.companies.push(comp);
  }
  const key = Number(checkType) === 1 ? 'apply_refund_reviewers' : 'contract_reviewers';
  comp[key] = reviewer || {};
  return comp;
}


// ---------------- 写接口通用辅助（模式 A：本地权威，写操作直接落库 SQLite，不再代理） ----------------
// 安全解析 JSON，失败返回 fallback（null/坏JSON/数字等异常 payload 兜底）
function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// 通用写落库：把写接口 body 合并进 list_json/detail_json + 更新常用列；本地记录同步 local_records
// opts: { table, idCol, id, body, ljCol, djCol, cols(映射 body字段名->列名), localEntity }
// 返回：true=已落库；false=记录不存在且非本地新建（调用方返回对应错误码）
function writeRecord(opts) {
  const { table, idCol, id, body, ljCol, djCol, cols, localEntity } = opts;
  if (id === null || id === undefined || body === null || typeof body !== 'object') return false;
  const nid = Number(id);
  const row = db.prepare('SELECT * FROM ' + table + ' WHERE ' + idCol + ' = ?').get(nid);
  // 记录不存在：本地新建记录直接更新 local_records（9 亿号段）
  if (!row) {
    const lr = localGet(localEntity, nid);
    if (lr) {
      localUpsert(localEntity, nid, { ...lr.payload, ...body });
      return true;
    }
    return false;
  }
  const { [idCol]: _idKey, ...rest } = body; // 排除 id 字段，避免污染 json
  const lj = parseJson(row[ljCol], {});
  const dj = djCol ? parseJson(row[djCol], {}) : null;
  const newLj = { ...lj, ...rest };
  const newDj = dj ? { ...dj, ...rest } : null;
  const upd = { [ljCol]: JSON.stringify(newLj), updated_at: dbNow() };
  if (newDj) upd[djCol] = JSON.stringify(newDj);
  if (cols) {
    for (const [bk, col] of Object.entries(cols)) {
      if (rest[bk] !== undefined) upd[col] = rest[bk];
    }
  }
  const cArr = Object.keys(upd);
  db.prepare('UPDATE ' + table + ' SET ' + cArr.map((c) => c + '=?').join(',') + ' WHERE ' + idCol + ' = ?')
    .run(...cArr.map((c) => (upd[c] === undefined ? '' : upd[c])), nid);
  // 本地新建记录：同步 local_records，保持本地权威完整对象一致
  if (row.is_local && localEntity) {
    localUpsert(localEntity, nid, { ...dj, ...lj, ...rest });
  }
  return true;
}

// 通用软删/恢复：deleted 列 + 本地记录同步；返回 true=已处理
function markEntityDeleted(table, idCol, id, localEntity, deleted) {
  const nid = Number(id);
  const row = db.prepare('SELECT * FROM ' + table + ' WHERE ' + idCol + ' = ?').get(nid);
  if (!row) {
    const lr = localGet(localEntity, nid);
    if (lr) {
      if (deleted) localMarkDeleted(localEntity, nid);
      else localUpsert(localEntity, nid, { ...lr.payload });
      return true;
    }
    return false;
  }
  db.prepare('UPDATE ' + table + ' SET deleted = ?, updated_at = ? WHERE ' + idCol + ' = ?').run(deleted ? 1 : 0, dbNow(), nid);
  if (row.is_local) {
    if (deleted) localMarkDeleted(localEntity, nid);
    else localUpsert(localEntity, nid, { ...parseJson(row.detail_json, {}), ...parseJson(row.list_json, {}) });
  }
  return true;
}

// 云端登录：联网时获取云端凭证，用于代理云端接口（断网时返回 null）
function cloudLogin(phone, pwd, _tries) {
  const tries = _tries || 0;
  return new Promise((resolve) => {
    const data = JSON.stringify({ type: 1, phone_number: phone, pwd: String(pwd) });
    const r = https.request({
      host: 'lzapi.e-shigong.com', port: 443, method: 'POST', path: '/api/user/login/',
      // platform=1(浏览器模式) 会话：后续业务接口带 platform=1 即可认证，无需 cookie
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'platform': '1' }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.code === 0 && j.data) { resolve(j); return; }
        } catch {}
        // 失败重试一次
        if (tries < 1) { resolve(cloudLogin(phone, pwd, tries + 1)); return; }
        resolve(null);
      });
    });
    r.on('error', () => {
      if (tries < 1) { resolve(cloudLogin(phone, pwd, tries + 1)); return; }
      resolve(null);
    });
    r.setTimeout(10000, () => r.destroy());
    r.write(data); r.end();
  });
}

// 云端企业后台登录：会话在 Set-Cookie 的 company_session_id 中（企业后台接口认证用），
// 解析后返回 { session_id, company_id, phone } 形式，供 getCloudSession 映射
function cloudCompanyLogin(adminName, adminPwd, _tries) {
  const tries = _tries || 0;
  return new Promise((resolve) => {
    const data = JSON.stringify({ admin_name: String(adminName), admin_pwd: String(adminPwd) });
    const r = https.request({
      host: 'lzapi.e-shigong.com', port: 443, method: 'POST', path: '/api/company/login/',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'platform': '1' }
    }, (res) => {
      let buf = '';
      const setCookie = String(res.headers['set-cookie'] || '');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.code === 0 && j.data) {
            const m = /company_session_id=([^;]+)/.exec(setCookie);
            resolve({
              code: 0,
              data: {
                session_id: m ? m[1] : '',
                company_id: j.data.company_id || 0,
                phone: j.data.phone_number || '',
                company_name: j.data.company_name || ''
              }
            });
            return;
          }
        } catch {}
        if (tries < 1) { resolve(cloudCompanyLogin(adminName, adminPwd, tries + 1)); return; }
        resolve(null);
      });
    });
    r.on('error', () => {
      if (tries < 1) { resolve(cloudCompanyLogin(adminName, adminPwd, tries + 1)); return; }
      resolve(null);
    });
    r.setTimeout(10000, () => r.destroy());
    r.write(data); r.end();
  });
}

// 供 server.js 代理使用：把本地 session 映射为云端凭证
function getCloudSession(headers) {
  const s = getSession(headers);
  if (!s || !s.cloud_session_id) return null;
  return { session_id: s.cloud_session_id, user_id: s.cloud_user_id, company_id: s.cloud_company_id, phone: s.cloud_phone };
}

// 云端凭证失效(10012)时重新登录云端并更新缓存，供代理重试
function refreshCloudSession(headers) {
  return new Promise((resolve) => {
    const s = getSession(headers);
    if (!s) { logger.warn('云端会话', '刷新被跳过：本地会话不存在', {}); resolve(null); return; }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!user || !user.password_plain) { logger.warn('云端会话', '刷新被跳过：无明文密码', { user_id: s.user_id }); resolve(null); return; }
    cloudLogin(user.phone, user.password_plain).then((cloud) => {
      if (cloud && cloud.code === 0 && cloud.data) {
        const d = cloud.data;
        db.prepare('UPDATE sessions SET cloud_session_id = ?, cloud_user_id = ?, cloud_company_id = ?, cloud_phone = ? WHERE session_id = ?')
          .run(String(d.session_id || ''), Number(d.user_id || 0), Number(d.company_id || 0), String(d.user_phone || ''), s.session_id);
        logger.info('云端会话', '刷新成功', { phone: user.phone, cloud_user_id: d.user_id });
        resolve({ session_id: d.session_id, user_id: d.user_id, company_id: d.company_id, phone: d.user_phone });
      } else {
        logger.warn('云端会话', '刷新失败：云端登录未成功', { phone: user.phone, cloud_code: cloud && cloud.code });
        resolve(null);
      }
    });
  });
}

// ---------------- 处理器 ----------------
// 本地新建项目（v2/v3 共用）：生成 9 亿号段 project_id 并落库
function handleProjectCreate(body) {
  if (!body || (!body.crm_id && !body.area_name && !body.project_name)) return { code: 10011, msg: '参数错误', data: {} };
  const projectId = localNextId('project');
  const payload = { project_id: projectId, status: 1, project_status: 1, ...body };
  localUpsert('project', projectId, payload);
  // 立即落 projects 表（详情/写接口即时可查；ensure 归并遇已存在记录跳过，不冲突）
  db.prepare('INSERT INTO projects (project_id, project_name, status, project_status, list_json, detail_json, is_local, deleted, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(projectId, String(payload.project_name || ''), Number(payload.status || 1), Number(payload.project_status || payload.status || 1), JSON.stringify(payload), '{}', 1, 0, dbNow(), dbNow());
  return { code: 0, msg: '创建成功', data: { project_id: projectId } };
}

const handlers = {
  // 登录
  'POST /user/login/': async ({ body }) => {
    const phone_number = body && body.phone_number;
    const pwd = String(body && body.pwd || '');
    const type = body && body.type; // 1=密码 2=验证码
    // 参数校验：畸形请求体返回参数错误，避免服务器崩溃
    if (!phone_number) return { code: 10011, msg: '参数错误', data: {} };
    if (type === 2) {
      // 验证码登录：本地固定验证码 123456
      if (body.code !== '123456') return { code: 10011, msg: '验证码错误', data: {} };
    } else {
      const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone_number);
      // 密码兼容双体系：user.password=后台口令(123456)哈希；password_plain=前台云端口令(123456789)
      if (!user || (user.password !== md5(pwd) && user.password_plain !== pwd && md5(user.password_plain || '') !== md5(pwd))) {
        return { code: 10011, msg: '手机号或密码错误', data: {} };
      }
    }
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone_number);
    if (!user) return { code: 10011, msg: '用户未在系统中注册', data: {} };
    const sessionId = crypto.randomBytes(16).toString('hex');
    // 联网时同步获取云端凭证（用于代理未本地化的接口）
    // 注意：云端账号密码与本地登录口令可能不同，云端同步必须用 users.password_plain
    let cloud = null;
    try { cloud = await cloudLogin(phone_number, user.password_plain || pwd); } catch {}
    const cloudOk = cloud && cloud.code === 0 && cloud.data;
    // 云端响应字段可能缺失（如非企业用户无 company_id），兜底避免 undefined 绑定 SQLite 报错
    const cSessionId = cloudOk ? String(cloud.data.session_id || '') : '';
    const cUserId = cloudOk ? Number(cloud.data.user_id || 0) : 0;
    const cCompanyId = cloudOk ? Number(cloud.data.company_id || 0) : 0;
    const cPhone = cloudOk ? String(cloud.data.user_phone || '') : '';
    logger.info('登录', '本地登录', { phone: phone_number, type: type === 2 ? '验证码' : '密码', cloudOk, user_id: user.id, company_id: user.company_id });
    if (!cloudOk) logger.warn('登录', '云端凭证获取失败（断网或云端异常），未本地化接口将离线', { phone: phone_number });
    db.prepare('INSERT INTO sessions (session_id, user_id, created_at, cloud_session_id, cloud_user_id, cloud_company_id, cloud_phone) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, user.id, new Date().toISOString(), cSessionId, cUserId, cCompanyId, cPhone);
    // 以云端登录响应为模板（本地管理员拥有全部权限），替换动态字段
    const d = JSON.parse(JSON.stringify(mock('login').data));
    // user_id 用云端真实 id（前端"我的客户"等页面按当前用户 filter_user_ids 筛选，
    // 本地 id(1) 在云端不存在会导致列表为空；云端不可用时回退本地 id）
    d.user_id = cloudOk ? Number(cloud.data.user_id || user.id) : user.id;
    d.user_name = user.name;
    d.user_phone = user.phone;
    d.company_name = user.company_name;
    // NIM 聊天登录依赖 user_accid + user_token（两者配对，必须来自云端真实云信凭证；
    // 云端不可用时回退登录模板中的真实快照凭证，保证云信能连上）
    d.user_accid = cloudOk ? (cloud.data.user_accid || d.user_accid || '') : (d.user_accid || '');
    d.user_token = cloudOk ? (cloud.data.user_token || d.user_token || '') : (d.user_token || crypto.randomBytes(16).toString('hex'));
    d.session_id = sessionId;
    // 权限按账号身份区分：管理员保留云端/模板完整权限；
    // 非管理员权限为空（与云端真实行为一致，仅保留基础功能）。
    const isAdmin = !!user.is_administrator;
    d.is_administrator = isAdmin ? 1 : 0;
    d.permissions = isAdmin
      ? (cloudOk && Array.isArray(cloud.data.permissions) ? cloud.data.permissions : d.permissions || [])
      : [];
    d.permission_groups = isAdmin
      ? (cloudOk && Array.isArray(cloud.data.permission_groups) ? cloud.data.permission_groups : d.permission_groups || [])
      : [];
    d.finance_permission = isAdmin ? 1 : 0;
    d.project_permission = isAdmin ? 1 : 0;
    d.is_staff = isAdmin ? 1 : 0;
    d.can_business = isAdmin ? 1 : 0;
    // 补全前端 store 用到的字段（登录模板缺省时兜底）
    if (!('permission' in d)) d.permission = d.permissions || [];
    if (!('web_permission_codes' in d)) d.web_permission_codes = d.permissions || [];
    return { code: 0, msg: '成功', data: d };
  },

  // 短信验证码：本地不真正发短信，返回成功（固定验证码 123456）
  'POST /user/smscode/': () => ok({}),

  // 用户所属公司列表（企业通讯录顶部公司切换器 $getCompanyList 依赖）
  // 前端映射：companies.map((t) => ({ id: t.company_id, title: t.company_name }))
  // 数据源：当前登录用户 users.company_id/company_name，公司名优先 company_info 快照真实名称
  'POST /user/company/list/': ({ headers }) => {
    let companyId = 6808;
    let companyName = '本地企业';
    const sess = getSession(headers || {});
    if (sess) {
      const u = db.prepare('SELECT company_id, company_name FROM users WHERE id = ?').get(sess.user_id);
      if (u && u.company_id) {
        companyId = Number(u.company_id);
        if (u.company_name) companyName = u.company_name;
      }
    }
    try {
      const info = db.prepare('SELECT payload FROM company_info WHERE id = 1').get();
      if (info) {
        const p = JSON.parse(info.payload);
        if (p && p.name) companyName = p.name;
      }
    } catch {}
    return ok({ companies: [{ company_id: companyId, company_name: companyName }] });
  },

  // 企业后台登录（enterprise SPA 调 POST /api/company/login/）
  // 密码登录 body: { admin_name, admin_pwd }（admin_pwd 为 MD5，主应用跳转时直接传 MD5）
  // 验证码登录 body: { type: 0, phone_number, code }（本地固定验证码 123456）
  'POST /company/login/': async ({ body }) => {
    const adminName = String((body && (body.admin_name || body.phone_number)) || '').trim();
    const adminPwd = String((body && body.admin_pwd) || '');
    const type = body && body.type;
    if (!adminName) return { code: 10011, msg: '参数错误', data: {} };
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(adminName);
    if (!user) return { code: 10011, msg: '账号不存在', data: {} };
    if (type === 0) {
      if (body.code !== '123456') return { code: 10011, msg: '验证码错误', data: {} };
    } else if (adminPwd !== user.password && md5(adminPwd) !== user.password) {
      return { code: 10011, msg: '账号或密码错误', data: {} };
    }
    // 企业后台仅限管理员：非管理员（普通成员/设计师等）登录后台属越权，直接拒绝
    if (!user.is_administrator) {
      return { code: 10011, msg: '无权限，仅管理员可登录企业后台', data: {} };
    }
    const sessionId = crypto.randomBytes(16).toString('hex');
    // 联网时同步获取云端凭证（用于代理企业后台未本地化的接口）
    // 企业后台接口按 company 会话认证：云端登录走 /company/login/ 并解析 Set-Cookie 的 company_session_id。
    // 密码用用户本次输入（body.admin_pwd：表单为明文，主应用跳转为 MD5；云端两者均接受），
    // 不能用 users.password_plain（那是前台云端密码，与后台密码可能不同）
    let cloud = null;
    try { cloud = await cloudCompanyLogin(user.phone, String(body.admin_pwd || user.password_plain || '')); } catch {}
    const cloudOk = cloud && cloud.code === 0 && cloud.data;
    // 云端响应字段可能缺失（如非企业用户无 company_id），兜底避免 undefined 绑定 SQLite 报错
    const cSessionId = cloudOk ? String(cloud.data.session_id || '') : '';
    const cUserId = cloudOk ? Number(cloud.data.user_id || 0) : 0;
    const cCompanyId = cloudOk ? Number(cloud.data.company_id || 0) : 0;
    const cPhone = cloudOk ? String(cloud.data.phone || '') : '';
    logger.info('企业后台登录', '本地登录', { phone: user.phone, cloudOk, user_id: user.id, company_id: user.company_id });
    db.prepare('INSERT INTO sessions (session_id, user_id, created_at, cloud_session_id, cloud_user_id, cloud_company_id, cloud_phone) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, user.id, new Date().toISOString(), cSessionId, cUserId, cCompanyId, cPhone);
    const d = JSON.parse(JSON.stringify(mock('login').data));
    d.user_id = user.id;
    d.user_name = user.name;
    d.user_phone = user.phone;
    d.phone_number = user.phone;            // 企业后台 saveUserSession 存 mobile 用
    d.administrator_name = user.name;        // 企业后台 saveUserSession 存 username 用
    d.company_name = (() => {
      // 真实公司名优先公司信息快照（原站头部显示"网筑(广州)装饰工程有限公司"）
      try {
        const info = db.prepare('SELECT payload FROM company_info WHERE id = 1').get();
        if (info && info.payload) { const p = JSON.parse(info.payload); if (p && p.name) return p.name; }
      } catch (e) { /* keep fallback */ }
      return user.company_name;
    })();
    d.company_id = user.company_id;
    d.company_type = 0;                      // 企业后台要求公司类型为 0，否则提示"账号不存在"
    d.is_administrator = user.is_administrator ? 1 : 0;
    d.is_superadmin = user.is_administrator ? 1 : 0;
    d.is_parent = user.is_administrator ? 1 : 0;
    d.first_login = 0;
    d.user_token = (cloudOk && cloud.data.user_token) ? cloud.data.user_token : crypto.randomBytes(16).toString('hex');
    d.session_id = sessionId;
    // 企业后台权限码为 4xxxx 段。必须返回数字数组：enterprise SPA 登录成功后会对
    // web_permission_codes 再做一次 Base64.encode，后端若预编码会导致双重编码，
    // 守卫 Number(Base64.decode(...)) 得 NaN，权限校验恒失败、自动登录卡死。
    // 对齐原版 /company/login/ 返回的 18 个权限码（406789/41002 仅原版常量，未下发）
    d.web_permission_codes = user.is_administrator
      ? [40001, 40002, 40003, 40004, 40005, 40006, 40007, 40008, 40009, 40010, 40011, 41001, 41003, 41004, 42001, 43001, 43002, 43003]
      : [];
    return { code: 0, msg: '成功', data: d };
  },

  // 企业后台权限组列表（enterprise SPA 登录后 getCompanyPermission 调用；页面级权限组也走该接口）
  // permission_groups：权限码数组（前端会 Base64 编码后写入 sessionStorage.permission_group）
  // 非管理员（如设计师）Web 端权限码为空，仅保留基础功能；管理员返回完整 4xxxx 权限码
  // 对齐原版 /company/login/ 返回的 18 个权限码（406789/41002 仅原版常量，未下发）
  'POST /company/permission_group/list/': ({ headers }) => {
    const s = getSession(headers);
    const u = s ? db.prepare('SELECT is_administrator FROM users WHERE id = ?').get(s.user_id) : null;
    const isAdmin = u && u.is_administrator;
    // 对齐原站：permission_groups 是权限组 ID 列表（管理员 7 组），paid_function_ids 为空数组
    const groups = isAdmin ? [1, 2, 10, 11, 12, 13, 14] : [];
    return { code: 0, msg: '成功', data: { permission_groups: groups, paid_function_ids: [] } };
  },

  // 企业后台账号信息（账号信息弹窗：管理员/手机号/账号）
  'GET /company/account/info/': ({ headers }) => {
    const s = getSession(headers);
    const u = s ? db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) : null;
    if (!u) return { code: 10012, msg: '登录失效', data: {} };
    let companyName = u.company_name;
    try {
      const info = db.prepare('SELECT payload FROM company_info WHERE id = 1').get();
      if (info && info.payload) { const p = JSON.parse(info.payload); if (p && p.name) companyName = p.name; }
    } catch (e) { /* keep fallback */ }
    return { code: 0, msg: '成功', data: { user_id: u.id, admin_user_name: u.name, user_name: u.name, phone_number: u.phone, account: u.phone, company_id: u.company_id, company_name: companyName } };
  },

  // 系统角色类型列表（添加成员弹窗“角色配置”区域；数据抓取自云端真实接口，1:1 快照）
  // selected 按公司角色配置动态计算（role/add 启用后 selected=1，与云端一致）
  'POST /company/role/sys_role_type/list/': () => {
    const sys_role_types = [
      { role_type_id: 7, role_type_name: '管理层角色', roles: [
        { role_id: 31, role_name: '店面经理', selected: 1 }, { role_id: 32, role_name: '总经理', selected: 1 },
        { role_id: 33, role_name: '董事长', selected: 1 }, { role_id: 37, role_name: '系统管理员', selected: 1 },
        { role_id: 57, role_name: '部长', selected: 1 }, { role_id: 58, role_name: '副部长', selected: 1 },
        { role_id: 73, role_name: '合伙人', selected: 1 }, { role_id: 102, role_name: '副总经理', selected: 0 },
        { role_id: 106, role_name: '董事', selected: 0 }, { role_id: 107, role_name: '店长', selected: 0 },
        { role_id: 116, role_name: '事业合伙人', selected: 0 }, { role_id: 123, role_name: '店长经理', selected: 0 },
        { role_id: 134, role_name: '店面主管', selected: 0 }, { role_id: 163, role_name: '分店经理', selected: 0 },
        { role_id: 185, role_name: '技术总监', selected: 0 }, { role_id: 190, role_name: '售后部经理', selected: 0 },
        { role_id: 228, role_name: '总经理助理', selected: 0 }
      ] },
      { role_type_id: 1, role_type_name: '设计部角色', roles: [
        { role_id: 1, role_name: '设计师', selected: 1 }, { role_id: 2, role_name: '设计助理', selected: 0 },
        { role_id: 3, role_name: '制图员', selected: 1 }, { role_id: 4, role_name: '软装设计', selected: 1 },
        { role_id: 5, role_name: '设计主管', selected: 1 }, { role_id: 6, role_name: '设计总监', selected: 1 },
        { role_id: 44, role_name: '全屋定制设计师', selected: 1 }, { role_id: 50, role_name: '机电设计师', selected: 1 },
        { role_id: 75, role_name: '橱柜设计师', selected: 1 }, { role_id: 89, role_name: '全屋定制设计主管', selected: 0 },
        { role_id: 90, role_name: '审单员', selected: 1 }, { role_id: 91, role_name: '排版专员', selected: 0 },
        { role_id: 92, role_name: '厂方专员', selected: 0 }, { role_id: 101, role_name: '深化设计师', selected: 0 },
        { role_id: 103, role_name: '表现设计师', selected: 0 }, { role_id: 109, role_name: '工装设计师', selected: 0 },
        { role_id: 110, role_name: '设计经理', selected: 0 }, { role_id: 114, role_name: '效果图设计师', selected: 0 },
        { role_id: 115, role_name: '制图设计师', selected: 0 }, { role_id: 121, role_name: '主材设计师', selected: 0 },
        { role_id: 124, role_name: '大宅设计师', selected: 0 }, { role_id: 126, role_name: '主案设计师', selected: 0 },
        { role_id: 127, role_name: '设计师角色', selected: 0 }, { role_id: 128, role_name: '制图员角色', selected: 0 },
        { role_id: 129, role_name: '设计总监角色', selected: 0 }, { role_id: 139, role_name: '设计老师', selected: 0 },
        { role_id: 143, role_name: '设计副总监', selected: 0 }, { role_id: 144, role_name: '常务副总监', selected: 0 },
        { role_id: 154, role_name: '景观设计师', selected: 0 }, { role_id: 157, role_name: '服务设计师', selected: 0 },
        { role_id: 166, role_name: '室内设计师', selected: 0 }, { role_id: 170, role_name: '全案设计师', selected: 0 },
        { role_id: 178, role_name: '全屋定制设计经理', selected: 0 }, { role_id: 181, role_name: '设计部总监', selected: 0 },
        { role_id: 186, role_name: '施工图设计师', selected: 0 }, { role_id: 191, role_name: '见习设计师', selected: 0 },
        { role_id: 201, role_name: '设计人员', selected: 0 }, { role_id: 212, role_name: '设计部合伙人', selected: 0 },
        { role_id: 217, role_name: '设计师~', selected: 0 }, { role_id: 223, role_name: '预算成本查看', selected: 0 },
        { role_id: 224, role_name: '硬装设计师', selected: 0 }, { role_id: 225, role_name: '收款管理', selected: 0 },
        { role_id: 233, role_name: '转单设计师', selected: 0 }, { role_id: 245, role_name: '整装设计师', selected: 0 },
        { role_id: 252, role_name: '设计角色', selected: 0 }, { role_id: 253, role_name: '全局收款查看', selected: 0 },
        { role_id: 258, role_name: '顾问设计师.', selected: 0 }, { role_id: 259, role_name: '深化设计师.', selected: 0 }
      ] },
      { role_type_id: 2, role_type_name: '市场部角色', roles: [
        { role_id: 7, role_name: '家装顾问', selected: 1 }, { role_id: 8, role_name: '客服', selected: 1 },
        { role_id: 9, role_name: '市场总监', selected: 1 }, { role_id: 39, role_name: '销售管理', selected: 1 },
        { role_id: 45, role_name: '运营总监', selected: 1 }, { role_id: 49, role_name: '新媒体', selected: 1 },
        { role_id: 51, role_name: '视频制作', selected: 1 }, { role_id: 53, role_name: '社群运营', selected: 1 },
        { role_id: 61, role_name: '经营导师', selected: 0 }, { role_id: 74, role_name: '业务经理', selected: 1 },
        { role_id: 82, role_name: '导购', selected: 1 }, { role_id: 83, role_name: '电器售后', selected: 1 },
        { role_id: 88, role_name: '市场专员', selected: 0 }, { role_id: 95, role_name: '市场部门主管', selected: 0 },
        { role_id: 98, role_name: '售后', selected: 0 }, { role_id: 100, role_name: '销售顾问', selected: 0 },
        { role_id: 108, role_name: '营销总监', selected: 0 }, { role_id: 117, role_name: '客服经理', selected: 0 },
        { role_id: 118, role_name: '客户经理', selected: 0 }, { role_id: 145, role_name: '公海查看角色', selected: 0 },
        { role_id: 146, role_name: '销售', selected: 0 }, { role_id: 147, role_name: '组长', selected: 0 },
        { role_id: 148, role_name: '市场部长', selected: 0 }, { role_id: 150, role_name: '销售经理', selected: 0 },
        { role_id: 168, role_name: '市场副总监', selected: 0 }, { role_id: 172, role_name: '智能产品主管', selected: 0 },
        { role_id: 174, role_name: '智能产品专员', selected: 0 }, { role_id: 175, role_name: '全屋用水业务主管', selected: 0 },
        { role_id: 177, role_name: '运营专员', selected: 0 }, { role_id: 187, role_name: '摄像后期', selected: 0 },
        { role_id: 188, role_name: '短视频', selected: 0 }, { role_id: 193, role_name: '废单查看权限', selected: 0 },
        { role_id: 196, role_name: '渠道总监', selected: 0 }, { role_id: 203, role_name: '渠道销售', selected: 0 },
        { role_id: 204, role_name: '品推专员', selected: 0 }, { role_id: 205, role_name: '品推总监', selected: 0 },
        { role_id: 220, role_name: '设置废单', selected: 0 }, { role_id: 229, role_name: '事业部经理', selected: 0 },
        { role_id: 231, role_name: '品推经理', selected: 0 }, { role_id: 232, role_name: '地推经理', selected: 0 },
        { role_id: 234, role_name: '软装店长', selected: 0 }, { role_id: 235, role_name: '合同查看（市场）', selected: 0 },
        { role_id: 250, role_name: '家装经理', selected: 0 }
      ] },
      { role_type_id: 3, role_type_name: '施工部角色', roles: [
        { role_id: 10, role_name: '质检员', selected: 1 }, { role_id: 11, role_name: '项目管家', selected: 1 },
        { role_id: 12, role_name: '工班长', selected: 1 }, { role_id: 13, role_name: '施工人员', selected: 0 },
        { role_id: 14, role_name: '施工部经理', selected: 1 }, { role_id: 15, role_name: '施工部总监', selected: 1 },
        { role_id: 63, role_name: '项目合同查看角色', selected: 1 }, { role_id: 71, role_name: '监理', selected: 1 },
        { role_id: 79, role_name: '安装员', selected: 1 }, { role_id: 80, role_name: '仓库管理员', selected: 1 },
        { role_id: 85, role_name: '项目经理', selected: 1 }, { role_id: 86, role_name: '巡检总管', selected: 1 },
        { role_id: 87, role_name: '巡检主管', selected: 1 }, { role_id: 97, role_name: '工程总监', selected: 1 },
        { role_id: 104, role_name: '工程文员', selected: 1 }, { role_id: 119, role_name: '安全员', selected: 1 },
        { role_id: 120, role_name: '工程部经理助理', selected: 1 }, { role_id: 125, role_name: '工程助理', selected: 1 },
        { role_id: 130, role_name: '收款查看权限角色', selected: 1 }, { role_id: 132, role_name: '工程客服', selected: 1 },
        { role_id: 136, role_name: '工程部经理', selected: 1 }, { role_id: 140, role_name: '工程经理', selected: 1 },
        { role_id: 142, role_name: '工程副总监', selected: 1 }, { role_id: 152, role_name: '普工', selected: 1 },
        { role_id: 155, role_name: '测试项目', selected: 1 }, { role_id: 206, role_name: '巡检跟进人员', selected: 1 },
        { role_id: 213, role_name: '合同赠品查看角色', selected: 1 }, { role_id: 214, role_name: '预算查看角色', selected: 1 },
        { role_id: 219, role_name: '合同查看', selected: 1 }, { role_id: 221, role_name: '施工部主管', selected: 1 },
        { role_id: 222, role_name: '付款汇总查看', selected: 1 }, { role_id: 237, role_name: '美容师', selected: 0 },
        { role_id: 240, role_name: '工程行政主管', selected: 1 }, { role_id: 241, role_name: '行政部总监', selected: 0 },
        { role_id: 246, role_name: '售后汇总', selected: 0 }, { role_id: 247, role_name: '巡检汇总', selected: 1 },
        { role_id: 248, role_name: '待办汇总', selected: 0 }, { role_id: 249, role_name: '工地打卡汇总', selected: 0 },
        { role_id: 262, role_name: '项目工长', selected: 0 }, { role_id: 265, role_name: '交付经理', selected: 0 }
      ] },
      { role_type_id: 4, role_type_name: '材料部角色', roles: [
        { role_id: 16, role_name: '主材专员', selected: 1 }, { role_id: 17, role_name: '辅料专员', selected: 1 },
        { role_id: 18, role_name: '机电专员', selected: 0 }, { role_id: 19, role_name: '预核算专员', selected: 1 },
        { role_id: 20, role_name: '材料总监', selected: 1 }, { role_id: 54, role_name: '主材经理', selected: 1 },
        { role_id: 62, role_name: '物料商', selected: 0 }, { role_id: 70, role_name: '安装总监', selected: 1 },
        { role_id: 72, role_name: '主材采购员', selected: 1 }, { role_id: 99, role_name: '采购', selected: 0 },
        { role_id: 105, role_name: '仓库主管', selected: 0 }, { role_id: 149, role_name: '拆单员', selected: 0 },
        { role_id: 151, role_name: '采购专员', selected: 0 }, { role_id: 153, role_name: '库管', selected: 0 },
        { role_id: 156, role_name: '材料员', selected: 0 }, { role_id: 159, role_name: '安装主管角色', selected: 0 },
        { role_id: 160, role_name: '定制专员', selected: 0 }, { role_id: 161, role_name: '定制下单专员', selected: 0 },
        { role_id: 162, role_name: '审价专员', selected: 0 }, { role_id: 164, role_name: '材料专员', selected: 0 },
        { role_id: 182, role_name: '材料订单专员', selected: 0 }, { role_id: 197, role_name: '测试订单权限', selected: 0 },
        { role_id: 227, role_name: '查看自己待审批订单', selected: 0 }, { role_id: 236, role_name: '送货员', selected: 0 },
        { role_id: 238, role_name: '项目付款', selected: 0 }, { role_id: 251, role_name: '合同操作及查看', selected: 0 },
        { role_id: 254, role_name: '设计师下单员', selected: 0 }, { role_id: 256, role_name: '品控', selected: 0 },
        { role_id: 257, role_name: '产品总监', selected: 0 }, { role_id: 264, role_name: '仓库专员', selected: 0 }
      ] },
      { role_type_id: 5, role_type_name: '行政部角色', roles: [
        { role_id: 21, role_name: '行政', selected: 1 }, { role_id: 22, role_name: '人事', selected: 1 },
        { role_id: 23, role_name: '高管助理', selected: 1 }, { role_id: 24, role_name: '后勤', selected: 1 },
        { role_id: 25, role_name: '售后专员', selected: 0 }, { role_id: 26, role_name: '售后主管', selected: 0 },
        { role_id: 27, role_name: '行政总监', selected: 1 }, { role_id: 60, role_name: '经理', selected: 1 },
        { role_id: 111, role_name: '司机', selected: 0 }, { role_id: 112, role_name: '前台', selected: 0 },
        { role_id: 122, role_name: '统计员', selected: 0 }, { role_id: 133, role_name: '行政经理', selected: 0 },
        { role_id: 138, role_name: '保洁', selected: 0 }, { role_id: 167, role_name: '行政主管', selected: 0 },
        { role_id: 179, role_name: '管培生', selected: 0 }, { role_id: 184, role_name: '办公室主任', selected: 0 },
        { role_id: 195, role_name: '考勤管理审批角色', selected: 0 }, { role_id: 208, role_name: '业务数据员', selected: 0 },
        { role_id: 230, role_name: '保安', selected: 0 }
      ] },
      { role_type_id: 6, role_type_name: '财务部角色', roles: [
        { role_id: 28, role_name: '财务', selected: 1 }, { role_id: 29, role_name: '出纳', selected: 1 },
        { role_id: 30, role_name: '财务总监', selected: 1 }, { role_id: 84, role_name: '出纳(有限权限)', selected: 0 },
        { role_id: 96, role_name: '核算员', selected: 0 }, { role_id: 135, role_name: '财务专员', selected: 0 },
        { role_id: 141, role_name: '财务助理', selected: 0 }, { role_id: 158, role_name: '财务角色', selected: 0 },
        { role_id: 169, role_name: '材料成本专员', selected: 0 }, { role_id: 171, role_name: '财务主管', selected: 0 },
        { role_id: 176, role_name: '收银', selected: 0 }, { role_id: 180, role_name: '出纳助理', selected: 0 },
        { role_id: 183, role_name: '会计', selected: 0 }, { role_id: 192, role_name: '工程出纳', selected: 0 },
        { role_id: 194, role_name: '统计财务', selected: 0 }, { role_id: 209, role_name: '付款审批查看', selected: 0 },
        { role_id: 216, role_name: '账户管理员', selected: 0 }, { role_id: 226, role_name: '项目流水', selected: 0 },
        { role_id: 239, role_name: '收款专员', selected: 0 }, { role_id: 255, role_name: '付款审批专员', selected: 0 },
        { role_id: 263, role_name: '出纳专员', selected: 0 }
      ] },
      { role_type_id: 8, role_type_name: '企划部角色', roles: [
        { role_id: 34, role_name: '文案', selected: 0 }, { role_id: 35, role_name: '美图', selected: 0 },
        { role_id: 36, role_name: '企划总监', selected: 0 }, { role_id: 78, role_name: '企划', selected: 1 },
        { role_id: 113, role_name: '商务经理', selected: 0 }, { role_id: 131, role_name: '品牌经理 ', selected: 0 },
        { role_id: 198, role_name: '主播', selected: 0 }, { role_id: 199, role_name: '摄影师', selected: 0 },
        { role_id: 215, role_name: '企划主管', selected: 0 }
      ] },
      { role_type_id: 9, role_type_name: '预算部角色', roles: [
        { role_id: 38, role_name: '预算员', selected: 1 }, { role_id: 46, role_name: '预算总监', selected: 1 },
        { role_id: 137, role_name: '预算专员', selected: 0 }, { role_id: 165, role_name: '成本专员', selected: 0 },
        { role_id: 200, role_name: '预算经理', selected: 0 }, { role_id: 202, role_name: '成本查看角色', selected: 0 }
      ] },
      { role_type_id: 11, role_type_name: '产品部角色', roles: [
        { role_id: 81, role_name: '数据员', selected: 1 }, { role_id: 218, role_name: '下单员', selected: 0 }
      ] },
      { role_type_id: 13, role_type_name: '成控部', roles: [
        { role_id: 260, role_name: '成控经理', selected: 0 }, { role_id: 261, role_name: '成控专员', selected: 0 }
      ] }
    ];
    const cfgIds = new Set();
    for (const rt of roleStoreJson().role_types) for (const r of (rt.roles || [])) cfgIds.add(Number(r.role_id));
    for (const t of sys_role_types) for (const r of (t.roles || [])) r.selected = cfgIds.has(Number(r.role_id)) ? 1 : 0;
    return { code: 0, msg: '成功', data: { sys_role_types } };
  },

  // 角色管理页（原版 /company/role/*，全本地化）：左树计数用本地成员动态重算；
  // role/add、role/del 落 role_store.json，绝不写云端
  'POST /company/role/list/': () => {
    const s = roleStoreJson();
    const types = s.role_types.map(t => ({ ...t, roles: (t.roles || []).map(r => ({ ...r })) }));
    const counts = roleCountMap(roleMemberBase());
    for (const t of types) {
      for (const r of (t.roles || [])) r.user_num = counts[Number(r.role_id)] || 0;
      t.total_user_num = (t.roles || []).reduce((a, r) => a + (Number(r.user_num) || 0), 0);
    }
    return { code: 0, msg: '成功', data: { role_types: types } };
  },
  'POST /company/role/detail/': ({ body }) => {
    const rid = Number(body && body.role_id) || 0;
    if (!rid) return { code: 10011, msg: '参数错误', data: {} };
    const s = roleStoreJson();
    // 公司配置优先（role_store.details），否则系统默认配置（原站对任意角色返回默认岗位职责+权限组）
    if (s.details && s.details[rid]) return { code: 0, msg: '成功', data: s.details[rid] };
    return { code: 0, msg: '成功', data: roleDetailDefault(rid) };
  },
  'POST /company/role/member/list/': ({ body }) => {
    const rid = Number(body && body.role_id) || 0;
    if (!rid) return { code: 10011, msg: '参数错误', data: {} };
    const kw = String((body && body.search_key) || '').trim();
    const pageIndex = Math.max(1, Number((body && body.page_index) || 1));
    const pageSize = Math.max(1, Number((body && body.page_size) || 20));
    let users = roleMemberBase().filter(u => memberHasRole(u, rid));
    if (kw) users = users.filter(u => (u.user_name || '').includes(kw) || (u.phone_number || '').includes(kw));
    const total = users.length;
    // 原站行为：角色不在公司配置中（未启用）→ data 为空对象（无 total_num/description/权限组/users）
    if (!roleInConfig(rid)) return { code: 0, msg: '成功', data: {} };
    const page = users.slice((pageIndex - 1) * pageSize, pageIndex * pageSize);
    const s = roleStoreJson();
    const d = (s.details && s.details[rid]) || roleDetailDefault(rid);
    return {
      code: 0, msg: '成功',
      data: {
        total_num: total,
        description: d.description || '',
        permission_groups: Array.isArray(d.permission_groups) ? d.permission_groups : [],
        users: page.map(u => ({
          user_id: u.user_id, user_name: u.user_name || '',
          user_avatar: u.user_avatar || 'https://cdn.e-shigong.com/brief_default_avatar.png',
          phone_number: u.phone_number || ''
        }))
      }
    };
  },
  'POST /company/role/add/': ({ body }) => {
    const ids = (body && body.role_ids) || [];
    const arr = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
    if (!arr.length) return { code: 10011, msg: '请选择角色！', data: {} };
    const sysMap = getSysRoleMap();
    const s = roleStoreJson();
    for (const rid of arr) {
      const info = sysMap[rid];
      if (!info) continue;
      let rt = s.role_types.find(t => Number(t.role_type_id) === Number(info.role_type_id));
      if (!rt) {
        rt = { role_type_id: info.role_type_id, role_type_name: info.role_type_name, total_user_num: 0, roles: [] };
        s.role_types.push(rt);
      }
      if (!rt.roles.some(r => Number(r.role_id) === rid)) {
        rt.roles.push({ role_id: rid, role_name: info.role_name, user_num: 0 });
      }
      // 与云端一致：启用后 role/detail 即返回该角色系统默认配置
      if (!s.details[rid]) s.details[rid] = roleDetailDefault(rid);
    }
    saveRoleStoreJson();
    return { code: 0, msg: '成功', data: {} };
  },
  'POST /company/role/del/': ({ body }) => {
    const rid = Number(body && body.role_id) || 0;
    if (!rid) return { code: 10011, msg: '参数错误', data: {} };
    const s = roleStoreJson();
    for (const rt of s.role_types) {
      rt.roles = (rt.roles || []).filter(r => Number(r.role_id) !== rid);
      rt.total_user_num = (rt.roles || []).reduce((a, r) => a + (Number(r.user_num) || 0), 0);
    }
    if (s.details) delete s.details[rid];
    saveRoleStoreJson();
    return { code: 0, msg: '成功', data: {} };
  },

  // 企业成员新增（添加成员弹窗提交）：{user_name, phone_number, role_ids:[], department_ids:[]} → {user_id}
  // 响应格式对照线上真实接口：code:0/msg:成功/data:{user_id}
  'POST /company/v2/department/member/add/': ({ body }) => {
    if (!body || !body.user_name || !body.phone_number) return { code: 10011, msg: '参数错误', data: {} };
    const roleIds = Array.isArray(body.role_ids) ? body.role_ids : [];
    const deptIds = Array.isArray(body.department_ids) ? body.department_ids : [];
    if (!roleIds.length) return { code: 10011, msg: '请选择角色', data: {} };
    if (!deptIds.length) return { code: 10011, msg: '请选择部门', data: {} };
    const roleNameMap = getRoleNameMap();
    const roles = roleIds.map((rid) => ({ role_id: Number(rid), role_name: roleNameMap[Number(rid)] || '' }));
    const department_info = deptIds.map((did) => ({ department_id: Number(did), department_name: getDeptName(did) }));
    const userId = localNextId('member');
    const payload = {
      user_id: userId,
      user_name: body.user_name,
      phone_number: body.phone_number,
      user_avatar: 'https://cdn.e-shigong.com/brief_default_avatar.png',
      user_accid: crypto.randomBytes(16).toString('hex'),
      roles: roles,
      department_ids: deptIds.map(Number),
      is_leader: 0,
      department_num: department_info.length,
      department_info: department_info
    };
    localUpsert('member', userId, payload);
    // 同步创建 users 表记录（默认密码 123456），使新成员可用手机号登录
    const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(body.phone_number);
    if (!existing) {
      const admin = db.prepare('SELECT company_id, company_name FROM users WHERE is_administrator = 1 LIMIT 1').get();
      db.prepare('INSERT INTO users (phone, password, password_plain, name, company_id, company_name, is_administrator) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(body.phone_number, md5('123456'), '123456', body.user_name, (admin && admin.company_id) || 0, (admin && admin.company_name) || '本地企业');
    }
    logger.info('企业成员写接口', '成员新增落库', { user_id: userId, name: body.user_name, dept_ids: deptIds, role_ids: roleIds, login_created: !existing });
    return { code: 0, msg: '成功', data: { user_id: userId } };
  },

  // 省市区（抓取自云端真实数据）
  'GET /area_info/open/list/': () => mock('area_info_open_list'),

  // 版本信息
  'GET /version/latest/info/': () => ({
    code: 0, msg: '成功',
    data: { latest: true, version: '2.18.2', has_new_version: false, url: '', description: '', force_update: false }
  }),

  // 表情列表（本地内置一份）
  'GET /im/emoji/list/': () => ({
    code: 0, msg: '成功',
    data: { list: [] }
  }),

  // 聊天常用语
  'POST /im/terminology/list/': () => ({
    code: 0, msg: '成功',
    data: { list: ['好的', '收到', '请问有什么可以帮您', '尽快处理', '好的，马上到'] }
  }),

  // 权限列表（管理员全权限，字段与前端 getPermissions 期望一致）
  // 普通成员只保留平台基础码(1xxxx) + 20015(我的预算)：能看自己的预算入口，
  // 但看不到 20014(预算汇总)/20016(预算审核) 等公司级/审核权限。
  'GET /user/app/permission/list/': ({ headers }) => {
    const s = getSession(headers);
    const u = s ? db.prepare('SELECT is_administrator FROM users WHERE id = ?').get(s.user_id) : null;
    const isAdmin = u && u.is_administrator;
    const d = mock('login').data;
    const all = d.permissions || [];
    const perms = isAdmin ? all : [...all.filter((p) => Number(p) < 20000), 20015];
    return {
      code: 0, msg: '成功',
      data: {
        permissions: perms,
        paid_function_ids: [],
        can_business: isAdmin ? 1 : 0,
        permission: perms,
        im_company_select_enable: d.im_company_select_enable || 1,
        // setCompanyPermission 读取该字段，缺失会置 store.companyPermission=undefined，导致工作台 .includes 崩溃
        permission_groups: isAdmin ? (d.permission_groups || [1, 2, 10, 11, 12, 13, 14]) : [1]
      }
    };
  },

  // ---------------- 客户本地 CRUD（B 类深化：断网增删改落库） ----------------
  // 本地新建客户；返回 {code:0, data:{crm_id}}，前端取 data.crm_id
  'POST /crm/add/': ({ body }) => {
    const ci = body && (body.customer_info || body);
    if (!ci || !ci.name) return { code: 10011, msg: '客户姓名不能为空', data: {} };
    const ri = body && body.room_info || {};
    const crmId = localNextId('customer');
    // 来源名称映射（crm_sources 表）
    let sourceName = ci.source_name || '';
    if (!sourceName && ci.source) {
      const sr = db.prepare('SELECT name FROM crm_sources WHERE source_id = ?').get(Number(ci.source));
      if (sr) sourceName = sr.name;
    }
    const address = [ri.province_name, ri.city_name, ri.district_name, ri.community_name, ri.building, ri.room_number]
      .filter(v => v !== undefined && v !== null && String(v).trim() !== '').join('');
    const payload = {
      ...(body || {}),
      customer_name: ci.name,
      customer_phone: ci.phone_number || ci.phone || '',
      customer_gender: ci.gender || 0,
      room_type: ri.room_type || '',
      room_size: String(ri.size || 0),
      address,
      source: ci.source || 0,
      source_name: sourceName,
      customer_type_id: ci.customer_type_id || 0,
      customer_type_name: ci.customer_type_name || '',
      channel_number: ci.channel_number || '',
      other_content: ci.other_content || '',
      description: ci.description || '',
      crm_status: 1, status_name: '意向', status_map_id: 10, color_value: '#FF9200',
      create_user_name: '管理员'
    };
    localUpsert('customer', crmId, payload);
    // 立即归并进 crm_customers，列表/详情/筛选即时可见
    ensureLocalCustomersMerged();
    logger.info('客户写接口', '客户新增落库', { crm_id: crmId, name: ci.name, phone: ci.phone_number || '' });
    return { code: 0, msg: '成功', data: { crm_id: crmId } };
  },

  // 编辑客户：完全落库到本地 SQLite（crm_customers + local_records），不回云端
  'POST /crm/customer/edit/': ({ body }) => {
    const crm_id = body && (body.crm_id || body.customer_id || body.id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    ensureLocalCustomersMerged();
    updateCustomerRecord(Number(crm_id), body);
    return { code: 0, msg: '成功', data: {} };
  },

  // 删除客户（停用/删除/废单删除）：本地软删，不回云端
  'POST /crm/disable/': ({ body }) => {
    const crm_id = body && (body.crm_id || body.customer_id || body.id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    return deleteCustomerRecord(Number(crm_id));
  },
  'POST /crm/del/': ({ body }) => {
    const crm_id = body && (body.crm_id || body.customer_id || body.id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    return deleteCustomerRecord(Number(crm_id));
  },
  'POST /crm/aborted_crm/delete/': ({ body }) => {
    const crm_id = body && (body.crm_id || body.customer_id || body.id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    return deleteCustomerRecord(Number(crm_id));
  },

  // 修改客户状态：本地更新状态列 + JSON（status 字典缺失时用请求里的名称）
  'POST /crm/status/edit/': ({ body }) => {
    const crm_id = body && (body.crm_id || body.id || body.customer_id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    ensureLocalCustomersMerged();
    const statusId = Number(body.status_map_id || body.status_id || body.crm_status || 0);
    const st = statusId ? db.prepare('SELECT * FROM crm_status WHERE status_id = ?').get(statusId) : null;
    const upd = { ...body };
    if (st) { upd.status_map_id = st.status_id; upd.status_name = st.name; upd.color_value = st.color_value; }
    updateCustomerRecord(Number(crm_id), upd);
    logger.info('客户写接口', '客户状态变更落库', { crm_id: Number(crm_id), status_id: statusId, status_name: st ? st.name : (body.status_name || '(未命中字典)') });
    return { code: 0, msg: '成功', data: {} };
  },

  // 写跟进记录：落库 crm_follow_records
  'POST /crm/follow/info/add/': ({ body }) => {
    const crm_id = body && (body.crm_id || body.id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    const nowStr = dbNow();
    // 页面字段：follow_content / follow_type_id / remind_enable / next_remind_date / files
    const content = body.follow_content !== undefined ? body.follow_content : body.content;
    const followType = body.follow_type_id !== undefined ? body.follow_type_id : body.follow_type;
    db.prepare('INSERT INTO crm_follow_records (crm_id, follow_id, content, follow_type, follow_time, create_user_id, create_user_name, extra_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(Number(crm_id), 0, String(content || ''), Number(followType || 0), body.follow_time || nowStr.slice(0, 16).replace('T', ' '), 0, body.create_user_name || '管理员', JSON.stringify(body), nowStr, nowStr);
    logger.info('客户写接口', '跟进记录落库', { crm_id: Number(crm_id), follow_type: Number(followType || 0), content: String(content || '').slice(0, 50) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 标签新增/删除/客户打标签
  'POST /crm/tag/add/': ({ body }) => {
    const name = body && (body.name || body.tag_name);
    if (!name) return { code: 10011, msg: '参数错误', data: {} };
    const tagId = localNextId('tag');
    db.prepare('INSERT OR REPLACE INTO crm_tags (tag_id, name, updated_at) VALUES (?,?,?)').run(tagId, name, dbNow());
    logger.info('客户写接口', '标签新增落库', { tag_id: tagId, name });
    return { code: 0, msg: '成功', data: { tag_id: tagId } };
  },
  'POST /crm/tag/del/': ({ body }) => {
    const tag_id = body && (body.tag_id || body.id);
    if (!tag_id) return { code: 10011, msg: '参数错误', data: {} };
    db.prepare('DELETE FROM crm_tags WHERE tag_id = ?').run(Number(tag_id));
    logger.info('客户写接口', '标签删除落库', { tag_id: Number(tag_id) });
    return { code: 0, msg: '成功', data: {} };
  },
  'POST /crm/crm_tag_map/edit/': ({ body }) => {
    const crm_id = body && (body.crm_id || body.id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    ensureLocalCustomersMerged();
    const tagIds = body.tag_ids || body.tag_id;
    updateCustomerRecord(Number(crm_id), { tag_ids: Array.isArray(tagIds) ? tagIds : [Number(tagIds)] });
    return { code: 0, msg: '成功', data: {} };
  },

  // 客户类型编辑
  'POST /crm/customer/type/edit/': ({ body }) => {
    const crm_id = body && (body.crm_id || body.id || body.customer_id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    ensureLocalCustomersMerged();
    updateCustomerRecord(Number(crm_id), body);
    return { code: 0, msg: '成功', data: {} };
  },

  // 跟进已读状态：本地无跨端已读概念，返回成功
  'POST /crm/follow_record/read_status/update/': () => ({ code: 0, msg: '成功', data: {} }),

  // 客户详情：本地记录优先，其次 crm_customers 种子表；都没有走代理
  'POST /crm/detail/': ({ body }) => {
    const crm_id = body && body.crm_id;
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    const local = localGet('customer', crm_id);
    if (local) {
      const d = JSON.parse(JSON.stringify(mock('crm_detail') && mock('crm_detail').data ? mock('crm_detail').data : {}));
      // 覆盖基本信息字段
      const p = local.payload || {};
      d.crm_id = Number(crm_id);
      d.customer_name = p.customer_name || p.name || '';
      d.customer_phone = p.customer_phone || p.phone_number || '';
      d.customer_gender = p.customer_gender || 0;
      d.address = p.address || '';
      d.room_type = p.room_type || '';
      d.room_size = p.room_size || '';
      d.source_name = p.source_name || '';
      d.customer_type_name = p.customer_type_name || '';
      d.create_time = local.created_at;
      if (!Array.isArray(d.follow_records)) d.follow_records = [];
      if (!d.customer_info || typeof d.customer_info !== 'object') {
        d.customer_info = { name: d.customer_name, gender: d.customer_gender, room_size: d.room_size, room_type: d.room_type };
      }
      if (d.project_id === undefined) d.project_id = 0;
      return { code: 0, msg: '成功', data: d };
    }
    // 种子表客户（migrate-crm 拉的云端数据）：返回与云端同构的详情
    const row = db.prepare('SELECT * FROM crm_customers WHERE crm_id = ?').get(Number(crm_id));
    if (row) {
      if (row.deleted) return { code: 13001, msg: '客户不存在', data: {} };
      const d = buildCustomerDetail(row);
      return { code: 0, msg: '成功', data: d };
    }
    return null;
  },

  // ================ 客户模块读接口本地化（模式 A：全部从本地 SQLite 查询，替换云端请求） ================
  // 客户列表（个人视角）：本地权威，全量返回；支持分页/搜索/状态/负责人/来源/废单/待跟进筛选
  'POST /crm/v2/pc/list/': ({ body }) => queryCrmList(body, false),
  // 客户列表（公司视角）：额外返回统计与权限字段
  'POST /crm/v2/pc/company/crm/list/': ({ body }) => queryCrmList(body, true),

  // 客户详情：本地权威，从 crm_customers 查询（detail_json 优先，无则列字段构造同构结构）
  'POST /crm/customer/detail/': ({ body }) => {
    ensureLocalCustomersMerged();
    const crm_id = body && (body.crm_id || body.customer_id || body.id);
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT * FROM crm_customers WHERE crm_id = ?').get(Number(crm_id));
    if (!row) return null; // 本地无此客户（云端存在但未迁移），走代理兜底
    // 本地软删客户：不能回退代理（云端仍有该客户会复活），返回错误码让前端走失败分支
    if (row.deleted) return { code: 13001, msg: '客户不存在', data: {} };
    return ok(buildCustomerDetail(row));
  },

  // 客户跟进记录：云端同构 {crm_id, follow_records}
  'POST /crm/follow/record/': ({ body }) => {
    const crm_id = body && body.crm_id;
    if (!crm_id) return { code: 10011, msg: '参数错误', data: {} };
    const rows = db.prepare('SELECT * FROM crm_follow_records WHERE crm_id = ? AND deleted = 0 ORDER BY follow_time DESC, id DESC').all(Number(crm_id));
    const follow_records = rows.map((r) => {
      let extra = {};
      try { extra = JSON.parse(r.extra_json || '{}'); } catch {}
      return {
        record_id: r.follow_id, create_user_id: r.create_user_id, create_user_name: r.create_user_name,
        create_time: r.follow_time, content: r.content, follow_type: r.follow_type,
        ...extra
      };
    });
    return ok({ crm_id: Number(crm_id), follow_records });
  },

  // 客户状态字典（本地化前探测确认：body 需 crm_id，返回 data.status_list）
  'POST /crm/company/crm/status/': () => {
    const rows = db.prepare('SELECT * FROM crm_status ORDER BY status_id ASC').all();
    return ok({
      status_list: rows.map((r) => ({
        status_map_id: r.status_id, status_name: r.name, color_value: r.color_value, can_select: r.is_selected
      }))
    });
  },

  // 客户标签字典
  'POST /crm/tag/list/': () => {
    const rows = db.prepare('SELECT * FROM crm_tags ORDER BY tag_id ASC').all();
    return ok({ tag_list: rows.map((r) => ({ tag_id: r.tag_id, tag_name: r.name, has_used: 1 })) });
  },

  // 客户来源字典（系统来源 + 公司自定义来源）
  'POST /company/crm/source/list/': () => {
    const rows = db.prepare('SELECT * FROM crm_sources ORDER BY source_type DESC, source_id ASC').all();
    const pick = (t) => rows.filter((r) => r.source_type === t).map((r) => ({ id: r.source_id, name: r.name }));
    return ok({ sys_sources: pick('sys'), self_sources: pick('self') });
  },

  // 筛选条件（成员下拉，从本地客户数据聚合）
  'POST /crm/screen/conditions/': () => ok(crmScreenConditions()),
  'POST /crm/company/crm/screen/conditions/': () => ok(crmScreenConditions()),

  // 跟进类型（系统固定字典，与云端一致）
  'POST /crm/follow/type/list/': () => ok({
    follow_types: [
      { id: 1, name: '上门拜访', can_del: 0 },
      { id: 2, name: '微信', can_del: 0 },
      { id: 3, name: '电话', can_del: 0 },
      { id: 4, name: '进店', can_del: 0 }
    ]
  }),

  // 客户列表设置项 + 组织架构（公司级快照，由 migrate-settings.js 落库；缺失回退代理）
  'POST /crm/screen/condition/list/': crmGlobal('screen_conditions'),
  'POST /crm/status/list/': crmGlobal('status_list'),
  'POST /crm/table/header/list/': crmGlobal('table_header'),
  // 组织架构按 company_id 校验（与云端一致：company_id=0 返回 10322 公司不存在）
  'POST /company/v2/department/member/all/': ({ body }) => {
    if (!body || !Number(body.company_id)) return { code: 10322, msg: '公司不存在', data: {} };
    return crmGlobal('department_members')();
  },
  'POST /crm/department_leader/members/': crmGlobal('department_leaders'),

  // ---------------- 项目本地 CRUD（B 类深化：断网增删改落库） ----------------
  // 本地新建项目（v2/v3 创建表单一致）；返回 {code:0, data:{project_id}}
  'POST /project/v2/create/': ({ body }) => handleProjectCreate(body),
  'POST /project/v3/create/': ({ body }) => handleProjectCreate(body),

  // 项目详情：本地权威（迁移项目读 detail_json，本地项目按列构造）；无记录回退代理
  'POST /project/detail/': ({ body }) => {
    const project_id = body && (body.project_id || body.pid);
    if (!project_id) return { code: 10011, msg: '参数错误', data: {} };
    ensureLocalProjectsMerged(); // 本地新建项目可能尚未归并，先增量归并保证即时可见
    // 本地软删项目：不回退代理（云端仍有该项目会复活），返回错误码
    const pr = db.prepare('SELECT deleted FROM projects WHERE project_id = ?').get(Number(project_id));
    if (pr && pr.deleted) return { code: 10805, msg: '项目不存在', data: {} };
    const detail = getProjectDetail(project_id);
    if (detail) return { code: 0, msg: '成功', data: detail };
    return null;
  },

  // 修改项目状态（开工/完工/延期等）：本地权威，云端迁移项目同样直接落库
  'POST /project/status/setting/update/': ({ body }) => {
    const project_id = body && (body.project_id || body.pid);
    if (!project_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'projects', idCol: 'project_id', id: project_id, body, ljCol: 'list_json', djCol: 'detail_json',
      localEntity: 'project',
      cols: { status: 'status', project_status: 'project_status', project_name: 'project_name',
              start_date: 'start_date', end_date: 'end_date', completed_date: 'completed_date',
              delay_status: 'delay_status', complete_rate: 'complete_rate', plan_project_rate: 'plan_project_rate' }
    });
    if (!ok) { logger.warn('项目写接口', '状态修改未命中项目', { project_id }); return { code: 10805, msg: '项目不存在', data: {} }; }
    logger.info('项目写接口', '状态修改落库', { project_id: Number(project_id), fields: Object.keys(body) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 项目描述新增：统一落库 project_payloads(kind=desc)，本地项目同步 local_records
  'POST /project/desc/add/': ({ body }) => {
    const project_id = body && body.project_id;
    if (!project_id) return { code: 10011, msg: '参数错误', data: {} };
    const nid = Number(project_id);
    const row = db.prepare('SELECT is_local FROM projects WHERE project_id = ?').get(nid);
    const localRow = row ? null : localGet('project', nid);
    if (!row && !localRow) return { code: 10805, msg: '项目不存在', data: {} };
    const desc = parseJson((db.prepare('SELECT payload FROM project_payloads WHERE project_id = ? AND kind = ?').get(nid, 'desc') || {}).payload, []);
    const arr = Array.isArray(desc) ? desc : [];
    const did = arr.length ? Math.max(...arr.map((d) => Number(d.id) || 0)) + 1 : 1;
    arr.push({ id: did, content: body.content || body.desc_content || '', create_time: new Date().toISOString() });
    db.prepare('INSERT INTO project_payloads (project_id, kind, payload, updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
      .run(nid, 'desc', JSON.stringify(arr), dbNow());
    if (row && row.is_local) { const lr = localGet('project', nid); if (lr) localUpsert('project', nid, { ...lr.payload, desc: arr }); }
    if (localRow) localUpsert('project', nid, { ...localRow.payload, desc: arr });
    logger.info('项目写接口', '描述新增落库', { project_id: nid, desc_id: did });
    return { code: 0, msg: '成功', data: { id: did } };
  },
  'POST /project/desc/del/': ({ body }) => {
    const project_id = body && body.project_id;
    if (!project_id) return { code: 10011, msg: '参数错误', data: {} };
    const nid = Number(project_id);
    const row = db.prepare('SELECT is_local FROM projects WHERE project_id = ?').get(nid);
    const localRow = row ? null : localGet('project', nid);
    if (!row && !localRow) return { code: 10805, msg: '项目不存在', data: {} };
    const desc = parseJson((db.prepare('SELECT payload FROM project_payloads WHERE project_id = ? AND kind = ?').get(nid, 'desc') || {}).payload, []);
    const arr = Array.isArray(desc) ? desc.filter((d) => Number(d.id) !== Number(body.id)) : [];
    db.prepare('INSERT INTO project_payloads (project_id, kind, payload, updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
      .run(nid, 'desc', JSON.stringify(arr), dbNow());
    if (row && row.is_local) { const lr = localGet('project', nid); if (lr) localUpsert('project', nid, { ...lr.payload, desc: arr }); }
    if (localRow) localUpsert('project', nid, { ...localRow.payload, desc: arr });
    logger.info('项目写接口', '描述删除落库', { project_id: nid, desc_id: Number(body.id) });
    return { code: 0, msg: '成功', data: {} };
  },

  // ---------------- 项目读接口本地化（模式 A：本地权威，数据已由 migrate-project.js 落库） ----------------
  // PC 项目列表
  'POST /project/pc/list/': ({ body }) => queryProjectList(body),
  // 移动端项目列表
  'POST /project/list/': () => queryProjectMobileList(),
  // 已完成项目（迁移快照 + 本地已完成项目动态合并）
  'POST /project/completed/project/list/': () => {
    ensureLocalProjectsMerged();
    const g = projectGlobal('completed_list')();
    const list = g ? ((g.data && g.data.project_list) || []) : [];
    const localCompleted = db.prepare('SELECT * FROM projects WHERE deleted = 0 AND status = 4').all();
    for (const r of localCompleted) {
      if (list.some((x) => Number(x.project_id) === Number(r.project_id))) continue;
      let lj = {};
      try { lj = JSON.parse(r.list_json || '{}'); } catch {}
      list.push({
        project_id: Number(r.project_id),
        project_name: lj.project_name || r.project_name,
        area_name: lj.area_name || r.area_name || '',
        room_number: lj.room_number || r.room_number || '',
        designer_name: lj.designer_name || '',
        pm_name: lj.pm_name || '',
        complete_time: r.completed_date || '',
        customer_name: lj.customer_name || r.customer_name || '',
        customer_gender: lj.customer_gender || r.customer_gender || 0,
        room_type: lj.room_type || r.room_type || '',
        phone_number: lj.phone_number || r.phone_number || ''
      });
    }
    return { code: 0, msg: '成功', data: { project_list: list, total_num: list.length } };
  },
  // 项目子资源（区域/任务/周计划/待办/施工日志/描述/角色/装饰区域）
  'POST /project/area/list/': projectPayload('areas'),
  'POST /project/task/list/': projectPayload('tasks'),
  'POST /project/all/task/list/': projectPayload('all_tasks'),
  'POST /project/handled/task/list/': projectPayload('handled_tasks'),
  'POST /project/v2/task/list/': projectPayload('v2_tasks'),
  'POST /project/weekly_plan/list/': projectPayload('weekly_plans'),
  // 周计划详情按 weekly_plan_id 存储（kind=weekly_plan_detail_<id>）
  'POST /project/weekly_plan/detail/': ({ body }) => {
    const wid = body && (body.weekly_plan_id || body.id);
    if (!wid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT payload FROM project_payloads WHERE kind = ?').get('weekly_plan_detail_' + Number(wid));
    if (!row) return null;
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  },
  'POST /project/todo/list/': projectPayload('todos'),
  'POST /project/construction_log/list/': projectPayload('construction_logs'),
  'POST /project/desc/list/': projectPayload('desc'),
  'POST /project/role/list/': projectPayload('roles'),
  'POST /project/decorated_area/list/': projectPayload('decorated_areas'),
  // 公司级项目全局数据（筛选/模板/步骤/售后项目）
  'POST /project/filter/list/': projectGlobal('filter_settings'),
  'POST /project/pc/filter/project/info/': projectGlobal('pc_filter_project'),
  'POST /project/pc/filter/role_user/info/': projectGlobal('pc_filter_role_user'),
  'POST /project/template/list/': projectGlobal('template_list'),
  'POST /project/todo/filter/info/': projectGlobal('todo_filter'),
  'POST /project/step/label/list/': projectGlobal('step_labels'),
  'POST /project/company/project/list/': projectGlobal('company_project_list'),

  // ---------------- 工作台杂项（节假日/到期提醒/版本信息） ----------------
  // 节假日：按年聚合本地快照（migrate-misc.js 落库 kind=holiday_<year>）
  'POST /project/holiday/list/': ({ body }) => {
    const years = Array.isArray(body && body.years) ? body.years : [];
    const holidays = [];
    for (const y of years) {
      const row = db.prepare('SELECT payload FROM project_globals WHERE kind = ?').get('holiday_' + Number(y));
      if (!row) continue;
      try {
        const d = JSON.parse(row.payload);
        if (Array.isArray(d.holidays)) holidays.push(...d.holidays);
      } catch {}
    }
    return { code: 0, msg: '成功', data: { holidays } };
  },
  // 公司到期提醒（公司级快照；缺失回退代理）
  'POST /company/expire/remind/info/': projectGlobal('expire_remind'),
  // 版本信息：云端该接口恒返回 10000（本地保持一致，避免前端行为差异）
  'POST /version/latest/info/': () => ({ code: 10000, msg: '网络异常，请稍后再试！', data: {} }),

  // ---------------- 预算写接口（模式 A：本地权威，写操作直接落库 SQLite，不再代理） ----------------
  // 本地新建预算；返回 {code:0, data:{budget_id}}
  'POST /budget/add/': ({ body, headers }) => {
    if (!body) return { code: 10011, msg: '参数错误', data: {} };
    const budgetId = localNextId('budget');
    // 记录创建人姓名（"我的预算"按此归属），避免新预算在普通成员视图里消失
    const scope = currentUserBudgetScope(headers);
    const creator = (scope.names && scope.names[0]) || '';
    localUpsert('budget', budgetId, { name: body.budget_name || body.name || '新预算', ...body, create_user_name: body.create_user_name || creator });
    logger.info('预算写接口', '新增预算落库', { budget_id: budgetId, crm_id: body.crm_id || 0, create_user_name: body.create_user_name || creator });
    return { code: 0, msg: '成功', data: { budget_id: budgetId } };
  },

  // 从模板新增预算：本地生成预算（模板内容已迁移，name 取模板名；模板内容需另行还原）
  'POST /budget/import/': ({ body, headers }) => {
    if (!body) return { code: 10011, msg: '参数错误', data: {} };
    const budgetId = localNextId('budget');
    const scope = currentUserBudgetScope(headers);
    const creator = (scope.names && scope.names[0]) || '';
    localUpsert('budget', budgetId, { name: body.budget_name || body.name || '新预算', ...body, status: 0, create_user_name: body.create_user_name || creator });
    return { code: 0, msg: '成功', data: { budget_id: budgetId } };
  },

  // 编辑预算：合并字段直接落库（云端迁移预算同样本地处理）
  'POST /budget/edit/': ({ body }) => {
    const budget_id = body && (body.budget_id || body.id);
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'budgets', idCol: 'budget_id', id: budget_id, body, ljCol: 'list_json', djCol: 'detail_json',
      localEntity: 'budget',
      cols: { name: 'name', status: 'status', selected: 'selected', crm_id: 'crm_id', project_id: 'project_id',
              contract_price: 'contract_price', total_price: 'total_price' }
    });
    if (!ok) { logger.warn('预算写接口', '编辑未命中预算', { budget_id }); return { code: 20029, msg: '预算不存在', data: {} }; }
    logger.info('预算写接口', '编辑预算落库', { budget_id: Number(budget_id), fields: Object.keys(body) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 修改预算名称
  'POST /budget/edit/name/': ({ body }) => {
    const budget_id = body && (body.budget_id || body.id);
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'budgets', idCol: 'budget_id', id: budget_id, body: { ...body, name: body.name || body.budget_name || '' },
      ljCol: 'list_json', djCol: 'detail_json', localEntity: 'budget', cols: { name: 'name' }
    });
    if (!ok) return { code: 20029, msg: '预算不存在', data: {} };
    logger.info('预算写接口', '预算改名落库', { budget_id: Number(budget_id), name: body.name || body.budget_name });
    return { code: 0, msg: '成功', data: {} };
  },

  // 保存预算（编辑器保存 contract_price/gift 等字段）
  'POST /budget/save/': ({ body }) => {
    const budget_id = body && (body.budget_id || body.id);
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'budgets', idCol: 'budget_id', id: budget_id, body, ljCol: 'list_json', djCol: 'detail_json',
      localEntity: 'budget',
      cols: { name: 'name', status: 'status', selected: 'selected', crm_id: 'crm_id', project_id: 'project_id',
              contract_price: 'contract_price', total_price: 'total_price' }
    });
    if (!ok) return { code: 20029, msg: '预算不存在', data: {} };
    logger.info('预算写接口', '保存预算落库', { budget_id: Number(budget_id), fields: Object.keys(body) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 复制预算：任意预算可复制为本地新预算（9 亿号段）
  'POST /budget/copy/': ({ body }) => {
    const budget_id = body && body.budget_id;
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT * FROM budgets WHERE budget_id = ?').get(Number(budget_id));
    const src = row
      ? { ...parseJson(row.detail_json, {}), ...parseJson(row.list_json, {}) }
      : ((localGet('budget', budget_id) || {}).payload || null);
    if (!src) return { code: 20029, msg: '预算不存在', data: {} };
    const newId = localNextId('budget');
    const payload = { ...src, name: (src.name || '预算') + '副本', selected: 0, status: 0 };
    localUpsert('budget', newId, payload);
    logger.info('预算写接口', '复制预算落库', { from: Number(budget_id), budget_id: newId });
    return { code: 0, msg: '成功', data: { budget_id: newId } };
  },

  // 删除预算：软删落库（deleted=1），列表/回收站即时联动
  'POST /budget/del/': ({ body }) => {
    const budget_id = body && (body.budget_id || body.id);
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = markEntityDeleted('budgets', 'budget_id', budget_id, 'budget', true);
    if (!ok) return { code: 20029, msg: '预算不存在', data: {} };
    logger.info('预算写接口', '删除预算落库', { budget_id: Number(budget_id) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 恢复预算（回收站还原）：deleted=0
  'POST /budget/restore/': ({ body }) => {
    const budget_id = body && (body.budget_id || body.id);
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = markEntityDeleted('budgets', 'budget_id', budget_id, 'budget', false);
    if (!ok) return { code: 20029, msg: '预算不存在', data: {} };
    logger.info('预算写接口', '恢复预算落库', { budget_id: Number(budget_id) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 设为签约预算 / 取消签约
  'POST /budget/select/': ({ body }) => {
    const budget_id = body && (body.budget_id || body.id);
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'budgets', idCol: 'budget_id', id: budget_id, body: { ...body, selected: 1 },
      ljCol: 'list_json', djCol: 'detail_json', localEntity: 'budget', cols: { selected: 'selected' }
    });
    if (!ok) return { code: 20029, msg: '预算不存在', data: {} };
    logger.info('预算写接口', '设为签约预算', { budget_id: Number(budget_id) });
    return { code: 0, msg: '成功', data: {} };
  },
  'POST /budget/cancel_select/': ({ body }) => {
    const budget_id = body && (body.budget_id || body.id);
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'budgets', idCol: 'budget_id', id: budget_id, body: { ...body, selected: 0 },
      ljCol: 'list_json', djCol: 'detail_json', localEntity: 'budget', cols: { selected: 'selected' }
    });
    if (!ok) return { code: 20029, msg: '预算不存在', data: {} };
    logger.info('预算写接口', '取消签约预算', { budget_id: Number(budget_id) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 预算详情：本地权威（迁移预算读 detail_json，本地预算按 payload 构造）；无记录回退代理
  'POST /budget/detail/': ({ body }) => {
    const budget_id = body && (body.budget_id || body.id);
    if (!budget_id) return { code: 10011, msg: '参数错误', data: {} };
    // 本地软删预算：不回退代理（云端仍有该预算会复活），返回错误码
    const br = db.prepare('SELECT deleted FROM budgets WHERE budget_id = ?').get(Number(budget_id));
    if (br && br.deleted) return { code: 20029, msg: '预算不存在', data: {} };
    const detail = getBudgetDetail(budget_id);
    if (detail) return { code: 0, msg: '成功', data: detail };
    return null;
  },

  // ---------------- 预算读接口本地化（模式 A：本地权威，数据已由 migrate-budget.js 落库） ----------------
  // 预算列表（我的/全部）
  'POST /budget/mine/budget/list/': ({ body, headers }) => queryBudgetList(body, headers, true),
  'POST /budget/list/': ({ body, headers }) => queryBudgetList(body, headers, false),
  // 按客户预算列表（公司/我的）——均按当前登录用户过滤（管理员全量，普通成员仅本人）
  'POST /budget/app/company/budget/crm/list/': ({ headers }) => queryBudgetCrmList('budget_crm_list', headers),
  'POST /budget/app/budget/crm/list/': ({ headers }) => queryBudgetCrmList('my_budget_crm_list', headers),
  // 回收站（迁移快照 + 本地软删预算）
  'POST /budget/delete/list/': () => {
    ensureLocalBudgetsMerged();
    const g = budgetGlobal('delete_list')();
    const list = g ? ((g.data && g.data.budgets) || []) : [];
    const deleted = db.prepare('SELECT * FROM budgets WHERE deleted = 1').all();
    for (const r of deleted) list.unshift(buildBudgetItem(r));
    return { code: 0, msg: '成功', data: { budgets: list } };
  },
  // 预算子资源（成本/人工/审核记录/表头）
  'POST /budget/cost/detail/': budgetPayload('cost_detail'),
  'POST /budget/worker/summary/detail/': budgetPayload('worker_summary'),
  'POST /budget/review/record/detail/': budgetPayload('review_record'),
  'POST /budget/table_header/list/': budgetPayload('table_header'),
  // 预算公司级全局数据
  'POST /budget/company/budget/explanation/list/': budgetGlobal('explanation'),
  'POST /budget/review/list/': budgetGlobal('review_list'),
  'POST /budget/company/reviewer/setting/get/': budgetGlobal('reviewer_setting'),
  'POST /budget/app/company/budget/crm/all_conditions/': budgetGlobal('all_conditions'),
  'POST /budget/template/list/': budgetGlobal('template_list'),
  'POST /budget/specification/list/': budgetGlobal('specification'),
  'POST /budget/commodity_content/list/': budgetGlobal('commodity_content'),
  // 预算模板详情按 template_id 存储（kind=template_detail_<id>）
  'POST /budget/template/detail/': ({ body }) => {
    const tid = body && (body.template_id || body.id);
    if (!tid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT payload FROM budget_globals WHERE kind = ?').get('template_detail_' + Number(tid));
    if (!row) {
      // 列表快照中也不存在的模板：返回数据不存在（不回退代理，避免云端 500）
      const trow = db.prepare("SELECT payload FROM budget_globals WHERE kind='template_list'").get();
      let known = false;
      if (trow) {
        try { known = (JSON.parse(trow.payload).templates || []).some((t) => Number(t.id) === Number(tid)); } catch {}
      }
      if (!known) return { code: 10032, msg: '数据不存在', data: {} };
      return null;
    }
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  },

  // ---------------- 合同读接口本地化（模式 A：本地权威，数据已由 migrate-contract.js 落库） ----------------
  // 按客户合同列表
  'POST /finance/contract/list/': ({ body }) => queryContractList(body),
  // 合同详情：云端该接口对存量合同返回"数据不存在"，本地按列表行构造最小同构结构；无记录回退代理
  'POST /finance/contract/detail/': ({ body }) => {
    const cid = body && (body.contract_id || body.id);
    if (!cid) return { code: 10011, msg: '参数错误', data: {} };
    ensureLocalContractsMerged();
    const row = db.prepare('SELECT * FROM contracts WHERE contract_id = ?').get(Number(cid));
    if (!row) return null;
    // 本地软删合同：不回退代理（云端仍有该合同会复活），返回错误码
    if (row.deleted) return { code: 10032, msg: '数据不存在', data: {} };
    return { code: 0, msg: '成功', data: buildContractItem(row) };
  },

  // ---------------- 合同写接口（模式 A：本地权威，写操作直接落库 SQLite，不再代理） ----------------
  // 新增合同：本地新建（9 亿号段）落库 contracts + local_records；CRM 不存在返回 13001
  'POST /finance/contract/add/': ({ body }) => {
    if (!body || !body.crm_id) return { code: 13001, msg: 'CRM不存在', data: {} };
    const crm = db.prepare('SELECT crm_id FROM crm_customers WHERE crm_id = ? AND deleted = 0').get(Number(body.crm_id));
    if (!crm) return { code: 13001, msg: 'CRM不存在', data: {} };
    const contractId = localNextId('contract');
    const payload = {
      contract_id: contractId,
      crm_id: Number(body.crm_id),
      contract_type: Number(body.contract_type || 0),
      contract_name: body.contract_name || body.name || '新合同',
      order: Number(body.order || 0),
      ...body
    };
    localUpsert('contract', contractId, payload);
    // 立即落 contracts 表（列表/详情即时可见，ensure 归并遇已存在记录会跳过，不冲突）
    db.prepare('INSERT INTO contracts (contract_id, crm_id, contract_type, contract_name, sort_order, list_json, is_local, deleted, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(contractId, payload.crm_id, payload.contract_type, payload.contract_name, payload.order, JSON.stringify(payload), 1, 0, dbNow(), dbNow());
    logger.info('合同写接口', '新增合同落库', { contract_id: contractId, crm_id: payload.crm_id });
    return { code: 0, msg: '成功', data: { contract_id: contractId } };
  },

  // 修改合同（合并字段直接落库；云端迁移合同同样本地处理）
  'POST /finance/contract/modify/': ({ body }) => {
    const contract_id = body && (body.contract_id || body.id);
    if (!contract_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'contracts', idCol: 'contract_id', id: contract_id, body, ljCol: 'list_json', djCol: null,
      localEntity: 'contract',
      cols: { contract_name: 'contract_name', contract_type: 'contract_type', crm_id: 'crm_id',
              contract_title: 'contract_title', contact_name: 'contact_name', order: 'sort_order' }
    });
    if (!ok) { logger.warn('合同写接口', '修改未命中合同', { contract_id }); return { code: 10032, msg: '数据不存在', data: {} }; }
    logger.info('合同写接口', '修改合同落库', { contract_id: Number(contract_id), fields: Object.keys(body) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 删除合同：软删落库（deleted=1）
  'POST /finance/contract/del/': ({ body }) => {
    const contract_id = body && (body.contract_id || body.id);
    if (!contract_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = markEntityDeleted('contracts', 'contract_id', contract_id, 'contract', true);
    if (!ok) return { code: 10032, msg: '数据不存在', data: {} };
    logger.info('合同写接口', '删除合同落库', { contract_id: Number(contract_id) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 合同排序（order 为 SQLite 保留字，映射 sort_order 列 + list_json.order）
  'POST /finance/contract/order/update/': ({ body }) => {
    const contract_id = body && (body.contract_id || body.id);
    if (!contract_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'contracts', idCol: 'contract_id', id: contract_id, body, ljCol: 'list_json', djCol: null,
      localEntity: 'contract', cols: { order: 'sort_order' }
    });
    if (!ok) return { code: 10032, msg: '数据不存在', data: {} };
    logger.info('合同写接口', '合同排序落库', { contract_id: Number(contract_id), order: body.order });
    return { code: 0, msg: '成功', data: {} };
  },

  // 合同状态设置（审核状态等，合并进 list_json 原样返回）
  'POST /finance/contract/status/set/': ({ body }) => {
    const contract_id = body && (body.contract_id || body.id);
    if (!contract_id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({
      table: 'contracts', idCol: 'contract_id', id: contract_id, body, ljCol: 'list_json', djCol: null,
      localEntity: 'contract', cols: {}
    });
    if (!ok) return { code: 10032, msg: '数据不存在', data: {} };
    logger.info('合同写接口', '合同状态设置落库', { contract_id: Number(contract_id), status: body.status });
    return { code: 0, msg: '成功', data: {} };
  },

  // ---------------- 合同子资源写接口本地化（预付款/坏账/审核人/付款设置，本地权威落库） ----------------
  // 新增合同预付款（增减项）：{contract_id, amount, description, files} → prepay_list items
  'POST /finance/contract/add_prepay/add/': ({ body, headers }) => {
    const cid = body && (body.contract_id || body.id);
    if (!cid) return { code: 21003, msg: '合同不存在', data: {} };
    if (!db.prepare('SELECT contract_id FROM contracts WHERE contract_id = ? AND deleted = 0').get(Number(cid))) {
      return { code: 21003, msg: '合同不存在', data: {} };
    }
    // 当前登录用户（本地 users 表）作为创建人
    let createUser = { user_id: 0, user_name: '本地用户' };
    const s = getSession(headers);
    if (s) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      if (u) createUser = { user_id: Number(s.user_id), user_name: u.name || '本地用户' };
    }
    const data = getContractPrepay(cid);
    const item = {
      id: nextContractSubId(),
      amount: String(body.amount === undefined || body.amount === null ? 0 : body.amount),
      description: body.description || '',
      create_time: fmtLocalTime(),
      files: Array.isArray(body.files) ? body.files : [],
      create_user_id: createUser.user_id,
      create_user_name: createUser.user_name
    };
    data.items.push(item);
    data.total_amount = String(data.items.reduce((s2, it) => s2 + Number(it.amount || 0), 0));
    saveContractPrepay(cid, data);
    logger.info('合同写接口', '新增预付款落库', { contract_id: Number(cid), prepay_id: item.id, amount: item.amount });
    return { code: 0, msg: '成功', data: {} };
  },

  // 删除合同预付款（增减项）：{add_prepay_id}
  'POST /finance/contract/add_prepay/del/': ({ body }) => {
    const pid = body && (body.add_prepay_id || body.prepay_id);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const rows = db.prepare("SELECT contract_id, payload FROM contract_payloads WHERE kind = 'prepay_list'").all();
    for (const r of rows) {
      const d = parseJson(r.payload, null);
      if (!d || !Array.isArray(d.items)) continue;
      const idx = d.items.findIndex((it) => Number(it.id) === Number(pid));
      if (idx >= 0) {
        d.items.splice(idx, 1);
        d.total_amount = String(d.items.reduce((s, it) => s + Number(it.amount || 0), 0));
        saveContractPrepay(r.contract_id, d);
        logger.info('合同写接口', '删除预付款落库', { contract_id: Number(r.contract_id), prepay_id: Number(pid) });
        return { code: 0, msg: '成功', data: {} };
      }
    }
    return { code: 10032, msg: '数据不存在', data: {} };
  },

  // 坏账设置：{contract_id, bad_debt_amount} → 落 contracts.bad_debt_amount（财务详情合并用）
  'POST /finance/contract/bad_debt/set/': ({ body }) => {
    const cid = body && (body.contract_id || body.id);
    if (!cid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT * FROM contracts WHERE contract_id = ?').get(Number(cid));
    if (!row) return { code: 21003, msg: '合同不存在', data: {} };
    const amount = String(body.bad_debt_amount === undefined || body.bad_debt_amount === null ? 0 : body.bad_debt_amount);
    db.prepare('UPDATE contracts SET bad_debt_amount = ?, updated_at = ? WHERE contract_id = ?').run(amount, dbNow(), Number(cid));
    // 本地新建合同同步 local_records（权威一致）
    const lr = localGet('contract', cid);
    if (lr) localUpsert('contract', cid, { ...lr.payload, bad_debt_amount: amount });
    logger.info('合同写接口', '坏账设置落库', { contract_id: Number(cid), bad_debt_amount: amount });
    return { code: 0, msg: '成功', data: {} };
  },

  // 审核人添加：{company_id, check_type, reviewer_id}（check_type 0=合同 1=收款退款）
  'POST /finance/company/contract/reviewer/add/': ({ body }) => {
    const companyId = body && body.company_id;
    const reviewerId = body && body.reviewer_id;
    if (!companyId || !reviewerId) return { code: 10011, msg: '参数错误', data: {} };
    const setting = contractGlobalGet('reviewer_setting', { companies: [] });
    const ui = findContractUserById(reviewerId);
    updateContractReviewer(setting, companyId, body.check_type, {
      user_id: Number(reviewerId),
      user_name: (ui && ui.user_name) || '用户' + reviewerId,
      user_avatar: (ui && ui.user_avatar) || ''
    });
    contractGlobalSet('reviewer_setting', setting);
    logger.info('合同写接口', '审核人添加落库', { company_id: Number(companyId), check_type: Number(body.check_type || 0), reviewer_id: Number(reviewerId) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 审核人删除：{company_id, check_type, reviewer_id}
  'POST /finance/company/contract/reviewer/del/': ({ body }) => {
    const companyId = body && body.company_id;
    if (!companyId) return { code: 10011, msg: '参数错误', data: {} };
    const setting = contractGlobalGet('reviewer_setting', { companies: [] });
    updateContractReviewer(setting, companyId, body.check_type, {});
    contractGlobalSet('reviewer_setting', setting);
    logger.info('合同写接口', '审核人删除落库', { company_id: Number(companyId), check_type: Number(body.check_type || 0) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 审核人替换：{company_id, check_type, reviewer_id, new_reviewer_id}
  'POST /finance/company/contract/reviewer/replace/': ({ body }) => {
    const companyId = body && body.company_id;
    const newId = body && (body.new_reviewer_id || body.reviewer_id);
    if (!companyId || !newId) return { code: 10011, msg: '参数错误', data: {} };
    const setting = contractGlobalGet('reviewer_setting', { companies: [] });
    const ui = findContractUserById(newId);
    updateContractReviewer(setting, companyId, body.check_type, {
      user_id: Number(newId),
      user_name: (ui && ui.user_name) || '用户' + newId,
      user_avatar: (ui && ui.user_avatar) || ''
    });
    contractGlobalSet('reviewer_setting', setting);
    logger.info('合同写接口', '审核人替换落库', { company_id: Number(companyId), check_type: Number(body.check_type || 0), reviewer_id: Number(newId) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 付款设置读取：云端对当前 SPA 版本恒返回"软件版本过低"（12002），1:1 镜像
  'POST /finance/company/contract/pay_setting/get/': () => ({ code: 12002, msg: '您当前使用的软件版本过低，请前往手机应用市场或亮宅官网下载最新版本', data: {} }),

  // 付款设置写入（费率数组）：{company_id, first_rate..fifth_rate}
  'POST /finance/company/contract/pay_setting/set/': ({ body }) => {
    const def = { pay_times: 3, first_rate: [], second_rate: [], third_rate: [], fourth_rate: [], fifth_rate: [] };
    const d = contractGlobalGet('pay_setting', def);
    for (const k of ['first_rate', 'second_rate', 'third_rate', 'fourth_rate', 'fifth_rate']) {
      if (Array.isArray(body[k])) d[k] = body[k];
    }
    contractGlobalSet('pay_setting', d);
    logger.info('合同写接口', '付款费率设置落库', { pay_times: d.pay_times, rates: Object.keys(body).filter((k) => k.endsWith('_rate')) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 付款期数设置：{company_id, pay_times}
  'POST /finance/company/contract/pay_times/': ({ body }) => {
    const def = { pay_times: 3, first_rate: [], second_rate: [], third_rate: [], fourth_rate: [], fifth_rate: [] };
    const d = contractGlobalGet('pay_setting', def);
    if (body.pay_times !== undefined) d.pay_times = Number(body.pay_times);
    contractGlobalSet('pay_setting', d);
    logger.info('合同写接口', '付款期数设置落库', { pay_times: d.pay_times });
    return { code: 0, msg: '成功', data: {} };
  },

  // ---------------- 巡检模块本地化（模式 A：本地权威，数据由 migrate-inspection.js 落库） ----------------
  // 公司级巡检列表：本地查询 + 筛选快照，结构与云端一致（projects/create_users 筛选下拉 + total_num + inspection_list）
  'POST /project/inspection/company/list/': ({ body }) => {
    const b = body || {};
    const pageIndex = Math.max(Number(b.page_index || 1), 1);
    const pageSize = Math.max(Number(b.page_size || 20), 1);
    const status = b.status === undefined || b.status === null ? -1 : Number(b.status);
    const projectIds = Array.isArray(b.project_ids) ? b.project_ids.map(Number) : [];
    const createUserIds = Array.isArray(b.create_user_ids) ? b.create_user_ids.map(Number) : [];
    // 筛选快照（巡检记录无 project_id 列，按名称匹配筛选）
    const frow = db.prepare('SELECT payload FROM inspection_globals WHERE kind = ?').get('filter');
    let filter = { projects: [], create_users: [] };
    try { if (frow) filter = JSON.parse(frow.payload) || filter; } catch {}
    const conds = ['deleted = 0'];
    const args = [];
    if (status !== -1) { conds.push('status = ?'); args.push(status); }
    if (projectIds.length) {
      const names = (filter.projects || []).filter((p) => projectIds.includes(Number(p.project_id))).map((p) => p.project_name);
      if (names.length) { conds.push('project_name IN (' + names.map(() => '?').join(',') + ')'); args.push(...names); }
    }
    if (createUserIds.length) {
      const names = (filter.create_users || []).filter((u) => createUserIds.includes(Number(u.create_user_id))).map((u) => u.create_user_name);
      if (names.length) { conds.push('create_user_name IN (' + names.map(() => '?').join(',') + ')'); args.push(...names); }
    }
    const total = db.prepare('SELECT COUNT(*) AS c FROM inspections WHERE ' + conds.join(' AND ')).get(...args).c;
    const rows = db.prepare('SELECT * FROM inspections WHERE ' + conds.join(' AND ') + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, pageSize, (pageIndex - 1) * pageSize);
    return {
      code: 0, msg: '成功',
      data: {
        projects: filter.projects || [],
        create_users: filter.create_users || [],
        total_num: total,
        inspection_list: rows.map(buildInspectionItem)
      }
    };
  },

  // 巡检详情：云端对存量数据恒返回 10032，本地按列表行构造同构结构；无记录回退代理
  'POST /project/inspection/detail/': ({ body }) => {
    const id = body && (body.inspection_id || body.id);
    if (!id) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(Number(id));
    if (!row) return null;
    // 本地软删巡检：不回退代理（云端仍有该巡检会复活），返回错误码
    if (row.deleted) return { code: 10032, msg: '数据不存在', data: {} };
    return { code: 0, msg: '成功', data: buildInspectionItem(row) };
  },

  // 巡检状态更新（直接落库 inspections）
  'POST /project/inspection/status/update/': ({ body }) => {
    const id = body && (body.inspection_id || body.id);
    if (!id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({ table: 'inspections', idCol: 'id', id, body, ljCol: 'list_json', djCol: null, localEntity: null, cols: { status: 'status', handle_content: 'handle_content' } });
    if (!ok) { logger.warn('巡检写接口', '状态更新未命中', { id: Number(id) }); return { code: 10032, msg: '数据不存在', data: {} }; }
    logger.info('巡检写接口', '状态更新落库', { id: Number(id), status: body.status });
    return { code: 0, msg: '成功', data: {} };
  },

  // 巡检完成（合并字段落库）
  'POST /project/inspection/complete/': ({ body }) => {
    const id = body && (body.inspection_id || body.id);
    if (!id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = writeRecord({ table: 'inspections', idCol: 'id', id, body, ljCol: 'list_json', djCol: null, localEntity: null, cols: { status: 'status', handle_content: 'handle_content' } });
    if (!ok) return { code: 10032, msg: '数据不存在', data: {} };
    logger.info('巡检写接口', '巡检完成落库', { id: Number(id), fields: Object.keys(body) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 巡检删除（软删）
  'POST /project/inspection/del/': ({ body }) => {
    const id = body && (body.inspection_id || body.id);
    if (!id) return { code: 10011, msg: '参数错误', data: {} };
    const ok = markEntityDeleted('inspections', 'id', id, null, true);
    if (!ok) return { code: 10032, msg: '数据不存在', data: {} };
    logger.info('巡检写接口', '巡检删除落库', { id: Number(id) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 巡检新增：{project_id, inspection_content, deadline, ...}（模式 A 本地权威，9 亿号段）
  // 错误码与云端一致：无 project_id → 10505 缺少必填参数；项目不存在 → 10805 项目不存在
  'POST /project/inspection/add/': ({ body, headers }) => {
    const b = body || {};
    if (b.project_id === undefined || b.project_id === null) return { code: 10505, msg: '缺少必填参数', data: {} };
    const proj = db.prepare('SELECT project_id, project_name FROM projects WHERE project_id = ?').get(Number(b.project_id));
    if (!proj) return { code: 10805, msg: '项目不存在', data: {} };
    // 当前登录用户（本地 users 表）作为创建人
    let createUserName = '本地用户';
    const s = getSession(headers);
    if (s) {
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(s.user_id);
      if (u && u.name) createUserName = u.name;
    }
    const id = nextInspectionId();
    const item = {
      id,
      project_name: proj.project_name || '',
      create_user_name: createUserName,
      inspection_content: String(b.inspection_content || ''),
      inspection_files: Array.isArray(b.inspection_files) ? b.inspection_files : [],
      handle_content: String(b.handle_content || ''),
      handle_files: Array.isArray(b.handle_files) ? b.handle_files : [],
      create_time: fmtLocalTime(),
      deadline: b.deadline || '',
      status: b.status === undefined || b.status === null ? 0 : Number(b.status)
    };
    db.prepare('INSERT INTO inspections (id, project_name, create_user_name, inspection_content, handle_content, create_time, deadline, status, list_json, is_local, deleted, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)')
      .run(item.id, item.project_name, item.create_user_name, item.inspection_content, item.handle_content, item.create_time, item.deadline, item.status, JSON.stringify(item), dbNow(), dbNow());
    logger.info('巡检写接口', '巡检新增落库', { id, project_id: Number(b.project_id), project_name: item.project_name, status: item.status });
    return { code: 0, msg: '成功', data: {} };
  },
  // 巡检导出 Excel：云端返回 xlsx 二进制，代理透传不支持二进制，暂保持代理
  // 'POST /project/inspection/company/export/excel/': () => null,

  // ---------------- 项目子资源写接口（任务/区域，模式 A：直接落库 project_payloads） ----------------
  // 任务新增
  'POST /project/task/add/': ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const proj = db.prepare('SELECT project_id, project_name FROM projects WHERE project_id = ?').get(Number(pid));
    if (!proj) return { code: 10805, msg: '项目不存在', data: {} };
    const taskId = nextLocalSubId('tasks', 'project_task_id');
    const task = {
      project_id: Number(pid),
      project_name: proj.project_name || '',
      project_step_id: Number(body.project_step_id || 0),
      project_step_name: body.project_step_name || '',
      project_task_id: taskId,
      enable: body.enable !== undefined ? Number(body.enable) : 1,
      start_date: body.start_date || '',
      end_date: body.end_date || '',
      task_type: Number(body.task_type || 0),
      task_status: Number(body.task_status || 1),
      task_name: body.task_name || '',
      task_content: body.task_content || '',
      read_status: 0,
      ...body
    };
    updateProjectSub(pid, 'tasks', (d) => { d.tasks.push(task); });
    logger.info('项目写接口', '任务新增落库', { project_id: Number(pid), task_id: taskId });
    return { code: 0, msg: '成功', data: { project_task_id: taskId } };
  },

  // 任务保存/编辑（save 与 edit 语义一致：按 project_task_id 合并字段）
  'POST /project/task/save/': ({ body }) => saveProjectTask(body),
  'POST /project/task/edit/': ({ body }) => saveProjectTask(body),

  // 任务状态类操作（start/handle/commit/cancel：按 project_task_id 合并字段，不存在返回 10828）
  'POST /project/task/start/': ({ body }) => saveProjectTask(body),
  'POST /project/task/handle/': ({ body }) => saveProjectTask(body),
  'POST /project/task/commit/': ({ body }) => saveProjectTask(body),
  'POST /project/task/cancel/': ({ body }) => saveProjectTask(body),

  // 任务删除
  'POST /project/task/del/': ({ body }) => {
    const taskId = body && (body.project_task_id || body.task_id || body.id);
    if (!taskId) return { code: 10011, msg: '参数错误', data: {} };
    const proj = findProjectByTask(taskId);
    if (!proj) { logger.warn('项目写接口', '任务删除未命中', { task_id: taskId }); return { code: 10828, msg: '项目任务状态映射记录不存在', data: {} }; }
    updateProjectSub(proj.project_id, 'tasks', (d) => { d.tasks = d.tasks.filter((t) => Number(t.project_task_id) !== Number(taskId)); });
    logger.info('项目写接口', '任务删除落库', { project_id: Number(proj.project_id), task_id: Number(taskId) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 区域新增（项目不存在返回 10031，与云端一致）
  'POST /project/area/add/': ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const proj = db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(Number(pid));
    if (!proj) return { code: 10031, msg: '数据创建失败', data: {} };
    const areaId = nextLocalSubId('areas', 'area_id');
    const area = { area_id: areaId, ...body };
    updateProjectSub(pid, 'areas', (d) => { if (!Array.isArray(d.areas)) d.areas = []; d.areas.push(area); });
    logger.info('项目写接口', '区域新增落库', { project_id: Number(pid), area_id: areaId });
    return { code: 0, msg: '成功', data: { area_id: areaId } };
  },

  // 区域编辑（不存在返回 10032）
  'POST /project/area/edit/': ({ body }) => {
    const areaId = body && (body.area_id || body.id);
    if (!areaId) return { code: 10011, msg: '参数错误', data: {} };
    const proj = findProjectByArea(areaId);
    if (!proj) return { code: 10032, msg: '数据不存在', data: {} };
    let found = false;
    updateProjectSub(proj.project_id, 'areas', (d) => {
      if (!Array.isArray(d.areas)) d.areas = [];
      for (const a of d.areas) if (Number(a.area_id) === Number(areaId)) { Object.assign(a, body); found = true; }
    });
    if (!found) return { code: 10032, msg: '数据不存在', data: {} };
    logger.info('项目写接口', '区域编辑落库', { project_id: Number(proj.project_id), area_id: Number(areaId) });
    return { code: 0, msg: '成功', data: {} };
  },

  // 区域删除（云端无校验直接成功；本地同样不校验存在性）
  'POST /project/area/del/': ({ body }) => {
    const areaId = body && (body.area_id || body.id);
    if (!areaId) return { code: 10011, msg: '参数错误', data: {} };
    const proj = findProjectByArea(areaId);
    if (proj) {
      updateProjectSub(proj.project_id, 'areas', (d) => { if (Array.isArray(d.areas)) d.areas = d.areas.filter((a) => Number(a.area_id) !== Number(areaId)); });
      logger.info('项目写接口', '区域删除落库', { project_id: Number(proj.project_id), area_id: Number(areaId) });
    }
    return { code: 0, msg: '成功', data: {} };
  },

  // ---------------- 项目模块扩展本地化（todo/周计划/任务扩展/角色成员，模式 A 落 project_payloads） ----------------
  // todo 数据载体 = project_payloads kind='todos'（{total_num, todos[], create_button}）；周计划 = kind='weekly_plans'（{total_num, weekly_planes[]}）
  // 新增待办：{project_id, ...}（body 原样保留，9 亿号段 todo_id）
  'POST /project/todo/create/': ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    if (!db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(Number(pid))) return { code: 10805, msg: '项目不存在', data: {} };
    const todoId = nextProjectPayloadId('todos', 'todos', 'todo_id');
    const todo = { todo_id: todoId, project_id: Number(pid), create_time: fmtLocalTime(), ...body };
    updateProjectSub(pid, 'todos', (d) => {
      if (!Array.isArray(d.todos)) d.todos = [];
      d.todos.unshift(todo);
      d.total_num = d.todos.length;
    });
    logger.info('项目写接口', '待办新增落库', { project_id: Number(pid), todo_id: todoId, fields: Object.keys(body) });
    return { code: 0, msg: '成功', data: { todo_id: todoId } };
  },
  // 待办提交/重提/审核：按 todo_id 合并 body（status 等字段透传）
  'POST /project/todo/submit/': ({ body }) => updateProjectTodo(body, '提交'),
  'POST /project/todo/resubmit/': ({ body }) => updateProjectTodo(body, '重提'),
  'POST /project/todo/review/': ({ body }) => updateProjectTodo(body, '审核'),
  // 待办删除：按 todo_id 移除
  'POST /project/todo/del/': ({ body }) => {
    const todoId = body && (body.todo_id || body.id);
    if (!todoId) return { code: 10011, msg: '参数错误', data: {} };
    const hit = findProjectPayloadItem('todos', 'todos', 'todo_id', todoId);
    if (!hit) { logger.warn('项目写接口', '待办删除未命中', { todo_id: todoId }); return { code: 10032, msg: '数据不存在', data: {} }; }
    updateProjectSub(hit.project_id, 'todos', (d) => {
      if (Array.isArray(d.todos)) d.todos = d.todos.filter((x) => Number(x.todo_id) !== Number(todoId));
      d.total_num = (d.todos || []).length;
    });
    logger.info('项目写接口', '待办删除落库', { project_id: Number(hit.project_id), todo_id: Number(todoId) });
    return { code: 0, msg: '成功', data: {} };
  },
  // 待办删除记录：直接成功（本地无历史回收站语义）
  'POST /project/todo/del/records/': () => ({ code: 0, msg: '成功', data: {} }),
  // 待办详情：按 todo_id 查 todos 快照（含本地新建）；无记录回退代理
  'POST /project/todo/detail/': ({ body }) => {
    const todoId = body && (body.todo_id || body.id);
    if (!todoId) return { code: 10011, msg: '参数错误', data: {} };
    const hit = findProjectPayloadItem('todos', 'todos', 'todo_id', todoId);
    if (!hit) return null;
    return { code: 0, msg: '成功', data: hit.item };
  },
  // 待办总数列表：{project_id} → {total_num, todos}（与 /project/todo/list/ 同构）
  'POST /project/todo/total/list/': ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT payload FROM project_payloads WHERE project_id = ? AND kind = ?').get(Number(pid), 'todos');
    const d = row ? parseJson(row.payload, null) : null;
    if (d && typeof d === 'object') return { code: 0, msg: '成功', data: { total_num: d.total_num || 0, todos: d.todos || [] } };
    return { code: 0, msg: '成功', data: { total_num: 0, todos: [] } };
  },

  // 新增周计划：{project_id, year, week, contents, ...}（9 亿号段 weekly_plan_id）
  'POST /project/weekly_plan/create/': ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    if (!db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(Number(pid))) return { code: 10805, msg: '项目不存在', data: {} };
    const wpId = nextProjectPayloadId('weekly_plans', 'weekly_planes', 'weekly_plan_id');
    const wp = { weekly_plan_id: wpId, project_id: Number(pid), year: Number(body.year || new Date().getFullYear()), week: Number(body.week || 0), contents: Array.isArray(body.contents) ? body.contents : [], project_step_ids: Array.isArray(body.project_step_ids) ? body.project_step_ids : [], project_step_name: body.project_step_name || '', ...body };
    updateProjectSub(pid, 'weekly_plans', (d) => {
      if (!Array.isArray(d.weekly_planes)) d.weekly_planes = [];
      d.weekly_planes.push(wp);
      d.total_num = d.weekly_planes.length;
    });
    logger.info('项目写接口', '周计划新增落库', { project_id: Number(pid), weekly_plan_id: wpId, year: wp.year, week: wp.week });
    return { code: 0, msg: '成功', data: { weekly_plan_id: wpId } };
  },
  // 编辑周计划：按 weekly_plan_id 合并 body
  'POST /project/weekly_plan/edit/': ({ body }) => {
    const wpId = body && (body.weekly_plan_id || body.id);
    if (!wpId) return { code: 10011, msg: '参数错误', data: {} };
    const hit = findProjectPayloadItem('weekly_plans', 'weekly_planes', 'weekly_plan_id', wpId);
    if (!hit) { logger.warn('项目写接口', '周计划编辑未命中', { weekly_plan_id: wpId }); return { code: 10032, msg: '数据不存在', data: {} }; }
    updateProjectSub(hit.project_id, 'weekly_plans', (d) => {
      for (const w of d.weekly_planes || []) if (Number(w.weekly_plan_id) === Number(wpId)) Object.assign(w, body, { weekly_plan_id: Number(wpId) });
    });
    logger.info('项目写接口', '周计划编辑落库', { project_id: Number(hit.project_id), weekly_plan_id: Number(wpId) });
    return { code: 0, msg: '成功', data: {} };
  },
  // 周基准：{project_id} → {project_id, year, week, start_date, end_date}（时间戳，本地计算当前周）
  'POST /project/weekly_plan/base_week/': ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const now = new Date();
    const oneJan = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil((((now - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
    const day = now.getDay() === 0 ? 7 : now.getDay();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1, 0, 0, 0);
    const sunday = new Date(monday.getTime() + 6 * 86400000, 0, 0, 0, 0);
    return { code: 0, msg: '成功', data: { project_id: Number(pid), year: now.getFullYear(), week, start_date: Math.floor(monday.getTime() / 1000), end_date: Math.floor((monday.getTime() + 7 * 86400000) / 1000) } };
  },

  // 任务详情：{project_task_id} → tasks 快照中该项；无 → 10828（与云端一致）
  'POST /project/task/detail/': ({ body }) => {
    const taskId = body && (body.project_task_id || body.task_id || body.id);
    if (!taskId) return { code: 10011, msg: '参数错误', data: {} };
    const hit = findProjectPayloadItem('tasks', 'tasks', 'project_task_id', taskId);
    if (!hit) return { code: 10828, msg: '项目任务状态映射记录不存在', data: {} };
    return { code: 0, msg: '成功', data: hit.item };
  },
  // 任务执行信息：与 detail 同源，无 → 10828
  'POST /project/task/exec_info/': ({ body }) => {
    const taskId = body && (body.project_task_id || body.task_id || body.id);
    if (!taskId) return { code: 10011, msg: '参数错误', data: {} };
    const hit = findProjectPayloadItem('tasks', 'tasks', 'project_task_id', taskId);
    if (!hit) return { code: 10828, msg: '项目任务状态映射记录不存在', data: {} };
    return { code: 0, msg: '成功', data: hit.item };
  },
  // 任务内检/外检：按 project_task_id 合并审核字段
  'POST /project/task/inside_review/': ({ body }) => saveProjectTask(body),
  'POST /project/task/outside_review/': ({ body }) => saveProjectTask(body),
  // 任务图片增删：按 project_task_id 更新 images 数组字段
  'POST /project/task/image/add/': ({ body }) => saveProjectTask(body),
  'POST /project/task/image/del/': ({ body }) => saveProjectTask(body),
  // 任务工作日：{project_id} → 从 tasks 快照按步骤聚合起止日期
  'POST /project/task/work_days/': ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const proj = db.prepare('SELECT project_id, project_name, start_date, end_date FROM projects WHERE project_id = ?').get(Number(pid));
    if (!proj) return { code: 10805, msg: '项目不存在', data: {} };
    const row = db.prepare('SELECT payload FROM project_payloads WHERE project_id = ? AND kind = ?').get(Number(pid), 'tasks');
    const d = row ? parseJson(row.payload, null) : null;
    const tasks = (d && Array.isArray(d.tasks)) ? d.tasks : [];
    const steps = [];
    for (const t of tasks) {
      const sid = Number(t.project_step_id || 0);
      let s = steps.find((x) => x.project_step_id === sid);
      if (!s) { s = { project_step_id: sid, project_step_name: t.project_step_name || '', start_day: 0, end_day: 0, start_date: '', end_date: '', start_date_fmt: '', end_date_fmt: '' }; steps.push(s); }
      if (t.start_date) { s.start_date = t.start_date; s.start_date_fmt = String(t.start_date).slice(0, 10).replace(/\//g, '-'); }
      if (t.end_date && t.end_date !== '无') { s.end_date = t.end_date; s.end_date_fmt = String(t.end_date).slice(0, 10).replace(/\//g, '-'); }
    }
    return { code: 0, msg: '成功', data: { project_id: Number(pid), project_name: proj.project_name || '', project_start_date: proj.start_date || '', project_end_date: proj.end_date || '', work_day_mode: 1, steps } };
  },
  // 任务启用设置：{project_id} → tasks 快照（show_edit_button/show_create_button/task_num），无快照 10828
  'POST /project/task/enable_setting/': ({ body }) => {
    const pid = body && (body.project_id || body.pid);
    if (!pid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare('SELECT payload FROM project_payloads WHERE project_id = ? AND kind = ?').get(Number(pid), 'tasks');
    const d = row ? parseJson(row.payload, null) : null;
    if (!d || typeof d !== 'object') return { code: 10828, msg: '项目任务状态映射记录不存在', data: {} };
    return { code: 0, msg: '成功', data: { project_id: Number(pid), show_edit_button: d.show_edit_button, show_create_button: d.show_create_button, task_num: d.task_num || 0 } };
  },
  // v2 任务编辑：按 project_task_id 合并（v2_tasks 快照不同步，tasks 同步；已知限制）
  'POST /project/v2/task/edit/': ({ body }) => saveProjectTask(body),

  // 项目角色成员列表：{project_id} → 公司级快照（project_globals kind=project_role_members），无快照回退代理
  'POST /project/role/member/list/': ({ body }) => {
    const row = db.prepare('SELECT payload FROM project_globals WHERE kind = ?').get('project_role_members');
    if (!row) return null;
    return { code: 0, msg: '成功', data: parseJson(row.payload, { roles: [] }) };
  },
  // 项目角色成员增删：更新公司级快照 roles[].members
  'POST /project/role/member/add/': ({ body }) => updateProjectRoleMember(body, true),
  'POST /project/role/member/del/': ({ body }) => updateProjectRoleMember(body, false),

  // 合同审核列表（PC + App，公司级快照；qt×st 池与云端一致：
  // st=0→待审核池、其余(1/2/-1)→已审核池；checked_num/uncheck_num 按 query_type 固定）
  'POST /finance/v2/pc/contract/check/list/': ({ body }) => {
    const b = body || {};
    const qt = Number(b.query_type) === 1 ? 1 : 0;
    const st = Number(b.status) === 0 ? 0 : 1;
    const row = db.prepare("SELECT payload FROM contract_globals WHERE kind = 'pc_check_list'").get();
    let pools = {};
    try { pools = row ? JSON.parse(row.payload) : {}; } catch (e) { pools = {}; }
    const pool = pools[qt + '_' + st] || { items: [], checked_num: 0, uncheck_num: 0 };
    const items = Array.isArray(pool.items) ? pool.items : [];
    const pi = Number(b.page_index || 1), ps = Number(b.page_size || 0);
    let page = items;
    if (ps > 0) page = items.slice((pi - 1) * ps, pi * ps);
    return { code: 0, msg: '成功', data: { data_list: page, checked_num: pool.checked_num, uncheck_num: pool.uncheck_num } };
  },
  'POST /finance/contract/check/list/': contractGlobal('app_check_list'),
  // 审核筛选条件 / 审核人设置
  'POST /finance/v2/pc/contract/check/filter/info/': contractGlobal('check_filter_info'),
  'POST /finance/company/contract/reviewer/setting/get/': contractGlobal('reviewer_setting'),
  // 合同子资源（预算价格/预付款）
  'POST /finance/contract/budget/price/': contractPayload('budget_price'),
  'POST /finance/contract/add_prepay/list/': contractPayload('prepay_list'),

  // ================ 预算子资源写接口（区域/明细项/附加项/汇总项，模式 A：落 budget.detail_json） ================
  // 错误码与云端一致：预算不存在 20029 / 区域不存在 20031 / 明细项不存在 20035 / 附加项不存在 20045 / 汇总项 20060
  // 新增区域：{budget_id, name} → {budget_area_id}
  'POST /budget/budget_area/add/': ({ body }) => {
    const bid = body && body.budget_id;
    if (!bid) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    if (!Array.isArray(g.detail.areas)) g.detail.areas = [];
    const areaId = nextBudgetSubId();
    g.detail.areas.push({
      id: areaId, order: g.detail.areas.length, name: body.name || '新区域', description: '',
      total_sale_price: '0', total_cost_price: '0', total_change_sale_price: '0', total_change_cost_price: '0',
      total_increase_price: '0', total_decrease_price: '0', area_items: []
    });
    saveBudgetDetail(Number(bid), g.detail);
    logger.info('预算写接口', '区域新增落库', { budget_id: Number(bid), area_id: areaId, name: body.name });
    return { code: 0, msg: '成功', data: { budget_area_id: areaId } };
  },

  // 编辑区域：{budget_area_id, name}
  'POST /budget/budget_area/edit/': ({ body }) => {
    const areaId = body && body.budget_area_id;
    if (!areaId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByArea(areaId);
    if (!g) return { code: 20031, msg: '预算区域不存在', data: [] };
    const area = g.detail.areas[g.area_index];
    if (body.name !== undefined) area.name = body.name;
    if (body.description !== undefined) area.description = body.description;
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '区域编辑落库', { budget_id: Number(g.budget_id), area_id: Number(areaId) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 删除区域：{budget_area_id}
  'POST /budget/budget_area/del/': ({ body }) => {
    const areaId = body && body.budget_area_id;
    if (!areaId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByArea(areaId);
    if (!g) return { code: 20031, msg: '预算区域不存在', data: [] };
    g.detail.areas.splice(g.area_index, 1);
    // 重排 order
    g.detail.areas.forEach((a, i) => { a.order = i; });
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '区域删除落库', { budget_id: Number(g.budget_id), area_id: Number(areaId) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 复制区域：{budget_area_id} → {budget_area_id}
  'POST /budget/budget_area/copy/': ({ body }) => {
    const areaId = body && body.budget_area_id;
    if (!areaId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByArea(areaId);
    if (!g) return { code: 20031, msg: '预算区域不存在', data: [] };
    const src = g.detail.areas[g.area_index];
    const newArea = JSON.parse(JSON.stringify(src));
    newArea.id = nextBudgetSubId();
    newArea.order = g.detail.areas.length;
    for (const it of (newArea.area_items || [])) it.id = nextBudgetSubId();
    g.detail.areas.push(newArea);
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '区域复制落库', { budget_id: Number(g.budget_id), from: Number(areaId), area_id: newArea.id });
    return { code: 0, msg: '成功', data: { budget_area_id: newArea.id } };
  },

  // 区域排序：{budget_areas:[{id,order}]}
  'POST /budget/budget_area/order/update/': ({ body }) => {
    if (!body || !Array.isArray(body.budget_areas)) return { code: 0, msg: '成功', data: [] };
    let saved = new Set();
    for (const a of body.budget_areas) {
      const g = findBudgetByArea(a.id);
      if (!g) continue;
      if (saved.has(g.budget_id)) { const hit = findBudgetByArea(a.id); if (hit) hit.detail.areas[hit.area_index].order = a.order; }
      else { saved.add(g.budget_id); g.detail.areas[g.area_index].order = a.order; }
      saveBudgetDetail(g.budget_id, g.detail);
    }
    logger.info('预算写接口', '区域排序落库', { count: body.budget_areas.length });
    return { code: 0, msg: '成功', data: [] };
  },

  // 区域描述：{budget_area_id, description}
  'POST /budget/budget_area/description/': ({ body }) => {
    const areaId = body && body.budget_area_id;
    if (!areaId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByArea(areaId);
    if (!g) return { code: 20031, msg: '预算区域不存在', data: [] };
    g.detail.areas[g.area_index].description = body.description || '';
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '区域描述落库', { budget_id: Number(g.budget_id), area_id: Number(areaId) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 新增明细项：{budget_area_id, material_ids|specification_ids|other_info} → {area_items, random_key}
  'POST /budget/budget_area_item/add/': ({ body }) => {
    const areaId = body && body.budget_area_id;
    if (!areaId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByArea(areaId);
    if (!g) return { code: 20031, msg: '预算区域不存在', data: [] };
    const area = g.detail.areas[g.area_index];
    if (!Array.isArray(area.area_items)) area.area_items = [];
    const items = [];
    let baseOrder = area.area_items.length;
    if (Array.isArray(body.material_ids)) {
      for (const mid of body.material_ids) {
        const mrow = db.prepare('SELECT payload FROM budget_materials WHERE material_id = ?').get(Number(mid));
        if (!mrow) continue;
        const m = parseJson(mrow.payload, {});
        items.push(buildAreaItemFromMaterial({ ...m, id: Number(mid) }, baseOrder++));
      }
    }
    if (Array.isArray(body.specification_ids)) {
      const specRow = db.prepare("SELECT payload FROM budget_globals WHERE kind = 'specification'").get();
      const specs = specRow ? (parseJson(specRow.payload, {}).specifications || []) : [];
      for (const sid of body.specification_ids) {
        const sp = specs.find((s) => Number(s.id) === Number(sid));
        if (sp) items.push(buildAreaItemFromSpec(sp, baseOrder++));
      }
    }
    // 其他自定义项（other_info / other_list 兜底）
    if (!items.length && (body.other_info || (Array.isArray(body.other_list) && body.other_list.length))) {
      const src = body.other_info || body.other_list[0];
      const it = defaultAreaItemFields();
      it.order = baseOrder; it.type = body.other_type !== undefined ? Number(body.other_type) : 0;
      it.name = src.name || ''; it.description = src.description || '';
      it.unit = src.unit || ''; it.budget_num = String(src.budget_num || '1'); it.real_num = String(src.real_num || '1');
      it.main_material_sale_price = String(src.price !== undefined ? src.price : '0');
      it.all_sale = String(src.price !== undefined ? src.price : '0'); it.single_price = it.main_material_sale_price;
      items.push(it);
    }
    if (!items.length) return { code: 20031, msg: '预算区域不存在', data: [] };
    area.area_items = area.area_items.concat(items);
    saveBudgetDetail(g.budget_id, g.detail);
    const key = logBudgetOp(g.budget_id, 'add', { area_id: Number(areaId), item_ids: items.map((x) => x.id) });
    logger.info('预算写接口', '明细项新增落库', { budget_id: Number(g.budget_id), area_id: Number(areaId), count: items.length });
    return { code: 0, msg: '成功', data: { area_items: items, random_key: key } };
  },

  // 编辑明细项：{budget_area_item_id, ...字段}
  'POST /budget/budget_area_item/edit/': ({ body }) => {
    const itemId = body && body.budget_area_item_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 20035, msg: '预算材料不存在', data: [] };
    const it = g.detail.areas[g.area_index].area_items[g.item_index];
    const original = JSON.parse(JSON.stringify(it));
    const { budget_area_item_id, budget_id, budget_area_id, id, ...rest } = body;
    Object.assign(it, rest);
    saveBudgetDetail(g.budget_id, g.detail);
    const key = logBudgetOp(g.budget_id, 'edit', { item_id: Number(itemId), restore_fields: original });
    logger.info('预算写接口', '明细项编辑落库', { budget_id: Number(g.budget_id), item_id: Number(itemId), fields: Object.keys(rest) });
    return { code: 0, msg: '成功', data: { random_key: key } };
  },

  // 删除明细项：{budget_area_item_id}
  'POST /budget/budget_area_item/del/': ({ body }) => {
    const itemId = body && body.budget_area_item_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 20035, msg: '预算材料不存在', data: [] };
    const item = g.detail.areas[g.area_index].area_items[g.item_index];
    const key = logBudgetOp(g.budget_id, 'del', { budget_id: g.budget_id, area_id: g.detail.areas[g.area_index].id, items: [{ area_index: g.area_index, item }] });
    g.detail.areas[g.area_index].area_items.splice(g.item_index, 1);
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '明细项删除落库', { budget_id: Number(g.budget_id), item_id: Number(itemId) });
    return { code: 0, msg: '成功', data: { random_key: key } };
  },

  // 批量删除明细项：{budget_id, budget_area_item_ids} → {random_key}
  'POST /budget/budget_area_item/batch/del/': ({ body }) => {
    const bid = body && body.budget_id;
    const ids = body && body.budget_area_item_ids;
    if (!bid || !Array.isArray(ids)) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    const removed = [];
    for (const rid of ids) {
      const hit = findBudgetByItem(rid);
      if (!hit || Number(hit.budget_id) !== Number(bid)) continue;
      const item = hit.detail.areas[hit.area_index].area_items[hit.item_index];
      removed.push({ area_index: hit.area_index, area_id: hit.detail.areas[hit.area_index].id, item });
      // 用 g.detail 执行删除（find 返回的是独立解析副本，直接改不生效）
      g.detail.areas[hit.area_index].area_items.splice(g.detail.areas[hit.area_index].area_items.findIndex((x) => Number(x.id) === Number(rid)), 1);
    }
    saveBudgetDetail(Number(bid), g.detail);
    const key = logBudgetOp(bid, 'batch_del', { budget_id: Number(bid), items: removed });
    logger.info('预算写接口', '明细项批量删除落库', { budget_id: Number(bid), count: removed.length });
    return { code: 0, msg: '成功', data: { random_key: key } };
  },

  // 明细项排序：{budget_area_items:[[{id,order}]]}（每区域一个数组）
  'POST /budget/budget_area_item/order/update/': ({ body }) => {
    const list = body && body.budget_area_items;
    if (!list) return { code: 0, msg: '成功', data: [] };
    let cnt = 0;
    for (const group of list) {
      if (!Array.isArray(group)) continue;
      for (const it of group) {
        const g = findBudgetByItem(it.id);
        if (!g) continue;
        g.detail.areas[g.area_index].area_items[g.item_index].order = it.order;
        saveBudgetDetail(g.budget_id, g.detail);
        cnt++;
      }
    }
    logger.info('预算写接口', '明细项排序落库', { count: cnt });
    return { code: 0, msg: '成功', data: [] };
  },

  // 替换明细项：{budget_area_item_id, material_id|specification_id} → {random_key}
  'POST /budget/budget_area_item/substitute/': ({ body }) => {
    const itemId = body && body.budget_area_item_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 20049, msg: '预算区域条目不存在', data: [] };
    const it = g.detail.areas[g.area_index].area_items[g.item_index];
    const original = JSON.parse(JSON.stringify(it));
    let replaced = null;
    if (body.material_id) {
      const mrow = db.prepare('SELECT payload FROM budget_materials WHERE material_id = ?').get(Number(body.material_id));
      if (mrow) {
        const m = parseJson(mrow.payload, {});
        replaced = buildAreaItemFromMaterial({ ...m, id: Number(body.material_id) }, it.order);
      }
    } else if (body.specification_id) {
      const specRow = db.prepare("SELECT payload FROM budget_globals WHERE kind = 'specification'").get();
      const specs = specRow ? (parseJson(specRow.payload, {}).specifications || []) : [];
      const sp = specs.find((s) => Number(s.id) === Number(body.specification_id));
      if (sp) replaced = buildAreaItemFromSpec(sp, it.order);
    }
    if (!replaced) return { code: 20049, msg: '预算区域条目不存在', data: [] };
    // 保留编辑过的数量/自定义信息
    replaced.id = it.id;
    replaced.budget_num = it.budget_num !== undefined ? it.budget_num : replaced.budget_num;
    replaced.real_num = it.real_num !== undefined ? it.real_num : replaced.real_num;
    replaced.change_num = it.change_num !== undefined ? it.change_num : replaced.change_num;
    replaced.custom_field_info = it.custom_field_info || replaced.custom_field_info;
    replaced.file_info = it.file_info || replaced.file_info;
    g.detail.areas[g.area_index].area_items[g.item_index] = replaced;
    saveBudgetDetail(g.budget_id, g.detail);
    const key = logBudgetOp(g.budget_id, 'replace', { item_id: Number(itemId), original_item: original });
    logger.info('预算写接口', '明细项替换落库', { budget_id: Number(g.budget_id), item_id: Number(itemId), material_id: body.material_id || 0, specification_id: body.specification_id || 0 });
    return { code: 0, msg: '成功', data: { random_key: key } };
  },

  // 复制明细项：{budget_id, budget_area_item_ids, dest_budget_id, dest_budget_area_id} → {random_key, new_area_items}
  'POST /budget/v3/budget_area_item/copy/': ({ body }) => {
    const srcBid = body && (body.budget_id || body.src_budget_id);
    const destAreaId = body && body.dest_budget_area_id;
    const ids = body && body.budget_area_item_ids;
    if (!srcBid || !destAreaId || !Array.isArray(ids)) return { code: 10011, msg: '参数错误', data: [] };
    const dg = findBudgetByArea(destAreaId);
    if (!dg) return { code: 20031, msg: '预算区域不存在', data: [] };
    if (!Array.isArray(dg.detail.areas[dg.area_index].area_items)) dg.detail.areas[dg.area_index].area_items = [];
    const newItems = [];
    let baseOrder = dg.detail.areas[dg.area_index].area_items.length;
    for (const sid of ids) {
      const sg = findBudgetByItem(sid);
      if (!sg) continue;
      const copy = JSON.parse(JSON.stringify(sg.detail.areas[sg.area_index].area_items[sg.item_index]));
      copy.id = nextBudgetSubId();
      copy.order = baseOrder++;
      newItems.push(copy);
    }
    if (!newItems.length) return { code: 20031, msg: '预算区域不存在', data: [] };
    dg.detail.areas[dg.area_index].area_items = dg.detail.areas[dg.area_index].area_items.concat(newItems);
    saveBudgetDetail(dg.budget_id, dg.detail);
    const key = logBudgetOp(dg.budget_id, 'copy', { dest_area_id: Number(destAreaId), item_ids: newItems.map((x) => x.id) });
    logger.info('预算写接口', '明细项复制落库', { budget_id: Number(dg.budget_id), dest_area_id: Number(destAreaId), count: newItems.length });
    return { code: 0, msg: '成功', data: { random_key: key, new_area_items: newItems } };
  },

  // 撤销操作：{budget_id, random_key}
  'POST /budget/v3/budget_area_item/recover/': ({ body }) => {
    const bid = body && body.budget_id;
    const key = body && body.random_key;
    if (!bid || !key) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    if (!undoBudgetOp(key)) return { code: 10011, msg: '参数错误', data: [] };
    logger.info('预算写接口', '撤销操作落库', { budget_id: Number(bid), random_key: String(key).slice(0, 8) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 明细项自定义字段：{item_custom_field_value_id(=明细项id), custom_field_id, content} → {item_custom_field_value_id}
  'POST /budget/budget_area_item/custom_field_value/update/': ({ body }) => {
    const itemId = body && body.item_custom_field_value_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 10032, msg: '数据不存在', data: [] };
    const it = g.detail.areas[g.area_index].area_items[g.item_index];
    if (!it.custom_field_info || typeof it.custom_field_info !== 'object') it.custom_field_info = {};
    const fid = body.custom_field_id;
    const valueId = nextBudgetSubId();
    if (fid) it.custom_field_info[fid] = { item_custom_field_value_id: valueId, content: body.content || '' };
    else { for (const k of Object.keys(it.custom_field_info)) it.custom_field_info[k].content = body.content || ''; }
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '自定义字段更新落库', { budget_id: Number(g.budget_id), item_id: Number(itemId), custom_field_id: fid || 0 });
    return { code: 0, msg: '成功', data: { item_custom_field_value_id: valueId } };
  },

  // 明细项标记：{budget_area_item_id, mark}
  'POST /budget/budget_area_item/mark/': ({ body }) => {
    const itemId = body && body.budget_area_item_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 20049, msg: '预算区域条目不存在', data: [] };
    const it = g.detail.areas[g.area_index].area_items[g.item_index];
    if (body.mark !== undefined) it.mark = Number(body.mark);
    Object.assign(it, body);
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '明细项标记落库', { budget_id: Number(g.budget_id), item_id: Number(itemId) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 明细项文件删除：{budget_area_item_id}
  'POST /budget/budget_area_item/file/del/': ({ body }) => {
    const itemId = body && body.budget_area_item_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 20035, msg: '预算材料不存在', data: [] };
    g.detail.areas[g.area_index].area_items[g.item_index].file_info = { id: 0, type: 0, name: '', url: '', origin_url: '' };
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '明细项文件删除落库', { budget_id: Number(g.budget_id), item_id: Number(itemId) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 明细项成本设置：{budget_area_item_id, ...成本字段}
  'POST /budget/budget_area_item/cost/set/': ({ body }) => {
    const itemId = body && body.budget_area_item_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 20049, msg: '预算区域条目不存在', data: [] };
    const it = g.detail.areas[g.area_index].area_items[g.item_index];
    const { budget_area_item_id, budget_id, id, ...rest } = body;
    Object.assign(it, rest);
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '明细项成本设置落库', { budget_id: Number(g.budget_id), item_id: Number(itemId), fields: Object.keys(rest) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 明细项类型转换（自定义↔材料）：{budget_area_item_id, type}
  'POST /budget/budget_area_item/type/cast/': ({ body }) => {
    const itemId = body && body.budget_area_item_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 20035, msg: '预算材料不存在', data: [] };
    const it = g.detail.areas[g.area_index].area_items[g.item_index];
    const { budget_area_item_id, budget_id, id, ...rest } = body;
    if (rest.type !== undefined) { it.type = Number(rest.type); delete rest.type; }
    Object.assign(it, rest);
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '明细项类型转换落库', { budget_id: Number(g.budget_id), item_id: Number(itemId) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 新增附加项：{budget_id, name, type, calculate_material, calculate_assist, calculate_worker, ...} → {budget_extra_item_id}
  'POST /budget/budget_extra_item/add/': ({ body }) => {
    const bid = body && body.budget_id;
    if (!bid) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    if (!Array.isArray(g.detail.extra_items)) g.detail.extra_items = [];
    const extraId = nextBudgetSubId();
    const { budget_id, budget_extra_item_id, id, ...rest } = body;
    const extra = { id: extraId, order: g.detail.extra_items.length, radix: 1, ...rest };
    g.detail.extra_items.push(extra);
    g.detail.extra_item_num = g.detail.extra_items.length;
    saveBudgetDetail(Number(bid), g.detail);
    logger.info('预算写接口', '附加项新增落库', { budget_id: Number(bid), extra_id: extraId, name: body.name });
    return { code: 0, msg: '成功', data: { budget_extra_item_id: extraId } };
  },

  // 编辑附加项：{budget_extra_item_id, ...字段}
  'POST /budget/budget_extra_item/edit/': ({ body }) => {
    const extraId = body && body.budget_extra_item_id;
    if (!extraId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByExtra(extraId);
    if (!g) return { code: 20045, msg: '预算综合项不存在', data: [] };
    const e = g.detail.extra_items[g.extra_index];
    const { budget_extra_item_id, budget_id, id, ...rest } = body;
    Object.assign(e, rest);
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '附加项编辑落库', { budget_id: Number(g.budget_id), extra_id: Number(extraId), fields: Object.keys(rest) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 删除附加项：{budget_extra_item_id}
  'POST /budget/budget_extra_item/del/': ({ body }) => {
    const extraId = body && body.budget_extra_item_id;
    if (!extraId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByExtra(extraId);
    if (!g) return { code: 20045, msg: '预算综合项不存在', data: [] };
    g.detail.extra_items.splice(g.extra_index, 1);
    g.detail.extra_item_num = g.detail.extra_items.length;
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '附加项删除落库', { budget_id: Number(g.budget_id), extra_id: Number(extraId) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 附加项计算基数：{budget_extra_item_id, radix}
  'POST /budget/budget_extra_item/radix/set/': ({ body }) => {
    const extraId = body && body.budget_extra_item_id;
    if (!extraId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByExtra(extraId);
    if (!g) return { code: 20045, msg: '预算综合项不存在', data: [] };
    if (body.radix !== undefined) g.detail.extra_items[g.extra_index].radix = Number(body.radix);
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '附加项基数落库', { budget_id: Number(g.budget_id), extra_id: Number(extraId), radix: body.radix });
    return { code: 0, msg: '成功', data: [] };
  },

  // 管理费/税金设置：{budget_id, manage_fee_rate|tax_fee_rate|change_item_*_enable|*_description}
  'POST /budget/manage/tax/fee/set/': ({ body }) => {
    const bid = body && body.budget_id;
    if (!bid) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    const d = g.detail;
    if (!d.manage_fee_info || typeof d.manage_fee_info !== 'object') d.manage_fee_info = { rate: '0', total_amount: '0', description: '' };
    if (!d.tax_fee_info || typeof d.tax_fee_info !== 'object') d.tax_fee_info = { rate: '0', total_amount: '0', description: '' };
    if (body.manage_fee_rate !== undefined) d.manage_fee_info.rate = String(body.manage_fee_rate);
    if (body.tax_fee_rate !== undefined) d.tax_fee_info.rate = String(body.tax_fee_rate);
    if (body.manage_fee_description !== undefined) d.manage_fee_info.description = body.manage_fee_description;
    if (body.tax_fee_description !== undefined) d.tax_fee_info.description = body.tax_fee_description;
    if (body.change_item_manage_fee_enable !== undefined) d.change_item_manage_fee_enable = Number(body.change_item_manage_fee_enable);
    if (body.change_item_tax_fee_enable !== undefined) d.change_item_tax_fee_enable = Number(body.change_item_tax_fee_enable);
    saveBudgetDetail(Number(bid), d);
    logger.info('预算写接口', '税费设置落库', { budget_id: Number(bid), manage_rate: d.manage_fee_info.rate, tax_rate: d.tax_fee_info.rate });
    return { code: 0, msg: '成功', data: [] };
  },

  // 区域属性值设置：{budget_id, area_attribute_data_list:[{area_id, data_info}]}
  'POST /budget/area/attribute/data/setting/': ({ body }) => {
    const bid = body && body.budget_id;
    const list = body && body.area_attribute_data_list;
    if (!bid || !Array.isArray(list)) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    for (const item of list) {
      const hit = findBudgetByArea(item.area_id);
      if (!hit || Number(hit.budget_id) !== Number(bid)) continue;
      // 修改 g.detail（find 返回的是独立解析副本，直接改不生效）
      g.detail.areas[hit.area_index].attribute = item.data_info || {};
    }
    saveBudgetDetail(Number(bid), g.detail);
    logger.info('预算写接口', '区域属性设置落库', { budget_id: Number(bid), count: list.length });
    return { code: 0, msg: '成功', data: [] };
  },

  // 明细项公式设置：{area_item_id, formula_list}
  'POST /budget/area/item/formula/setting/': ({ body }) => {
    const itemId = body && body.area_item_id;
    if (!itemId) return { code: 10011, msg: '参数错误', data: [] };
    const g = findBudgetByItem(itemId);
    if (!g) return { code: 10032, msg: '数据不存在', data: [] };
    const it = g.detail.areas[g.area_index].area_items[g.item_index];
    if (Array.isArray(body.formula_list)) it.formula_list = body.formula_list;
    saveBudgetDetail(g.budget_id, g.detail);
    logger.info('预算写接口', '明细项公式落库', { budget_id: Number(g.budget_id), item_id: Number(itemId) });
    return { code: 0, msg: '成功', data: [] };
  },

  // 签约预算明细项批量删除：{budget_id, budget_area_item_ids}
  'POST /budget/sign/budget_area_item/batch/del/': ({ body }) => {
    const bid = body && body.budget_id;
    const ids = body && body.budget_area_item_ids;
    if (!bid || !Array.isArray(ids)) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    let cnt = 0;
    for (const rid of ids) {
      const hit = findBudgetByItem(rid);
      if (!hit || Number(hit.budget_id) !== Number(bid)) continue;
      hit.detail.areas[hit.area_index].area_items.splice(hit.item_index, 1);
      cnt++;
    }
    saveBudgetDetail(Number(bid), g.detail);
    logger.info('预算写接口', '签约明细项批量删除落库', { budget_id: Number(bid), count: cnt });
    return { code: 0, msg: '成功', data: [] };
  },

  // ================ 预算子资源关联读接口（本地权威） ================
  // 区域列表：{budget_id} → {area_list:[{id,name}], total_num}
  'POST /budget/area/': ({ body }) => {
    const bid = body && body.budget_id;
    if (!bid) return { code: 20029, msg: '预算不存在', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    const area_list = (g.detail.areas || []).map((a) => ({ id: a.id, name: a.name || '' }));
    return { code: 0, msg: '成功', data: { area_list, total_num: area_list.length } };
  },

  // 区域属性数据：{budget_id} → {area_data_list:[{area_id,area_name,data_info}]}
  'POST /budget/area/attribute/data/get/': ({ body }) => {
    const bid = body && body.budget_id;
    if (!bid) return { code: 20029, msg: '预算不存在', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    const attrRow = db.prepare("SELECT payload FROM budget_globals WHERE kind = 'area_attribute_list'").get();
    const attrs = attrRow ? (parseJson(attrRow.payload, {}).area_attribute_list || []) : [];
    const zero = {};
    for (const a of attrs) zero[String(a.id)] = { attribute_data_id: 0, value: '' };
    const area_data_list = (g.detail.areas || []).map((area) => ({
      area_id: area.id, area_name: area.name || '',
      data_info: { ...zero, ...(area.attribute || {}) }
    }));
    return { code: 0, msg: '成功', data: { area_data_list } };
  },

  // 汇总项列表：{budget_id} → {summary_list}（本地复算，与云端公式一致）
  'POST /budget/budget_summary_item/': ({ body }) => {
    const bid = body && body.budget_id;
    if (!bid) return { code: 20029, msg: '预算不存在', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    return { code: 0, msg: '成功', data: { summary_list: calcBudgetSummary({ ...g.detail, budget_id: Number(bid) }) } };
  },

  // 新增汇总项：{budget_id, name, description}（自定义汇总行存 summary_item payload.custom）
  'POST /budget/budget_summary_item/add/': ({ body }) => {
    const bid = body && body.budget_id;
    if (!bid) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    const row = db.prepare('SELECT payload FROM budget_payloads WHERE budget_id = ? AND kind = ?').get(Number(bid), 'summary_item');
    const custom = row ? (parseJson(row.payload, {}).custom || []) : [];
    custom.push({
      id: nextBudgetSubId(), order: '九', name: body.name || '自定义项',
      description: body.description || '', total_price: String(body.total_price || '0'),
      can_edit: body.can_edit !== undefined ? Number(body.can_edit) : 1, is_bold: body.is_bold !== undefined ? Number(body.is_bold) : 0
    });
    db.prepare('INSERT OR REPLACE INTO budget_payloads (budget_id, kind, payload, updated_at) VALUES (?,?,?,?)')
      .run(Number(bid), 'summary_item', JSON.stringify({ custom }), dbNow());
    logger.info('预算写接口', '汇总项新增落库', { budget_id: Number(bid), name: body.name });
    return { code: 0, msg: '成功', data: [] };
  },

  // 编辑汇总项：{budget_summary_item_id, ...字段}
  'POST /budget/budget_summary_item/edit/': ({ body }) => {
    const sid = body && body.budget_summary_item_id;
    if (!sid) return { code: 10011, msg: '参数错误', data: [] };
    const row = db.prepare('SELECT budget_id, payload FROM budget_payloads WHERE kind = ?').all('summary_item');
    for (const r of row) {
      const custom = parseJson(r.payload, {}).custom || [];
      const hit = custom.find((c) => Number(c.id) === Number(sid));
      if (hit) {
        const { budget_summary_item_id, id, ...rest } = body;
        Object.assign(hit, rest);
        db.prepare('UPDATE budget_payloads SET payload = ?, updated_at = ? WHERE budget_id = ? AND kind = ?')
          .run(JSON.stringify({ custom }), dbNow(), r.budget_id, 'summary_item');
        logger.info('预算写接口', '汇总项编辑落库', { budget_id: Number(r.budget_id), summary_id: Number(sid) });
        return { code: 0, msg: '成功', data: [] };
      }
    }
    return { code: 20060, msg: '预算汇总项不存在', data: [] };
  },

  // 删除汇总项：{budget_summary_item_id}
  'POST /budget/budget_summary_item/del/': ({ body }) => {
    const sid = body && body.budget_summary_item_id;
    if (!sid) return { code: 10011, msg: '参数错误', data: [] };
    const row = db.prepare('SELECT budget_id, payload FROM budget_payloads WHERE kind = ?').all('summary_item');
    for (const r of row) {
      const custom = parseJson(r.payload, {}).custom || [];
      const idx = custom.findIndex((c) => Number(c.id) === Number(sid));
      if (idx >= 0) {
        custom.splice(idx, 1);
        db.prepare('UPDATE budget_payloads SET payload = ?, updated_at = ? WHERE budget_id = ? AND kind = ?')
          .run(JSON.stringify({ custom }), dbNow(), r.budget_id, 'summary_item');
        logger.info('预算写接口', '汇总项删除落库', { budget_id: Number(r.budget_id), summary_id: Number(sid) });
        return { code: 0, msg: '成功', data: [] };
      }
    }
    return { code: 20060, msg: '预算汇总项不存在', data: [] };
  },

  // 汇总项详情：{budget_summary_item_id}
  'POST /budget/budget_summary_item/detail/': ({ body }) => {
    const sid = body && body.budget_summary_item_id;
    if (!sid) return { code: 10011, msg: '参数错误', data: [] };
    const row = db.prepare('SELECT payload FROM budget_payloads WHERE kind = ?').all('summary_item');
    for (const r of row) {
      const custom = parseJson(r.payload, {}).custom || [];
      const hit = custom.find((c) => Number(c.id) === Number(sid));
      if (hit) return { code: 0, msg: '成功', data: hit };
    }
    return { code: 20060, msg: '预算汇总项不存在', data: [] };
  },

  // ---------------- 模板汇总项（/budget/template/summary_item/）----------------
  // 模板详情字段结构与预算详情略有差异（manage_fee_rate vs manage_fee_info.rate、
  // area_items 无 budget_num 默认1、价格为 '-' 需归零），适配后复用 calcBudgetSummary
  'POST /budget/template/summary_item/': ({ body }) => {
    const tid = body && (body.template_id || body.id);
    if (!tid) return { code: 10011, msg: '参数错误', data: [] };
    const row = db.prepare('SELECT payload FROM budget_globals WHERE kind = ?').get('template_detail_' + Number(tid));
    if (!row) return null; // 未迁移该模板，回退代理
    try {
      const d = JSON.parse(row.payload);
      const numOrZero = (v) => Number(v) || 0;
      const adapted = {
        budget_id: Number(tid),
        areas: (d.areas || []).map(function (a) {
          return {
            id: a.id,
            area_items: (a.area_items || []).map(function (it) {
              return {
                type: it.type,
                budget_num: (it.budget_num !== undefined && it.budget_num !== '') ? it.budget_num : 1,
                main_material_sale_price: numOrZero(it.main_material_sale_price),
                assist_material_sale_price: numOrZero(it.assist_material_sale_price),
                worker_sale_price: numOrZero(it.worker_sale_price)
              };
            })
          };
        }),
        manage_fee_info: { rate: Number(d.manage_fee_rate) || 0 },
        tax_fee_info: { rate: Number(d.tax_fee_rate) || 0 }
      };
      return { code: 0, msg: '成功', data: { summary_list: calcBudgetSummary(adapted) } };
    } catch (e) { return null; }
  },
  // 模板汇总项新增：{template_id, name, description, ...}
  'POST /budget/template/summary_item/add/': ({ body }) => {
    const tid = body && body.template_id;
    if (!tid) return { code: 10011, msg: '参数错误', data: [] };
    const row = db.prepare('SELECT payload FROM budget_payloads WHERE budget_id = ? AND kind = ?').get(Number(tid), 'summary_item');
    const custom = row ? (parseJson(row.payload, {}).custom || []) : [];
    const sid = nextBudgetSubId();
    custom.push({
      id: sid, template_summary_item_id: sid, order: '九', name: body.name || '自定义项',
      description: body.description || '', total_price: String(body.total_price || '0'),
      can_edit: body.can_edit !== undefined ? Number(body.can_edit) : 1, is_bold: body.is_bold !== undefined ? Number(body.is_bold) : 0
    });
    db.prepare('INSERT OR REPLACE INTO budget_payloads (budget_id, kind, payload, updated_at) VALUES (?,?,?,?)')
      .run(Number(tid), 'summary_item', JSON.stringify({ custom }), dbNow());
    logger.info('预算写接口', '模板汇总项新增落库', { template_id: Number(tid), name: body.name });
    return { code: 0, msg: '成功', data: [] };
  },
  // 模板汇总项编辑：{template_summary_item_id, ...字段}
  'POST /budget/template/summary_item/edit/': ({ body }) => {
    const sid = body && body.template_summary_item_id;
    if (!sid) return { code: 10011, msg: '参数错误', data: [] };
    const row = db.prepare('SELECT budget_id, payload FROM budget_payloads WHERE kind = ?').all('summary_item');
    for (const r of row) {
      const custom = parseJson(r.payload, {}).custom || [];
      const hit = custom.find((c) => Number(c.id) === Number(sid));
      if (hit) {
        const { template_summary_item_id, id, ...rest } = body;
        Object.assign(hit, rest);
        db.prepare('UPDATE budget_payloads SET payload = ?, updated_at = ? WHERE budget_id = ? AND kind = ?')
          .run(JSON.stringify({ custom }), dbNow(), r.budget_id, 'summary_item');
        logger.info('预算写接口', '模板汇总项编辑落库', { budget_id: Number(r.budget_id), summary_id: Number(sid) });
        return { code: 0, msg: '成功', data: [] };
      }
    }
    return { code: 20060, msg: '预算汇总项不存在', data: [] };
  },
  // 模板汇总项删除：{template_summary_item_id}
  'POST /budget/template/summary_item/del/': ({ body }) => {
    const sid = body && body.template_summary_item_id;
    if (!sid) return { code: 10011, msg: '参数错误', data: [] };
    const row = db.prepare('SELECT budget_id, payload FROM budget_payloads WHERE kind = ?').all('summary_item');
    for (const r of row) {
      const custom = parseJson(r.payload, {}).custom || [];
      const idx = custom.findIndex((c) => Number(c.id) === Number(sid));
      if (idx >= 0) {
        custom.splice(idx, 1);
        db.prepare('UPDATE budget_payloads SET payload = ?, updated_at = ? WHERE budget_id = ? AND kind = ?')
          .run(JSON.stringify({ custom }), dbNow(), r.budget_id, 'summary_item');
        logger.info('预算写接口', '模板汇总项删除落库', { budget_id: Number(r.budget_id), summary_id: Number(sid) });
        return { code: 0, msg: '成功', data: [] };
      }
    }
    return { code: 20060, msg: '预算汇总项不存在', data: [] };
  },
  // 模板汇总项详情：{template_summary_item_id}
  'POST /budget/template/summary_item/detail/': ({ body }) => {
    const sid = body && body.template_summary_item_id;
    if (!sid) return { code: 10011, msg: '参数错误', data: [] };
    const row = db.prepare('SELECT payload FROM budget_payloads WHERE kind = ?').all('summary_item');
    for (const r of row) {
      const custom = parseJson(r.payload, {}).custom || [];
      const hit = custom.find((c) => Number(c.id) === Number(sid));
      if (hit) return { code: 0, msg: '成功', data: hit };
    }
    return { code: 20060, msg: '预算汇总项不存在', data: [] };
  },

  // 区域属性字典（公司级快照，由 migrate-budget-materials.js 落库；缺失回退代理）
  'POST /budget/template/area/attribute/list/': budgetGlobal('area_attribute_list'),

  // ---------------- 预算模块扩展本地化（材料库/定额/分析设置/模板子资源/提交审核） ----------------
  // 材料库列表：公司级快照（migrate-budget-ext.js 全量落库；缺失回退代理）
  'POST /budget/material/list/': budgetGlobal('material_list'),
  // 材料详情：快照内按 id 查找；无 → 回退代理
  'POST /budget/material/detail/': ({ body }) => {
    const mid = body && (body.id || body.material_id);
    if (!mid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare("SELECT payload FROM budget_globals WHERE kind = 'material_list'").get();
    if (!row) return null;
    const d = parseJson(row.payload, null);
    const mat = (d && Array.isArray(d.materials) && d.materials.find((m) => Number(m.id) === Number(mid))) || null;
    if (!mat) return null;
    return { code: 0, msg: '成功', data: mat };
  },
  // 材料编辑：更新快照中对应材料（宽容落库）
  'POST /budget/material/edit/': ({ body }) => {
    const mid = body && (body.id || body.material_id);
    if (!mid) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare("SELECT payload FROM budget_globals WHERE kind = 'material_list'").get();
    if (!row) return { code: 10032, msg: '数据不存在', data: {} };
    const d = parseJson(row.payload, { materials: [] });
    if (!Array.isArray(d.materials)) d.materials = [];
    let found = false;
    for (const m of d.materials) if (Number(m.id) === Number(mid)) { Object.assign(m, body); found = true; }
    if (!found) return { code: 10032, msg: '数据不存在', data: {} };
    db.prepare("INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('material_list',?,?) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .run(JSON.stringify(d), dbNow());
    logger.info('预算写接口', '材料编辑落库', { material_id: Number(mid) });
    return { code: 0, msg: '成功', data: {} };
  },
  // 定额树 v2 / 定额类型 / 定额内容（公司级快照）
  'POST /budget/v2/project_quota/list/': budgetGlobal('project_quota_list'),
  'POST /budget/project_quota_type/list/': budgetGlobal('project_quota_types'),
  'POST /budget/project_quota/content/list/': budgetGlobal('project_quota_contents'),
  // 定额关系：快照树内递归查（无 → 20021 工程定额不存在）
  'POST /budget/project_quota/relations/get/': ({ body }) => {
    const qid = body && (body.project_quota_id || body.id);
    if (!qid) return { code: 20021, msg: '工程定额不存在', data: {} };
    const row = db.prepare("SELECT payload FROM budget_globals WHERE kind = 'project_quota_list'").get();
    if (!row) return null;
    const d = parseJson(row.payload, null);
    const find = (list) => {
      if (!Array.isArray(list)) return null;
      for (const it of list) {
        if (Number(it.id) === Number(qid)) return it;
        const sub = find(it.project_quota_list);
        if (sub) return sub;
      }
      return null;
    };
    const item = find(d && d.project_quota_list);
    if (!item) return { code: 20021, msg: '工程定额不存在', data: {} };
    return { code: 0, msg: '成功', data: { project_quota_id: item.id, name: item.name, project_quota_contents: [] } };
  },
  // 规格详情：specification 快照内查（无 → 20023 工程定额规格不存在）
  'POST /budget/specification/detail/': ({ body }) => {
    const sid = body && (body.specification_id !== undefined ? body.specification_id : body.id);
    if (sid === undefined || sid === null) return { code: 10011, msg: '参数错误', data: {} };
    const row = db.prepare("SELECT payload FROM budget_globals WHERE kind = 'specification'").get();
    if (!row) return null;
    const d = parseJson(row.payload, null);
    const list = (d && (d.specifications || d.list || [])) || [];
    const item = list.find((x) => Number(x.id || x.specification_id) === Number(sid)) || null;
    if (!item) return { code: 20023, msg: '工程定额规格不存在', data: {} };
    return { code: 0, msg: '成功', data: item };
  },
  // 分析设置：快照读 + 宽容写
  'POST /budget/company/analysis/detail/settings/': budgetGlobal('analysis_settings'),
  'POST /budget/company/analysis/detail/settings/edit/': ({ body }) => setBudgetGlobalAny('analysis_settings', body),
  // 模板子资源：按 template_id 存 kind=template_fee_detail_<id> / template_formula_<id>
  'POST /budget/template/fee_detail/get/': ({ body }) => {
    const tid = body && (body.template_id || body.id);
    if (!tid) return { code: 0, msg: '成功', data: { show_fee_detail: 1 } };
    const row = db.prepare('SELECT payload FROM budget_globals WHERE kind = ?').get('template_fee_detail_' + tid);
    if (!row) return null;
    return { code: 0, msg: '成功', data: parseJson(row.payload, { show_fee_detail: 1 }) };
  },
  'POST /budget/template/formula/records/': ({ body }) => {
    const tid = body && (body.template_id || body.id);
    if (!tid) return { code: 0, msg: '成功', data: { record_list: [], total_num: 0 } };
    const row = db.prepare('SELECT payload FROM budget_globals WHERE kind = ?').get('template_formula_' + tid);
    if (!row) return null;
    return { code: 0, msg: '成功', data: parseJson(row.payload, { record_list: [], total_num: 0 }) };
  },
  // 模板表头字段（公司级快照，entry_type 0=模板设置全字段 / 1=模板页展示字段）
  'POST /budget/template/table_header/list/': ({ body }) => {
    const entry = body && body.entry_type !== undefined ? Number(body.entry_type) : 1;
    const row = db.prepare('SELECT payload FROM budget_globals WHERE kind = ?').get('template_table_header_' + entry);
    if (!row) return null; // 未迁移：回退代理（云端会话可用时在线获取）
    try { return { code: 0, msg: '成功', data: JSON.parse(row.payload) }; } catch { return null; }
  },
  // 地区库（省/市/区县）：本地全量快照 data/areas.json {parent:[{code,name}]}；缺失回退代理
  'POST /area_info/web/list/': ({ body }) => {
    try {
      const areas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'areas.json'), 'utf8'));
      const key = body && body.code !== undefined ? String(body.code) : '0';
      return { code: 0, msg: '成功', data: { areas: areas[key] || [] } };
    } catch { return null; }
  },
  // 明细项成本：从预算 detail 构造（worker_loss_rate_enable + budget_area_items）
  'POST /budget/budget_area_item/cost/get/': ({ body }) => {
    const bid = body && body.budget_id;
    if (!bid) return { code: 10011, msg: '参数错误', data: [] };
    const g = getBudgetDetailObj(bid);
    if (!g) return { code: 20029, msg: '预算不存在', data: [] };
    const items = [];
    for (const a of (g.detail.areas || [])) for (const it of (a.area_items || [])) items.push({ ...it, area_name: a.name });
    return { code: 0, msg: '成功', data: { worker_loss_rate_enable: g.detail.worker_loss_rate_enable || 0, budget_area_items: items } };
  },
  // 提交审核/撤销审核/审核：校验预算存在（20029）→ status 更新（commit=1 / cancel=0 / review 透传 body.status 默认 2）
  'POST /budget/commit/': ({ body }) => updateBudgetStatus(body, 1, '提交审核'),
  'POST /budget/cancel/': ({ body }) => updateBudgetStatus(body, 0, '撤销审核'),
  'POST /budget/review/': ({ body }) => updateBudgetStatus(body, (body && body.status !== undefined && body.status !== null) ? Number(body.status) : 2, '审核'),
  // 审核规则/审核人设置：宽容落库 budget_globals
  'POST /budget/company/review/set/': ({ body }) => setBudgetGlobalAny('review_set', body),
  'POST /budget/company/reviewer/set/': ({ body }) => setBudgetGlobalAny('reviewer_setting', body),
  'POST /budget/company/reviewer/del/': ({ body }) => setBudgetGlobalAny('reviewer_setting', body, true),

  // ---------------- 财务模块本地化（收款/请款/资金记录，公司级快照 + 请款宽容落库） ----------------
  // 项目收款页（financial-income）主列表：原站 /finance/list/（非 v2 路径，快照同构）
  // 商品展厅（原站 /company/showroom/*，云端快照 1:1）
  'POST /company/showroom/commodity_content/list/': showroomContentList,
  'POST /company/showroom/material/list/': showroomMaterialList,
  // 汇总类读接口（云端快照 1:1）
  'POST /material_apply/v3/decorator/order/list/': materialOrderList,
  'POST /company/overview/data/': companyOverview,
  'POST /company/statistics/data/': companyStatistics,
  'POST /project/inspection/company/list/': inspectionCompanyList,
  'POST /project/attendance/company/list/': attendanceCompanyList,
  'POST /oa/attendance/company/month/check/statistic/': oaAttendanceStatistic,
  'POST /company/business/market/data/department/ranking/': deptRanking,
  // 后台财务设置（个性化设置页·财务管理 tab，云端快照 1:1；写接口宽容落库防云端污染）
  'POST /company/project/payment/setting/': bfRead(bfPaymentSettingSnap, {}),
  'POST /company/project/payment/setting/edit/': financeWriteSafe('payment_setting_edit'),
  'POST /company/material/apply/setting/contract/types/': bfRead(bfApplyContractTypesSnap, {}),
  'POST /company/material/apply/setting/commodity/contents/': bfRead(bfApplyCommodityContentsSnap, {}),
  'POST /company/material/apply/setting/edit/': financeWriteSafe('material_apply_setting_edit'),
  'POST /company/list/': bfRead(bfCompanyListSnap, {}),
  'POST /finance/add/sub_company/account/setting/': bfRead(bfSubCompanyAccountSnap, {}),
  'POST /finance/add/sub_company/account/setting/set/': financeWriteSafe('sub_company_account_set'),
  'POST /oa/reimbursement/review/mode/get/': bfRead(bfReimbursementModeSnap, {}),
  'POST /oa/reimbursement/review/mode/set/': financeWriteSafe('reimbursement_mode_set'),
  'POST /finance/project/apply_type/list/': bfRead(bfApplyTypeListSnap, {}),
  'POST /finance/analysis/setting/': bfRead(bfAnalysisSettingSnap, {}),
  'POST /finance/analysis/setting/set/': financeWriteSafe('analysis_setting_set'),
  'POST /finance/list/': financeListHandler,
  // 财务收款详情（子窗口 financial-income-detail）
  'POST /finance/detail/': financeDetailHandler,
  // 财务详情写接口（本地落库，云端零污染；v2 与旧路径同实现）
  'POST /finance/paid/record/add/': financeWriteAdd('income_add'),
  'POST /finance/paid/record/edit/': financeWriteEdit(),
  'POST /finance/paid/record/del/': financeWriteDel(),
  'POST /finance/v2/paid/record/add/': financeWriteAdd('income_add'),
  'POST /finance/v2/paid/record/edit/': financeWriteEdit(),
  'POST /finance/v2/paid/record/del/': financeWriteDel(),
  'POST /finance/contract/add/': financeContractAdd,
  'POST /finance/contract/modify/': financeContractModify,
  'POST /finance/v2/contract/add/': financeContractAdd,
  'POST /finance/v2/contract/modify/': financeContractModify,
  'POST /finance/contract/del/': financeContractDel,
  'POST /finance/contract/order/update/': financeContractOrder,
  'POST /finance/contract/bad_debt/set/': financeBadDebt,
  'POST /finance/contract/add_prepay/add/': financePrepayAdd,
  'POST /finance/contract/add_prepay/del/': financePrepayDel,
  'POST /finance/file/add/': financeFileAdd,
  'POST /finance/file/del/': financeFileDel,
  'POST /finance/set/': financeBasicSet,
  'POST /finance/crm/del/': financeCrmDel,
  // 其余财务写接口安全兜底（宽容落库，云端零污染）
  'POST /finance/analysis/paid_record/add/': financeWriteSafe('analysis_paid_add'),
  'POST /finance/v2/analysis/paid_record/add/': financeWriteSafe('analysis_paid_add'),
  'POST /finance/business/fee/add/': financeWriteSafe('business_fee_add'),
  'POST /finance/business/fee/edit/': financeWriteSafe('business_fee_edit'),
  'POST /finance/business/fee/del/': financeWriteSafe('business_fee_del'),
  'POST /finance/paid/edit/': financeWriteSafe('paid_edit'),
  'POST /finance/project/apply_type/add/': financeWriteSafe('apply_type_add'),
  'POST /finance/project/apply_type/del/': financeWriteSafe('apply_type_del'),
  'POST /finance/self_define_fee/record/add/': financeWriteSafe('self_fee_add'),
  'POST /finance/woker_fee/add/': financeWriteSafe('woker_fee_add'),
  'POST /finance/material_fee/add/': financeWriteSafe('material_fee_add'),
  'POST /finance/user/status/lock/update/': financeWriteSafe('user_lock_update'),
  'POST /finance/rejected/project/apply/del/': financeWriteSafe('rejected_apply_del'),
  'POST /finance/business/fee/file/add/': financeWriteSafe('business_fee_file_add'),
  'POST /finance/business/fee/file/del/': financeWriteSafe('business_fee_file_del'),
  'POST /finance/company/project/batch/apply/review/': financeWriteSafe('batch_apply_review'),
  'POST /finance/crm/import/': financeWriteSafe('crm_import'),
  'POST /finance/project/batch/apply/paid/': financeWriteSafe('batch_apply_paid'),
  'POST /finance/project/receivable/summary/setting/edit/': financeWriteSafe('recv_summary_setting'),
  'POST /finance/v2/project/receivable/summary/setting/edit/': financeWriteSafe('recv_summary_setting'),
  'POST /finance/project_type/add/': financeWriteSafe('project_type_add'),
  'POST /finance/project_type/del/': financeWriteSafe('project_type_del'),
  'POST /finance/v2/company/contract/pay_setting/set/': financeWriteSafe('pay_setting_set'),
  // 修改记录列表（云端当前为空记录，1:1 镜像）
  'POST /finance/edit/record/list/': () => ({ code: 0, msg: '成功', data: { records: [] } }),
  // 收款/编辑/审核详情（云端行为 1:1：paid/detail 空对象、edit/paid/detail 与 check/detail 数据不存在）
  'POST /finance/paid/detail/': () => ({ code: 0, msg: '成功', data: {} }),
  'POST /finance/edit/paid/detail/': () => ({ code: 10032, msg: '数据不存在', data: {} }),
  'POST /finance/contract/check/detail/': () => ({ code: 10032, msg: '数据不存在', data: {} }),
  // 项目付款页：原站 /finance/paid/list/ 对当前 SPA 版本返回"软件版本过低"（12002），1:1 镜像
  'POST /finance/paid/list/': () => ({ code: 12002, msg: '您当前使用的软件版本过低，请前往手机应用市场或亮宅官网下载最新版本', data: {} }),
  // 收款列表（v2/paid/list）与旧版（v2/list 财务客户汇总）
  'POST /finance/v2/paid/list/': financePaidList,
  'POST /finance/v2/paid/filter/list/': financeGlobal('paid_filter'),
  'POST /finance/v2/list/': financeCrmList,
  'POST /finance/v2/filter/list/': financeGlobal('finance_filter'),
  // 请款入口项目列表 / 公司项目列表 / 批量请款列表
  'POST /finance/project/list/': financeProjectList,
  'POST /finance/company/project/list/': financeGlobal('company_project_list'),
  'POST /finance/company/project/apply/list/': financeApplyList,
  'POST /finance/company/project/batch/apply/list/': () => ({ code: 0, msg: '成功', data: { total_num: 0, items: [] } }),
  // 收款明细（按客户快照）
  'POST /finance/project/receivable/detail/list/': financeReceivableDetail,
  // 项目应收汇总（按 is_bad 快照）
  'POST /finance/project/receivable/summary/list/': financeReceivableSummary,
  // 收付款分析 / 项目流水 / 公司账户管理（快照 1:1）
  'POST /finance/v2/analysis/paid/': financeAnalysisPaid,
  'POST /finance/v2/financial/record/list/': financeJournal,
  'POST /company/account/list/': financeAccountList,
  // 请款/资金记录筛选条件（公司级快照）
  'POST /finance/company/project/apply/all_conditions/': financeGlobal('apply_conditions'),
  'POST /finance/financial/record/all_conditions/': financeGlobal('financial_conditions'),
  'POST /finance/financial/record/all_crms/': () => {
    const g = financeGlobal('financial_conditions')();
    return g ? { code: 0, msg: '成功', data: { total_num: g.data.all_crms.length, crms: g.data.all_crms } } : null;
  },
  'POST /finance/financial/record/all_objects/': () => {
    const g = financeGlobal('financial_conditions')();
    return g ? { code: 0, msg: '成功', data: { total_num: g.data.all_object_names.length, object_name_list: g.data.all_object_names } } : null;
  },
  'POST /finance/financial/record/all_types/': () => {
    const g = financeGlobal('financial_conditions')();
    return g ? { code: 0, msg: '成功', data: { fund_types: g.data.fund_types } } : null;
  },
  'POST /finance/financial/record/all_child_apply_types/': () => ({ code: 0, msg: '成功', data: { child_apply_types: [] } }),
  // 请款写接口（模式 A：宽容落库 finance_globals kind=applies，9 亿号段 id）+ 状态操作（本地快照合并）
  'POST /finance/project/apply/': financeApplyAdd,
  'POST /finance/project/apply/detail/': financeApplyDetail2,
  'POST /finance/project/apply/review/': financeApplyStatusOp(1),
  'POST /finance/project/apply/reject/': financeApplyStatusOp(3),
  'POST /finance/project/apply/resubmit/': financeApplyStatusOp(0),
  'POST /finance/project/apply/withdraw/': financeApplyStatusOp(4),
  'POST /finance/project/apply/paid/': financeApplyStatusOp(2),
  'POST /finance/company/project/apply/set_top/': financeApplyTop,
  'POST /finance/company/project/apply/del/': financeApplyDel,
  // 请款子记录编辑：仅合并 body（record/edit / certification/edit）
  'POST /finance/project/apply/record/edit/': financeApplyStatus('record编辑', undefined),
  'POST /finance/v2/project/apply/record/edit/': financeApplyStatus('record编辑v2', undefined),
  'POST /finance/project/apply/certification/edit/': financeApplyStatus('认证编辑', undefined),
};

// 合并企业后台（houtai）接口：/company/v2/admin/*，后台配置落 SQLite，写操作联动主站快照
Object.assign(handlers, createCompanyApi(db, { ok, parseJson, getSession, dbNow, md5 }));
Object.assign(handlers, createCommodityStockApi(db, { ok, parseJson, getSession, dbNow }));
// crm 客户管理第一批接口（废单/公司列表/分配/批量作废/查重/公海）
Object.assign(handlers, createCrmApi(db, { ok, parseJson, getSession, dbNow, buildCrmItem, queryCrmList, localNextId }));
// 第五批接口（材料库 + 供应商/采购，全本地实现）
Object.assign(handlers, createMaterialApi(db, { ok, parseJson, getSession, dbNow, localNextId }));

// ================ 预算说明本地化（覆盖旧 budgetGlobal 实现） ================
// 原站结构：POST /budget/company/budget/explanation/list/ 按 file_type 区分
//   file_type=0 → excel 预算说明；file_type=1 → pdf、docx 预算说明
// 旧实现忽略 file_type 且缺 pdf 种子；这里建表 + 原站种子 + 按类型过滤（写操作阶段3落库）
db.exec(`CREATE TABLE IF NOT EXISTS budget_explanations (
  budget_explanation_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  file_type INTEGER NOT NULL DEFAULT 0,
  budget_explanation_url TEXT NOT NULL,
  order_num INTEGER NOT NULL DEFAULT 0
)`);
{
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM budget_explanations').get().c;
  if (cnt === 0) {
    const seed = [
      [12709, '套餐清单', 0, 'https://cdn.e-shigong.com/company-6808-image-1726995013-20240922165013dsn942.xlsx', 1],
      [3343, '预算说明', 1, 'http://cdn.e-shigong.com/company-6808-image-1695258854-20230921091414r9w789.pdf', 1],
      [3344, '清单预算说明', 1, 'http://cdn.e-shigong.com/company-6808-image-1695268582-2023092111562244d158.pdf', 2]
    ];
    const ins = db.prepare('INSERT INTO budget_explanations (budget_explanation_id, name, file_type, budget_explanation_url, order_num) VALUES (?, ?, ?, ?, ?)');
    for (const s of seed) ins.run(...s);
    logger.info('预算说明', '种子初始化', { count: seed.length });
  }
}
handlers['POST /budget/company/budget/explanation/list/'] = ({ body }) => {
  const ft = Number(body && body.file_type !== undefined ? body.file_type : 0);
  const rows = db.prepare('SELECT budget_explanation_id, name, file_type, budget_explanation_url FROM budget_explanations WHERE file_type = ? ORDER BY order_num ASC').all(ft);
  return { code: 0, msg: '成功', data: { total_num: rows.length, file_list: rows } };
};
handlers['POST /budget/company/budget/explanation/add/'] = ({ body }) => {
  const maxId = db.prepare('SELECT COALESCE(MAX(budget_explanation_id), 0) AS m FROM budget_explanations').get().m + 1;
  db.prepare('INSERT INTO budget_explanations (budget_explanation_id, name, file_type, budget_explanation_url, order_num) VALUES (?, ?, ?, ?, ?)')
    .run(maxId, String(body && body.name || '说明'), Number(body && body.file_type !== undefined ? body.file_type : 0), String(body && body.budget_explanation_url || ''), maxId);
  return { code: 0, msg: '成功', data: {} };
};
handlers['POST /budget/company/budget/explanation/del/'] = ({ body }) => {
  const id = Number(body && (body.budget_explanation_id || body.id) || 0);
  db.prepare('DELETE FROM budget_explanations WHERE budget_explanation_id = ?').run(id);
  return { code: 0, msg: '成功', data: {} };
};
handlers['POST /budget/company/budget/explanation/edit/'] = ({ body }) => {
  const id = Number(body && (body.budget_explanation_id || body.id) || 0);
  const cur = db.prepare('SELECT * FROM budget_explanations WHERE budget_explanation_id = ?').get(id);
  if (!cur) return { code: 10011, msg: '说明不存在', data: {} };
  db.prepare('UPDATE budget_explanations SET name = ?, file_type = ?, budget_explanation_url = ? WHERE budget_explanation_id = ?')
    .run(String(body.name !== undefined ? body.name : cur.name), Number(body.file_type !== undefined ? body.file_type : cur.file_type), String(body.budget_explanation_url !== undefined ? body.budget_explanation_url : cur.budget_explanation_url), id);
  return { code: 0, msg: '成功', data: {} };
};
handlers['POST /budget/company/budget/explanation/order/update/'] = ({ body }) => {
  const arr = body && Array.isArray(body.order) ? body.order : (body && body.list);
  if (Array.isArray(arr)) {
    arr.forEach((item, idx) => {
      const id = Number(item && (item.budget_explanation_id || item.id));
      if (id) db.prepare('UPDATE budget_explanations SET order_num = ? WHERE budget_explanation_id = ?').run(idx + 1, id);
    });
  }
  return { code: 0, msg: '成功', data: {} };
};

// ================ 成员/部门快照本地化（结构对齐原站） ================
// 以原站真实响应为种子（data/reference/*.json），返回结构 1:1；写操作（阶段3）在快照上叠加
db.exec(`CREATE TABLE IF NOT EXISTS company_department_snapshot (
  dept_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS company_member_snapshot (
  user_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS company_member_all_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL
)`);
{
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM company_department_snapshot').get().c;
  if (cnt === 0) {
    try {
      const refDir = path.join(ROOT, 'data', 'reference');
      const dlFile = path.join(refDir, 'department_list.json');
      const maFile = path.join(refDir, 'department_member_all.json');
      if (fs.existsSync(dlFile) && fs.existsSync(maFile)) {
        const dl = JSON.parse(fs.readFileSync(dlFile, 'utf8'));
        const ma = JSON.parse(fs.readFileSync(maFile, 'utf8'));
        if (dl.data && Array.isArray(dl.data.department_list) && ma.data) {
          const insD = db.prepare('INSERT INTO company_department_snapshot (dept_id, payload) VALUES (?, ?)');
          const walk = (list) => { for (const d of list) { insD.run(Number(d.id), JSON.stringify(d)); if (Array.isArray(d.child_departments)) walk(d.child_departments); } };
          walk(dl.data.department_list);
          const insM = db.prepare('INSERT INTO company_member_snapshot (user_id, payload) VALUES (?, ?)');
          const seen = new Set();
          const dml = Array.isArray(ma.data.department_member_list) ? ma.data.department_member_list : [];
          for (const dm of dml) {
            if (!Array.isArray(dm.user_info)) continue;
            for (const u of dm.user_info) {
              const uid = Number(u.user_id || 0);
              if (!uid || seen.has(uid)) continue;
              seen.add(uid);
              insM.run(uid, JSON.stringify({ ...u, department_id: dm.department_id, department_name: dm.department_name }));
            }
          }
          db.prepare('INSERT INTO company_member_all_snapshot (id, payload) VALUES (1, ?)').run(JSON.stringify(ma.data));
          logger.info('成员/部门', '快照种子导入', { departments: dl.data.department_list.length, members: seen.size });
        }
      } else {
        logger.warn('成员/部门', '快照种子缺失 reference 文件', {});
      }
    } catch (e) { logger.warn('成员/部门', '快照种子失败', { err: e.message }); }
  }
}
// ================ 部门 / 成员 快照读写合并（写操作落 local_records 或快照树，读接口即时可见） ================
// 部门树辅助
function loadDeptTree() {
  const rows = db.prepare('SELECT payload FROM company_department_snapshot ORDER BY dept_id').all();
  return rows.map(r => { try { return JSON.parse(r.payload); } catch { return null; } })
    .filter(Boolean).filter(d => Number(d.level || 1) === 1);
}
function saveDeptTree(tree) {
  const flat = [];
  const walk = (nodes) => { for (const n of nodes) { flat.push(n); if (Array.isArray(n.child_departments)) walk(n.child_departments); } };
  walk(tree);
  db.prepare('DELETE FROM company_department_snapshot').run();
  const ins = db.prepare('INSERT INTO company_department_snapshot (dept_id, payload) VALUES (?, ?)');
  for (const n of flat) ins.run(Number(n.id), JSON.stringify(n));
}
function findDeptNode(nodes, id) {
  for (const n of nodes) {
    if (Number(n.id) === Number(id)) return n;
    const c = findDeptNode(n.child_departments || [], id);
    if (c) return c;
  }
  return null;
}
function removeDeptNode(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (Number(nodes[i].id) === Number(id)) { nodes.splice(i, 1); return true; }
    if (removeDeptNode(nodes[i].child_departments || [], id)) return true;
  }
  return false;
}
function maxDeptId() {
  let m = 0;
  for (const r of db.prepare('SELECT payload FROM company_department_snapshot').all()) {
    try { m = Math.max(m, Number(JSON.parse(r.payload).id) || 0); } catch {}
  }
  return m;
}
// 部门 id → 名称（快照树优先，回退 getDeptName）
function deptNameOf(deptId) {
  const tree = loadDeptTree();
  const node = findDeptNode(tree, Number(deptId));
  if (node) return node.name || '';
  return getDeptName(deptId) || '';
}
// 本地成员 payload → 原站 user 行结构（phone_number 字段与原站一致）
function localMemberView(rec) {
  const p = rec.payload || {};
  const deptIds = memberDeptIds(p);
  return {
    user_id: Number(p.user_id || rec.record_id || 0),
    user_name: p.user_name || '',
    phone_number: p.phone_number || p.user_phone || '',
    user_avatar: p.user_avatar || 'https://cdn.e-shigong.com/brief_default_avatar.png',
    user_accid: p.user_accid || '',
    roles: Array.isArray(p.roles) ? p.roles : [],
    is_leader: p.is_leader || 0,
    department_id: deptIds[0] || 0,
    department_ids: deptIds,
    department_num: (Array.isArray(p.department_info) ? p.department_info.length : 0) || deptIds.length,
    department_info: Array.isArray(p.department_info) ? p.department_info : deptIds.map(did => ({ department_id: did, department_name: deptNameOf(did) })),
    enabled: p.enabled !== 0
  };
}
function memberDeptIds(p) {
  if (Array.isArray(p.department_ids)) return p.department_ids.map(Number);
  if (p.department_id) return [Number(p.department_id)];
  return [];
}
function snapshotMember(userId) {
  const r = db.prepare('SELECT payload FROM company_member_snapshot WHERE user_id = ?').get(userId);
  return r ? JSON.parse(r.payload) : null;
}
// 本地成员覆盖合并：deleted 墓碑剔除快照成员，未删除的本地成员覆盖/追加
function applyLocalMembers(baseUsers) {
  const byId = new Map(baseUsers.map(u => [Number(u.user_id), u]));
  const rows = db.prepare("SELECT record_id, payload, deleted FROM local_records WHERE entity = 'member'").all();
  for (const r of rows) {
    let p = {};
    try { p = JSON.parse(r.payload); } catch {}
    const uid = Number(p.user_id || r.record_id);
    if (r.deleted) { byId.delete(uid); continue; }
    byId.set(uid, localMemberView({ record_id: r.record_id, payload: p }));
  }
  return [...byId.values()];
}
// 把本地成员并入部门树的 user_info_list（同时重算 user_num）
function applyLocalMembersToTree(tree) {
  const allNodes = [];
  const walk = (nodes) => { for (const n of nodes) { allNodes.push(n); if (Array.isArray(n.child_departments)) walk(n.child_departments); } };
  walk(tree);
  const rows = db.prepare("SELECT record_id, payload, deleted FROM local_records WHERE entity = 'member'").all();
  for (const r of rows) {
    let p = {};
    try { p = JSON.parse(r.payload); } catch {}
    const uid = Number(p.user_id || r.record_id);
    if (r.deleted) {
      for (const node of allNodes) {
        const before = (node.user_info_list || []).length;
        node.user_info_list = (node.user_info_list || []).filter(u => Number(u.user_id) !== uid);
        if (node.user_info_list.length !== before) node.user_num = node.user_info_list.length;
      }
      continue;
    }
    for (const did of memberDeptIds(p)) {
      const node = findDeptNode(tree, did);
      if (!node) continue;
      if (!Array.isArray(node.user_info_list)) node.user_info_list = [];
      if (!node.user_info_list.some(u => Number(u.user_id) === uid)) {
        node.user_info_list.push({
          user_id: uid, user_name: p.user_name || '',
          user_phone: p.phone_number || p.user_phone || '',
          user_avatar: p.user_avatar || 'https://cdn.e-shigong.com/brief_default_avatar.png',
          user_accid: p.user_accid || '', roles: Array.isArray(p.roles) ? p.roles : [],
          is_leader: p.is_leader || 0, department_id: Number(did)
        });
        node.user_num = node.user_info_list.length;
      }
    }
  }
}
// 部门列表：原站结构 { edit_permission, department_list: [树] }
handlers['POST /company/v2/department/list/'] = () => {
  const tree = loadDeptTree();
  applyLocalMembersToTree(tree);
  return { code: 0, msg: '成功', data: { edit_permission: 1, department_list: tree } };
};
// 成员总表：原站结构 { department_list, department_member_list }
handlers['POST /company/v2/department/member/all/'] = ({ body }) => {
  const snap = db.prepare('SELECT payload FROM company_member_all_snapshot WHERE id = 1').get();
  const data = snap ? JSON.parse(snap.payload) : (() => {
    const tree = loadDeptTree();
    const groups = [];
    const walk = (nodes) => { for (const n of nodes) { groups.push({ department_id: Number(n.id), department_name: n.name, user_info: n.user_info_list || [] }); if (Array.isArray(n.child_departments)) walk(n.child_departments); } };
    walk(tree);
    return { department_list: tree, department_member_list: groups };
  })();
  if (!Array.isArray(data.department_member_list)) data.department_member_list = [];
  // 合并本地成员（deleted 墓碑从对应组剔除）
  const rows = db.prepare("SELECT record_id, payload, deleted FROM local_records WHERE entity = 'member'").all();
  for (const r of rows) {
    let p = {};
    try { p = JSON.parse(r.payload); } catch {}
    const uid = Number(p.user_id || r.record_id);
    const deptIds = memberDeptIds(p);
    if (r.deleted) {
      for (const g of data.department_member_list) {
        const before = (g.user_info || []).length;
        g.user_info = (g.user_info || []).filter(u => Number(u.user_id) !== uid);
        if (g.user_info.length !== before && Array.isArray(data.department_list)) {
          const node = findDeptNode(data.department_list, Number(g.department_id));
          if (node) node.user_num = Math.max(0, (Number(node.user_num) || 0) - 1);
        }
      }
      continue;
    }
    for (const did of deptIds) {
      let g = data.department_member_list.find(x => Number(x.department_id) === Number(did));
      if (!g) {
        g = { department_id: Number(did), department_name: deptNameOf(did), user_info: [] };
        data.department_member_list.push(g);
      }
      if (!Array.isArray(g.user_info)) g.user_info = [];
      if (!g.user_info.some(u => Number(u.user_id) === uid)) {
        g.user_info.push({
          user_id: uid, user_name: p.user_name || '', user_phone: p.phone_number || p.user_phone || '',
          user_avatar: p.user_avatar || 'https://cdn.e-shigong.com/brief_default_avatar.png',
          user_accid: p.user_accid || '', roles: Array.isArray(p.roles) ? p.roles : [], is_leader: p.is_leader || 0
        });
      }
    }
  }
  return { code: 0, msg: '成功', data };
};
// 成员列表：原站结构 { total_num, member_num, users, child_departments, edit_department, data_types }
// 请求体 { id: 部门id, search_key: 关键字 }
handlers['POST /company/v2/department/member/list/'] = ({ body }) => {
  const deptId = Number(body && (body.id ?? body.department_id ?? (Array.isArray(body.department_ids) ? body.department_ids[0] : body.department_ids)) || 0);
  const kw = String(body && (body.search_key || body.keyword) || '').trim();
  const rows = db.prepare('SELECT payload FROM company_member_snapshot ORDER BY user_id').all();
  const base = rows.map(r => JSON.parse(r.payload)).map(u => ({
    user_id: Number(u.user_id || 0), user_name: u.user_name || '', phone_number: u.user_phone || '',
    user_avatar: u.user_avatar || '', user_accid: u.user_accid || '', roles: u.roles || [],
    is_leader: u.is_leader || 0, department_id: Number(u.department_id || 0), department_name: u.department_name || '',
    department_ids: u.department_ids || [Number(u.department_id || 0)], enabled: u.enabled !== 0
  }));
  let users = applyLocalMembers(base);
  if (deptId) users = users.filter(u => Number(u.department_id) === deptId || (Array.isArray(u.department_ids) && u.department_ids.map(Number).includes(deptId)));
  if (kw) users = users.filter(u => (u.user_name || '').includes(kw) || (u.phone_number || '').includes(kw));
  // 子部门（当前部门节点的 child_departments；未指定部门时返回顶层）
  const allDepts = loadDeptTree();
  const top = allDepts;
  const curNode = deptId ? findDeptNode(top, deptId) : null;
  const childDepts = (curNode ? (curNode.child_departments || []) : top).map(d => ({
    department_id: Number(d.id), department_name: d.name, order: d.order || 0, level: d.level || 1,
    child_num: d.child_num || 0, member_num: d.user_num || 0
  }));
  const editDepartment = curNode ? (Number(curNode.level || 1) === 1 ? 1 : 0) : 1;
  const dataTypes = curNode ? (curNode.data_types || []) : [1, 0, 2];
  return {
    code: 0, msg: '成功',
    data: {
      total_num: users.length, member_num: users.length, users,
      child_departments: childDepts, edit_department: editDepartment, data_types: dataTypes
    }
  };
};

// ================ 部门 / 成员 写接口（原版路径，落快照树 / local_records） ================
// 新建部门：{name, leader_ids, data_types, department_id?(父部门)} → 子部门挂 parent.child_departments
handlers['POST /company/department/add/'] = ({ body }) => {
  const name = String(body && body.name || '').trim();
  if (!name) return { code: 10011, msg: '请填写部门名称', data: {} };
  const tree = loadDeptTree();
  const parentId = Number(body.department_id || 0);
  let level = 1;
  if (parentId) {
    const parent = findDeptNode(tree, parentId);
    if (!parent) return { code: 10032, msg: '部门不存在', data: {} };
    level = (Number(parent.level) || 1) + 1;
  }
  const node = {
    id: maxDeptId() + 1, name,
    can_add: 1, user_info_list: [],
    order: 0, level,
    child_num: 0, data_types: Array.isArray(body.data_types) ? body.data_types : [],
    user_num: 0, child_departments: []
  };
  if (parentId) {
    const parent = findDeptNode(tree, parentId);
    if (!Array.isArray(parent.child_departments)) parent.child_departments = [];
    parent.child_departments.push(node);
    parent.child_num = (Number(parent.child_num) || 0) + 1;
  } else {
    tree.push(node);
  }
  saveDeptTree(tree);
  logger.info('组织架构写接口', '部门新增落库', { department_id: node.id, name, parent_id: parentId });
  return { code: 0, msg: '成功', data: { department_id: node.id } };
};
// 编辑部门：{id, name, leader_ids, data_types}
handlers['POST /company/department/edit/'] = ({ body }) => {
  const id = Number(body && body.id || 0);
  if (!id) return { code: 10011, msg: '参数错误', data: {} };
  const tree = loadDeptTree();
  const node = findDeptNode(tree, id);
  if (!node) return { code: 10032, msg: '部门不存在', data: {} };
  if (body.name !== undefined) node.name = String(body.name);
  if (body.data_types !== undefined) node.data_types = Array.isArray(body.data_types) ? body.data_types : [];
  if (Array.isArray(body.leader_ids)) {
    const leaderIds = body.leader_ids.map(Number);
    for (const u of node.user_info_list || []) u.is_leader = leaderIds.includes(Number(u.user_id)) ? 1 : 0;
  }
  saveDeptTree(tree);
  logger.info('组织架构写接口', '部门编辑落库', { department_id: id, name: node.name });
  return { code: 0, msg: '成功', data: {} };
};
// 删除部门：{id}（有成员时拒绝，与原站提示一致）
handlers['POST /company/department/del/'] = ({ body }) => {
  const id = Number(body && body.id || 0);
  if (!id) return { code: 10011, msg: '参数错误', data: {} };
  const tree = loadDeptTree();
  const node = findDeptNode(tree, id);
  if (!node) return { code: 10032, msg: '部门不存在', data: {} };
  if (Number(node.user_num || 0) > 0 || (node.user_info_list || []).length > 0) return { code: 1, msg: '请先清空该部门下的成员！', data: {} };
  removeDeptNode(tree, id);
  saveDeptTree(tree);
  logger.info('组织架构写接口', '部门删除落库', { department_id: id });
  return { code: 0, msg: '成功', data: {} };
};
// 部门排序：{data_departments: [{id, order}]}
handlers['POST /company/v2/department/order/update/'] = ({ body }) => {
  const list = Array.isArray(body && body.data_departments) ? body.data_departments : [];
  const tree = loadDeptTree();
  for (const it of list) {
    const node = findDeptNode(tree, Number(it && it.id));
    if (node) node.order = Number(it.order || 0);
  }
  saveDeptTree(tree);
  return { code: 0, msg: '成功', data: {} };
};
// 编辑成员：{department_id, user_id, user_name, phone_number, role_ids, new_department_ids}
handlers['POST /company/department/member/edit/'] = ({ body }) => {
  const userId = Number(body && body.user_id || 0);
  if (!userId) return { code: 10011, msg: '参数错误', data: {} };
  const existing = (localGet('member', userId) || {}).payload || snapshotMember(userId) || {};
  const deptIds = Array.isArray(body.new_department_ids) ? body.new_department_ids.map(Number) : memberDeptIds(existing);
  const roleNameMap = getRoleNameMap();
  const payload = {
    ...existing,
    user_id: userId,
    user_name: body.user_name !== undefined ? body.user_name : (existing.user_name || existing.name || ''),
    phone_number: body.phone_number !== undefined ? body.phone_number : (existing.phone_number || existing.user_phone || ''),
    roles: body.role_ids !== undefined
      ? body.role_ids.map(rid => ({ role_id: Number(rid), role_name: roleNameMap[Number(rid)] || '' }))
      : (Array.isArray(existing.roles) ? existing.roles : []),
    department_ids: deptIds,
    department_info: deptIds.map(did => ({ department_id: did, department_name: deptNameOf(did) })),
    user_avatar: existing.user_avatar || 'https://cdn.e-shigong.com/brief_default_avatar.png',
    user_accid: existing.user_accid || '',
    is_leader: existing.is_leader || 0,
    enabled: existing.enabled !== 0 ? 1 : 0
  };
  // 手机号变更同步 users 表（保持登录账号一致）
  const oldPhone = existing.phone_number || existing.user_phone || '';
  if (body.phone_number && oldPhone && oldPhone !== body.phone_number) {
    db.prepare('UPDATE users SET phone = ?, name = ? WHERE phone = ?').run(String(body.phone_number), payload.user_name, String(oldPhone));
  }
  localUpsert('member', userId, payload);
  logger.info('组织架构写接口', '成员编辑落库', { user_id: userId, name: payload.user_name, dept_ids: deptIds });
  return { code: 0, msg: '成功', data: {} };
};
// 成员调岗：{department_id, new_department_ids, user_ids[]}
handlers['POST /company/department/member/change_department/'] = ({ body }) => {
  const newDeptIds = (Array.isArray(body && body.new_department_ids) ? body.new_department_ids : []).map(Number);
  const userIds = Array.isArray(body && body.user_ids) ? body.user_ids : [];
  if (!newDeptIds.length || !userIds.length) return { code: 10011, msg: '参数错误', data: {} };
  for (const uid of userIds) {
    const existing = (localGet('member', uid) || {}).payload || snapshotMember(uid) || {};
    localUpsert('member', uid, {
      ...existing,
      user_id: Number(uid),
      department_ids: newDeptIds,
      department_info: newDeptIds.map(did => ({ department_id: did, department_name: deptNameOf(did) }))
    });
  }
  logger.info('组织架构写接口', '成员调岗落库', { user_ids: userIds.map(Number), new_dept_ids: newDeptIds });
  return { code: 0, msg: '成功', data: {} };
};
// 删除成员：{department_ids, user_id}；department_ids 为空 = 从公司移除（进删除记录）
handlers['POST /company/department/member/del/'] = ({ body }) => {
  const userId = Number(body && body.user_id || 0);
  if (!userId) return { code: 10011, msg: '参数错误', data: {} };
  const deptIds = (Array.isArray(body && body.department_ids) ? body.department_ids : []).map(Number);
  if (deptIds.length) {
    // 从指定部门移除（保留公司成员身份）
    const existing = (localGet('member', userId) || {}).payload || snapshotMember(userId) || {};
    localUpsert('member', userId, {
      ...existing,
      user_id: userId,
      department_ids: deptIds,
      department_info: deptIds.map(did => ({ department_id: did, department_name: deptNameOf(did) }))
    });
    return { code: 0, msg: '成功', data: {} };
  }
  // 从公司移除：快照成员建墓碑，本地成员软删；同时生成删除记录
  const existing = (localGet('member', userId) || {}).payload || snapshotMember(userId) || {};
  const now = new Date().toISOString();
  const lr = db.prepare('SELECT id FROM local_records WHERE entity = ? AND record_id = ?').get('member', String(userId));
  if (lr) localMarkDeleted('member', userId);
  else db.prepare('INSERT INTO local_records (entity, record_id, payload, deleted, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run('member', String(userId), JSON.stringify(existing), now, now);
  // 删除记录（已删除成员列表）
  const recId = localNextId('member_del');
  const firstRole = Array.isArray(existing.roles) && existing.roles[0] ? existing.roles[0] : null;
  localUpsert('member_del', recId, {
    record_id: recId,
    user_id: userId,
    user_name: existing.user_name || '',
    user_phone_number: existing.phone_number || existing.user_phone || '',
    user_avatar: existing.user_avatar || 'https://cdn.e-shigong.com/brief_default_avatar.png',
    role_name: firstRole ? (firstRole.role_name || '') : '',
    del_time: now.slice(0, 19).replace('T', ' '),
    del_user_name: '管理员',
    crm_num: 0, project_num: 0,
    transfer_button: 1, crm_button: 0, project_button: 0
  });
  logger.info('组织架构写接口', '成员移除落库', { user_id: userId, record_id: recId });
  return { code: 0, msg: '成功', data: {} };
};
// 已删除成员列表：{ record_list: [...] }
handlers['POST /company/user/del/record/'] = () => {
  const rows = db.prepare("SELECT * FROM local_records WHERE entity = 'member_del' AND deleted = 0 ORDER BY id DESC").all();
  const record_list = rows.map(r => {
    let p = {};
    try { p = JSON.parse(r.payload); } catch {}
    return {
      record_id: Number(p.record_id || r.record_id),
      user_id: Number(p.user_id || 0),
      user_name: p.user_name || '',
      user_phone_number: p.user_phone_number || '',
      user_avatar: p.user_avatar || '',
      role_name: p.role_name || '',
      del_time: p.del_time || '',
      del_user_name: p.del_user_name || '',
      crm_num: Number(p.crm_num || 0),
      project_num: Number(p.project_num || 0),
      transfer_button: p.transfer_button ? 1 : 0,
      crm_button: p.crm_button ? 1 : 0,
      project_button: p.project_button ? 1 : 0
    };
  });
  return { code: 0, msg: '成功', data: { record_list } };
};
// 删除删除记录（彻底清除）：{record_id}
handlers['POST /company/user/record/del/'] = ({ body }) => {
  const recId = body && (body.record_id || body.id);
  if (!recId) return { code: 10011, msg: '参数错误', data: {} };
  localMarkDeleted('member_del', recId);
  return { code: 0, msg: '成功', data: {} };
};
// 转移数据（单个对接人）：{user_id, crm_user_id?, project_user_id?}
handlers['POST /company/user/transfer/data/'] = ({ body }) => {
  const userId = Number(body && body.user_id || 0);
  if (!userId) return { code: 10011, msg: '参数错误', data: {} };
  const rows = db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'member_del' AND deleted = 0").all();
  const hit = rows.map(r => { let p = {}; try { p = JSON.parse(r.payload); } catch {} return { ...p, _rid: r.record_id }; })
    .find(r => Number(r.user_id) === userId);
  if (hit) {
    const next = { ...hit };
    if (body.crm_user_id !== undefined) { next.crm_user_id = body.crm_user_id; next.crm_num = 0; next.crm_button = 0; }
    if (body.project_user_id !== undefined) { next.project_user_id = body.project_user_id; next.project_num = 0; next.project_button = 0; }
    if (!Number(next.crm_num) && !Number(next.project_num)) next.transfer_button = 0;
    localUpsert('member_del', hit._rid, next);
  }
  logger.info('组织架构写接口', '成员数据转移落库', { user_id: userId, crm_user_id: body.crm_user_id || 0, project_user_id: body.project_user_id || 0 });
  return { code: 0, msg: '成功', data: {} };
};
// 批量转移客户：{user_id, crm_ids, crm_user_ids}
handlers['POST /company/user/transfer/crm/data/'] = ({ body }) => {
  const userId = Number(body && body.user_id || 0);
  if (!userId) return { code: 10011, msg: '参数错误', data: {} };
  const rows = db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'member_del' AND deleted = 0").all();
  const hit = rows.map(r => { let p = {}; try { p = JSON.parse(r.payload); } catch {} return { ...p, _rid: r.record_id }; })
    .find(r => Number(r.user_id) === userId);
  if (hit) {
    const next = { ...hit, crm_num: 0, crm_button: 0 };
    if (!Number(next.project_num)) next.transfer_button = 0;
    localUpsert('member_del', hit._rid, next);
  }
  logger.info('组织架构写接口', '客户批量转移落库', { user_id: userId, crm_ids: (body && body.crm_ids || []).length });
  return { code: 0, msg: '成功', data: {} };
};
// 批量转移项目：{user_id, project_ids, project_user_ids}
handlers['POST /company/user/transfer/project/data/'] = ({ body }) => {
  const userId = Number(body && body.user_id || 0);
  if (!userId) return { code: 10011, msg: '参数错误', data: {} };
  const rows = db.prepare("SELECT record_id, payload FROM local_records WHERE entity = 'member_del' AND deleted = 0").all();
  const hit = rows.map(r => { let p = {}; try { p = JSON.parse(r.payload); } catch {} return { ...p, _rid: r.record_id }; })
    .find(r => Number(r.user_id) === userId);
  if (hit) {
    const next = { ...hit, project_num: 0, project_button: 0 };
    if (!Number(next.crm_num)) next.transfer_button = 0;
    localUpsert('member_del', hit._rid, next);
  }
  logger.info('组织架构写接口', '项目批量转移落库', { user_id: userId, project_ids: (body && body.project_ids || []).length });
  return { code: 0, msg: '成功', data: {} };
};
// 转移目标客户/项目列表（已删除成员转移弹窗）：{user_id} → {list}
handlers['POST /company/user/transfer/crm/list/'] = ({ body }) => {
  const userId = Number(body && body.user_id || 0);
  const kw = String(body && (body.search_key || body.keyword) || '').trim();
  let list = [];
  if (userId) {
    const rows = db.prepare('SELECT crm_id, customer_name, phone_number FROM crm_customers WHERE deleted = 0 ORDER BY crm_id DESC LIMIT 50').all();
    list = rows.filter(r => !kw || (r.customer_name || '').includes(kw) || (r.phone_number || '').includes(kw))
      .map(r => ({ user_id: 0, user_name: r.customer_name || '', user_phone: r.phone_number || '', crm_id: Number(r.crm_id) }));
  }
  return { code: 0, msg: '成功', data: { list } };
};
handlers['POST /company/user/transfer/project/list/'] = ({ body }) => {
  const userId = Number(body && body.user_id || 0);
  const kw = String(body && (body.search_key || body.keyword) || '').trim();
  let list = [];
  if (userId) {
    const rows = db.prepare('SELECT project_id, project_name FROM projects WHERE deleted = 0 ORDER BY project_id DESC LIMIT 50').all();
    list = rows.filter(r => !kw || (r.project_name || '').includes(kw))
      .map(r => ({ user_id: 0, user_name: r.project_name || '', project_id: Number(r.project_id) }));
  }
  return { code: 0, msg: '成功', data: { list } };
};

// ================ 材料库快照本地化（结构对齐原站） ================
// 以原站真实响应为种子（data/reference/budget_v2_material_list.json），
// 覆盖 createMaterialApi 的失真实现（旧实现字段重复、数据不全）
db.exec(`CREATE TABLE IF NOT EXISTS budget_material_snapshot (
  material_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
)`);
{
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM budget_material_snapshot').get().c;
  if (cnt === 0) {
    try {
      const refFile = path.join(ROOT, 'data', 'reference', 'budget_v2_material_list.json');
      if (fs.existsSync(refFile)) {
        const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
        if (ref.data && Array.isArray(ref.data.materials)) {
          const ins = db.prepare('INSERT INTO budget_material_snapshot (material_id, payload) VALUES (?, ?)');
          for (const m of ref.data.materials) ins.run(Number(m.id), JSON.stringify(m));
          logger.info('材料库', '快照种子导入', { count: ref.data.materials.length });
        }
      }
    } catch (e) { logger.warn('材料库', '快照种子失败', { err: e.message }); }
  }
}
// 材料列表：原站结构 { total_num, materials: [...] }，支持分页与筛选
handlers['POST /budget/v2/material/list/'] = ({ body }) => {
  const rows = db.prepare('SELECT payload FROM budget_material_snapshot ORDER BY material_id').all();
  let list = rows.map(r => JSON.parse(r.payload));
  const page = Math.max(1, Number(body && body.page) || 1);
  const pageSize = Math.max(1, Number(body && (body.page_size || body.pageSize)) || 20);
  const band = body && body.band;
  const typeId = Number(body && (body.commodity_type_id || body.type_id) || 0);
  const kw = String(body && (body.name || body.keyword) || '').trim();
  if (band) list = list.filter(m => m.band === band);
  if (typeId) list = list.filter(m => Number(m.commodity_type_id) === typeId);
  if (kw) list = list.filter(m => (m.name || '').includes(kw));
  const total = list.length;
  const start = (page - 1) * pageSize;
  return { code: 0, msg: '成功', data: { total_num: total, materials: list.slice(start, start + pageSize) } };
};
// 材料统计：原站结构 { supplier_material_num, warehouse_material_num, total_num, suppliers, manufacturers, band_names }
handlers['POST /budget/material/count/'] = () => {
  const rows = db.prepare('SELECT payload FROM budget_material_snapshot').all();
  const mats = rows.map(r => JSON.parse(r.payload));
  const bandNames = [...new Set(mats.map(m => m.band).filter(Boolean))];
  const supMap = new Map();
  for (const m of mats) {
    if (!m.supplier_id) continue;
    const k = Number(m.supplier_id);
    if (!supMap.has(k)) supMap.set(k, { supplier_id: k, supplier_name: m.supplier_name || '' });
  }
  const suppliers = [...supMap.values()];
  const warehouse = mats.filter(m => Number(m.is_self_warehouse) === 1).length;
  return {
    code: 0, msg: '成功',
    data: {
      supplier_material_num: mats.length - warehouse, warehouse_material_num: warehouse,
      total_num: mats.length, suppliers, manufacturers: [], band_names: bandNames
    }
  };
};

// ================ 工程定额 / 规格 / 预算模板 快照本地化 ================
db.exec(`CREATE TABLE IF NOT EXISTS budget_project_quota_snapshot (quota_id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS budget_specification_snapshot (spec_id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS budget_template_snapshot (template_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, detail TEXT DEFAULT '')`);
{
  const qc = db.prepare('SELECT COUNT(*) AS c FROM budget_project_quota_snapshot').get().c;
  if (qc === 0) {
    try {
      const refDir = path.join(ROOT, 'data', 'reference');
      const qf = path.join(refDir, 'budget_v2_project_quota_list.json');
      if (fs.existsSync(qf)) {
        const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
        if (q.data && Array.isArray(q.data.project_quota_list)) {
          const ins = db.prepare('INSERT INTO budget_project_quota_snapshot (quota_id, payload) VALUES (?, ?)');
          const walk = (list) => { for (const x of list) { ins.run(Number(x.id), JSON.stringify(x)); if (Array.isArray(x.project_quota_list)) walk(x.project_quota_list); } };
          walk(q.data.project_quota_list);
        }
      }
      const sf = path.join(refDir, 'budget_specification_list.json');
      if (fs.existsSync(sf)) {
        const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
        if (s.data && Array.isArray(s.data.specifications)) {
          const ins = db.prepare('INSERT INTO budget_specification_snapshot (spec_id, payload) VALUES (?, ?)');
          for (const x of s.data.specifications) ins.run(Number(x.id), JSON.stringify(x));
        }
      }
      const tf = path.join(refDir, 'budget_template_list.json');
      if (fs.existsSync(tf)) {
        const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
        if (t.data && Array.isArray(t.data.templates)) {
          const ins = db.prepare('INSERT INTO budget_template_snapshot (template_id, payload, detail) VALUES (?, ?, ?)');
          for (const x of t.data.templates) {
            const df = path.join(refDir, 'budget_template_detail_' + x.id + '.json');
            let detail = '';
            if (fs.existsSync(df)) { try { detail = fs.readFileSync(df, 'utf8'); } catch (e) { /* ignore */ } }
            ins.run(Number(x.id), JSON.stringify(x), detail);
          }
        }
      }
      logger.info('定额/规格/模板', '快照种子导入', {});
    } catch (e) { logger.warn('定额/规格/模板', '快照种子失败', { err: e.message }); }
  }
}
// 工程定额：原站结构 { project_quota_list: [树] }
handlers['POST /budget/v2/project_quota/list/'] = () => {
  const rows = db.prepare('SELECT payload FROM budget_project_quota_snapshot ORDER BY quota_id').all();
  const tree = rows.map(r => JSON.parse(r.payload)).filter(x => Number(x.parent_id || 0) === 0);
  return { code: 0, msg: '成功', data: { project_quota_list: tree } };
};
// 规格：原站结构 { specifications, custom_fields }
handlers['POST /budget/specification/list/'] = () => {
  const rows = db.prepare('SELECT payload FROM budget_specification_snapshot ORDER BY spec_id').all();
  const specs = rows.map(r => JSON.parse(r.payload));
  return { code: 0, msg: '成功', data: { specifications: specs, custom_fields: [] } };
};
// 预算模板列表：原站结构 { templates: [...] }
handlers['POST /budget/template/list/'] = ({ body }) => {
  const rows = db.prepare('SELECT payload FROM budget_template_snapshot ORDER BY template_id').all();
  let list = rows.map(r => JSON.parse(r.payload));
  const isMat = body && (body.is_material_template !== undefined ? Number(body.is_material_template) : null);
  if (isMat !== null) list = list.filter(t => Number(t.is_material_template) === isMat);
  return { code: 0, msg: '成功', data: { templates: list } };
};
// 预算模板详情：快照返回原站结构；无快照回退代理
handlers['POST /budget/template/detail/'] = ({ body }) => {
  const id = Number(body && (body.template_id || body.id) || 0);
  const row = db.prepare('SELECT detail FROM budget_template_snapshot WHERE template_id = ?').get(id);
  if (row && row.detail) { try { return JSON.parse(row.detail); } catch (e) { /* fallthrough */ } }
  return null; // 回退代理
};

// ================ 商品分类/供应商类型/品牌单位 快照本地化 ================
db.exec(`CREATE TABLE IF NOT EXISTS commodity_type_snapshot (type_id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
{
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM commodity_type_snapshot').get().c;
  if (cnt === 0) {
    try {
      const refFile = path.join(ROOT, 'data', 'reference', 'commodity_type_list.json');
      if (fs.existsSync(refFile)) {
        const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
        if (ref.data && Array.isArray(ref.data.types)) {
          const ins = db.prepare('INSERT INTO commodity_type_snapshot (type_id, payload) VALUES (?, ?)');
          for (const t of ref.data.types) ins.run(Number(t.id), JSON.stringify(t));
          logger.info('商品分类', '快照种子导入', { count: ref.data.types.length });
        }
      }
    } catch (e) { logger.warn('商品分类', '快照种子失败', { err: e.message }); }
  }
}
// 商品类型列表：原站结构 { types: [{id, name, content_id, content_name}] }
handlers['POST /commodity/type/list/'] = ({ body }) => {
  const rows = db.prepare('SELECT payload FROM commodity_type_snapshot ORDER BY type_id').all();
  const types = rows.map(r => JSON.parse(r.payload));
  const contentId = Number(body && body.content_id || 0);
  const kw = String(body && body.name || '').trim();
  let list = types;
  if (contentId) list = list.filter(t => Number(t.content_id) === contentId);
  if (kw) list = list.filter(t => (t.name || '').includes(kw));
  return { code: 0, msg: '成功', data: { types: list } };
};
// 品牌/单位：原站结构 { bands: [{id, name}], units: [] }
handlers['POST /commodity/band_unit/list/'] = () => {
  return { code: 0, msg: '成功', data: { bands: [{ id: 1, name: '其他' }], units: [] } };
};
// 供应商类型：原站结构 { supplier_main_types, supplier_assist_types }
handlers['POST /company/supplier_type/list/'] = () => {
  const main = [
    { supplier_type_id: 6, supplier_type_name: '主材', is_sys_type: 1 },
    { supplier_type_id: 7, supplier_type_name: '暖通/机电', is_sys_type: 1 },
    { supplier_type_id: 8, supplier_type_name: '软装/家具', is_sys_type: 1 },
    { supplier_type_id: 9, supplier_type_name: '家电/电器', is_sys_type: 1 },
    { supplier_type_id: 10, supplier_type_name: '智能家居', is_sys_type: 1 },
    { supplier_type_id: 11, supplier_type_name: '全屋定制', is_sys_type: 1 },
    { supplier_type_id: 12, supplier_type_name: '橱柜定制', is_sys_type: 1 }
  ];
  const assist = [
    { supplier_type_id: 1, supplier_type_name: '保护材料', is_sys_type: 1 },
    { supplier_type_id: 2, supplier_type_name: '水电材料', is_sys_type: 1 },
    { supplier_type_id: 3, supplier_type_name: '泥瓦材料', is_sys_type: 1 },
    { supplier_type_id: 4, supplier_type_name: '模板材料', is_sys_type: 1 },
    { supplier_type_id: 5, supplier_type_name: '油漆材料', is_sys_type: 1 },
    { supplier_type_id: 2122, supplier_type_name: '腻子', is_sys_type: 0 }
  ];
  return { code: 0, msg: '成功', data: { supplier_main_types: main, supplier_assist_types: assist } };
};
// 商品内容（分类分组）：原站结构 { main_material_num, assist_material_num, contents }
// 直接用原站快照（聚合结果与原文分组差异大，如 9544 商品 → 380 组 vs 原站 3 组）
db.exec(`CREATE TABLE IF NOT EXISTS commodity_content_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`);
{
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM commodity_content_snapshot').get().c;
  if (cnt === 0) {
    try {
      const refFile = path.join(ROOT, 'data', 'reference', 'budget_v2_commodity_content_list.json');
      if (fs.existsSync(refFile)) {
        const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
        if (ref.data) db.prepare('INSERT INTO commodity_content_snapshot (id, payload) VALUES (1, ?)').run(JSON.stringify(ref.data));
      }
    } catch (e) { logger.warn('商品内容', '快照种子失败', { err: e.message }); }
  }
}
handlers['POST /budget/v2/commodity_content/list/'] = () => {
  const snap = db.prepare('SELECT payload FROM commodity_content_snapshot WHERE id = 1').get();
  if (snap) return { code: 0, msg: '成功', data: JSON.parse(snap.payload) };
  return { code: 0, msg: '成功', data: { main_material_num: 0, assist_material_num: 0, contents: [] } };
};

// ================ 写操作落快照表（读一致性：写后列表立即可见） ================
// 材料新增（添加商品）
handlers['POST /budget/v2/material/add/'] = ({ body }) => {
  const maxId = db.prepare('SELECT COALESCE(MAX(material_id), 0) AS m FROM budget_material_snapshot').get().m + 1;
  const m = {
    id: maxId, name: String(body && body.name || '新增材料'), enable: 1,
    commodity_type_id: Number(body && (body.commodity_type_id || body.type_id) || 0),
    band: (body && body.band) || '', model: (body && body.model) || '', specification: (body && body.specification) || '',
    cost_unit_id: Number(body && body.cost_unit_id || 0), cost_unit: (body && body.cost_unit) || '',
    sale_unit_id: Number(body && body.sale_unit_id || 0), sale_unit: (body && body.sale_unit) || '',
    unit_rate: String(body && body.unit_rate !== undefined ? body.unit_rate : 1),
    profit_rate: String(body && body.profit_rate !== undefined ? body.profit_rate : 0),
    loss_rate: String(body && body.loss_rate !== undefined ? body.loss_rate : 0),
    cost_price: String(body && body.cost_price !== undefined ? body.cost_price : 0),
    sale_price: String(body && body.sale_price !== undefined ? body.sale_price : 0),
    min_sale_price: String(body && body.min_sale_price !== undefined ? body.min_sale_price : 0),
    image: (body && body.image) || '', description: (body && body.description) || '',
    is_self_warehouse: Number(body && body.is_self_warehouse !== undefined ? body.is_self_warehouse : 1),
    supplier_id: Number(body && body.supplier_id || 6808), supplier_name: (body && body.supplier_name) || '装企仓库',
    manufacturer_id: Number(body && body.manufacturer_id || 0), manufacturer_name: (body && body.manufacturer_name) || '-'
  };
  db.prepare('INSERT INTO budget_material_snapshot (material_id, payload) VALUES (?, ?)').run(maxId, JSON.stringify(m));
  return { code: 0, msg: '成功', data: { material_id: maxId } };
};
// 材料编辑：更新快照
handlers['POST /budget/material/edit/'] = ({ body }) => {
  const id = Number(body && (body.material_id || body.id) || 0);
  const row = db.prepare('SELECT payload FROM budget_material_snapshot WHERE material_id = ?').get(id);
  if (!row) return { code: 10011, msg: '材料不存在', data: {} };
  const m = JSON.parse(row.payload);
  for (const k of ['name', 'enable', 'band', 'model', 'specification', 'cost_unit_id', 'cost_unit', 'sale_unit_id', 'sale_unit', 'unit_rate', 'profit_rate', 'loss_rate', 'cost_price', 'sale_price', 'min_sale_price', 'image', 'description', 'is_self_warehouse', 'supplier_id', 'supplier_name', 'manufacturer_id', 'manufacturer_name', 'commodity_type_id']) {
    if (body[k] !== undefined) m[k] = body[k];
  }
  db.prepare('UPDATE budget_material_snapshot SET payload = ? WHERE material_id = ?').run(JSON.stringify(m), id);
  return { code: 0, msg: '成功', data: {} };
};
// 材料删除（支持批量 ids / 单个）
handlers['POST /budget/material/del/'] = ({ body }) => {
  const ids = [];
  if (body && Array.isArray(body.ids)) ids.push(...body.ids);
  if (body && body.material_id) ids.push(body.material_id);
  if (body && body.id) ids.push(body.id);
  for (const id of ids) db.prepare('DELETE FROM budget_material_snapshot WHERE material_id = ?').run(Number(id));
  return { code: 0, msg: '成功', data: {} };
};
// 材料启用/停用
handlers['POST /budget/material/status/set/'] = ({ body }) => {
  const id = Number(body && (body.material_id || body.id) || 0);
  const row = db.prepare('SELECT payload FROM budget_material_snapshot WHERE material_id = ?').get(id);
  if (row) {
    const m = JSON.parse(row.payload);
    if (body.enable !== undefined) m.enable = Number(body.enable);
    db.prepare('UPDATE budget_material_snapshot SET payload = ? WHERE material_id = ?').run(JSON.stringify(m), id);
  }
  return { code: 0, msg: '成功', data: {} };
};
// 模板新增（添加预算模板）：SPA 提交 {template_name, type} → {template_id, update_time}
handlers['POST /budget/template/add/'] = ({ body }) => {
  const name = String(body && (body.template_name || body.name) || '').trim();
  if (!name) return { code: 10011, msg: '请填写模板名称', data: {} };
  const maxId = (() => { const r = db.prepare('SELECT COALESCE(MAX(template_id), 0) AS m FROM budget_template_snapshot').get(); return Number(r.m) || 0; })();
  const updateTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const t = {
    id: maxId + 1,
    type: Number(body && (body.type !== undefined ? body.type : body.is_material_template) || 0),
    status: 1,
    is_material_template: Number(body && body.is_material_template || 0),
    name,
    area_num: Number(body && body.area_num || 0),
    update_time: updateTime,
    create_time: updateTime
  };
  db.prepare('INSERT INTO budget_template_snapshot (template_id, payload, detail) VALUES (?, ?, ?)').run(t.id, JSON.stringify(t), '');
  return { code: 0, msg: '成功', data: { template_id: t.id, update_time: updateTime } };
};
// 模板删除 / 状态
handlers['POST /budget/template/del/'] = ({ body }) => {
  const id = Number(body && (body.template_id || body.id) || 0);
  db.prepare('DELETE FROM budget_template_snapshot WHERE template_id = ?').run(id);
  return { code: 0, msg: '成功', data: {} };
};
handlers['POST /budget/template/status/set/'] = ({ body }) => {
  const id = Number(body && (body.template_id || body.id) || 0);
  const row = db.prepare('SELECT payload FROM budget_template_snapshot WHERE template_id = ?').get(id);
  if (row) {
    const t = JSON.parse(row.payload);
    if (body.status !== undefined) t.status = Number(body.status);
    db.prepare('UPDATE budget_template_snapshot SET payload = ? WHERE template_id = ?').run(JSON.stringify(t), id);
  }
  return { code: 0, msg: '成功', data: {} };
};

// ================ 商品/材料 编辑弹窗链路本地化（读快照表，写后列表即时可见） ================
// 一级分类（编辑弹窗"商品类型"下拉）：原站结构 { contents: [{id, name, type, commodity_types:[{id,name}]}] }
// type: 0=主材 非0=辅材（SPA 按 t.type?'辅材':'主材' 显示角标）
db.exec(`CREATE TABLE IF NOT EXISTS commodity_sys_content_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`);
{
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM commodity_sys_content_snapshot').get().c;
  if (cnt === 0) {
    try {
      const refFile = path.join(ROOT, 'data', 'reference', 'commodity_sys_content_list.json');
      if (fs.existsSync(refFile)) {
        const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
        if (ref.data && Array.isArray(ref.data.contents)) {
          db.prepare('INSERT INTO commodity_sys_content_snapshot (id, payload) VALUES (1, ?)').run(JSON.stringify(ref.data));
          logger.info('商品分类', 'sys/content 快照种子导入', { count: ref.data.contents.length });
        }
      }
    } catch (e) { logger.warn('商品分类', 'sys/content 快照种子失败', { err: e.message }); }
  }
}
handlers['POST /commodity/sys/content/list/'] = () => {
  const snap = db.prepare('SELECT payload FROM commodity_sys_content_snapshot WHERE id = 1').get();
  if (snap) return { code: 0, msg: '成功', data: JSON.parse(snap.payload) };
  // 兜底：从 v2 内容快照转（无 type 字段时按主材处理）
  const v2 = db.prepare('SELECT payload FROM commodity_content_snapshot WHERE id = 1').get();
  if (v2) {
    const d = JSON.parse(v2.payload);
    return { code: 0, msg: '成功', data: { contents: (d.contents || []).map(c => ({ id: c.id, name: c.name, type: 0, commodity_types: (c.commodity_types || []).map(t => ({ id: t.id, name: t.name })) })) } };
  }
  return { code: 0, msg: '成功', data: { contents: [] } };
};
// 材料详情（编辑弹窗回填）：读快照表，结构对齐原站 /budget/company/material/detail/
handlers['POST /budget/company/material/detail/'] = ({ body }) => {
  const mid = Number(body && (body.material_id || body.id));
  if (!mid) return { code: 10011, msg: '参数错误', data: {} };
  const row = db.prepare('SELECT payload FROM budget_material_snapshot WHERE material_id = ?').get(mid);
  if (!row) return { code: 10032, msg: '数据不存在', data: {} };
  const m = JSON.parse(row.payload);
  let cid = 0, cname = '', tname = '';
  const trow = db.prepare('SELECT payload FROM commodity_type_snapshot WHERE type_id = ?').get(Number(m.commodity_type_id || 0));
  if (trow) {
    try { const t = JSON.parse(trow.payload); cid = Number(t.content_id || 0); cname = t.content_name || ''; tname = t.name || ''; } catch (e) { /* keep */ }
  }
  const img = m.image || '';
  return {
    code: 0, msg: '成功',
    data: {
      commodity_content_id: cid, commodity_content_name: cname,
      commodity_type_id: Number(m.commodity_type_id || 0), commodity_type_name: tname,
      commodity_id: Number(m.id), commodity_name: m.name || '',
      description: m.description || '',
      band_name: m.band || '', model: m.model || '', specification: m.specification || '',
      product_place_name: m.product_place_name || '',
      unit_name: m.sale_unit || m.cost_unit || '',
      cost_price: m.cost_price || '', sale_price: m.sale_price || '',
      files: img ? [{ id: 0, type: 0, url: img, origin_url: String(img).split('?')[0], name: '' }] : [],
      manufacturer_id: Number(m.manufacturer_id || 0),
      panorama_url: m.panorama_url || ''
    }
  };
};
// 编辑保存（编辑商品信息弹窗）：写快照表，覆盖 company-api 旧实现（旧实现写 budget_globals 且 sale/cost 字段映射反了）
// SPA 提交字段语义：sale_price=出库价(cost_price)，market_price=报价(sale_price)
handlers['POST /commodity/company/material/edit/'] = ({ body }) => {
  const b = body || {};
  const mid = Number(b.material_id || b.commodity_id || b.id);
  const row = mid ? db.prepare('SELECT payload FROM budget_material_snapshot WHERE material_id = ?').get(mid) : null;
  if (!row) return { code: 10032, msg: '数据不存在', data: {} };
  const m = JSON.parse(row.payload);
  if (b.commodity_name !== undefined) m.name = String(b.commodity_name);
  if (b.commodity_type_id !== undefined) m.commodity_type_id = Number(b.commodity_type_id);
  if (b.band_name !== undefined) m.band = String(b.band_name);
  if (b.model !== undefined) m.model = String(b.model);
  if (b.specification !== undefined) m.specification = String(b.specification);
  if (b.product_place_name !== undefined) m.product_place_name = String(b.product_place_name);
  if (b.unit_name !== undefined) { m.cost_unit = String(b.unit_name); m.sale_unit = String(b.unit_name); }
  if (b.sale_price !== undefined) m.cost_price = String(b.sale_price);        // 出库价
  if (b.market_price !== undefined) m.sale_price = String(b.market_price);    // 报价
  if (b.description !== undefined) m.description = String(b.description);
  if (b.manufacturer_id !== undefined) m.manufacturer_id = Number(b.manufacturer_id);
  if (b.panorama_url !== undefined) m.panorama_url = String(b.panorama_url);
  if (Array.isArray(b.roll_images) && b.roll_images.length) {
    const ri = b.roll_images[0];
    if (ri && (ri.url || ri.origin_url)) m.image = ri.url || ri.origin_url;
  }
  db.prepare('UPDATE budget_material_snapshot SET payload = ? WHERE material_id = ?').run(JSON.stringify(m), mid);
  logger.info('材料写接口', '弹窗编辑落库', { material_id: mid, name: m.name, type_id: m.commodity_type_id, cost: m.cost_price, sale: m.sale_price });
  return { code: 0, msg: '成功', data: { commodity_id: mid } };
};

// ================ 前台操作端 阶段4 本地化（登录链路 + 基础数据） ================
// 法定节假日（项目工期日历）：原站结构 { holidays: [{name, date, year}] }
// 数据为原站真实快照（data/reference/project_holiday_list.json，2023-2027）
let _holidayCache = null;
function loadHolidays() {
  if (_holidayCache) return _holidayCache;
  try {
    const refFile = path.join(ROOT, 'data', 'reference', 'project_holiday_list.json');
    if (fs.existsSync(refFile)) {
      const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
      if (ref.data && Array.isArray(ref.data.holidays)) _holidayCache = ref.data.holidays;
    }
  } catch (e) { logger.warn('节假日', '快照读取失败', { err: e.message }); }
  if (!_holidayCache) _holidayCache = [];
  return _holidayCache;
}
handlers['POST /project/holiday/list/'] = ({ body }) => {
  const years = Array.isArray(body && body.years) ? body.years.map(Number) : [];
  let holidays = loadHolidays();
  if (years.length) holidays = holidays.filter(h => years.includes(Number(h.year)));
  return { code: 0, msg: '成功', data: { holidays } };
};

// ---------------- 路由匹配 ----------------
// 尾斜杠容错：Next.js rewrites 代理会把 /company/login/ 规范化为 /company/login（308），
// 直连 8080 时又常带尾斜杠，两种形式都要能命中 handlers（key 统一带尾斜杠）。
function match(method, apiPath) {
  const hit = (p) => handlers[method + ' ' + p] || null;
  let h = hit(apiPath);
  if (h) return h;
  if (apiPath.endsWith('/')) return hit(apiPath.slice(0, -1));
  return hit(apiPath + '/');
}

module.exports = { match, handlers, getSession, getSessionById, getCloudSession, refreshCloudSession, mergeLocalRecords };
