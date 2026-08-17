// crm 第一批 8 接口单元测试：加载真实 local-api（自动建新表），9 亿号段测试数据，测后清理
const { DatabaseSync } = require('node:sqlite');
const assert = require('assert');

const db = new DatabaseSync('e:/erpkok/webqianduan/data/local.db');
const localApi = require('./local-api');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + ' :: ' + e.message); }
}
const handler = (path, body, headers) => localApi.match('POST', path)({ body, query: {}, headers: headers || {} });
const H = {}; // 有效会话头（取 sessions 表第一条）
const sess = db.prepare('SELECT * FROM sessions LIMIT 1').get();
if (sess) H['session-id'] = sess.session_id;
const uid = (db.prepare("SELECT id FROM users WHERE name != '' ORDER BY id LIMIT 1").get() || { id: 1 }).id;
const ownerName = (db.prepare('SELECT name FROM users WHERE id = ?').get(uid) || { name: '测试' }).name;

// ---- 测试数据（9 亿号段） ----
const C1 = 900100001, C2 = 900100002, C3 = 900100003, CX = 900100099;
const P1 = 900200001, P2 = 900200002;
const INS_CRM = "INSERT INTO crm_customers (crm_id,customer_name,customer_phone,crm_status,status_map_id,status_name,is_aborted,owner_id,owner_name,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))";
db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_public_customers WHERE public_customer_id >= 900000000").run();
db.prepare("DELETE FROM crm_aborted_records WHERE crm_id >= 900000000").run();
// 清理 9 亿号段测试遗留 local_records，避免 ensureLocalCustomersMerged 归并回 crm_customers 污染断言
db.prepare("DELETE FROM local_records WHERE entity='customer' AND CAST(record_id AS INTEGER) >= 900000000").run();
db.prepare(INS_CRM).run(C1, '废单甲', '13900000001', 1, 100, '已作废', 1, 0, '');
db.prepare(INS_CRM).run(C2, '废单乙', '13900000002', 1, 100, '已作废', 1, 0, '');
db.prepare(INS_CRM).run(C3, '正常客户', '13900000003', 2, 200, '量房', 0, 0, '');
db.prepare("INSERT INTO crm_public_customers (public_customer_id,customer_name,customer_phone,source_type_id,community_name,status,deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,0,datetime('now'),datetime('now'))")
  .run(P1, '公海线索甲', '13900000101', 1, '阳光花园', 0);
db.prepare("INSERT INTO crm_public_customers (public_customer_id,customer_name,customer_phone,source_type_id,community_name,status,deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,0,datetime('now'),datetime('now'))")
  .run(P2, '公海线索乙', '13900000102', 2, '碧水湾', 1);

console.log('\n=== A1 crm/aborted_crm/list 废单列表 ===');
t('返回全部废单（is_aborted=1 共 2 条）', () => {
  const d = handler('/crm/aborted_crm/list/', { page_index: 1, page_size: 20 }).data;
  const mine = d.crm_list.filter((x) => x.crm_id >= 900000000);
  assert.strictEqual(mine.length, 2);
  assert.ok(mine.every((x) => x.is_aborted === 1));
});
t('search_key 过滤废单', () => {
  const d = handler('/crm/aborted_crm/list/', { search_key: '甲' }).data;
  assert.ok(d.crm_list.every((x) => x.crm_id >= 900000000 ? x.customer_name.includes('甲') : true));
});
t('page_index=0 容错返回第 1 页', () => {
  const d = handler('/crm/aborted_crm/list/', { page_index: 0, page_size: 10 }).data;
  assert.ok(Array.isArray(d.crm_list));
});

console.log('\n=== A2 crm/disable/aborted_crm/list 已作废复核 ===');
t('按 crm_ids 返回对应废单', () => {
  const d = handler('/crm/disable/aborted_crm/list/', { crm_ids: [C1, C2] }).data;
  const mine = d.crm_list.filter((x) => x.crm_id >= 900000000);
  assert.strictEqual(mine.length, 2);
});
t('不存在的 crm_id 返回空列表', () => {
  const d = handler('/crm/disable/aborted_crm/list/', { crm_ids: [CX] }).data;
  assert.strictEqual(d.crm_list.filter((x) => x.crm_id >= 900000000).length, 0);
});
t('正常客户（非废单）不会被列出', () => {
  const d = handler('/crm/disable/aborted_crm/list/', { crm_ids: [C3] }).data;
  assert.strictEqual(d.crm_list.filter((x) => x.crm_id >= 900000000).length, 0);
});

console.log('\n=== A4 crm/company/crm/list 公司客户列表 ===');
t('aborted_list:[1] 只返回废单', () => {
  const d = handler('/crm/company/crm/list/', { aborted_list: [1], page_size: 50 }).data;
  const mine = d.crm_list.filter((x) => x.crm_id >= 900000000);
  assert.strictEqual(mine.length, 2);
  assert.ok(d.aborted_num >= 2);
});
t('status 过滤只返回对应状态', () => {
  const d = handler('/crm/company/crm/list/', { status: 100, page_size: 50 }).data;
  const mine = d.crm_list.filter((x) => x.crm_id >= 900000000);
  assert.strictEqual(mine.length, 2); // 两条废单 status_map_id=100
});
t('默认返回全部（含正常客户）', () => {
  const d = handler('/crm/company/crm/list/', { page_size: 50 }).data;
  const mine = d.crm_list.filter((x) => x.crm_id >= 900000000);
  assert.strictEqual(mine.length, 3);
});

