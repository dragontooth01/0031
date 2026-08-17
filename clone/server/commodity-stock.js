/**
 * 商品 + 库存模块（commodity / commodity/stock/*）接口实现
 * ---------------------------------------------------------------
 * 对标原版后端（lzapi.e-shigong.com）commodity/stock 系列接口：
 * - 采购入库  /commodity/stock/im_warehouse/purchase/
 * - 领料出库  /commodity/stock/ex_warehouse/receive/
 * - 退料入库  /commodity/stock/im_warehouse/refund/
 * - 仓库 / 货位 / 批次 / 库存 / 出入库记录 等 40+ 接口
 * - 数据源：api_data/commodity_list.json 真实商品快照（51 个）落 commodity_commodities
 * 设计：与 company-api 一致 —— 共享 SQLite，公司维度 company_id 隔离。
 * ---------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

const API_DATA_DIR = process.env.API_DATA_DIR || 'E:/Program Files (x86)/000000/api_data';
const LOCAL_ID_BASE = 900000000;

// 出入库类型映射（与原版前端 typeMap 一致）
const STOCK_TYPE_MAP = { 0: '采购入库', 1: '领料出库', 2: '退料入库', 3: '盘盈入库', 4: '盘亏出库' };
const DEFAULT_COMPANY_ID = 6808;

const COMMODITY_STOCK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS commodity_commodities (
  id INTEGER PRIMARY KEY,
  commodity_content_id INTEGER DEFAULT 0,
  commodity_content_name TEXT DEFAULT '',
  commodity_type_id INTEGER DEFAULT 0,
  commodity_type_name TEXT DEFAULT '',
  name TEXT DEFAULT '',
  band TEXT DEFAULT '',
  model TEXT DEFAULT '',
  specification TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  content_type INTEGER DEFAULT 0,
  sale_price TEXT DEFAULT '',
  market_price TEXT DEFAULT '',
  image TEXT DEFAULT '',
  description TEXT DEFAULT '',
  company_id INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS commodity_warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  is_enabled INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0,
  company_id INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS commodity_goods_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER DEFAULT 0,
  name TEXT NOT NULL,
  remark TEXT DEFAULT '',
  is_enabled INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0,
  company_id INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS commodity_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER DEFAULT 0,
  name TEXT NOT NULL,
  remark TEXT DEFAULT '',
  company_id INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS commodity_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commodity_id INTEGER DEFAULT 0,
  commodity_name TEXT DEFAULT '',
  band TEXT DEFAULT '',
  model TEXT DEFAULT '',
  specification TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  image TEXT DEFAULT '',
  commodity_content_id INTEGER DEFAULT 0,
  commodity_content_name TEXT DEFAULT '',
  commodity_type_id INTEGER DEFAULT 0,
  commodity_type_name TEXT DEFAULT '',
  warehouse_id INTEGER DEFAULT 0,
  warehouse_name TEXT DEFAULT '',
  goods_location_id INTEGER DEFAULT 0,
  goods_location_name TEXT DEFAULT '',
  batch_id INTEGER DEFAULT 0,
  batch_no TEXT DEFAULT '',
  stock_num REAL DEFAULT 0,
  cost_price TEXT DEFAULT '',
  company_id INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS commodity_stock_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type INTEGER DEFAULT 0,
  commodity_id INTEGER DEFAULT 0,
  commodity_name TEXT DEFAULT '',
  band TEXT DEFAULT '',
  model TEXT DEFAULT '',
  specification TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  image TEXT DEFAULT '',
  num REAL DEFAULT 0,
  quoted_price TEXT DEFAULT '',
  warehouse_id INTEGER DEFAULT 0,
  warehouse_name TEXT DEFAULT '',
  goods_location_id INTEGER DEFAULT 0,
  goods_location_name TEXT DEFAULT '',
  batch_id INTEGER DEFAULT 0,
  batch_no TEXT DEFAULT '',
  crm_id INTEGER DEFAULT 0,
  project_name TEXT DEFAULT '',
  create_user_id INTEGER DEFAULT 0,
  create_user_name TEXT DEFAULT '',
  company_id INTEGER DEFAULT 0,
  description TEXT DEFAULT '',
  record_time TEXT DEFAULT '',
  repealed INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_stock_commodity ON commodity_stock(commodity_id);
CREATE INDEX IF NOT EXISTS idx_stock_records_type ON commodity_stock_records(type);
CREATE INDEX IF NOT EXISTS idx_stock_records_crm ON commodity_stock_records(crm_id);
`;

/** 读取 api_data 快照 JSON（不存在返回 null） */
function readApiData(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(API_DATA_DIR, name), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 首次启动种子：商品快照 + 默认仓库/货位/批次 */
function seedCommodityStock(db) {
  // 迁移：旧库 commodity_commodities 缺少 content_type 列时补列并回填
  // （辅材固定 commodity_content_id=152 → 1，其余主材 → 0）
  try {
    const cols = db.prepare('PRAGMA table_info(commodity_commodities)').all();
    if (cols.length && !cols.some((c) => c.name === 'content_type')) {
      db.exec('ALTER TABLE commodity_commodities ADD COLUMN content_type INTEGER DEFAULT 0');
      db.prepare('UPDATE commodity_commodities SET content_type = CASE WHEN commodity_content_id = 152 THEN 1 ELSE 0 END').run();
    }
  } catch (e) { /* 表尚未创建时忽略 */ }

  const exists = db.prepare('SELECT COUNT(*) AS c FROM commodity_commodities').get();
  if (exists && exists.c) return;

  const snap = readApiData('commodity_list.json');
  const commodities = (snap && snap.data && snap.data.commodities) || [];
  const contentSnap = readApiData('commodity_content_list.json');
  const contents = (contentSnap && contentSnap.data && contentSnap.data.contents) || [];
  const contentNameMap = {};
  for (const c of contents) contentNameMap[c.id] = c.name;

  const insert = db.prepare(`INSERT INTO commodity_commodities
    (id, commodity_content_id, commodity_content_name, commodity_type_id, commodity_type_name, name, band, model, specification, unit, sale_price, market_price, image, description, company_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const c of commodities) {
    insert.run(
      Number(c.id) || 0,
      Number(c.commodity_content_id) || 0,
      String(c.commodity_content_name || contentNameMap[c.commodity_content_id] || ''),
      Number(c.commodity_type_id) || 0,
      String(c.commodity_type_name || ''),
      String(c.name || ''),
      String(c.band || ''),
      String(c.model || ''),
      String(c.specification || ''),
      String(c.unit || ''),
      String(c.sale_price || ''),
      String(c.market_price || ''),
      String(c.image || ''),
      String(c.description || ''),
      DEFAULT_COMPANY_ID
    );
  }

  // 默认仓库 + 货位 + 批次（空表才建）
  const wc = db.prepare('SELECT COUNT(*) AS c FROM commodity_warehouses').get();
  if (!wc.c) {
    db.prepare("INSERT INTO commodity_warehouses (name, address, company_id, created_at) VALUES (?,?,?,?)")
      .run('默认仓库', '本地企业仓库', DEFAULT_COMPANY_ID, new Date().toISOString());
    db.prepare("INSERT INTO commodity_goods_locations (warehouse_id, name, company_id, created_at) VALUES (?,?,?,?)")
      .run(1, '默认货位', DEFAULT_COMPANY_ID, new Date().toISOString());
    db.prepare("INSERT INTO commodity_batches (warehouse_id, name, company_id, created_at) VALUES (?,?,?,?)")
      .run(1, '2026 首批', DEFAULT_COMPANY_ID, new Date().toISOString());
  }
}

/**
 * 创建商品/库存接口集
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ok:Function, parseJson:Function, getSession:Function, dbNow:Function}} H
 */
function createCommodityStockApi(db, H) {
  const { ok, parseJson, getSession, dbNow } = H;
  const j = (v, fb) => parseJson(v, fb);

  function nextId(table) {
    const r = db.prepare(`SELECT MAX(id) AS m FROM ${table}`).get();
    return (Number(r && r.m) || 0) + 1;
  }

  // 当前登录人（用于出入库记录的 create_user）
  function currentUser(headers) {
    const s = getSession(headers);
    if (s && s.user_id) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      if (u) return { user_id: u.id, user_name: u.name };
    }
    return { user_id: 0, user_name: '管理员' };
  }

  const companyId = (body) => Number((body && body.company_id) || 0) || DEFAULT_COMPANY_ID;

  // ---------- 商品工具 ----------
  function commodityView(r) {
    return {
      id: r.id,
      commodity_id: r.id,
      commodity_content_id: r.commodity_content_id,
      commodity_content_name: r.commodity_content_name,
      commodity_type_id: r.commodity_type_id,
      commodity_type_name: r.commodity_type_name,
      name: r.name,
      commodity_name: r.name,
      band: r.band,
      band_name: r.band,
      model: r.model,
      specification: r.specification,
      unit: r.unit,
      unit_name: r.unit,
      sale_price: r.sale_price,
      market_price: r.market_price,
      cost_price: r.sale_price,
      image: r.image,
      description: r.description,
    };
  }

  // 内容分类树（与 budget 快照一致：contents[].commodity_types[]）
  function contentTree(company_id, commodity_content_type) {
    const where = ['company_id = ?'];
    const args = [company_id];
    // commodity_content_type: 0=主材 1=辅材（辅材固定为 commodity_content_id=152）
    if (commodity_content_type !== undefined && commodity_content_type !== null && commodity_content_type !== '') {
      if (Number(commodity_content_type) === 0) where.push('commodity_content_id != 152');
      else if (Number(commodity_content_type) === 1) where.push('commodity_content_id = 152');
    }
    const rows = db.prepare(`SELECT * FROM commodity_commodities WHERE ${where.join(' AND ')} ORDER BY id`).all(...args);
    const map = new Map();
    for (const r of rows) {
      const cid = Number(r.commodity_content_id);
      if (!map.has(cid)) map.set(cid, { id: cid, name: r.commodity_content_name, type: contentTypeOf(r), commodity_types: [] });
      const node = map.get(cid);
      const tid = Number(r.commodity_type_id);
      let t = node.commodity_types.find((x) => Number(x.id) === tid);
      if (!t) {
        t = { id: tid, name: r.commodity_type_name, item_num: 0 };
        node.commodity_types.push(t);
      }
      t.item_num += 1;
    }
    return Array.from(map.values());
  }

  // 辅材判定：乳胶漆(152) 为 1（辅材），其余 0（主材）；种子数据来源即该分类
  function contentTypeOf(r) {
    if (Number(r.commodity_content_id) === 152) return 1;
    return 0;
  }

  // 库存行 → 前端 stock 结构
  function stockView(r) {
    return {
      id: r.id,
      stock_id: r.id,
      commodity_id: r.commodity_id,
      commodity_name: r.commodity_name,
      band: r.band,
      band_name: r.band,
      model: r.model,
      specification: r.specification,
      unit: r.unit,
      unit_name: r.unit,
      image: r.image,
      cost_price: r.cost_price,
      batch_id: r.batch_id,
      batch_no: r.batch_no,
      batch_name: r.batch_no,
      warehouse_id: r.warehouse_id,
      warehouse_name: r.warehouse_name,
      goods_location_id: r.goods_location_id,
      goods_location_name: r.goods_location_name,
      warehouse_goods_location: r.warehouse_name + (r.goods_location_name ? '/' + r.goods_location_name : ''),
      stock_num: r.stock_num,
      content_id: r.commodity_content_id,
      content_name: r.commodity_content_name,
      type_id: r.commodity_type_id,
      type_name: r.commodity_type_name,
      commodity_content_id: r.commodity_content_id,
      commodity_content_name: r.commodity_content_name,
      commodity_type_id: r.commodity_type_id,
      commodity_type_name: r.commodity_type_name,
    };
  }

  // 出入库记录行 → 前端 record 结构
  function recordView(r) {
    return {
      id: r.id,
      stock_record_id: r.id,
      type: r.type,
      type_name: STOCK_TYPE_MAP[r.type] || '',
      commodity_id: r.commodity_id,
      commodity_name: r.commodity_name,
      band: r.band,
      band_name: r.band,
      model: r.model,
      specification: r.specification,
      unit: r.unit,
      unit_name: r.unit,
      image: r.image,
      num: r.num,
      quoted_price: r.quoted_price,
      quoted_price_subtotal: Number(r.num || 0) * Number(r.quoted_price || 0),
      batch_id: r.batch_id,
      batch_no: r.batch_no,
      batch_name: r.batch_no,
      warehouse_id: r.warehouse_id,
      warehouse_name: r.warehouse_name,
      goods_location_id: r.goods_location_id,
      goods_location_name: r.goods_location_name,
      warehouse_goods_location: r.warehouse_name + (r.goods_location_name ? '/' + r.goods_location_name : ''),
      crm_id: r.crm_id,
      project_name: r.project_name,
      create_user_id: r.create_user_id,
      create_user_name: r.create_user_name,
      description: r.description,
      record_time: r.record_time,
      repealed: r.repealed,
    };
  }

  // 合并/新增库存行（入库 type 0/2 调增）
  function stockIn(company_id, item, commodity) {
    const wid = Number(item.warehouse_id) || 0;
    const gid = Number(item.goods_location_id) || 0;
    const bid = Number(item.batch_id) || 0;
    const batch = bid ? db.prepare('SELECT * FROM commodity_batches WHERE id = ?').get(bid) : null;
    const wh = wid ? db.prepare('SELECT * FROM commodity_warehouses WHERE id = ?').get(wid) : null;
    const gl = gid ? db.prepare('SELECT * FROM commodity_goods_locations WHERE id = ?').get(gid) : null;
    const warehouseName = wh ? wh.name : (item.warehouse_name || (wid ? '仓库' + wid : ''));
    const locationName = gl ? gl.name : (item.goods_location_name || (gid ? '货位' + gid : ''));
    const batchNo = batch ? batch.name : (item.batch_no || (bid ? '批次' + bid : ''));

    let row = db.prepare(`SELECT * FROM commodity_stock WHERE company_id=? AND commodity_id=? AND warehouse_id=? AND goods_location_id=? AND batch_id=?`)
      .get(company_id, Number(item.commodity_id), wid, gid, bid);
    if (row) {
      db.prepare('UPDATE commodity_stock SET stock_num = stock_num + ?, cost_price = ?, warehouse_name=?, goods_location_name=?, batch_no=?, updated_at=? WHERE id = ?')
        .run(Number(item.num || 0), String(item.purchase_price || row.cost_price || ''), warehouseName, locationName, batchNo, dbNow(), row.id);
      return row.id;
    }
    const sid = nextId('commodity_stock');
    db.prepare(`INSERT INTO commodity_stock (id, commodity_id, commodity_name, band, model, specification, unit, image, commodity_content_id, commodity_content_name, commodity_type_id, commodity_type_name, warehouse_id, warehouse_name, goods_location_id, goods_location_name, batch_id, batch_no, stock_num, cost_price, company_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sid, Number(item.commodity_id), commodity.commodity_name, commodity.band, commodity.model, commodity.specification, commodity.unit_name, commodity.image,
        commodity.commodity_content_id, commodity.commodity_content_name, commodity.commodity_type_id, commodity.commodity_type_name,
        wid, warehouseName, gid, locationName, bid, batchNo, Number(item.num || 0), String(item.purchase_price || commodity.cost_price || ''), company_id, dbNow());
    return sid;
  }

  // 写一条出入库记录
  function addRecord(type, company_id, item, commodity, user, opts) {
    const rid = nextId('commodity_stock_records');
    const wid = Number(item.warehouse_id) || 0;
    const gid = Number(item.goods_location_id) || 0;
    const bid = Number(item.batch_id) || 0;
    const batch = bid ? db.prepare('SELECT * FROM commodity_batches WHERE id = ?').get(bid) : null;
    const wh = wid ? db.prepare('SELECT * FROM commodity_warehouses WHERE id = ?').get(wid) : null;
    const gl = gid ? db.prepare('SELECT * FROM commodity_goods_locations WHERE id = ?').get(gid) : null;
    const warehouseName = wh ? wh.name : (item.warehouse_name || (wid ? '仓库' + wid : ''));
    const locationName = gl ? gl.name : (item.goods_location_name || (gid ? '货位' + gid : ''));
    const batchNo = batch ? batch.name : (item.batch_no || (bid ? '批次' + bid : ''));
    const now = dbNow();
    db.prepare(`INSERT INTO commodity_stock_records (id, type, commodity_id, commodity_name, band, model, specification, unit, image, num, quoted_price, warehouse_id, warehouse_name, goods_location_id, goods_location_name, batch_id, batch_no, crm_id, project_name, create_user_id, create_user_name, company_id, description, record_time, repealed, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`)
      .run(rid, type, Number(item.commodity_id), commodity.commodity_name, commodity.band, commodity.model, commodity.specification, commodity.unit_name, commodity.image,
        Number(item.num || 0), String(item.purchase_price || item.quoted_price || ''), wid, warehouseName, gid, locationName, bid, batchNo,
        Number(opts.crm_id || item.crm_id || 0), String(opts.project_name || item.project_name || ''), user.user_id, user.user_name, company_id,
        String(item.description || item.remark || opts.description || ''), now, now);
    return rid;
  }

  const handlers = {
    // ================= 商品分类 / 商品 =================
    'POST /commodity/app/content/list/': ({ body }) => {
      const cid = companyId(body);
      return ok({ contents: contentTree(cid, body && body.commodity_content_type) });
    },
    'POST /commodity/app/content/commodity/list/': ({ body }) => {
      const cid = companyId(body);
      const contentId = Number(body && body.commodity_content_id) || 0;
      const typeId = Number(body && body.commodity_type_id) || 0;
      let sql = 'SELECT * FROM commodity_commodities WHERE company_id = ?';
      const args = [cid];
      if (contentId) { sql += ' AND commodity_content_id = ?'; args.push(contentId); }
      if (typeId) { sql += ' AND commodity_type_id = ?'; args.push(typeId); }
      if (body && body.search_key) { sql += ' AND name LIKE ?'; args.push('%' + body.search_key + '%'); }
      const rows = db.prepare(sql + ' ORDER BY id').all(...args);
      return ok({ total_num: rows.length, commodities: rows.map(commodityView) });
    },
    'POST /commodity/company/manufacturer/list/': () => {
      // 种子商品未带厂商字段，返回统一厂商（空列表亦可，前端做"全部厂家"兜底）
      const set = new Set();
      const rows = db.prepare("SELECT band FROM commodity_commodities WHERE band != '' AND band IS NOT NULL").all();
      for (const r of rows) set.add(r.band);
      const contents = Array.from(set).map((name, i) => ({ manufacturer_id: i + 1, manufacturer_name: name }));
      return ok({ contents });
    },

    // ================= 内容分类 / 筛选 =================
    'POST /commodity/stock/content/list/': ({ body }) => {
      const cid = companyId(body);
      return ok({ contents: contentTree(cid, body && body.commodity_content_type) });
    },
    'POST /commodity/stock/valid/content/': ({ body }) => {
      const cid = companyId(body);
      return ok({ contents: contentTree(cid, body && body.commodity_content_type) });
    },
    'POST /commodity/stock/band/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT DISTINCT band FROM commodity_commodities WHERE company_id = ? AND band != ? ORDER BY band').all(cid, '');
      return ok({ contents: rows.map((r) => r.band).filter(Boolean) });
    },
    'POST /commodity/stock/model/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT DISTINCT model FROM commodity_commodities WHERE company_id = ? AND model != ? ORDER BY model').all(cid, '');
      return ok({ contents: rows.map((r) => r.model).filter(Boolean) });
    },
    'POST /commodity/stock/specification/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT DISTINCT specification FROM commodity_commodities WHERE company_id = ? AND specification != ? ORDER BY specification').all(cid, '');
      return ok({ contents: rows.map((r) => r.specification).filter(Boolean) });
    },
    // 筛选项（校验系列，返回结构同 band/model/specification）
    'POST /commodity/stock/valid/band/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT DISTINCT band FROM commodity_commodities WHERE company_id = ? AND band != ? ORDER BY band').all(cid, '');
      return ok({ contents: rows.map((r) => r.band).filter(Boolean) });
    },
    'POST /commodity/stock/valid/model/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT DISTINCT model FROM commodity_commodities WHERE company_id = ? AND model != ? ORDER BY model').all(cid, '');
      return ok({ contents: rows.map((r) => r.model).filter(Boolean) });
    },
    'POST /commodity/stock/valid/specification/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT DISTINCT specification FROM commodity_commodities WHERE company_id = ? AND specification != ? ORDER BY specification').all(cid, '');
      return ok({ contents: rows.map((r) => r.specification).filter(Boolean) });
    },
    'POST /commodity/stock/valid/create_user/': () => {
      const rows = db.prepare("SELECT DISTINCT create_user_id, create_user_name FROM commodity_stock_records WHERE create_user_id != 0 ORDER BY create_user_id").all();
      return ok({ contents: rows.map((r) => ({ create_user_id: r.create_user_id, create_user_name: r.create_user_name })) });
    },
    'POST /commodity/stock/valid/batch/': () => {
      const rows = db.prepare('SELECT * FROM commodity_batches ORDER BY id').all();
      return ok({ contents: rows.map((r) => ({ batch_id: r.id, batch_name: r.name })) });
    },
    'POST /commodity/stock/valid/manufacturer/': () => {
      const set = new Set();
      const rows = db.prepare("SELECT band FROM commodity_commodities WHERE band != '' AND band IS NOT NULL").all();
      for (const r of rows) set.add(r.band);
      const contents = Array.from(set).map((name, i) => ({ manufacturer_id: i + 1, manufacturer_name: name }));
      return ok({ contents });
    },
    'POST /commodity/stock/valid/project/': () => {
      // 项目/客户来自 crm_customers（crm_id → crm_name 供出库选择）
      const rows = db.prepare('SELECT crm_id, customer_name FROM crm_customers WHERE is_aborted = 0 ORDER BY crm_id').all();
      return ok({ contents: rows.map((r) => ({ crm_id: r.crm_id, project_name: r.customer_name, crm_name: r.customer_name })) });
    },
    'POST /commodity/stock/valid/warehouse_goods_location/': ({ body }) => {
      const cid = companyId(body);
      const whs = db.prepare('SELECT * FROM commodity_warehouses WHERE company_id = ? AND deleted = 0 ORDER BY id').all(cid);
      const gls = db.prepare('SELECT * FROM commodity_goods_locations WHERE company_id = ? AND deleted = 0 ORDER BY id').all(cid);
      return ok({
        contents: whs.map((w) => ({
          warehouse_id: w.id,
          warehouse_name: w.name,
          goods_locations: gls.filter((g) => Number(g.warehouse_id) === Number(w.id)).map((g) => ({ goods_location_id: g.id, goods_location_name: g.name })),
        })),
      });
    },

    // ================= 仓库 =================
    'POST /commodity/stock/warehouse/list/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT * FROM commodity_warehouses WHERE company_id = ? AND deleted = 0 ORDER BY id').all(cid);
      return ok({ contents: rows.map((r) => ({ warehouse_id: r.id, warehouse_name: r.name, address: r.address, contact_name: r.contact_name, contact_phone: r.contact_phone, remark: r.remark, is_enabled: r.is_enabled })) });
    },
    'POST /commodity/stock/warehouse/add/': ({ body }) => {
      const cid = companyId(body);
      if (!body || !body.name) return { code: 10011, msg: '参数错误', data: {} };
      const id = nextId('commodity_warehouses');
      db.prepare('INSERT INTO commodity_warehouses (id, name, address, contact_name, contact_phone, remark, is_enabled, deleted, company_id, created_at) VALUES (?,?,?,?,?,?,1,0,?,?)')
        .run(id, String(body.name), String(body.address || ''), String(body.contact_name || ''), String(body.contact_phone || ''), String(body.remark || ''), cid, dbNow());
      return ok({ warehouse_id: id });
    },
    'POST /commodity/stock/warehouse/edit/': ({ body }) => {
      const id = Number(body && body.warehouse_id) || Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const cur = db.prepare('SELECT * FROM commodity_warehouses WHERE id = ?').get(id);
      if (!cur) return { code: 10013, msg: '仓库不存在', data: {} };
      db.prepare('UPDATE commodity_warehouses SET name=?, address=?, contact_name=?, contact_phone=?, remark=? WHERE id=?')
        .run(String(body.name || cur.name), String(body.address ?? cur.address), String(body.contact_name ?? cur.contact_name), String(body.contact_phone ?? cur.contact_phone), String(body.remark ?? cur.remark), id);
      return ok({});
    },
    'POST /commodity/stock/warehouse/del/': ({ body }) => {
      const id = Number(body && body.warehouse_id) || Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE commodity_warehouses SET deleted = 1 WHERE id = ?').run(id);
      return ok({});
    },
    'POST /commodity/stock/warehouse/enable/': ({ body }) => {
      const id = Number(body && body.warehouse_id) || Number(body && body.id);
      const en = body && body.is_enabled !== undefined ? Number(body.is_enabled) : 1;
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE commodity_warehouses SET is_enabled = ? WHERE id = ?').run(en ? 1 : 0, id);
      return ok({});
    },
    'POST /commodity/stock/warehouse/is_enabled/list/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT * FROM commodity_warehouses WHERE company_id = ? AND deleted = 0 AND is_enabled = 1 ORDER BY id').all(cid);
      return ok({ contents: rows.map((r) => ({ warehouse_id: r.id, warehouse_name: r.name })) });
    },

    // ================= 货位 =================
    'POST /commodity/stock/goods_location/list/': ({ body }) => {
      const cid = companyId(body);
      const rows = db.prepare('SELECT * FROM commodity_goods_locations WHERE company_id = ? AND deleted = 0 ORDER BY id').all(cid);
      return ok({ contents: rows.map((r) => ({ goods_location_id: r.id, goods_location_name: r.name, warehouse_id: r.warehouse_id, remark: r.remark, is_enabled: r.is_enabled })) });
    },
    'POST /commodity/stock/goods_location/add/': ({ body }) => {
      const cid = companyId(body);
      if (!body || !body.name) return { code: 10011, msg: '参数错误', data: {} };
      const id = nextId('commodity_goods_locations');
      db.prepare('INSERT INTO commodity_goods_locations (id, warehouse_id, name, remark, is_enabled, deleted, company_id, created_at) VALUES (?,?,?,?,1,0,?,?)')
        .run(id, Number(body.warehouse_id) || 0, String(body.name), String(body.remark || ''), cid, dbNow());
      return ok({ goods_location_id: id });
    },
    'POST /commodity/stock/goods_location/edit/': ({ body }) => {
      const id = Number(body && body.goods_location_id) || Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const cur = db.prepare('SELECT * FROM commodity_goods_locations WHERE id = ?').get(id);
      if (!cur) return { code: 10013, msg: '货位不存在', data: {} };
      db.prepare('UPDATE commodity_goods_locations SET name=?, warehouse_id=?, remark=? WHERE id=?')
        .run(String(body.name || cur.name), Number(body.warehouse_id ?? cur.warehouse_id), String(body.remark ?? cur.remark), id);
      return ok({});
    },
    'POST /commodity/stock/goods_location/del/': ({ body }) => {
      const id = Number(body && body.goods_location_id) || Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE commodity_goods_locations SET deleted = 1 WHERE id = ?').run(id);
      return ok({});
    },
    'POST /commodity/stock/goods_location/enable/': ({ body }) => {
      const id = Number(body && body.goods_location_id) || Number(body && body.id);
      const en = body && body.is_enabled !== undefined ? Number(body.is_enabled) : 1;
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE commodity_goods_locations SET is_enabled = ? WHERE id = ?').run(en ? 1 : 0, id);
      return ok({});
    },
    'POST /commodity/stock/goods_location/is_enabled/list/': ({ body }) => {
      const wid = Number(body && body.warehouse_id) || 0;
      let sql = 'SELECT * FROM commodity_goods_locations WHERE deleted = 0 AND is_enabled = 1';
      const args = [];
      if (wid) { sql += ' AND warehouse_id = ?'; args.push(wid); }
      const rows = db.prepare(sql + ' ORDER BY id').all(...args);
      return ok({ contents: rows.map((r) => ({ goods_location_id: r.id, goods_location_name: r.name, warehouse_id: r.warehouse_id })) });
    },

    // ================= 批次 =================
    'POST /commodity/stock/batch/list/': ({ body }) => {
      const cid = companyId(body);
      let sql = 'SELECT * FROM commodity_batches WHERE company_id = ?';
      const args = [cid];
      if (body && body.warehouse_id) { sql += ' AND warehouse_id = ?'; args.push(Number(body.warehouse_id)); }
      const rows = db.prepare(sql + ' ORDER BY id').all(...args);
      const page = Number(body && body.page_index) || 1;
      const size = Number(body && body.page_size) || 20;
      const start = (page - 1) * size;
      return ok({ contents: rows.slice(start, start + size).map((r) => ({ batch_id: r.id, batch_name: r.name, warehouse_id: r.warehouse_id, remark: r.remark })), total_num: rows.length });
    },
    'POST /commodity/stock/batch/add/': ({ body }) => {
      const cid = companyId(body);
      if (!body || !body.name) return { code: 10011, msg: '参数错误', data: {} };
      const id = nextId('commodity_batches');
      db.prepare('INSERT INTO commodity_batches (id, warehouse_id, name, remark, company_id, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, Number(body.warehouse_id) || 0, String(body.name), String(body.remark || ''), cid, dbNow());
      return ok({ batch_id: id });
    },
    'POST /commodity/stock/batch/edit/': ({ body }) => {
      const id = Number(body && body.batch_id) || Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const cur = db.prepare('SELECT * FROM commodity_batches WHERE id = ?').get(id);
      if (!cur) return { code: 10013, msg: '批次不存在', data: {} };
      db.prepare('UPDATE commodity_batches SET name=?, warehouse_id=?, remark=? WHERE id=?')
        .run(String(body.name || cur.name), Number(body.warehouse_id ?? cur.warehouse_id), String(body.remark ?? cur.remark), id);
      return ok({});
    },
    'POST /commodity/stock/batch/del/': ({ body }) => {
      const id = Number(body && body.batch_id) || Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('DELETE FROM commodity_batches WHERE id = ?').run(id);
      return ok({});
    },

    // ================= 材料列表（采购入库页 materials / 出库页 contents） =================
    'POST /commodity/stock/material/list/': ({ body }) => {
      const cid = companyId(body);
      const b = body || {};
      const hasStockFilter = b.commodity_content_type !== undefined && b.commodity_content_type !== null && b.commodity_content_type !== '';
      // 商品维度（采购入库页）
      let sql = 'SELECT * FROM commodity_commodities WHERE company_id = ?';
      const args = [cid];
      if (b.commodity_type_id) { sql += ' AND commodity_type_id = ?'; args.push(Number(b.commodity_type_id)); }
      if (Array.isArray(b.band_name_list) && b.band_name_list.length) { sql += ` AND band IN (${b.band_name_list.map(() => '?').join(',')})`; args.push(...b.band_name_list); }
      if (Array.isArray(b.model_list) && b.model_list.length) { sql += ` AND model IN (${b.model_list.map(() => '?').join(',')})`; args.push(...b.model_list); }
      if (Array.isArray(b.specification_list) && b.specification_list.length) { sql += ` AND specification IN (${b.specification_list.map(() => '?').join(',')})`; args.push(...b.specification_list); }
      if (b.search_key) { sql += ' AND name LIKE ?'; args.push('%' + b.search_key + '%'); }
      const commodities = db.prepare(sql + ' ORDER BY id').all(...args).map(commodityView);
      // 库存维度（出库页）：合并各仓库/货位/批次行
      let ssql = 'SELECT * FROM commodity_stock WHERE company_id = ?';
      const sargs = [cid];
      if (hasStockFilter) {
        if (Number(b.commodity_content_type) === 0) { ssql += ' AND commodity_content_id != 152'; }
        if (Number(b.commodity_content_type) === 1) { ssql += ' AND commodity_content_id = 152'; }
      }
      if (Array.isArray(b.commodity_type_ids) && b.commodity_type_ids.length) { ssql += ` AND commodity_type_id IN (${b.commodity_type_ids.map(() => '?').join(',')})`; sargs.push(...b.commodity_type_ids.map(Number)); }
      if (b.search_key) { ssql += ' AND (commodity_name LIKE ? OR band LIKE ? OR model LIKE ? OR specification LIKE ?)'; sargs.push('%' + b.search_key + '%', '%' + b.search_key + '%', '%' + b.search_key + '%', '%' + b.search_key + '%'); }
      const stockRows = db.prepare(ssql + ' ORDER BY commodity_id, warehouse_id, batch_id').all(...sargs).map(stockView);
      return ok({ contents: stockRows, materials: commodities, total_num: stockRows.length });
    },

    // 客户/项目列表（出库选择客户）
    'POST /commodity/stock/all/crm/': ({ body }) => {
      const page = Number(body && body.page_index) || 1;
      const size = Number(body && body.page_size) || 20;
      let sql = 'SELECT crm_id, customer_name FROM crm_customers WHERE is_aborted = 0';
      const args = [];
      if (body && body.search_key) { sql += ' AND (customer_name LIKE ? OR customer_phone LIKE ?)'; args.push('%' + body.search_key + '%', '%' + body.search_key + '%'); }
      const rows = db.prepare(sql + ' ORDER BY crm_id').all(...args);
      const start = (page - 1) * size;
      return ok({ contents: rows.slice(start, start + size).map((r) => ({ crm_id: r.crm_id, crm_name: r.customer_name })), total_num: rows.length });
    },
    'POST /commodity/stock/rejected/material/warehouse/': ({ body }) => {
      // 退料场景：查询指定客户已领料（出库）的记录对应库存，供退回选择
      const cid = companyId(body);
      const crm_id = Number(body && body.crm_id) || 0;
      let sql = 'SELECT * FROM commodity_stock WHERE company_id = ?';
      const args = [cid];
      if (crm_id) {
        const recs = db.prepare('SELECT DISTINCT commodity_id, warehouse_id, goods_location_id, batch_id FROM commodity_stock_records WHERE company_id = ? AND crm_id = ? AND type = 1 AND repealed = 0').all(cid, crm_id);
        const keys = recs.map((r) => `${r.commodity_id}-${r.warehouse_id}-${r.goods_location_id}-${r.batch_id}`);
        if (keys.length) {
          const rows = db.prepare('SELECT * FROM commodity_stock WHERE company_id = ?').all(cid);
          const hit = rows.filter((r) => keys.includes(`${r.commodity_id}-${r.warehouse_id}-${r.goods_location_id}-${r.batch_id}`));
          return ok({ contents: hit.map(stockView) });
        }
        return ok({ contents: [] });
      }
      const rows = db.prepare(sql + ' ORDER BY id').all(...args);
      return ok({ contents: rows.map(stockView) });
    },

    // ================= 核心：采购入库（type 0） =================
    'POST /commodity/stock/im_warehouse/purchase/': ({ body, headers }) => {
      const cid = companyId(body);
      const user = currentUser(headers);
      const items = (body && Array.isArray(body.items)) ? body.items : [];
      if (!items.length) return { code: 10011, msg: '参数错误', data: {} };
      const errorCodes = [];
      const recordIds = [];
      for (const item of items) {
        const commodity = db.prepare('SELECT * FROM commodity_commodities WHERE id = ? AND company_id = ?').get(Number(item.commodity_id), cid);
        if (!commodity) {
          errorCodes.push({ commodity_id: item.commodity_id, msg: '商品不存在' });
          continue;
        }
        const cv = commodityView(commodity);
        stockIn(cid, { ...item, num: Number(item.num) }, cv);
        const rid = addRecord(0, cid, { ...item, commodity_id: commodity.id, purchase_price: item.purchase_price }, cv, user, {});
        recordIds.push(rid);
      }
      if (errorCodes.length) return { code: 25002, msg: '部分商品处理失败', data: { error_codes: errorCodes } };
      return ok({ stock_record_ids: recordIds });
    },

    // ================= 核心：领料出库（type 1）/ 退料入库（type 2） =================
    'POST /commodity/stock/ex_warehouse/receive/': ({ body, headers }) => {
      return doInOut(1, body, headers);
    },
    'POST /commodity/stock/im_warehouse/refund/': ({ body, headers }) => {
      return doInOut(2, body, headers);
    },

    // ================= 库存 =================
    'POST /commodity/stock/list/': ({ body }) => {
      const cid = companyId(body);
      const b = body || {};
      let sql = 'SELECT * FROM commodity_stock WHERE company_id = ?';
      const args = [cid];
      if (b.commodity_content_type !== undefined && b.commodity_content_type !== null && b.commodity_content_type !== '') {
        if (Number(b.commodity_content_type) === 0) sql += ' AND commodity_content_id != 152';
        else if (Number(b.commodity_content_type) === 1) sql += ' AND commodity_content_id = 152';
      }
      if (Array.isArray(b.commodity_type_ids) && b.commodity_type_ids.length) { sql += ` AND commodity_type_id IN (${b.commodity_type_ids.map(() => '?').join(',')})`; args.push(...b.commodity_type_ids.map(Number)); }
      if (b.band_name) { sql += ' AND band = ?'; args.push(String(b.band_name)); }
      if (b.model) { sql += ' AND model = ?'; args.push(String(b.model)); }
      if (b.specification) { sql += ' AND specification = ?'; args.push(String(b.specification)); }
      if (b.batch_id) { sql += ' AND batch_id = ?'; args.push(Number(b.batch_id)); }
      if (b.warehouse_id) { sql += ' AND warehouse_id = ?'; args.push(Number(b.warehouse_id)); }
      if (b.goods_location_id) { sql += ' AND goods_location_id = ?'; args.push(Number(b.goods_location_id)); }
      if (b.search_key) { sql += ' AND (commodity_name LIKE ? OR band LIKE ? OR model LIKE ? OR specification LIKE ?)'; args.push('%' + b.search_key + '%', '%' + b.search_key + '%', '%' + b.search_key + '%', '%' + b.search_key + '%'); }
      const rows = db.prepare(sql + ' ORDER BY commodity_id, warehouse_id, batch_id').all(...args);
      const page = Number(b.page_index) || 1;
      const size = Number(b.page_size) || 20;
      const start = (page - 1) * size;
      return ok({ contents: rows.slice(start, start + size).map(stockView), total_num: rows.length });
    },
    'POST /commodity/stock/check/': ({ body, headers }) => {
      // 盘点：传入实盘数量，差异生成盘盈(type3)/盘亏(type4)记录并校正库存
      const cid = companyId(body);
      const user = currentUser(headers);
      const items = (body && Array.isArray(body.items)) ? body.items : [];
      const recordIds = [];
      for (const item of items) {
        const stock = db.prepare('SELECT * FROM commodity_stock WHERE id = ? AND company_id = ?').get(Number(item.stock_id), cid);
        if (!stock) continue;
        const diff = Number(item.check_num || item.num || 0) - Number(stock.stock_num || 0);
        if (diff === 0) continue;
        const type = diff > 0 ? 3 : 4;
        const sv = { ...stockView(stock), commodity_name: stock.commodity_name, band: stock.band, model: stock.model, specification: stock.specification, unit_name: stock.unit, image: stock.image, commodity_content_id: stock.commodity_content_id, commodity_content_name: stock.commodity_content_name, commodity_type_id: stock.commodity_type_id, commodity_type_name: stock.commodity_type_name };
        const rid = addRecord(type, cid, { ...stockView(stock), commodity_id: stock.commodity_id, num: Math.abs(diff), warehouse_id: stock.warehouse_id, goods_location_id: stock.goods_location_id, batch_id: stock.batch_id }, sv, user, {});
        db.prepare('UPDATE commodity_stock SET stock_num = ?, updated_at = ? WHERE id = ?').run(Number(item.check_num || item.num || 0), dbNow(), stock.id);
        recordIds.push(rid);
      }
      return ok({ stock_record_ids: recordIds });
    },

    // ================= 出入库记录 =================
    'POST /commodity/stock/record/list/': ({ body }) => {
      const cid = companyId(body);
      const b = body || {};
      let sql = 'SELECT * FROM commodity_stock_records WHERE company_id = ?';
      const args = [cid];
      // record_type/type：-1 = 全部（前端默认值，不过滤）
      if (b.record_type !== undefined && b.record_type !== null && b.record_type !== '' && Number(b.record_type) !== -1) { sql += ' AND type = ?'; args.push(Number(b.record_type)); }
      if (b.type !== undefined && b.type !== null && b.type !== '' && Number(b.type) !== -1) { sql += ' AND type = ?'; args.push(Number(b.type)); }
      if (b.crm_id) { sql += ' AND crm_id = ?'; args.push(Number(b.crm_id)); }
      if (b.commodity_type_ids && Array.isArray(b.commodity_type_ids) && b.commodity_type_ids.length) { sql += ` AND commodity_id IN (SELECT id FROM commodity_commodities WHERE commodity_type_id IN (${b.commodity_type_ids.map(() => '?').join(',')}))`; args.push(...b.commodity_type_ids.map(Number)); }
      if (b.band_name) { sql += ' AND band = ?'; args.push(String(b.band_name)); }
      if (b.model) { sql += ' AND model = ?'; args.push(String(b.model)); }
      if (b.specification) { sql += ' AND specification = ?'; args.push(String(b.specification)); }
      if (b.batch_id) { sql += ' AND batch_id = ?'; args.push(Number(b.batch_id)); }
      if (b.warehouse_id) { sql += ' AND warehouse_id = ?'; args.push(Number(b.warehouse_id)); }
      if (b.goods_location_id) { sql += ' AND goods_location_id = ?'; args.push(Number(b.goods_location_id)); }
      if (b.create_user_id) { sql += ' AND create_user_id = ?'; args.push(Number(b.create_user_id)); }
      if (b.search_key) { sql += ' AND (commodity_name LIKE ? OR band LIKE ? OR model LIKE ? OR specification LIKE ?)'; args.push('%' + b.search_key + '%', '%' + b.search_key + '%', '%' + b.search_key + '%', '%' + b.search_key + '%'); }
      if (b.start_date) { sql += ' AND record_time >= ?'; args.push(String(b.start_date)); }
      if (b.end_date) { sql += ' AND record_time <= ?'; args.push(String(b.end_date) + ' 23:59:59'); }
      if (b.ids) {
        const ids = Array.isArray(b.ids) ? b.ids.map(Number) : String(b.ids).split(',').map(Number);
        if (ids.length) { sql += ` AND id IN (${ids.map(() => '?').join(',')})`; args.push(...ids); }
      }
      const rows = db.prepare(sql + ' ORDER BY id DESC').all(...args);
      const page = Number(b.page_index) || 1;
      const size = Number(b.page_size) || 20;
      const start = (page - 1) * size;
      return ok({ contents: rows.slice(start, start + size).map(recordView), total_num: rows.length });
    },
    'POST /commodity/material/edit/record/detail/': ({ body }) => {
      const id = Number(body && body.stock_record_id) || Number(body && body.id) || Number(body && body.record_id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM commodity_stock_records WHERE id = ?').get(id);
      if (!row) return { code: 10013, msg: '记录不存在', data: {} };
      return ok({ record: recordView(row) });
    },
    // 记录冲正（撤销）：type 0/2 反冲库存为减，type 1/3/4 反冲为加
    'POST /commodity/stock/record/repeal/': ({ body }) => {
      const id = Number(body && body.stock_record_id) || Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM commodity_stock_records WHERE id = ?').get(id);
      if (!row) return { code: 10013, msg: '记录不存在', data: {} };
      if (row.repealed) return { code: 10011, msg: '该记录已冲正', data: {} };
      const sign = (row.type === 0 || row.type === 2) ? -1 : 1; // 入库类冲正减库存；出库类冲正加库存
      const stock = db.prepare('SELECT * FROM commodity_stock WHERE company_id=? AND commodity_id=? AND warehouse_id=? AND goods_location_id=? AND batch_id=?')
        .get(row.company_id, row.commodity_id, row.warehouse_id, row.goods_location_id, row.batch_id);
      if (stock) {
        const newNum = Number(stock.stock_num) + sign * Number(row.num);
        if (newNum < 0) return { code: 10011, msg: '冲正后库存不足', data: {} };
        db.prepare('UPDATE commodity_stock SET stock_num = ?, updated_at = ? WHERE id = ?').run(newNum, dbNow(), stock.id);
      }
      db.prepare('UPDATE commodity_stock_records SET repealed = 1 WHERE id = ?').run(id);
      return ok({});
    },
    'POST /commodity/repeal/record/list/': ({ body }) => {
      const cid = companyId(body);
      const b = body || {};
      const rows = db.prepare('SELECT * FROM commodity_stock_records WHERE company_id = ? AND repealed = 1 ORDER BY id DESC').all(cid);
      const page = Number(b.page_index) || 1;
      const size = Number(b.page_size) || 20;
      const start = (page - 1) * size;
      return ok({ contents: rows.slice(start, start + size).map(recordView), total_num: rows.length });
    },
    'POST /commodity/repeal/record/recover/': ({ body }) => {
      // 恢复已冲正记录：重新应用原库存变动方向
      const id = Number(body && body.stock_record_id) || Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM commodity_stock_records WHERE id = ?').get(id);
      if (!row) return { code: 10013, msg: '记录不存在', data: {} };
      if (!row.repealed) return { code: 10011, msg: '该记录未冲正', data: {} };
      const sign = (row.type === 0 || row.type === 2) ? 1 : -1;
      const stock = db.prepare('SELECT * FROM commodity_stock WHERE company_id=? AND commodity_id=? AND warehouse_id=? AND goods_location_id=? AND batch_id=?')
        .get(row.company_id, row.commodity_id, row.warehouse_id, row.goods_location_id, row.batch_id);
      if (stock) {
        const newNum = Number(stock.stock_num) + sign * Number(row.num);
        if (newNum < 0) return { code: 10011, msg: '恢复后库存不足', data: {} };
        db.prepare('UPDATE commodity_stock SET stock_num = ?, updated_at = ? WHERE id = ?').run(newNum, dbNow(), stock.id);
      }
      db.prepare('UPDATE commodity_stock_records SET repealed = 0 WHERE id = ?').run(id);
      return ok({});
    },

    // ================= 导出（简化 CSV；responseType=blob 场景后续再对齐 xlsx） =================
    'POST /commodity/stock/record/excel/export/': () => ({ code: 0, msg: '成功', data: {} }),
    'POST /commodity/stock/export/': () => ({ code: 0, msg: '成功', data: {} }),
  };

  // 出库/退料共用的库存变更逻辑（type 1 出库 / type 2 退料入库）
  function doInOut(type, body, headers) {
    const cid = companyId(body);
    const user = currentUser(headers);
    const items = (body && Array.isArray(body.items)) ? body.items : [];
    if (!items.length) return { code: 10011, msg: '参数错误', data: {} };
    const errorCodes = [];
    const recordIds = [];
    // 退料入库（type 2）默认把退料回到"默认仓库/货位"
    const defaultWh = db.prepare('SELECT * FROM commodity_warehouses WHERE company_id = ? AND deleted = 0 ORDER BY id').get(cid);

    for (const item of items) {
      const stock = db.prepare('SELECT * FROM commodity_stock WHERE id = ? AND company_id = ?').get(Number(item.stock_id), cid);
      if (!stock) {
        errorCodes.push({ commodity_id: Number(item.commodity_id) || 0, msg: '库存记录不存在' });
        continue;
      }
      const num = Number(item.num || 0);
      if (type === 1) {
        // 领料出库：校验库存充足
        if (Number(stock.stock_num) < num) {
          errorCodes.push({ commodity_id: stock.commodity_id, stock_id: stock.id, stock_num: stock.stock_num, msg: '库存不足' });
          continue;
        }
        db.prepare('UPDATE commodity_stock SET stock_num = stock_num - ?, updated_at = ? WHERE id = ?').run(num, dbNow(), stock.id);
      } else {
        // 退料入库：增加回原库存行（或默认仓库）
        const inItem = {
          commodity_id: stock.commodity_id, num,
          warehouse_id: stock.warehouse_id || (defaultWh && defaultWh.id) || 0,
          goods_location_id: stock.goods_location_id || 0,
          batch_id: stock.batch_id || 0,
          warehouse_name: stock.warehouse_name, goods_location_name: stock.goods_location_name, batch_no: stock.batch_no,
          description: item.description,
        };
        stockIn(cid, inItem, stockView(stock));
      }
      // 项目名解析
      let project_name = '';
      if (body && body.crm_id) {
        const crm = db.prepare('SELECT customer_name FROM crm_customers WHERE crm_id = ?').get(Number(body.crm_id));
        project_name = crm ? crm.customer_name : '';
      }
      const cv = stockView(stock);
      const rid = addRecord(type, cid, {
        commodity_id: stock.commodity_id, num,
        warehouse_id: stock.warehouse_id, goods_location_id: stock.goods_location_id, batch_id: stock.batch_id,
        description: item.description,
      }, cv, user, { crm_id: body.crm_id, project_name });
      recordIds.push(rid);
    }
    if (errorCodes.length) return { code: 25002, msg: '部分材料处理失败', data: { error_codes: errorCodes } };
    return ok({ stock_record_ids: recordIds });
  }

  return handlers;
}

module.exports = { COMMODITY_STOCK_SCHEMA_SQL, seedCommodityStock, createCommodityStockApi, STOCK_TYPE_MAP, LOCAL_ID_BASE };
