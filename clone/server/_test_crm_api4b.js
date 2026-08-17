// crm 第四批剩余 23 项单元测试：A5~A11 / B9~B13 / C2/C4/C5 / D8/D10 / G1 / H1~H5
// 覆盖规格文档 _crm_batch4b_plan.md §4 的 24 用例；测试数据 9 亿号段，测后清理（含 local_records）
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
const CRM = 900800001, CRM_B = 900800002, CRM_SIM = 900800003, CRM_NONE = 900800004;
const PUB1 = 900800005, PUB2 = 900800006;
const OWNER = 34806; // 小君
db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_public_customers WHERE public_customer_id >= 900000000").run();
db.prepare("DELETE FROM crm_service_team WHERE crm_id >= 900000000").run();
try { db.prepare("DELETE FROM projects WHERE project_id >= 900000000").run(); } catch (e) {}
db.prepare("DELETE FROM local_records WHERE entity IN ('customer','project','crm_public_customer') AND CAST(record_id AS INTEGER) >= 900000000").run();

// 主客户（A5 需跟进 A类 + C2 转交 + C4 + C5 主设计师 + D10 排除 + H4/H5 导出）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,customer_gender,customer_type_id,customer_type_name,source,source_name,address,room_size,is_aborted,deleted,owner_id,owner_name,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM, '第四批主客户', '13700000001', 1, 25397, 'A类客户', 1068, '网单', '西城区幸福家园小区1号楼', '89', OWNER, '小君');
// B 类客户（A5 类型过滤区分）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,customer_type_id,customer_type_name,is_aborted,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,0,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM_B, '第四批B类客户', '13700000002', 25398, 'B类客户');
// 相似房源客户（D10 命中：address 包含 + room_size 相同）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,address,room_size,is_aborted,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,0,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM_SIM, '相似房源客户', '13700000003', '西城区幸福家园小区2期', '89');
// 无数据客户（A5 空结果 / C2 13001 的对照）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,customer_type_id,customer_type_name,is_aborted,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,0,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM_NONE, '第四批空客户', '13700000004', 25399, 'C类客户');
// 公海线索（B9 导出 / B13 搜索 / G1 网单列表）
db.prepare("INSERT INTO crm_public_customers (public_customer_id,customer_name,customer_phone,source_type_id,address_detail,community_name,room_size,status,owner_id,owner_name,deleted,create_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,0,'',0,datetime('now'),datetime('now'),datetime('now'))")
  .run(PUB1, '测试线索用户', '13700000005', 1, '海淀区搜索关键词小区', '搜索关键词小区', '120');
db.prepare("INSERT INTO crm_public_customers (public_customer_id,customer_name,customer_phone,status,owner_id,owner_name,deleted,create_time,created_at,updated_at) VALUES (?,?,?,1,?,?,0,datetime('now'),datetime('now'),datetime('now'))")
  .run(PUB2, '已分配线索', '13700000006', OWNER, '小君');

console.log('\n=== A5 需跟进客户列表 ===');
t('A5 正常：按 customer_type_id 过滤命中 A 类', () => {
  const r = handler('POST', '/crm/v2/need/follow/list/', { page_index: 1, page_size: 20, customer_type_id: 25397 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.total_num >= 1);
  const hit = r.data.crm_list.find((x) => x.crm_id === CRM);
  assert.ok(hit, 'A类主客户在列表中');
  assert.strictEqual(hit.customer_type_name, 'A类客户');
  assert.ok('owner_name' in hit && 'update_time' in hit);
});
t('A5 空结果：无该类型的 customer_type_id', () => {
  const r = handler('POST', '/crm/v2/need/follow/list/', { page_index: 1, page_size: 20, customer_type_id: 99999 });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.total_num, 0);
});