console.log('\n=== C1 crm/assign_owner 分配负责人 ===');
t('分配成功后 owner_id/owner_name 更新', () => {
  const r = handler('/crm/assign_owner/', { crm_id: C3, owner_id: uid });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT owner_id, owner_name FROM crm_customers WHERE crm_id = ?').get(C3);
  assert.strictEqual(row.owner_id, uid);
  assert.strictEqual(row.owner_name, ownerName);
});
t('缺 crm_id 返回 10011', () => {
  const r = handler('/crm/assign_owner/', { owner_id: uid });
  assert.strictEqual(r.code, 10011);
});
t('缺 owner_id 返回 10011', () => {
  const r = handler('/crm/assign_owner/', { crm_id: C3 });
  assert.strictEqual(r.code, 10011);
});
t('客户不存在返回 13001', () => {
  const r = handler('/crm/assign_owner/', { crm_id: CX, owner_id: uid });
  assert.strictEqual(r.code, 13001);
});

console.log('\n=== C3 crm/batch/reassign_owner 批量转交 ===');
t('全部成功返回 success_num=N', () => {
  const r = handler('/crm/batch/reassign_owner/', { crm_ids: [C1, C2], owner_id: uid });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.success_num, 2);
});
t('部分不存在返回 25002', () => {
  const r = handler('/crm/batch/reassign_owner/', { crm_ids: [C1, CX], owner_id: uid });
  assert.strictEqual(r.code, 25002);
  assert.strictEqual(r.data.success_num, 1);
  assert.strictEqual(r.data.fail_num, 1);
});
t('空 crm_ids 返回 10011', () => {
  const r = handler('/crm/batch/reassign_owner/', { crm_ids: [], owner_id: uid });
  assert.strictEqual(r.code, 10011);
});

console.log('\n=== D1 crm/batch/disable 批量作废 ===');
t('作废成功后 is_aborted=1 且留痕', () => {
  const r = handler('/crm/batch/disable/', { crm_ids: [C3], reason: '客户不装修了' }, H);
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT is_aborted FROM crm_customers WHERE crm_id = ?').get(C3);
  assert.strictEqual(row.is_aborted, 1);
  const rec = db.prepare('SELECT * FROM crm_aborted_records WHERE crm_id = ?').get(C3);
  assert.ok(rec, '应写入作废记录');
  assert.strictEqual(rec.reason, '客户不装修了');
});
t('部分不存在返回 25002', () => {
  const r = handler('/crm/batch/disable/', { crm_ids: [C1, CX], reason: 'x' }, H);
  assert.strictEqual(r.code, 25002);
});
t('空 ids 返回 10011', () => {
  const r = handler('/crm/batch/disable/', { crm_ids: [] }, H);
  assert.strictEqual(r.code, 10011);
});

console.log('\n=== D9 crm/v2/check 手机号查重 ===');
t('已存在手机号返回 exist=1 + 客户信息', () => {
  const d = handler('/crm/v2/check/', { customer_phone: '13900000003' }).data;
  assert.strictEqual(d.exist, 1);
  assert.strictEqual(d.crm_id, C3);
  assert.strictEqual(d.customer_name, '正常客户');
});
t('不存在手机号返回 exist=0', () => {
  const d = handler('/crm/v2/check/', { customer_phone: '13999999999' }).data;
  assert.strictEqual(d.exist, 0);
});
t('空手机号返回 10011', () => {
  const r = handler('/crm/v2/check/', { customer_phone: '' });
  assert.strictEqual(r.code, 10011);
});

console.log('\n=== B1 crm/public/customer/list 公海列表 ===');
t('返回全部公海线索（2 条）', () => {
  const d = handler('/crm/public/customer/list/', { page_index: 1, page_size: 20 }).data;
  const mine = d.public_customers.filter((x) => x.public_customer_id >= 900000000);
  assert.strictEqual(mine.length, 2);
});
t('search_key 按小区/姓名搜索', () => {
  const d = handler('/crm/public/customer/list/', { search_key: '阳光花园' }).data;
  assert.strictEqual(d.public_customers.filter((x) => x.public_customer_id >= 900000000).length, 1);
});
t('status 过滤', () => {
  const d = handler('/crm/public/customer/list/', { status: 1 }).data;
  assert.strictEqual(d.public_customers.filter((x) => x.public_customer_id >= 900000000).length, 1);
});
t('source_ids 过滤', () => {
  const d = handler('/crm/public/customer/list/', { source_ids: [2] }).data;
  assert.strictEqual(d.public_customers.filter((x) => x.public_customer_id >= 900000000).length, 1);
});
t('空表返回 total_count=0', () => {
  const d = handler('/crm/public/customer/list/', { page_index: 5, page_size: 20 }).data;
  assert.strictEqual(d.public_customers.filter((x) => x.public_customer_id >= 900000000).length, 0);
});

// ---- 清理测试数据 ----
db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_public_customers WHERE public_customer_id >= 900000000").run();
db.prepare("DELETE FROM crm_aborted_records WHERE crm_id >= 900000000").run();
// 清理 9 亿号段测试遗留 local_records，避免 ensureLocalCustomersMerged 归并回 crm_customers 污染断言
db.prepare("DELETE FROM local_records WHERE entity='customer' AND CAST(record_id AS INTEGER) >= 900000000").run();
db.close();

console.log('\n==============================');
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
