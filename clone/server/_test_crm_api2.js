// crm 第二批 12 接口单元测试：公海与客户转交（B2-B8/B14/E1-E4），9 亿号段数据，测后清理
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
const H = {};
const sess = db.prepare('SELECT * FROM sessions LIMIT 1').get();
if (sess) H['session-id'] = sess.session_id;
const uid = (db.prepare("SELECT id FROM users WHERE name != '' ORDER BY id LIMIT 1").get() || { id: 1 }).id;
const ownerName = (db.prepare('SELECT name FROM users WHERE id = ?').get(uid) || { name: '测试' }).name;

// ---- 测试数据 ----
const CRM = 900400001, P1 = 900500001, P2 = 900500002, PX = 900599999;
db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_public_customers WHERE public_customer_id >= 900000000").run();
db.prepare("DELETE FROM crm_service_team WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_aborted_records WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM local_records WHERE entity='customer' AND CAST(record_id AS INTEGER) >= 900000000").run();
// 已有正式客户（用于复用分配测试）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,crm_status,status_map_id,status_name,is_aborted,owner_id,owner_name,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM, '老客户', '13600000001', 2, 200, '量房', 0, 0, '');
// 公海线索 P1/P2
const INS_P = "INSERT INTO crm_public_customers (public_customer_id,customer_name,customer_gender,customer_phone,source_type_id,community_name,status,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))";
db.prepare(INS_P).run(P1, '线索甲', 1, '13600000002', 1, '阳光花园', 0);
db.prepare(INS_P).run(P2, '线索乙', 2, '13600000003', 2, '碧水湾', 0);
// 一条已回收线索
db.prepare(INS_P).run(900500003, '已回收线索', 1, '13600000004', 1, '回收小区', 2);

console.log('\n=== B2 公海线索新增 ===');
t('正常新增返回 9 亿号段 id', () => {
  const d = handler('/crm/public/customer/add/', { customer_name: '新线索', customer_phone: '13600000099', source_type_id: 1, community_name: '新小区' }, H).data;
  assert.ok(d.public_customer_id >= 900000000);
  const row = db.prepare('SELECT * FROM crm_public_customers WHERE public_customer_id = ?').get(d.public_customer_id);
  assert.strictEqual(row.status, 0);
  assert.strictEqual(row.community_name, '新小区');
  db.prepare('DELETE FROM crm_public_customers WHERE public_customer_id = ?').run(d.public_customer_id);
});
t('缺手机号返回 10011', () => {
  const r = handler('/crm/public/customer/add/', { customer_name: 'x' }, H);
  assert.strictEqual(r.code, 10011);
});

console.log('\n=== B3 公海线索编辑 ===');
t('正常编辑字段落库', () => {
  const r = handler('/crm/public/customer/edit/', { public_customer_id: P1, community_name: '改名小区', room_size: '120平' });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT community_name, room_size FROM crm_public_customers WHERE public_customer_id = ?').get(P1);
  assert.strictEqual(row.community_name, '改名小区');
  assert.strictEqual(row.room_size, '120平');
});
t('不存在的线索返回 13001', () => {
  const r = handler('/crm/public/customer/edit/', { public_customer_id: PX, community_name: 'x' });
  assert.strictEqual(r.code, 13001);
});
t('缺 public_customer_id 返回 10011', () => {
  const r = handler('/crm/public/customer/edit/', { community_name: 'x' });
  assert.strictEqual(r.code, 10011);
});