console.log('\n=== A6/A7/A8/A9 部门与成员 ===');
t('A6 部门维度：contents 平铺含 id/name', () => {
  const r = handler('POST', '/crm/company/crm/all_department/', { company_id: 6808 });
  assert.strictEqual(r.code, 0);
  assert.ok(Array.isArray(r.data.contents) && r.data.contents.length >= 7);
  const d = r.data.contents[0];
  assert.ok(String(d.id).length > 0 && d.name.length > 0);
  assert.ok(Array.isArray(d.child_departments));
});
t('A7 成员维度 + department_ids 过滤', () => {
  const dept = db.prepare("SELECT department_id FROM company_members WHERE department_id != '' GROUP BY department_id LIMIT 1").get();
  assert.ok(dept, '存在部门成员数据');
  const r = handler('POST', '/crm/company/crm/all_user/', { company_id: 6808, department_ids: [dept.department_id] });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.contents.length >= 1);
  for (const u of r.data.contents) assert.ok(u.user_id > 0 && u.user_name.length > 0);
});
t('A8 客户类型字典：含 A 类客户', () => {
  const r = handler('POST', '/crm/company/crm/customer_type/list/', { company_id: 6808 });
  assert.strictEqual(r.code, 0);
  const hit = r.data.customer_type_list.find((x) => x.customer_type_id === 25397);
  assert.ok(hit, 'A类客户在类型字典');
  assert.strictEqual(hit.name, 'A类客户');
  assert.ok('description' in hit);
});
t('A9 角色成员列表：members 字段齐全', () => {
  const r = handler('POST', '/crm/company/crm/role/member/list/', { company_id: 6808, type: 0 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.members.length >= 1);
  const m = r.data.members[0];
  assert.ok('user_id' in m && 'user_name' in m && 'is_leave' in m);
});

console.log('\n=== A10 销售分析 ===');
t('A10 回退云端代理（本地返回 null）', () => {
  const h = localApi.match('GET', '/crm/statistic/');
  assert.ok(h, '本地注册了 handler');
  assert.strictEqual(h({ body: {}, query: {}, headers: {} }), null);
});

console.log('\n=== B9/B10/B11/B12/B13 公海 ===');
t('B9 线索导出：真 xlsx，行数正确', async () => {
  const r = await handler('POST', '/crm/public/customer/export/excel/', { public_customer_ids: [PUB1] });
  isXlsx(r);
  assert.ok(/^公海线索导出_\d{8}\.xlsx$/.test(r.fileName));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.rowCount, 2, '表头 + 1 行数据');
  const dataRow = ws.getRow(2);
  assert.strictEqual(dataRow.getCell(1).value, '测试线索用户');
  assert.strictEqual(dataRow.getCell(3).value, '13700000005');
});
t('B10 线索导入模板：真 xlsx，表头完整', async () => {
  const r = await handler('GET', '/crm/public/customer/download/excel/', {});
  isXlsx(r);
  assert.strictEqual(r.fileName, '线索批量导入模板.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const ws = wb.worksheets[0];
  assert.ok(ws.getRow(1).cellCount >= 5, '模板列数 >= 5');
  assert.strictEqual(ws.getRow(1).getCell(1).value, '线索名称');
});
t('B11 线索上传回退云端代理', () => {
  const h = localApi.match('POST', '/crm/public/customer/upload/excel/');
  assert.ok(h, '本地注册了 handler');
  assert.strictEqual(h({ body: {}, query: {}, headers: {} }), null);
});
t('B12 线索确认回退云端代理', () => {
  const h = localApi.match('POST', '/crm/public/customer/confirm/excel/');
  assert.ok(h, '本地注册了 handler');
  assert.strictEqual(h({ body: {}, query: {}, headers: {} }), null);
});
t('B13 关键词搜索命中', () => {
  const r = handler('POST', '/crm/open_sea/search/', { search_key: '搜索关键词', page_index: 1, page_size: 20 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.total_count >= 1);
  const hit = r.data.public_customers.find((x) => x.public_customer_id === PUB1);
  assert.ok(hit, '关键词命中线索');
  assert.ok('customer_name' in hit && 'customer_phone' in hit && 'address_detail' in hit);
});
t('B13 无命中：total_count=0', () => {
  const r = handler('POST', '/crm/open_sea/search/', { search_key: '不存在的关键词XYZ', page_index: 1, page_size: 20 });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.total_count, 0);
});

console.log('\n=== C2/C4/C5 转交 ===');
t('C2 单条转交：owner 更新', () => {
  const r = handler('POST', '/crm/reassign_owner/', { crm_id: CRM_NONE, owner_id: OWNER });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.owner_id, OWNER);
  const row = db.prepare('SELECT owner_id, owner_name FROM crm_customers WHERE crm_id = ?').get(CRM_NONE);
  assert.strictEqual(row.owner_id, OWNER);
  assert.strictEqual(row.owner_name, '小君');
});
t('C2 客户不存在返回 13001', () => {
  assert.strictEqual(handler('POST', '/crm/reassign_owner/', { crm_id: 900799999, owner_id: OWNER }).code, 13001);
});
t('C4 转交确认列表：crm_list 与 crm_ids 一致', () => {
  const r = handler('POST', '/crm/reassign/owner/list/', { page_index: 1, page_size: 20, crm_ids: [CRM, CRM_B] });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.total_num, 2);
  assert.deepStrictEqual(r.data.crm_list.map((x) => x.crm_id).sort(), [CRM, CRM_B].sort());
});
t('C5 转主设计师：客户 + 服务团队主设计师同步', () => {
  const r = handler('POST', '/crm/reassign_main_designer/', { crm_id: CRM, main_designer_id: OWNER });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.main_designer_id, OWNER);
  const row = db.prepare('SELECT designer_id, designer_name FROM crm_customers WHERE crm_id = ?').get(CRM);
  assert.strictEqual(row.designer_id, OWNER);
  const st = db.prepare('SELECT user_id, team_role FROM crm_service_team WHERE crm_id = ? AND team_role = 1 AND deleted = 0').get(CRM);
  assert.ok(st, '服务团队存在主设计师记录');
  assert.strictEqual(st.user_id, OWNER);
});
t('C5 缺参返回 10011', () => {
  assert.strictEqual(handler('POST', '/crm/reassign_main_designer/', {}).code, 10011);
});

