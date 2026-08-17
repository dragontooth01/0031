/**
 * 第五批：crm_material 材料库（13 项）+ supplier 供应商/采购（25 项）
 * 对应开发计划 _api_dev_plan.md §2.2 + §2.4，规格文档 data/_crm_batch5_plan.md
 * 全部本地实现：crm_material 清单 / 销售退货单 / 材料申请单（v3 订单+快单+退料）三套新表闭环
 * 导出（M12/S15/S17）走二进制 xlsx 协议（{__binary, contentType, fileName, buffer}）
 */
const ExcelJS = require('exceljs');

function createMaterialApi(db, deps) {
  const { ok, getSession, dbNow, localNextId } = deps;
  const handlers = {};

  // ---------- Excel 导出辅助（与 crm-api.js 同协议） ----------
  async function buildXlsx(fileName, sheetName, headers, rows, fields) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName || 'Sheet1');
    ws.columns = headers.map((h) => ({ header: h, width: Math.max(10, h.length * 2 + 4) }));
    for (const r of rows) {
      ws.addRow(fields.map((f) => {
        const v = r[f];
        return v === undefined || v === null ? '' : v;
      }));
    }
    const buf = await wb.xlsx.writeBuffer();
    return { __binary: true, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName, buffer: buf };
  }

  // ---------- 内部辅助 ----------
  const sessionUserId = (headers) => {
    const s = getSession(headers);
    return s ? Number(s.user_id || s.cloud_user_id || 0) : 0;
  };
  const userName = (uid) => {
    const n = Number(uid);
    if (!n) return '';
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(n);
    if (u && u.name) return u.name;
    const m = db.prepare('SELECT name FROM company_members WHERE id = ?').get(n);
    return m ? (m.name || '') : '';
  };
  const pager = (b) => ({
    page_index: Math.max(1, Number(b.page_index || 1)),
    page_size: Math.max(1, Number(b.page_size || 20))
  });
  const errParam = () => ({ code: 10011, msg: '参数错误', data: {} });
  const parseJson = (v, fallback) => {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  };
  const orderStatusName = (s) => {
    const map = ['待审批', '待商家确认', '配送中', '待签收', '已完成', '装企取消', '商家取消', '装企驳回', '待结算', '已结算', '拒绝结算', '退货中', '供应商驳回', '待退货'];
    return map[Number(s) >= 0 && Number(s) < map.length ? Number(s) : 0] || '待审批';
  };
  const companyMemberName = (uid) => {
    const n = Number(uid);
    if (!n) return '';
    const m = db.prepare('SELECT name FROM company_members WHERE id = ?').get(n);
    return m ? (m.name || '') : '';
  };

  // ==================== 一、crm_material_type 材料清单分组 ====================

  // M1 清单列表
  handlers['POST /material_apply/crm_material_type/list/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    if (!crmId) return errParam();
    const rows = db.prepare('SELECT * FROM crm_material_types WHERE crm_id = ? AND deleted = 0 ORDER BY order_num ASC, crm_material_type_id ASC')
      .all(crmId);
    return ok({
      crm_material_types: rows.map((r) => ({
        id: Number(r.crm_material_type_id),
        name: r.name,
        order: r.order_num,
        create_user_name: r.create_user_name
      }))
    });
  };

  // M2 清单全量详情（含材料行）
  handlers['POST /material_apply/crm_material_type/all/detail/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    if (!crmId) return errParam();
    const types = db.prepare('SELECT * FROM crm_material_types WHERE crm_id = ? AND deleted = 0 ORDER BY order_num ASC, crm_material_type_id ASC')
      .all(crmId);
    const items = db.prepare('SELECT * FROM crm_materials WHERE deleted = 0 ORDER BY order_num ASC, crm_material_id ASC').all();
    return ok({
      crm_material_types: types.map((t) => ({
        id: Number(t.crm_material_type_id),
        name: t.name,
        create_user_name: t.create_user_name,
        description: t.description,
        crm_materials: items.filter((m) => m.crm_material_type_id === t.crm_material_type_id).map(buildMaterialRow)
      }))
    });
  };

  // 材料行 → 前端消费对象
  const buildMaterialRow = (m) => ({
    crm_material_id: Number(m.crm_material_id),
    name: m.name,
    material_name: m.material_name,
    model: m.model,
    specification: m.specification,
    brand: m.brand,
    num: m.num,
    unit_name: m.unit_name,
    sale_price: m.sale_price,
    total_price: m.total_price,
    self_definition: m.self_definition
  });

  // M3 新增清单
  handlers['POST /material_apply/crm_material_type/add/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const name = String(b.name || '').trim();
    if (!crmId || !name) return errParam();
    const dup = db.prepare('SELECT crm_material_type_id FROM crm_material_types WHERE crm_id = ? AND name = ? AND deleted = 0').get(crmId, name);
    if (dup) return { code: 10011, msg: '清单名称已存在', data: {} };
    const uid = sessionUserId(req.headers);
    const id = db.prepare('INSERT INTO crm_material_types (crm_id, name, order_num, create_user_id, create_user_name, deleted, created_at) VALUES (?,?,?,?,?,0,?)')
      .run(crmId, name, 0, uid, userName(uid), dbNow()).lastInsertRowid;
    return ok({ crm_material_type_id: Number(id) });
  };

  // M4 重命名清单
  handlers['POST /material_apply/crm_material_type/edit/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.id || 0);
    const name = String(b.name || '').trim();
    if (!id || !name) return errParam();
    const row = db.prepare('SELECT * FROM crm_material_types WHERE crm_material_type_id = ? AND deleted = 0').get(id);
    if (!row) return { code: 13001, msg: '清单不存在', data: {} };
    const dup = db.prepare('SELECT crm_material_type_id FROM crm_material_types WHERE crm_id = ? AND name = ? AND crm_material_type_id != ? AND deleted = 0')
      .get(row.crm_id, name, id);
    if (dup) return { code: 10011, msg: '清单名称已存在', data: {} };
    db.prepare('UPDATE crm_material_types SET name = ? WHERE crm_material_type_id = ?').run(name, id);
    return ok({});
  };

  // M5 删除清单（级联软删材料行）
  handlers['POST /material_apply/crm_material_type/del/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.id || 0);
    if (!id) return errParam();
    const row = db.prepare('SELECT crm_material_type_id FROM crm_material_types WHERE crm_material_type_id = ? AND deleted = 0').get(id);
    if (!row) return { code: 13001, msg: '清单不存在', data: {} };
    db.prepare('UPDATE crm_material_types SET deleted = 1 WHERE crm_material_type_id = ?').run(id);
    db.prepare('UPDATE crm_materials SET deleted = 1 WHERE crm_material_type_id = ?').run(id);
    return ok({});
  };

  // M6 清单排序
  handlers['POST /material_apply/crm_material_type/order/update/'] = (req) => {
    const b = req.body || {};
    const list = Array.isArray(b.crm_material_types) ? b.crm_material_types : [];
    if (!list.length) return errParam();
    const upd = db.prepare('UPDATE crm_material_types SET order_num = ? WHERE crm_material_type_id = ? AND deleted = 0');
    list.forEach((x, i) => upd.run(Number(x.order !== undefined ? x.order : i), Number(x.id || 0)));
    return ok({});
  };

  // ==================== 二、crm_material 材料行 ====================

  // M7 新增空材料行
  handlers['POST /material_apply/crm_material/add/'] = (req) => {
    const b = req.body || {};
    const typeId = Number(b.crm_material_type_id || 0);
    if (!typeId) return errParam();
    const t = db.prepare('SELECT crm_material_type_id FROM crm_material_types WHERE crm_material_type_id = ? AND deleted = 0').get(typeId);
    if (!t) return { code: 13001, msg: '清单不存在', data: {} };
    const id = db.prepare('INSERT INTO crm_materials (crm_material_type_id, deleted, self_definition, created_at) VALUES (?,0,1,?)')
      .run(typeId, dbNow()).lastInsertRowid;
    return ok({ crm_material_id: Number(id) });
  };

  // M8 行内编辑（一次只改一个字段）
  handlers['POST /material_apply/crm_material/edit/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.crm_material_id || 0);
    if (!id) return errParam();
    const row = db.prepare('SELECT * FROM crm_materials WHERE crm_material_id = ? AND deleted = 0').get(id);
    if (!row) return { code: 13001, msg: '材料不存在', data: {} };
    const upd = (cols) => {
      const keys = Object.keys(cols);
      db.prepare('UPDATE crm_materials SET ' + keys.map((k) => k + '=?').join(',') + ' WHERE crm_material_id = ?')
        .run(...keys.map((k) => cols[k]), id);
    };
    const set = {};
    for (const f of ['name', 'material_name', 'model', 'specification', 'brand', 'unit_name']) {
      if (b[f] !== undefined) set[f] = String(b[f]);
    }
    if (b.num !== undefined) set.num = Number(b.num || 0);
    if (b.sale_price !== undefined) set.sale_price = Number(b.sale_price || 0);
    // 文字字段手动定义；数量/单价联动总价
    if (b.name !== undefined || b.material_name !== undefined || b.model !== undefined || b.specification !== undefined || b.brand !== undefined) {
      set.self_definition = 1;
    }
    const num = b.num !== undefined ? Number(b.num || 0) : row.num;
    const price = b.sale_price !== undefined ? Number(b.sale_price || 0) : row.sale_price;
    set.total_price = num * price;
    upd(set);
    return ok({});
  };

  // M9 删除材料行
  handlers['POST /material_apply/crm_material/del/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.crm_material_id || 0);
    if (!id) return errParam();
    const row = db.prepare('SELECT crm_material_id FROM crm_materials WHERE crm_material_id = ? AND deleted = 0').get(id);
    if (!row) return { code: 13001, msg: '材料不存在', data: {} };
    // 本地无签约预算联动：一律可删（is_selected 供前端提示，默认 false）
    db.prepare('UPDATE crm_materials SET deleted = 1 WHERE crm_material_id = ?').run(id);
    return ok({ is_selected: false });
  };

  // M10 从展示厅商品库导入替换材料行
  handlers['POST /material_apply/crm_material/import/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.crm_material_id || 0);
    const typeId = Number(b.crm_material_type_id || 0);
    const materialId = Number(b.material_id || 0);
    if (!id || !typeId || !materialId) return errParam();
    const row = db.prepare('SELECT crm_material_id FROM crm_materials WHERE crm_material_id = ? AND deleted = 0').get(id);
    if (!row) return { code: 13001, msg: '材料不存在', data: {} };
    // company_materials 为展示厅商品快照（payload 原样含材料全字段）
    const mat = db.prepare('SELECT * FROM company_materials WHERE id = ?').get(materialId);
    if (!mat) return { code: 13001, msg: '商品不存在', data: {} };
    const p = parseJson(mat.payload, {});
    db.prepare(`UPDATE crm_materials SET material_id = ?, name = ?, material_name = ?, model = ?, specification = ?, brand = ?,
      unit_name = ?, sale_price = ?, total_price = ?, self_definition = 0 WHERE crm_material_id = ?`)
      .run(materialId,
        String(p.name || mat.name || ''),
        String(p.name || mat.name || ''),
        String(p.model || mat.model || ''),
        String(p.specification || mat.spec || ''),
        String(p.band || mat.brand || ''),
        String(p.sale_unit || p.unit || '项'),
        Number(p.sale_price || 0),
        Number(p.sale_price || 0),
        id);
    const updated = db.prepare('SELECT * FROM crm_materials WHERE crm_material_id = ?').get(id);
    return ok(buildMaterialRow(updated));
  };

  // M11 材料行排序
  handlers['POST /material_apply/crm_material/order/update/'] = (req) => {
    const b = req.body || {};
    const list = Array.isArray(b.crm_materials) ? b.crm_materials : [];
    if (!list.length) return errParam();
    const upd = db.prepare('UPDATE crm_materials SET order_num = ? WHERE crm_material_id = ? AND deleted = 0');
    list.forEach((x, i) => upd.run(Number(x.order !== undefined ? x.order : i), Number(x.id || 0)));
    return ok({});
  };

  // M12 材料清单导出（blob xlsx）
  handlers['POST /material_apply/crm_material_type/export/excel/'] = async (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    if (!crmId) return errParam();
    const ids = Array.isArray(b.crm_material_type_ids) ? b.crm_material_type_ids.map(Number) : [];
    const where = ['crm_id = ?', 'deleted = 0'];
    const params = [crmId];
    if (ids.length) { where.push('crm_material_type_id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
    const types = db.prepare('SELECT * FROM crm_material_types WHERE ' + where.join(' AND ') + ' ORDER BY order_num ASC, crm_material_type_id ASC').all(...params);
    const wb = new ExcelJS.Workbook();
    const headers = ['材料名称', '品牌', '型号', '规格', '单位', '数量', '单价', '总价'];
    for (const t of types) {
      const ws = wb.addWorksheet(String(t.name).slice(0, 31) || '材料清单');
      ws.columns = headers.map((h) => ({ header: h, width: 16 }));
      const items = db.prepare('SELECT * FROM crm_materials WHERE crm_material_type_id = ? AND deleted = 0 ORDER BY order_num ASC, crm_material_id ASC').all(t.crm_material_type_id);
      for (const m of items) {
        ws.addRow([m.material_name || m.name, m.brand, m.model, m.specification, m.unit_name, m.num, m.sale_price, m.total_price]);
      }
    }
    const buf = await wb.xlsx.writeBuffer();
    return { __binary: true, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: '材料清单.xlsx', buffer: buf };
  };

  // M13 预算模板导入清单
  handlers['POST /material_apply/crm_material_type/template/import/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const templateId = Number(b.budget_template_id || 0);
    if (!crmId || !templateId) return errParam();
    const tpl = db.prepare('SELECT * FROM company_budget_templates WHERE id = ?').get(templateId);
    if (!tpl) return { code: 13001, msg: '预算模板不存在', data: {} };
    const uid = sessionUserId(req.headers);
    const id = db.prepare('INSERT INTO crm_material_types (crm_id, name, order_num, create_user_id, create_user_name, deleted, created_at) VALUES (?,?,?,?,?,0,?)')
      .run(crmId, tpl.name, 0, uid, userName(uid), dbNow()).lastInsertRowid;
    return ok({ crm_material_type_id: Number(id) });
  };

  // ==================== 三、supplier 销售/退货单（S1~S15） ====================

  const buildSaleOrderItem = (i) => ({
    material_nick_name: i.material_nick_name,
    name: i.name,
    model: i.model,
    specification: i.specification,
    band_name: i.band_name,
    unit_name: i.unit_name,
    market_price: i.market_price,
    num: i.num,
    market_price_subtotal: i.market_price_subtotal
  });

  // S1 全部客户（选客户/项目下拉）
  handlers['POST /material_apply/supplier/all_crm/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    const kw = String(b.search_key || '').trim();
    const where = ['deleted = 0', 'is_aborted = 0'];
    const params = [];
    if (kw) { where.push('(customer_name LIKE ? OR customer_phone LIKE ?)'); params.push('%' + kw + '%', '%' + kw + '%'); }
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_customers WHERE ' + whereSql + ' ORDER BY crm_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({
      total_num: total,
      crms: rows.map((r) => ({
        crm_id: Number(r.crm_id),
        crm_name: r.customer_name,
        consignee_name: r.owner_name || '',
        consignee_phone: r.customer_phone || ''
      }))
    });
  };

  // 建单共用：order_type 11=销售 12=退货
  const addSaleOrder = (req, orderType) => {
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    const crmId = Number(b.crm_id || 0);
    if (!crmId || !items.length) return errParam();
    const uid = sessionUserId(req.headers);
    const now = dbNow();
    let total = 0;
    const rows = items.map((it) => {
      const num = Number(it.num || 0);
      const price = Number(it.market_price || 0);
      total += num * price;
      return { commodity_id: Number(it.commodity_id || 0), material_nick_name: String(it.material_nick_name || ''), market_price: price, num };
    });
    const orderId = db.prepare(`INSERT INTO supplier_sales_orders
      (order_type, crm_id, project_name, consignee_name, consignee_phone, description, status, total_amount, create_user_id, create_user_name, create_time, deleted, created_at)
      VALUES (?,?,?,?,?,?,0,?,?,?,?,0,?)`)
      .run(orderType, crmId,
        String(b.project_name || ''), String(b.consignee_name || ''), String(b.consignee_phone || ''),
        String(b.description || ''), total, uid, userName(uid), now, now).lastInsertRowid;
    db.prepare('UPDATE supplier_sales_orders SET order_sn = ? WHERE order_id = ?').run('SO' + String(orderId).padStart(8, '0'), orderId);
    const insItem = db.prepare('INSERT INTO supplier_sales_order_items (order_id, commodity_id, material_nick_name, market_price, num, market_price_subtotal) VALUES (?,?,?,?,?,?)');
    for (const r of rows) {
      insItem.run(orderId, r.commodity_id, r.material_nick_name, r.market_price, r.num, r.market_price * r.num);
    }
    return ok({ order_id: Number(orderId) });
  };

  // S2 新增销售单
  handlers['POST /material_apply/supplier/sales/order/add/'] = (req) => addSaleOrder(req, 11);
  // S3 新增退货单
  handlers['POST /material_apply/supplier/refund/order/add/'] = (req) => addSaleOrder(req, 12);

  // S4 销售/退货单列表
  handlers['POST /material_apply/supplier/sales/order/list/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0'];
    const params = [];
    const crmId = Number(b.crm_id || 0);
    if (crmId) { where.push('crm_id = ?'); params.push(crmId); }
    if (b.status !== undefined && b.status !== '' && b.status !== null) { where.push('status = ?'); params.push(Number(b.status)); }
    if (b.order_type !== undefined && b.order_type !== '' && b.order_type !== null) { where.push('order_type = ?'); params.push(Number(b.order_type)); }
    if (b.start_date) { where.push('create_time >= ?'); params.push(String(b.start_date)); }
    if (b.end_date) { where.push('create_time <= ?'); params.push(String(b.end_date) + ' 23:59:59'); }
    const kw = String(b.search_key || '').trim();
    if (kw) { where.push('(order_sn LIKE ? OR project_name LIKE ? OR consignee_name LIKE ?)'); params.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%'); }
    const whereSql = where.join(' AND ');
    const all = db.prepare('SELECT * FROM supplier_sales_orders WHERE ' + whereSql + ' ORDER BY order_id DESC').all(...params);
    const totalAmount = all.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const pending = all.filter((r) => Number(r.status) === 0).length;
    const processed = all.filter((r) => Number(r.status) !== 0).length;
    const page = all.slice((page_index - 1) * page_size, page_index * page_size);
    return ok({
      contents: page.map((r) => ({
        order_id: Number(r.order_id),
        order_sn: r.order_sn,
        order_type: r.order_type,
        name: r.project_name || r.order_sn,
        operate_time: r.create_time,
        type_num: db.prepare('SELECT COUNT(*) AS c FROM supplier_sales_order_items WHERE order_id = ?').get(r.order_id).c,
        order_amount: r.total_amount,
        description: r.description
      })),
      total_amount: totalAmount,
      pending_num: pending,
      processed_num: processed
    });
  };

  // S5 销售/退货单详情
  handlers['POST /material_apply/supplier/sales/order/detail/'] = (req) => {
    const b = req.body || {};
    const orderId = Number(b.order_id || 0);
    if (!orderId) return errParam();
    const row = db.prepare('SELECT * FROM supplier_sales_orders WHERE order_id = ? AND deleted = 0').get(orderId);
    if (!row) return { code: 13001, msg: '订单不存在', data: {} };
    const items = db.prepare('SELECT * FROM supplier_sales_order_items WHERE order_id = ?').all(orderId);
    return ok({
      order_id: Number(row.order_id),
      order_type: row.order_type,
      base_info: {
        project_name: row.project_name,
        consignee_name: row.consignee_name,
        consignee_phone: row.consignee_phone,
        order_sn: row.order_sn,
        create_time: row.create_time,
        create_user_name: row.create_user_name,
        description: row.description
      },
      content_list: items.map(buildSaleOrderItem)
    });
  };

  // S6 编辑销售/退货单
  handlers['POST /material_apply/supplier/sales/order/edit/'] = (req) => {
    const b = req.body || {};
    const orderId = Number(b.order_id || 0);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!orderId || !items.length) return errParam();
    const row = db.prepare('SELECT order_id FROM supplier_sales_orders WHERE order_id = ? AND deleted = 0').get(orderId);
    if (!row) return { code: 13001, msg: '订单不存在', data: {} };
    let total = 0;
    const rows = items.map((it) => {
      const num = Number(it.num || 0);
      const price = Number(it.market_price || 0);
      total += num * price;
      return { commodity_id: Number(it.commodity_id || 0), material_nick_name: String(it.material_nick_name || ''), market_price: price, num };
    });
    db.prepare(`UPDATE supplier_sales_orders SET project_name = ?, consignee_name = ?, consignee_phone = ?, description = ?, total_amount = ? WHERE order_id = ?`)
      .run(String(b.project_name || ''), String(b.consignee_name || ''), String(b.consignee_phone || ''), String(b.description || ''), total, orderId);
    db.prepare('DELETE FROM supplier_sales_order_items WHERE order_id = ?').run(orderId);
    const insItem = db.prepare('INSERT INTO supplier_sales_order_items (order_id, commodity_id, material_nick_name, market_price, num, market_price_subtotal) VALUES (?,?,?,?,?,?)');
    for (const r of rows) insItem.run(orderId, r.commodity_id, r.material_nick_name, r.market_price, r.num, r.market_price * r.num);
    return ok({});
  };

  // S7 状态更新（出/入库弹窗关闭后刷新）
  handlers['POST /material_apply/supplier/sales/order/status/update/'] = (req) => {
    const b = req.body || {};
    const orderId = Number(b.order_id || 0);
    if (!orderId) return errParam();
    const row = db.prepare('SELECT * FROM supplier_sales_orders WHERE order_id = ? AND deleted = 0').get(orderId);
    if (!row) return { code: 13001, msg: '订单不存在', data: {} };
    // 简单状态推进：待审批→待商家确认→配送中→待签收→已完成（不超过已完成）
    const next = Math.min(Number(row.status || 0) + 1, 4);
    db.prepare('UPDATE supplier_sales_orders SET status = ? WHERE order_id = ?').run(next, orderId);
    return ok({ status: next });
  };

  // S8 全部项目（下拉；projects 表无 crm_id 列，从 list_json 提取）
  handlers['POST /material_apply/supplier/sales/order/all_project/'] = (req) => {
    const rows = db.prepare('SELECT project_id, project_name, list_json FROM projects WHERE deleted = 0 ORDER BY project_id DESC LIMIT 200').all();
    return ok({
      contents: rows.map((r) => {
        const lj = parseJson(r.list_json, {});
        return { project_name: r.project_name, crm_id: Number(lj.crm_id || 0) };
      })
    });
  };

  // 选材字典共用：从 commodity_commodities（公司级商品库快照）筛 DISTINCT 值
  // 商品库不分客户，crm_id 参数忽略（前端仅作上下文传递）
  const commodityFilter = (b) => {
    const typeId = Number(b.commodity_type_id || 0);
    const where = ['1=1'];
    const params = [];
    if (typeId) { where.push('commodity_type_id = ?'); params.push(typeId); }
    if (Array.isArray(b.band_name_list) && b.band_name_list.length) {
      where.push('band IN (' + b.band_name_list.map(() => '?').join(',') + ')'); params.push(...b.band_name_list);
    }
    if (Array.isArray(b.model_list) && b.model_list.length) {
      where.push('model IN (' + b.model_list.map(() => '?').join(',') + ')'); params.push(...b.model_list);
    }
    if (Array.isArray(b.specification_list) && b.specification_list.length) {
      where.push('specification IN (' + b.specification_list.map(() => '?').join(',') + ')'); params.push(...b.specification_list);
    }
    return { where: where.join(' AND '), params };
  };

  // S9 全部品牌
  handlers['POST /material_apply/supplier/sales/order/all_band_name/'] = (req) => {
    const b = req.body || {};
    const { where, params } = commodityFilter(b);
    const rows = db.prepare('SELECT DISTINCT band AS v FROM commodity_commodities WHERE ' + where + ' AND band != \'\' ORDER BY band').all(...params);
    return ok({ contents: rows.map((r) => r.v) });
  };

  // S10 全部型号
  handlers['POST /material_apply/supplier/sales/order/all_model/'] = (req) => {
    const b = req.body || {};
    const { where, params } = commodityFilter(b);
    const rows = db.prepare('SELECT DISTINCT model AS v FROM commodity_commodities WHERE ' + where + ' AND model != \'\' ORDER BY model').all(...params);
    return ok({ contents: rows.map((r) => r.v) });
  };

  // S11 全部规格
  handlers['POST /material_apply/supplier/sales/order/all_specification/'] = (req) => {
    const b = req.body || {};
    const { where, params } = commodityFilter(b);
    const rows = db.prepare('SELECT DISTINCT specification AS v FROM commodity_commodities WHERE ' + where + ' AND specification != \'\' ORDER BY specification').all(...params);
    return ok({ contents: rows.map((r) => r.v) });
  };

  // S12 内容分类（退货选材：内容分组 → 类型列表）
  handlers['POST /material_apply/supplier/sales/order/content/list/'] = (req) => {
    const b = req.body || {};
    const contentType = Number(b.commodity_content_type || 0);
    const rows = db.prepare('SELECT DISTINCT commodity_content_id, commodity_content_name FROM commodity_commodities ORDER BY commodity_content_id').all();
    const groups = rows
      .filter((r) => !contentType || Number(r.commodity_content_id) === contentType)
      .map((r) => {
        const types = db.prepare('SELECT DISTINCT commodity_type_id AS id, commodity_type_name AS name FROM commodity_commodities WHERE commodity_content_id = ? ORDER BY commodity_type_id')
          .all(r.commodity_content_id);
        return { commodity_content_id: Number(r.commodity_content_id), commodity_content_name: r.commodity_content_name, commodity_types: types };
      });
    return ok({ contents: groups });
  };

  // S13 商品列表（选材）
  handlers['POST /material_apply/supplier/sales/order/commodity/list/'] = (req) => {
    const b = req.body || {};
    const { where, params } = commodityFilter(b);
    const kw = String(b.search_key || '').trim();
    const conds = [where];
    const p = params.slice();
    if (kw) { conds.push('(name LIKE ? OR band LIKE ? OR model LIKE ?)'); p.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%'); }
    const rows = db.prepare('SELECT * FROM commodity_commodities WHERE ' + conds.join(' AND ') + ' ORDER BY id DESC LIMIT 200').all(...p);
    return ok({
      materials: rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        image: r.image,
        band_name: r.band,
        model: r.model,
        specification: r.specification,
        unit_name: r.unit,
        sale_price: r.sale_price
      }))
    });
  };

  // S14 订单库存（出/入库弹窗）
  handlers['POST /material_apply/supplier/sales/order/warehouse/'] = (req) => {
    const b = req.body || {};
    const orderId = Number(b.order_id || 0);
    if (!orderId) return errParam();
    const row = db.prepare('SELECT order_id FROM supplier_sales_orders WHERE order_id = ? AND deleted = 0').get(orderId);
    if (!row) return { code: 13001, msg: '订单不存在', data: {} };
    const items = db.prepare('SELECT * FROM supplier_sales_order_items WHERE order_id = ?').all(orderId);
    return ok({
      contents: items.map((i) => {
        const stocks = db.prepare('SELECT * FROM commodity_stock WHERE commodity_id = ? ORDER BY id').all(i.commodity_id);
        return {
          material_name: i.name || i.material_nick_name,
          num: i.num,
          unit_name: i.unit_name,
          band_name: i.band_name,
          model: i.model,
          specification: i.specification,
          commodity_type_name: '',
          stock_list: stocks.map((s) => ({
            batch_no: s.batch_no || '',
            warehouse_goods_location: (s.warehouse_name || '') + (s.goods_location_name ? '/' + s.goods_location_name : ''),
            unit_name: s.unit || '',
            stock_num: s.stock_num,
            out_num: 0,
            description: ''
          }))
        };
      })
    });
  };

  // S15 订单详情导出（blob xlsx）
  handlers['POST /material_apply/supplier/sales/order/detail/export/excel/'] = async (req) => {
    const b = req.body || {};
    const orderId = Number(b.order_id || 0);
    if (!orderId) return errParam();
    const row = db.prepare('SELECT * FROM supplier_sales_orders WHERE order_id = ? AND deleted = 0').get(orderId);
    if (!row) return { code: 13001, msg: '订单不存在', data: {} };
    const items = db.prepare('SELECT * FROM supplier_sales_order_items WHERE order_id = ?').all(orderId);
    const wb = new ExcelJS.Workbook();
    const infoWs = wb.addWorksheet('订单信息');
    infoWs.columns = [{ header: '字段', width: 14 }, { header: '内容', width: 40 }];
    const kv = [
      ['订单号', row.order_sn], ['类型', Number(row.order_type) === 12 ? '退货单' : '销售单'],
      ['项目', row.project_name], ['收货人', row.consignee_name], ['联系电话', row.consignee_phone],
      ['创建人', row.create_user_name], ['创建时间', row.create_time], ['状态', orderStatusName(row.status)],
      ['备注', row.description], ['总金额', row.total_amount]
    ];
    kv.forEach(([k, v]) => infoWs.addRow([k, v === undefined || v === null ? '' : v]));
    const ws = wb.addWorksheet('订单明细');
    ws.columns = ['材料名称', '品牌', '型号', '规格', '单位', '数量', '单价', '小计'].map((h) => ({ header: h, width: 16 }));
    for (const i of items) {
      ws.addRow([i.name || i.material_nick_name, i.band_name, i.model, i.specification, i.unit_name, i.num, i.market_price, i.market_price_subtotal]);
    }
    const buf = await wb.xlsx.writeBuffer();
    return { __binary: true, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: '订单详情.xlsx', buffer: buf };
  };

  // ==================== 四、material_apply 材料申请单（S16~S25） ====================

  const findApply = (id) => db.prepare('SELECT * FROM material_apply_orders WHERE material_apply_id = ? AND deleted = 0').get(id);
  const buildApplyItem = (r) => ({
    order_id: Number(r.material_apply_id),
    order_sn: r.order_sn,
    order_type: r.order_type,
    project_name: r.project_name,
    supplier_name: r.supplier_name,
    total_amount: r.total_amount,
    status: r.status,
    status_name: orderStatusName(r.status),
    apply_type: r.apply_type,
    create_time: r.create_time,
    description: r.description
  });

  // S16 材料订单列表（v3）
  handlers['POST /material_apply/v3/supplier/order/list/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0'];
    const params = [];
    if (b.status !== undefined && b.status !== '' && b.status !== null) { where.push('status = ?'); params.push(Number(b.status)); }
    if (b.project_id) { where.push('project_id = ?'); params.push(Number(b.project_id)); }
    if (b.apply_type !== undefined && b.apply_type !== '' && b.apply_type !== null) { where.push('apply_type = ?'); params.push(Number(b.apply_type)); }
    if (b.supplier_id) { where.push('supplier_id = ?'); params.push(Number(b.supplier_id)); }
    if (b.decorator_id) { where.push('decorator_id = ?'); params.push(Number(b.decorator_id)); }
    if (b.start_date) { where.push('create_time >= ?'); params.push(String(b.start_date)); }
    if (b.end_date) { where.push('create_time <= ?'); params.push(String(b.end_date) + ' 23:59:59'); }
    const whereSql = where.join(' AND ');
    const all = db.prepare('SELECT * FROM material_apply_orders WHERE ' + whereSql + ' ORDER BY material_apply_id DESC').all(...params);
    const totalAmount = all.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const page = all.slice((page_index - 1) * page_size, page_index * page_size);
    return ok({
      orders: page.map(buildApplyItem),
      order_num: all.length,
      order_ids: all.map((r) => Number(r.material_apply_id)),
      total_order_amount: totalAmount,
      all_projects: db.prepare('SELECT project_id, project_name FROM projects WHERE deleted = 0 ORDER BY project_id DESC LIMIT 200').all().map((r) => ({ id: r.project_id, name: r.project_name })),
      all_suppliers: db.prepare('SELECT id, name FROM company_suppliers ORDER BY id').all().map((r) => ({ id: r.id, name: r.name })),
      all_appliers: db.prepare('SELECT id, name FROM company_members ORDER BY id').all().map((r) => ({ id: r.id, name: r.name })),
      all_decorators: db.prepare('SELECT id, name FROM company_members ORDER BY id').all().map((r) => ({ id: r.id, name: r.name })),
      bottom_button: true,
      show_button: true
    });
  };

  // S17 材料订单导出（blob xlsx）
  handlers['POST /material_apply/v3/supplier/order/export/'] = async (req) => {
    const b = req.body || {};
    const ids = Array.isArray(b.order_ids) ? b.order_ids.map(Number).filter((x) => x > 0) : [];
    if (!ids.length) return errParam();
    const rows = db.prepare('SELECT * FROM material_apply_orders WHERE material_apply_id IN (' + ids.map(() => '?').join(',') + ') AND deleted = 0 ORDER BY material_apply_id DESC').all(...ids);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('材料订单');
    ws.columns = ['订单号', '类型', '项目', '供应商', '金额', '状态', '创建时间', '备注'].map((h) => ({ header: h, width: 16 }));
    for (const r of rows) {
      ws.addRow([r.order_sn, r.order_type, r.project_name, r.supplier_name, r.total_amount, orderStatusName(r.status), r.create_time, r.description]);
    }
    const buf = await wb.xlsx.writeBuffer();
    return { __binary: true, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: '材料订单.xlsx', buffer: buf };
  };

  // S18 派单
  handlers['POST /material_apply/v2/order/supplier/assign/'] = (req) => {
    const b = req.body || {};
    const orderId = Number(b.order_id || 0);
    const senderId = Number(b.sender_id || 0);
    if (!orderId || !senderId) return errParam();
    const row = findApply(orderId);
    if (!row) return { code: 13001, msg: '订单不存在', data: {} };
    db.prepare('UPDATE material_apply_orders SET sender_id = ?, sender_name = ?, status = 1 WHERE material_apply_id = ?')
      .run(senderId, companyMemberName(senderId) || userName(senderId), orderId);
    return ok({});
  };

  // 换取货人共用
  const changePick = (id, newPickId) => {
    if (!id || !newPickId) return errParam();
    const row = findApply(id);
    if (!row) return { code: 13001, msg: '订单不存在', data: {} };
    db.prepare('UPDATE material_apply_orders SET pick_user_id = ?, pick_user_name = ? WHERE material_apply_id = ?')
      .run(newPickId, companyMemberName(newPickId) || userName(newPickId), id);
    return ok({});
  };

  // S19 退料单换取货人
  handlers['POST /material_apply/refund/order/supplier/change/pick/'] = (req) => {
    const b = req.body || {};
    return changePick(Number(b.refund_order_id || 0), Number(b.new_pick_user_id || 0));
  };

  // S20 快退单换取货人
  handlers['POST /material_apply/fast/refund/supplier/picker/change/'] = (req) => {
    const b = req.body || {};
    return changePick(Number(b.fast_refund_apply_id || 0), Number(b.new_pick_user_id || 0));
  };

  // S21 快单货单确认（供应商）
  handlers['POST /material_apply/fast/supplier/confirm/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.material_apply_id || 0);
    if (!id) return errParam();
    const row = findApply(id);
    if (!row) return { code: 13001, msg: '申请单不存在', data: {} };
    db.prepare('UPDATE material_apply_orders SET total_amount = ?, files = ?, description = ?, status = 2 WHERE material_apply_id = ?')
      .run(Number(b.total_amount || 0), JSON.stringify(Array.isArray(b.files) ? b.files : []), String(b.description || ''), id);
    return ok({});
  };

  // S22 快单驳回
  handlers['POST /material_apply/fast/supplier/reject/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.material_apply_id || 0);
    if (!id) return errParam();
    const row = findApply(id);
    if (!row) return { code: 13001, msg: '申请单不存在', data: {} };
    db.prepare('UPDATE material_apply_orders SET reject_reason = ?, status = 12 WHERE material_apply_id = ?')
      .run(String(b.reject_reason || ''), id);
    return ok({});
  };

  // S23 退料单审核（result 1=通过 0=驳回）
  handlers['POST /material_apply/company/refund/order/review/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.refund_order_id || 0);
    if (!id) return errParam();
    const row = findApply(id);
    if (!row) return { code: 13001, msg: '订单不存在', data: {} };
    const result = Number(b.result);
    const status = result === 0 ? 7 : 8;
    db.prepare('UPDATE material_apply_orders SET status = ?, description = ?, files = ? WHERE material_apply_id = ?')
      .run(status, String(b.description || ''), JSON.stringify(Array.isArray(b.files) ? b.files : []), id);
    return ok({});
  };

  // S24 快单签收
  handlers['POST /material_apply/fast/supplier/sign/apply/'] = (req) => {
    const b = req.body || {};
    const id = Number(b.material_apply_id || 0);
    if (!id) return errParam();
    const row = findApply(id);
    if (!row) return { code: 13001, msg: '申请单不存在', data: {} };
    db.prepare('UPDATE material_apply_orders SET files = ?, description = ?, status = 4 WHERE material_apply_id = ?')
      .run(JSON.stringify(Array.isArray(b.files) ? b.files : []), String(b.description || ''), id);
    return ok({});
  };

  // S25 供应商列表（Web 端未调用；本地从公司供应商快照返回基础列表）
  handlers['POST /supplier/list/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    const kw = String(b.keyword || b.search_key || '').trim();
    const where = ['1=1'];
    const params = [];
    if (kw) { where.push('name LIKE ?'); params.push('%' + kw + '%'); }
    const rows = db.prepare('SELECT * FROM company_suppliers WHERE ' + where.join(' AND ') + ' ORDER BY id LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ suppliers: rows.map((r) => ({ id: r.id, name: r.name, type: r.type, status: r.status, contact: r.contact, phone: r.phone, cooperation: r.cooperation })) });
  };

  return handlers;
}

module.exports = { createMaterialApi };
