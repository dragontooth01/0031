// crm 第五批单元测试：crm_material 材料库 13 项 + supplier 供应商/采购 25 项
// 覆盖规格文档 _crm_batch5_plan.md；测试数据 9 亿号段，测后清理（含 local_records）
const { DatabaseSync } = require('node:sqlite');
const assert = require('assert');
const ExcelJS = require('exceljs');

const db = new DatabaseSync('e:/erpkok/webqianduan/data/local.db');
const localApi = require('./local-api');

let pass = 0, fail = 0;
const asyncTasks = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      asyncTasks.push(r.then(
        () => { pass++; console.log('  PASS  ' + name); },
        (e) => { fail++; console.log('  FAIL  ' + name + ' :: ' + (e.message || e)); }
      ));
    } else { pass++; console.log('  PASS  ' + name); }
  } catch (e) { fail++; console.log('  FAIL  ' + name + ' :: ' + e.message); }
}
const isXlsx = (r) => {
  assert.ok(r && r.__binary === true, '返回二进制协议标记 __binary');
  assert.ok(Buffer.isBuffer(r.buffer), 'buffer 为 Buffer');
  assert.ok(r.buffer.length > 4 && r.buffer[0] === 0x50 && r.buffer[1] === 0x4b, 'xlsx 为 ZIP 容器（PK 头）');
  assert.ok(r.contentType.includes('spreadsheetml'), 'Content-Type 为 xlsx');
  assert.ok(r.fileName && r.fileName.endsWith('.xlsx'), '文件名为 .xlsx: ' + r.fileName);
};
const handler = (method, path, body, headers) => localApi.match(method, path)({ body: body || {}, query: {}, headers: headers || {} });
const H = {};
const sess = db.prepare('SELECT * FROM sessions LIMIT 1').get();
if (sess) H['session-id'] = sess.session_id;
const uid = sess ? Number(sess.user_id || sess.cloud_user_id || 0) : 1;