console.log('\n=== B4 公海线索分配（单条） ===');
t('分配后 status=1 + 同步生成正式客户', () => {
  const r = handler('/crm/public/customer/assign/', { public_customer_id: P1, owner_id: uid });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT status, owner_id FROM crm_public_customers WHERE public_customer_id = ?').get(P1);
  assert.strictEqual(row.status, 1);
  assert.strictEqual(row.owner_id, uid);
  const crm = db.prepare('SELECT * FROM crm_customers WHERE customer_phone = ? AND deleted = 0').get('13600000002');
  assert.ok(crm, '应生成正式客户');
  assert.strictEqual(crm.owner_id, uid);
  assert.strictEqual(crm.customer_name, '线索甲');
});
t('手机号已存在则复用并更新负责人', () => {
  db.prepare('UPDATE crm_public_customers SET status = 0, owner_id = 0 WHERE public_customer_id = ?').run(P2);
  // 给 P2 的手机号预建正式客户（模拟已存在）
  db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,crm_status,status_name,owner_id,owner_name,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
    .run(900400002, '已存在客户', '13600000003', 1, '潜在客户', 0, '', );
  const r = handler('/crm/public/customer/assign/', { public_customer_id: P2, owner_id: uid });
  assert.strictEqual(r.code, 0);
  const rows = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE customer_phone = ? AND deleted = 0').get('13600000003');
  assert.strictEqual(rows.c, 1, '不应重复创建正式客户');
  const crm = db.prepare('SELECT owner_id FROM crm_customers WHERE customer_phone = ?').get('13600000003');
  assert.strictEqual(crm.owner_id, uid, '应更新已有客户负责人');
});
t('不存在的线索返回 13001', () => {
  const r = handler('/crm/public/customer/assign/', { public_customer_id: PX, owner_id: uid });
  assert.strictEqual(r.code, 13001);
});
t('缺参返回 10011', () => {
  assert.strictEqual(handler('/crm/public/customer/assign/', { public_customer_id: P1 }).code, 10011);
  assert.strictEqual(handler('/crm/public/customer/assign/', { owner_id: uid }).code, 10011);
});

console.log('\n=== B5 公海线索批量分配 ===');
t('全部成功 success_num=N', () => {
  const r = handler('/crm/public/customer/batch/assign/', { public_customer_ids: [P1, P2], owner_id: uid });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.success_num, 2);
});
t('部分不存在返回 25002', () => {
  const r = handler('/crm/public/customer/batch/assign/', { public_customer_ids: [P1, PX], owner_id: uid });
  assert.strictEqual(r.code, 25002);
  assert.strictEqual(r.data.success_num, 1);
  assert.strictEqual(r.data.fail_num, 1);
});
t('空 ids 返回 10011', () => {
  const r = handler('/crm/public/customer/batch/assign/', { public_customer_ids: [], owner_id: uid });
  assert.strictEqual(r.code, 10011);
});

console.log('\n=== B6 分配确认列表 ===');
t('按 crm_ids 返回对应客户', () => {
  const d = handler('/crm/public/customer/assign/crm/list/', { crm_ids: [CRM] }).data;
  const mine = d.crm_list.filter((x) => x.crm_id >= 900000000);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].crm_id, CRM);
});
t('空 crm_ids 返回空列表', () => {
  const d = handler('/crm/public/customer/assign/crm/list/', { crm_ids: [] }).data;
  assert.strictEqual(d.crm_list.filter((x) => x.crm_id >= 900000000).length, 0);
});

console.log('\n=== B7 分配统计 ===');
t('统计计数正确', () => {
  const d = handler('/crm/public/customer/assign/info/', {}).data;
  const mine = { total: d.total_count, assigned: d.assigned_count, unassigned: d.unassigned_count, reclaimed: d.reclaimed_count };
  // 本组测试数据：P1/P2 已分配（status=1），900500003 已回收（status=2），新线索已删 → total>=3
  assert.ok(mine.total >= 3);
  assert.ok(mine.assigned >= 2);
  assert.ok(mine.unassigned >= 0);
  assert.ok(mine.reclaimed >= 1);
});

console.log('\n=== B8 公海筛选条件 ===');
t('返回 source_list 与 status_list', () => {
  const d = handler('/crm/public/customer/filter/list/', {}).data;
  assert.ok(Array.isArray(d.source_list));
  assert.strictEqual(d.status_list.length, 3);
  assert.strictEqual(d.status_list[0].name, '待分配');
});