console.log('\n=== D8/D10 ===');
t('D8 新增客户初始数据：code 0 字段齐全（空值）', () => {
  const r = handler('POST', '/crm/add_info/get/', {});
  assert.strictEqual(r.code, 0);
  for (const k of ['province_code', 'province_name', 'city_code', 'city_name', 'area_code', 'area_name']) {
    assert.ok(k in r.data, k + ' 字段存在');
  }
});
t('D10 相似房源：address 包含 + room_size 相同命中', () => {
  const r = handler('POST', '/crm/house/similar/check/', { room_info: { address: '幸福家园', room_size: '89' }, crm_id: CRM, page_index: 1, page_size: 20 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.total_num >= 1);
  const hit = r.data.crm_list.find((x) => x.crm_id === CRM_SIM);
  assert.ok(hit, '相似房源客户命中');
  const self = r.data.crm_list.find((x) => x.crm_id === CRM);
  assert.ok(!self, '排除本客户');
});

console.log('\n=== G1 网单客户列表 ===');
t('G1 网单列表：status 过滤 + 字段', () => {
  const r = handler('POST', '/crm/internet_customer/list/', { page_index: 1, page_size: 20, status: 0 });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.total_num >= 1);
  const hit = r.data.crm_list.find((x) => x.crm_id === PUB1);
  assert.ok(hit, '待分配线索在网单列表');
  assert.strictEqual(hit.status, 0);
  assert.ok('customer_name' in hit && 'customer_phone' in hit && 'room_size' in hit);
  const assigned = r.data.crm_list.find((x) => x.crm_id === PUB2);
  assert.ok(!assigned, '已分配线索被 status 过滤');
});

console.log('\n=== H1/H4/H5 Excel ===');
t('H1 客户导入模板：真 xlsx，表头完整', async () => {
  const r = await handler('GET', '/crm/download/excel/', {});
  isXlsx(r);
  assert.strictEqual(r.fileName, '客户模板.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const ws = wb.worksheets[0];
  assert.ok(ws.getRow(1).cellCount >= 10, '模板列数 >= 10');
  assert.strictEqual(ws.getRow(1).getCell(1).value, '客户名称');
});
t('H4 客户数据导出（GET）：真 xlsx', async () => {
  const r = await handler('GET', '/crm/customer/data/', {});
  isXlsx(r);
  assert.ok(/^客户数据_\d{8}\.xlsx$/.test(r.fileName));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const ws = wb.worksheets[0];
  assert.ok(ws.rowCount >= 2, '表头 + 数据行');
  const names = [];
  for (let i = 2; i <= ws.rowCount; i++) names.push(ws.getRow(i).getCell(1).value);
  assert.ok(names.includes('第四批主客户'), '导出行含主客户');
});
t('H5 客户列表导出（POST）：真 xlsx', async () => {
  const r = await handler('POST', '/crm/v2/export/', { search_key: '第四批主客户', page_index: 1, page_size: 100 });
  isXlsx(r);
  assert.ok(/^客户列表_\d{8}\.xlsx$/.test(r.fileName));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const ws = wb.worksheets[0];
  assert.ok(ws.rowCount >= 2, '表头 + 数据行');
  const names = [];
  for (let i = 2; i <= ws.rowCount; i++) names.push(ws.getRow(i).getCell(1).value);
  assert.ok(names.includes('第四批主客户'), '导出行含主客户');
});
t('H2 客户上传回退云端代理', () => {
  const h = localApi.match('POST', '/crm/upload/excel/');
  assert.ok(h, '本地注册了 handler');
  assert.strictEqual(h({ body: {}, query: {}, headers: {} }), null);
});
t('H3 客户确认（GET）回退云端代理', () => {
  const h = localApi.match('GET', '/crm/confirm/excel/');
  assert.ok(h, '本地注册了 handler');
  assert.strictEqual(h({ body: {}, query: {}, headers: {} }), null);
});

// ---- 清理（等全部异步用例完成后再执行，避免删掉断言所需数据） ----
Promise.all(asyncTasks).then(() => {
  db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
  db.prepare("DELETE FROM crm_public_customers WHERE public_customer_id >= 900000000").run();
  db.prepare("DELETE FROM crm_service_team WHERE crm_id >= 900000000").run();
  try { db.prepare("DELETE FROM projects WHERE project_id >= 900000000").run(); } catch (e) {}
  db.prepare("DELETE FROM local_records WHERE entity IN ('customer','project','crm_public_customer') AND CAST(record_id AS INTEGER) >= 900000000").run();
  db.close();

  console.log('\n==============================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('测试流程异常: ' + e.message); process.exit(1); });