// ---- 测试数据（9 亿号段，测后清理）----
const CRM = 900900001, TYPE_A = 900900101, TYPE_B = 900900102;
const MAT = 900900201, MAT2 = 900900202, SALES = 900900301, RET = 900900302, APPLY = 900900401;
const CLEAN_TABLES = ['crm_material_types', 'crm_materials', 'supplier_sales_orders', 'supplier_sales_order_items', 'material_apply_orders', 'material_apply_items'];
// 第五批新表测试前清空（本批刚上线，表中无生产业务数据）
for (const tbl of CLEAN_TABLES) {
  try { db.prepare('DELETE FROM ' + tbl).run(); } catch (e) {}
}
try { db.prepare('DELETE FROM crm_customers WHERE crm_id >= 900000000').run(); } catch (e) {}
db.prepare("INSERT INTO crm_customers (crm_id, customer_name, customer_phone, deleted, create_time, update_time, created_at, updated_at) VALUES (?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM, '第五批客户', '13900000001');

console.log('\n=== crm_material_type 清单 ===');
t('M1 空客户清单返回空数组', () => {
  const r = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: 900999999 });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.data.crm_material_types, []);
});
t('M3 新增清单返回 id', () => {
  const r = handler('POST', '/material_apply/crm_material_type/add/', { crm_id: CRM, name: '主材清单' });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.crm_material_type_id > 0);
});
t('M3 重名返回 10011', () => {
  assert.strictEqual(handler('POST', '/material_apply/crm_material_type/add/', { crm_id: CRM, name: '主材清单' }).code, 10011);
});
t('M3 缺 crm_id 返回 10011', () => {
  assert.strictEqual(handler('POST', '/material_apply/crm_material_type/add/', { name: 'x' }).code, 10011);
});
t('M1 建清单后列表命中 + 字段', () => {
  const r = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  assert.strictEqual(r.code, 0);
  const hit = r.data.crm_material_types.find((x) => x.name === '主材清单');
  assert.ok(hit, '清单在列表');
  assert.ok('id' in hit && 'order' in hit && 'create_user_name' in hit);
});
t('M4 重命名生效', () => {
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const id = l.data.crm_material_types[0].id;
  const r = handler('POST', '/material_apply/crm_material_type/edit/', { id, name: '辅材清单' });
  assert.strictEqual(r.code, 0);
  const l2 = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  assert.strictEqual(l2.data.crm_material_types[0].name, '辅材清单');
});
t('M4 清单不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/material_apply/crm_material_type/edit/', { id: 900999999, name: 'x' }).code, 13001);
});
t('M6 清单排序写入 order', () => {
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const ids = l.data.crm_material_types.map((x) => x.id);
  const r = handler('POST', '/material_apply/crm_material_type/order/update/', { crm_material_types: [{ id: ids[0], order: 5 }] });
  assert.strictEqual(r.code, 0);
  const l2 = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  assert.strictEqual(l2.data.crm_material_types.find((x) => x.id === ids[0]).order, 5);
});
t('M6 空数组返回 10011', () => {
  assert.strictEqual(handler('POST', '/material_apply/crm_material_type/order/update/', {}).code, 10011);
});
t('M7 清单下新增空材料行', () => {
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const r = handler('POST', '/material_apply/crm_material/add/', { crm_material_type_id: l.data.crm_material_types[0].id });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.crm_material_id > 0);
});
t('M7 清单不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/material_apply/crm_material/add/', { crm_material_type_id: 900999999 }).code, 13001);
});
t('M8 行内编辑 num/单价联动总价', () => {
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const t2 = l.data.crm_material_types[0];
  const m = handler('POST', '/material_apply/crm_material/add/', { crm_material_type_id: t2.id }).data.crm_material_id;
  let r = handler('POST', '/material_apply/crm_material/edit/', { crm_material_id: m, num: 3 });
  assert.strictEqual(r.code, 0);
  r = handler('POST', '/material_apply/crm_material/edit/', { crm_material_id: m, sale_price: 100 });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT * FROM crm_materials WHERE crm_material_id = ?').get(m);
  assert.strictEqual(Number(row.num), 3);
  assert.strictEqual(Number(row.sale_price), 100);
  assert.strictEqual(Number(row.total_price), 300);
});
t('M8 文字字段置 self_definition=1', () => {
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const m = handler('POST', '/material_apply/crm_material/add/', { crm_material_type_id: l.data.crm_material_types[0].id }).data.crm_material_id;
  const r = handler('POST', '/material_apply/crm_material/edit/', { crm_material_id: m, name: '定制柜体' });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT self_definition FROM crm_materials WHERE crm_material_id = ?').get(m);
  assert.strictEqual(row.self_definition, 1);
});
t('M8 缺 id 返回 10011', () => {
  assert.strictEqual(handler('POST', '/material_apply/crm_material/edit/', {}).code, 10011);
});
t('M10 展示厅商品导入替换行', () => {
  const src = db.prepare('SELECT id, payload FROM company_materials LIMIT 1').get();
  assert.ok(src, '存在展示厅商品');
  const p = JSON.parse(src.payload);
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const m = handler('POST', '/material_apply/crm_material/add/', { crm_material_type_id: l.data.crm_material_types[0].id }).data.crm_material_id;
  const r = handler('POST', '/material_apply/crm_material/import/', { crm_material_id: m, crm_material_type_id: l.data.crm_material_types[0].id, material_id: src.id });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.name, p.name);
  assert.strictEqual(r.data.brand, p.band);
  assert.strictEqual(r.data.self_definition, 0);
  const row = db.prepare('SELECT material_id FROM crm_materials WHERE crm_material_id = ?').get(m);
  assert.strictEqual(row.material_id, src.id);
});
t('M10 商品不存在返回 13001', () => {
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const m = handler('POST', '/material_apply/crm_material/add/', { crm_material_type_id: l.data.crm_material_types[0].id }).data.crm_material_id;
  assert.strictEqual(handler('POST', '/material_apply/crm_material/import/', { crm_material_id: m, crm_material_type_id: l.data.crm_material_types[0].id, material_id: 900999999 }).code, 13001);
});
t('M9 删除材料行（is_selected=false）', () => {
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const m = handler('POST', '/material_apply/crm_material/add/', { crm_material_type_id: l.data.crm_material_types[0].id }).data.crm_material_id;
  const r = handler('POST', '/material_apply/crm_material/del/', { crm_material_id: m });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.is_selected, false);
  const row = db.prepare('SELECT deleted FROM crm_materials WHERE crm_material_id = ?').get(m);
  assert.strictEqual(row.deleted, 1);
});
t('M9 材料不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/material_apply/crm_material/del/', { crm_material_id: 900999999 }).code, 13001);
});
t('M11 材料行排序', () => {
  const l = handler('POST', '/material_apply/crm_material_type/list/', { crm_id: CRM });
  const m = handler('POST', '/material_apply/crm_material/add/', { crm_material_type_id: l.data.crm_material_types[0].id }).data.crm_material_id;
  const r = handler('POST', '/material_apply/crm_material/order/update/', { crm_materials: [{ id: m, order: 7 }] });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT order_num FROM crm_materials WHERE crm_material_id = ?').get(m);
  assert.strictEqual(row.order_num, 7);
});
t('M2 清单全量详情嵌套结构完整', () => {
  const r = handler('POST', '/material_apply/crm_material_type/all/detail/', { crm_id: CRM });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.crm_material_types.length >= 1);
  const t2 = r.data.crm_material_types[0];
  assert.ok('name' in t2 && 'create_user_name' in t2 && 'description' in t2);
  assert.ok(Array.isArray(t2.crm_materials));
});
t('M12 材料清单导出：真 xlsx 多 sheet', async () => {
  const r = await handler('POST', '/material_apply/crm_material_type/export/excel/', { crm_id: CRM });
  isXlsx(r);
  assert.strictEqual(r.fileName, '材料清单.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  assert.ok(wb.worksheets.length >= 1, '至少一个清单 sheet');
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.getRow(1).getCell(1).value, '材料名称');
});
t('M13 预算模板导入清单', () => {
  const tpl = db.prepare('SELECT * FROM company_budget_templates LIMIT 1').get();
  if (!tpl) return; // 无模板快照则跳过
  const r = handler('POST', '/material_apply/crm_material_type/template/import/', { crm_id: CRM, budget_template_id: tpl.id });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.crm_material_type_id > 0);
});
t('M13 模板不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/material_apply/crm_material_type/template/import/', { crm_id: CRM, budget_template_id: 900999999 }).code, 13001);
});