console.log('\n=== B14 回收列表 ===');
t('只返回 status=2 线索', () => {
  const d = handler('/crm/reclaim/public/customer/list/', {}).data;
  const mine = d.public_customers.filter((x) => x.public_customer_id >= 900000000);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].customer_name, '已回收线索');
});
t('按 public_customer_ids 过滤', () => {
  const d = handler('/crm/reclaim/public/customer/list/', { public_customer_ids: [900500003] }).data;
  assert.strictEqual(d.public_customers.filter((x) => x.public_customer_id >= 900000000).length, 1);
});
t('空表 total_count=0', () => {
  const d = handler('/crm/reclaim/public/customer/list/', { page_index: 9, page_size: 20 }).data;
  assert.strictEqual(d.public_customers.filter((x) => x.public_customer_id >= 900000000).length, 0);
});

console.log('\n=== E1 服务团队列表 ===');
t('返回 main_designer 与 followers 结构', () => {
  const d = handler('/crm/service/team/member/list/', { crm_id: CRM }).data;
  assert.ok('main_designer' in d && Array.isArray(d.followers));
});
t('无主设计师时 main_designer=null', () => {
  const d = handler('/crm/service/team/member/list/', { crm_id: CRM }).data;
  assert.strictEqual(d.main_designer, null);
});
t('缺 crm_id 返回 10011', () => {
  assert.strictEqual(handler('/crm/service/team/member/list/', {}).code, 10011);
});

console.log('\n=== E2 添加协办成员 ===');
t('添加后 followers 生效', () => {
  const r = handler('/crm/service/team/member/add/', { crm_id: CRM, followers: [uid] }, H);
  assert.strictEqual(r.code, 0);
  const d = handler('/crm/service/team/member/list/', { crm_id: CRM }).data;
  assert.strictEqual(d.followers.length, 1);
  assert.strictEqual(d.followers[0].user_id, uid);
});
t('重复添加幂等', () => {
  handler('/crm/service/team/member/add/', { crm_id: CRM, followers: [uid] }, H);
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM crm_service_team WHERE crm_id = ? AND deleted = 0').get(CRM).c;
  assert.strictEqual(cnt, 1);
});
t('缺参返回 10011', () => {
  assert.strictEqual(handler('/crm/service/team/member/add/', { crm_id: CRM }).code, 10011);
});

console.log('\n=== E3 移除协办成员 ===');
t('移除后 followers 为空', () => {
  const r = handler('/crm/service/team/member/del/', { crm_id: CRM, followers: [uid] });
  assert.strictEqual(r.code, 0);
  const d = handler('/crm/service/team/member/list/', { crm_id: CRM }).data;
  assert.strictEqual(d.followers.length, 0);
});
t('缺参返回 10011', () => {
  assert.strictEqual(handler('/crm/service/team/member/del/', { crm_id: CRM }).code, 10011);
});

console.log('\n=== E4 移除主设计师 ===');
t('清空 designer_id 并软删 team_role=1', () => {
  db.prepare('UPDATE crm_customers SET designer_id = ?, designer_name = ? WHERE crm_id = ?').run(uid, ownerName, CRM);
  db.prepare("INSERT INTO crm_service_team (crm_id,user_id,user_name,team_role,create_time,deleted,created_at,updated_at) VALUES (?,?,?,1,datetime('now'),0,datetime('now'),datetime('now'))")
    .run(CRM, uid, ownerName);
  const r = handler('/crm/service/team/main_designer/del/', { crm_id: CRM, main_designer_id: uid });
  assert.strictEqual(r.code, 0);
  const crm = db.prepare('SELECT designer_id FROM crm_customers WHERE crm_id = ?').get(CRM);
  assert.strictEqual(crm.designer_id, 0);
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM crm_service_team WHERE crm_id = ? AND team_role = 1 AND deleted = 0').get(CRM).c;
  assert.strictEqual(cnt, 0);
});
t('缺参返回 10011', () => {
  assert.strictEqual(handler('/crm/service/team/main_designer/del/', { crm_id: CRM }).code, 10011);
});

// ---- 清理 ----
db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_public_customers WHERE public_customer_id >= 900000000").run();
db.prepare("DELETE FROM crm_service_team WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_aborted_records WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM local_records WHERE entity='customer' AND CAST(record_id AS INTEGER) >= 900000000").run();
db.close();

console.log('\n==============================');
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