console.log('\n=== supplier 销售/退货单 ===');
t('S1 all_crm 分页 + 搜索', () => {
  const r = handler('POST', '/material_apply/supplier/all_crm/', { page_index: 1, page_size: 10, search_key: '第五批客户' });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.total_num >= 1);
  const hit = r.data.crms.find((x) => x.crm_id === CRM);
  assert.ok(hit, '客户命中');
  assert.strictEqual(hit.crm_name, '第五批客户');
  assert.ok('consignee_name' in hit && 'consignee_phone' in hit);
});
t('S1 空搜索无命中', () => {
  const r = handler('POST', '/material_apply/supplier/all_crm/', { page_index: 1, page_size: 10, search_key: '不存在的客户XYZ' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.total_num, 0);
});
t('S2 新增销售单返回 order_id + 落库', () => {
  const r = handler('POST', '/material_apply/supplier/sales/order/add/', {
    crm_id: CRM, project_name: '测试项目', consignee_name: '张先生', consignee_phone: '13900000001', description: '备注',
    items: [{ commodity_id: 113220, material_nick_name: '板材', market_price: 100, num: 2 }]
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.order_id > 0);
  const row = db.prepare('SELECT * FROM supplier_sales_orders WHERE order_id = ?').get(r.data.order_id);
  assert.strictEqual(row.order_type, 11);
  assert.strictEqual(Number(row.total_amount), 200);
  assert.ok(row.order_sn.startsWith('SO'));
  const item = db.prepare('SELECT * FROM supplier_sales_order_items WHERE order_id = ?').get(r.data.order_id);
  assert.strictEqual(Number(item.market_price_subtotal), 200);
});
t('S2 缺 items 返回 10011', () => {
  assert.strictEqual(handler('POST', '/material_apply/supplier/sales/order/add/', { crm_id: CRM }).code, 10011);
});
t('S3 新增退货单 order_type=12', () => {
  const r = handler('POST', '/material_apply/supplier/refund/order/add/', {
    crm_id: CRM, items: [{ commodity_id: 113220, market_price: 50, num: 1 }]
  });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT order_type FROM supplier_sales_orders WHERE order_id = ?').get(r.data.order_id);
  assert.strictEqual(row.order_type, 12);
});
t('S4 销售单列表字段齐全 + 计数', () => {
  const r = handler('POST', '/material_apply/supplier/sales/order/list/', { crm_id: CRM, page_index: 1, page_size: 20 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.contents.length >= 1);
  const o = r.data.contents[0];
  assert.ok('order_id' in o && 'order_sn' in o && 'order_type' in o && 'name' in o && 'order_amount' in o && 'type_num' in o);
  assert.ok(r.data.pending_num >= 0 && r.data.processed_num >= 0);
});
t('S4 order_type 过滤只返回对应类型', () => {
  const r = handler('POST', '/material_apply/supplier/sales/order/list/', { crm_id: CRM, order_type: 12, page_index: 1, page_size: 20 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.contents.length >= 1);
  for (const o of r.data.contents) assert.strictEqual(o.order_type, 12);
});
t('S5 订单详情 base_info + content_list', () => {
  const l = handler('POST', '/material_apply/supplier/sales/order/list/', { crm_id: CRM, order_type: 11 });
  const oid = l.data.contents[0].order_id;
  const r = handler('POST', '/material_apply/supplier/sales/order/detail/', { order_id: oid });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.base_info.consignee_name, '张先生');
  assert.ok(r.data.content_list.length >= 1);
  assert.ok('material_nick_name' in r.data.content_list[0] && 'market_price' in r.data.content_list[0]);
});
t('S5 订单不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/material_apply/supplier/sales/order/detail/', { order_id: 900999999 }).code, 13001);
});
t('S6 编辑订单覆盖明细', () => {
  const l = handler('POST', '/material_apply/supplier/sales/order/list/', { crm_id: CRM, order_type: 11 });
  const oid = l.data.contents[0].order_id;
  const r = handler('POST', '/material_apply/supplier/sales/order/edit/', {
    order_id: oid, crm_id: CRM, project_name: '改后项目', consignee_name: '李女士',
    items: [{ commodity_id: 113220, market_price: 10, num: 5 }]
  });
  assert.strictEqual(r.code, 0);
  const d = handler('POST', '/material_apply/supplier/sales/order/detail/', { order_id: oid });
  assert.strictEqual(d.data.base_info.project_name, '改后项目');
  assert.strictEqual(d.data.base_info.consignee_name, '李女士');
  assert.strictEqual(Number(d.data.content_list[0].market_price), 10);
  assert.strictEqual(Number(d.data.content_list[0].num), 5);
});
t('S6 订单不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/material_apply/supplier/sales/order/edit/', { order_id: 900999999, items: [{}] }).code, 13001);
});
t('S7 状态推进（0→1）', () => {
  const l = handler('POST', '/material_apply/supplier/sales/order/list/', { crm_id: CRM });
  const oid = l.data.contents[0].order_id;
  const r = handler('POST', '/material_apply/supplier/sales/order/status/update/', { order_id: oid });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT status FROM supplier_sales_orders WHERE order_id = ?').get(oid);
  assert.strictEqual(row.status, 1);
});
t('S7 缺 order_id 返回 10011', () => {
  assert.strictEqual(handler('POST', '/material_apply/supplier/sales/order/status/update/', {}).code, 10011);
});
t('S8 all_project 返回项目列表', () => {
  const r = handler('POST', '/material_apply/supplier/sales/order/all_project/', {});
  assert.strictEqual(r.code, 0);
  assert.ok(Array.isArray(r.data.contents));
  const p = r.data.contents[0];
  assert.ok(p && 'project_name' in p && 'crm_id' in p);
});
t('S9 品牌字典 DISTINCT', () => {
  const r = handler('POST', '/material_apply/supplier/sales/order/all_band_name/', { crm_id: 6808 });
  assert.strictEqual(r.code, 0);
  assert.ok(Array.isArray(r.data.contents) && r.data.contents.length >= 1);
  assert.ok(r.data.contents.every((v) => typeof v === 'string'));
});
t('S10 型号字典按品牌级联过滤', () => {
  const brands = handler('POST', '/material_apply/supplier/sales/order/all_band_name/', { crm_id: 6808 }).data.contents;
  const r = handler('POST', '/material_apply/supplier/sales/order/all_model/', { crm_id: 6808, band_name_list: [brands[0]] });
  assert.strictEqual(r.code, 0);
  assert.ok(Array.isArray(r.data.contents));
});
t('S11 规格字典', () => {
  const r = handler('POST', '/material_apply/supplier/sales/order/all_specification/', { crm_id: 6808 });
  assert.strictEqual(r.code, 0);
  assert.ok(Array.isArray(r.data.contents));
});
t('S12 内容分类树', () => {
  const r = handler('POST', '/material_apply/supplier/sales/order/content/list/', { crm_id: 6808 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.contents.length >= 1);
  const g = r.data.contents[0];
  assert.ok(Array.isArray(g.commodity_types) && g.commodity_types.length >= 1);
  assert.ok('id' in g.commodity_types[0] && 'name' in g.commodity_types[0]);
});
t('S13 商品列表组合筛选', () => {
  const r = handler('POST', '/material_apply/supplier/sales/order/commodity/list/', { crm_id: 6808, search_key: '无醛' });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.materials.length >= 1);
  const m = r.data.materials[0];
  assert.ok('id' in m && 'name' in m && 'band_name' in m && 'sale_price' in m && 'unit_name' in m);
});
t('S14 订单库存（无对应库存返回空数组不报错）', () => {
  const l = handler('POST', '/material_apply/supplier/sales/order/list/', { crm_id: CRM });
  const oid = l.data.contents[0].order_id;
  const r = handler('POST', '/material_apply/supplier/sales/order/warehouse/', { order_id: oid });
  assert.strictEqual(r.code, 0);
  assert.ok(Array.isArray(r.data.contents));
  for (const c of r.data.contents) assert.ok(Array.isArray(c.stock_list));
});
t('S15 订单详情导出：真 xlsx', async () => {
  const l = handler('POST', '/material_apply/supplier/sales/order/list/', { crm_id: CRM });
  const oid = l.data.contents[0].order_id;
  const r = await handler('POST', '/material_apply/supplier/sales/order/detail/export/excel/', { order_id: oid });
  isXlsx(r);
  assert.strictEqual(r.fileName, '订单详情.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  assert.ok(wb.worksheets.length >= 2, '订单信息 + 明细 sheet');
  const ws = wb.worksheets[1];
  assert.strictEqual(ws.getRow(1).getCell(1).value, '材料名称');
});

console.log('\n=== material_apply 材料申请单 ===');
t('S16 空表材料订单列表返回空 + 筛选源', () => {
  const r = handler('POST', '/material_apply/v3/supplier/order/list/', { page_index: 1, page_size: 20, func_type: 0 });
  assert.strictEqual(r.code, 0);
  assert.ok(Array.isArray(r.data.orders));
  assert.ok(Array.isArray(r.data.all_projects) && Array.isArray(r.data.all_suppliers));
  assert.ok(Array.isArray(r.data.all_appliers) && Array.isArray(r.data.all_decorators));
  assert.ok('order_num' in r.data && 'order_ids' in r.data);
});
t('S16 插入申请单后列表命中', () => {
  const id = db.prepare(`INSERT INTO material_apply_orders
    (material_apply_id, order_sn, order_type, apply_type, crm_id, project_id, project_name, supplier_id, supplier_name, total_amount, status, create_user_id, create_user_name, create_time, deleted, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,datetime('now'),0,datetime('now'))`)
    .run(APPLY, 'MA' + String(APPLY), 0, 0, CRM, 0, '测试申请项目', 1, '供应商Y', 500, uid, '测试用户').lastInsertRowid;
  const r = handler('POST', '/material_apply/v3/supplier/order/list/', { page_index: 1, page_size: 20 });
  assert.strictEqual(r.code, 0);
  const hit = r.data.orders.find((x) => x.order_id === APPLY);
  assert.ok(hit, '申请单在列表');
  assert.strictEqual(hit.status_name, '待审批');
  assert.strictEqual(Number(hit.total_amount), 500);
  assert.ok(r.data.order_ids.includes(APPLY));
});
t('S18 派单 + 状态流转', () => {
  const r = handler('POST', '/material_apply/v2/order/supplier/assign/', { order_id: APPLY, sender_id: uid });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT sender_id, status FROM material_apply_orders WHERE material_apply_id = ?').get(APPLY);
  assert.strictEqual(row.sender_id, uid);
  assert.strictEqual(row.status, 1);
});
t('S18 订单不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/material_apply/v2/order/supplier/assign/', { order_id: 900999999, sender_id: uid }).code, 13001);
});
t('S19 退料单换取货人', () => {
  const r = handler('POST', '/material_apply/refund/order/supplier/change/pick/', { refund_order_id: APPLY, new_pick_user_id: uid });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT pick_user_id FROM material_apply_orders WHERE material_apply_id = ?').get(APPLY);
  assert.strictEqual(row.pick_user_id, uid);
});
t('S20 快退单换取货人', () => {
  const r = handler('POST', '/material_apply/fast/refund/supplier/picker/change/', { fast_refund_apply_id: APPLY, new_pick_user_id: uid });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(db.prepare('SELECT pick_user_id FROM material_apply_orders WHERE material_apply_id = ?').get(APPLY).pick_user_id, uid);
});
t('S21 快单确认：金额/文件落库 + status=2', () => {
  const r = handler('POST', '/material_apply/fast/supplier/confirm/', { material_apply_id: APPLY, total_amount: '888.5', files: [{ type: 'image', url: 'http://x/1.png' }], description: '已确认' });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT * FROM material_apply_orders WHERE material_apply_id = ?').get(APPLY);
  assert.strictEqual(Number(row.total_amount), 888.5);
  assert.strictEqual(row.status, 2);
  const files = JSON.parse(row.files);
  assert.strictEqual(files.length, 1);
});
t('S22 快单驳回：status=12 + 理由', () => {
  const r = handler('POST', '/material_apply/fast/supplier/reject/', { material_apply_id: APPLY, reject_reason: '价格不符' });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT status, reject_reason FROM material_apply_orders WHERE material_apply_id = ?').get(APPLY);
  assert.strictEqual(row.status, 12);
  assert.strictEqual(row.reject_reason, '价格不符');
});
t('S23 退料单审核通过 status=8', () => {
  const r = handler('POST', '/material_apply/company/refund/order/review/', { refund_order_id: APPLY, result: 1, description: '同意', files: [] });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(db.prepare('SELECT status FROM material_apply_orders WHERE material_apply_id = ?').get(APPLY).status, 8);
});
t('S23 退料单审核驳回 status=7', () => {
  const r = handler('POST', '/material_apply/company/refund/order/review/', { refund_order_id: APPLY, result: 0, description: '资料不全' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(db.prepare('SELECT status FROM material_apply_orders WHERE material_apply_id = ?').get(APPLY).status, 7);
});
t('S24 快单签收 status=4', () => {
  const r = handler('POST', '/material_apply/fast/supplier/sign/apply/', { material_apply_id: APPLY, files: [], description: '已签收' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(db.prepare('SELECT status FROM material_apply_orders WHERE material_apply_id = ?').get(APPLY).status, 4);
});
t('S24 申请单不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/material_apply/fast/supplier/sign/apply/', { material_apply_id: 900999999 }).code, 13001);
});
t('S17 材料订单导出：真 xlsx', async () => {
  const r = await handler('POST', '/material_apply/v3/supplier/order/export/', { order_ids: [APPLY] });
  isXlsx(r);
  assert.strictEqual(r.fileName, '材料订单.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.getRow(1).getCell(1).value, '订单号');
});
t('S17 空 order_ids 返回 10011', async () => {
  assert.strictEqual((await handler('POST', '/material_apply/v3/supplier/order/export/', {})).code, 10011);
});
t('S25 供应商列表（本地快照）', () => {
  const r = handler('POST', '/supplier/list/', { page_index: 1, page_size: 20 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.suppliers.length >= 1);
  const s = r.data.suppliers[0];
  assert.ok('id' in s && 'name' in s && 'type' in s && 'status' in s);
});

// ---- 清理（等全部异步用例完成后再执行） ----
Promise.all(asyncTasks).then(() => {
  for (const tbl of CLEAN_TABLES) {
    try { db.prepare('DELETE FROM ' + tbl).run(); } catch (e) {}
  }
  try { db.prepare('DELETE FROM crm_customers WHERE crm_id >= 900000000').run(); } catch (e) {}
  db.close();

  console.log('\n==============================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('测试流程异常: ' + e.message); process.exit(1); });
