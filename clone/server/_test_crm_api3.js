// crm 第三批 15 接口单元测试：D2-D7 配置 + F1-F9 附件，9 亿号段数据，测后清理
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
// uid 以会话 user_id 为准（users 或 company_members 均可解析名称）
const uid = sess ? Number(sess.user_id || sess.cloud_user_id || 0) : 1;
const ownerName = (db.prepare('SELECT name FROM users WHERE id = ?').get(uid)
  || db.prepare('SELECT name FROM company_members WHERE id = ?').get(uid) || { name: '测试' }).name;

// ---- 测试数据（9 亿号段，测后清理）----
const CRM = 900600001, PROJ = 900600002, FX = 900699999;
db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_file_items WHERE crm_id >= 900000000 OR project_id >= 900000000 OR file_id >= 900000000").run();
db.prepare("DELETE FROM crm_file_records WHERE record_id >= 900000000 OR file_id >= 900000000").run();
db.prepare("DELETE FROM crm_field_settings WHERE field_id >= 900000000").run();
db.prepare("DELETE FROM local_records WHERE entity='customer' AND CAST(record_id AS INTEGER) >= 900000000").run();
// 状态字典（作废 + 普通）
db.prepare("DELETE FROM crm_status WHERE status_id >= 900000000").run();
db.prepare("INSERT INTO crm_status (status_id,name,color_value,is_selected,aborted,enable) VALUES (?,?,?,?,?,?)")
  .run(900000001, '已作废', '#ff0000', 0, 1, 1);
db.prepare("INSERT INTO crm_status (status_id,name,color_value,is_selected,aborted,enable) VALUES (?,?,?,?,?,?)")
  .run(900000002, '量房', '#00ff00', 0, 0, 1);
// 客户 + 项目（F 组关联）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,crm_status,status_name,owner_id,owner_name,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM, '附件客户', '13600000011', 1, '潜在客户', uid, ownerName);
try {
  db.prepare("INSERT INTO projects (project_id,project_name,status,deleted,created_at,updated_at) VALUES (?,?,1,0,datetime('now'),datetime('now'))")
    .run(PROJ, '附件项目');
} catch (e) { /* projects 表可能被并行测试占用，忽略 */ }

console.log('\n=== D2 作废标签启用开关 ===');
t('enable=0 关闭后 crm_status.enable 置 0', () => {
  const r = handler('/crm/aborted_tag/enable/', { enable: 0, aborted_list: [900000001], crm_type: 1 });
  assert.strictEqual(r.code, 0);
  const s = db.prepare('SELECT enable FROM crm_status WHERE status_id = ?').get(900000001);
  assert.strictEqual(s.enable, 0);
});
t('enable=1 重新启用', () => {
  const r = handler('/crm/aborted_tag/enable/', { enable: 1, aborted_list: [900000001], crm_type: 1 });
  assert.strictEqual(r.code, 0);
  const s = db.prepare('SELECT enable FROM crm_status WHERE status_id = ?').get(900000001);
  assert.strictEqual(s.enable, 1);
});
t('enable=0 时 aborted_list 空数组合法（原版行为）', () => {
  const r = handler('/crm/aborted_tag/enable/', { enable: 0, aborted_list: [], crm_type: 1 });
  assert.strictEqual(r.code, 0);
});
t('enable=1 但 aborted_list 为空返回 10011', () => {
  assert.strictEqual(handler('/crm/aborted_tag/enable/', { enable: 1, aborted_list: [], crm_type: 1 }).code, 10011);
});
t('缺 enable 返回 10011', () => {
  assert.strictEqual(handler('/crm/aborted_tag/enable/', { aborted_list: [900000001], crm_type: 1 }).code, 10011);
});

console.log('\n=== D3 状态标签启用开关 ===');
t('正常翻转状态 enable', () => {
  const r = handler('/crm/status_tag/enable/', { enable: 0, status_id: 900000002 });
  assert.strictEqual(r.code, 0);
  const s = db.prepare('SELECT enable FROM crm_status WHERE status_id = ?').get(900000002);
  assert.strictEqual(s.enable, 0);
});
t('支持 status_list 数组形式', () => {
  const r = handler('/crm/status_tag/enable/', { enable: 1, status_list: [900000002] });
  assert.strictEqual(r.code, 0);
  const s = db.prepare('SELECT enable FROM crm_status WHERE status_id = ?').get(900000002);
  assert.strictEqual(s.enable, 1);
});
t('状态不存在返回 13001', () => {
  assert.strictEqual(handler('/crm/status_tag/enable/', { enable: 1, status_id: FX }).code, 13001);
});
t('缺参返回 10011', () => {
  assert.strictEqual(handler('/crm/status_tag/enable/', { enable: 1 }).code, 10011);
  assert.strictEqual(handler('/crm/status_tag/enable/', { status_id: 900000002 }).code, 10011);
});

console.log('\n=== D4 筛选条件显隐 ===');
t('更新 field_type=0 的 enable', () => {
  const r = handler('/crm/screen/condition/enable/update/', { field_id: 900300001, enable: 0 });
  assert.strictEqual(r.code, 0);
  const s = db.prepare('SELECT * FROM crm_field_settings WHERE field_id = ? AND field_type = 0').get(900300001);
  assert.ok(s, '不存在时应幂等插入');
  assert.strictEqual(s.enable, 0);
});
t('不存在 field_id 幂等插入', () => {
  const r = handler('/crm/screen/condition/enable/update/', { field_id: 900300002, enable: 1 });
  assert.strictEqual(r.code, 0);
  const s = db.prepare('SELECT * FROM crm_field_settings WHERE field_id = ? AND field_type = 0').get(900300002);
  assert.strictEqual(s.enable, 1);
});
t('缺 field_id 返回 10011', () => {
  assert.strictEqual(handler('/crm/screen/condition/enable/update/', { enable: 1 }).code, 10011);
});

console.log('\n=== D5 筛选条件排序 ===');
t('按数组顺序写入 sort_order', () => {
  const r = handler('/crm/screen/condition/order/update/', { fields: [{ field_id: 900300001 }, { field_id: 900300002 }] });
  assert.strictEqual(r.code, 0);
  const s1 = db.prepare('SELECT sort_order FROM crm_field_settings WHERE field_id = ? AND field_type = 0').get(900300001);
  const s2 = db.prepare('SELECT sort_order FROM crm_field_settings WHERE field_id = ? AND field_type = 0').get(900300002);
  assert.strictEqual(s1.sort_order, 0);
  assert.strictEqual(s2.sort_order, 1);
});
t('fields 非数组返回 10011', () => {
  assert.strictEqual(handler('/crm/screen/condition/order/update/', { fields: 'x' }).code, 10011);
});

console.log('\n=== D6 列表表头显隐 ===');
t('更新 field_type=1 的 enable 且与筛选互不干扰', () => {
  const r = handler('/crm/table/header/enable/update/', { field_id: 900400001, enable: 1 });
  assert.strictEqual(r.code, 0);
  const s = db.prepare('SELECT * FROM crm_field_settings WHERE field_id = ?').get(900400001);
  assert.ok(s);
  assert.strictEqual(s.field_type, 1);
  assert.strictEqual(s.enable, 1);
  const f0 = db.prepare('SELECT enable FROM crm_field_settings WHERE field_id = ?').get(900300001);
  assert.strictEqual(f0.enable, 0, '筛选条件 enable 不应被表头操作影响');
});
t('缺 field_id 返回 10011', () => {
  assert.strictEqual(handler('/crm/table/header/enable/update/', { enable: 0 }).code, 10011);
});

console.log('\n=== D7 列表表头排序 ===');
t('按数组顺序写入 sort_order', () => {
  const r = handler('/crm/table/header/order/update/', { fields: [{ field_id: 900400001 }, { field_id: 900400002 }] });
  assert.strictEqual(r.code, 0);
  const s1 = db.prepare('SELECT sort_order FROM crm_field_settings WHERE field_id = ?').get(900400001);
  const s2 = db.prepare('SELECT sort_order FROM crm_field_settings WHERE field_id = ?').get(900400002);
  assert.strictEqual(s1.sort_order, 0);
  assert.strictEqual(s2.sort_order, 1);
});
t('fields 非数组返回 10011', () => {
  assert.strictEqual(handler('/crm/table/header/order/update/', { fields: null }).code, 10011);
});

console.log('\n=== F1 附件列表 ===');
let FID1 = 0, FID2 = 0;
t('按 crm_id 查附件', () => {
  FID1 = handler('/crm/file_item/add/', { crm_id: CRM, name: '户型图', type: 1, files: [{ type: 1, name: 'a.jpg', url: 'http://x/a.jpg', size: 100 }] }).data.item_id;
  FID2 = handler('/crm/file_item/add/', { crm_id: CRM, project_id: PROJ, name: '合同', type: 2, files: [{ type: 2, name: 'b.pdf', url: 'http://x/b.pdf', size: 200 }] }).data.item_id;
  const d = handler('/crm/file_item/list/', { crm_id: CRM }).data;
  assert.strictEqual(d.total_num, 2);
  assert.ok(d.file_items.every((f) => f.crm_id === CRM));
});
t('按 project_id 查附件', () => {
  const d = handler('/crm/file_item/list/', { project_id: PROJ }).data;
  assert.strictEqual(d.total_num, 1);
  assert.strictEqual(d.file_items[0].project_id, PROJ);
});
t('type 过滤生效', () => {
  const d = handler('/crm/file_item/list/', { crm_id: CRM, type: 1 }).data;
  assert.strictEqual(d.total_num, 1);
  assert.strictEqual(d.file_items[0].file_type, 1);
});
t('缺 crm_id/project_id 返回 10011', () => {
  assert.strictEqual(handler('/crm/file_item/list/', {}).code, 10011);
});

console.log('\n=== F2 新增附件 ===');
t('写入 file_items + 上传记录', () => {
  const d = handler('/crm/file_item/add/', { crm_id: CRM, name: '预算表', files: [{ type: 3, name: 'c.xlsx', url: 'http://x/c.xlsx', size: 300 }] }, H).data;
  assert.ok(d.item_id >= 900000000);
  const row = db.prepare('SELECT * FROM crm_file_items WHERE file_id = ?').get(d.item_id);
  assert.strictEqual(row.crm_id, CRM);
  assert.strictEqual(row.create_user_name, ownerName);
  const rec = db.prepare('SELECT * FROM crm_file_records WHERE file_id = ?').get(d.item_id);
  assert.strictEqual(rec.action, 0);
  assert.strictEqual(rec.operator_name, ownerName);
});
t('缺 crm_id 或 files 返回 10011', () => {
  assert.strictEqual(handler('/crm/file_item/add/', { crm_id: CRM }).code, 10011);
  assert.strictEqual(handler('/crm/file_item/add/', { files: [] }).code, 10011);
});

console.log('\n=== F3 重命名附件 ===');
t('重命名生效', () => {
  const r = handler('/crm/file_item/edit/', { item_id: FID1, name: '新户型图' });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT name FROM crm_file_items WHERE file_id = ?').get(FID1);
  assert.strictEqual(row.name, '新户型图');
});
t('item_id 不存在返回 13001', () => {
  assert.strictEqual(handler('/crm/file_item/edit/', { item_id: FX, name: 'x' }).code, 13001);
});
t('name 为空返回 10011', () => {
  assert.strictEqual(handler('/crm/file_item/edit/', { item_id: FID1, name: '' }).code, 10011);
});

console.log('\n=== F4 删除附件 ===');
t('批量软删成功', () => {
  const r = handler('/crm/file_item/del/', { item_ids: [FID1, FID2] });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.success_num, 2);
  const row = db.prepare('SELECT deleted FROM crm_file_items WHERE file_id = ?').get(FID1);
  assert.strictEqual(row.deleted, 1);
  const rec = db.prepare('SELECT COUNT(*) AS c FROM crm_file_records WHERE file_id = ? AND action = 1').get(FID2);
  assert.strictEqual(rec.c, 1);
});
t('部分失败返回 25002', () => {
  const okId = handler('/crm/file_item/add/', { crm_id: CRM, name: 'x', files: [{ type: 1, name: 'x', url: 'u', size: 1 }] }).data.item_id;
  const r = handler('/crm/file_item/del/', { item_ids: [okId, FX] });
  assert.strictEqual(r.code, 25002);
  assert.strictEqual(r.data.success_num, 1);
  assert.strictEqual(r.data.fail_num, 1);
});
t('item_ids 空返回 10011', () => {
  assert.strictEqual(handler('/crm/file_item/del/', { item_ids: [] }).code, 10011);
});

console.log('\n=== F5 附件详情 ===');
let FID3 = 0;
t('返回 file_item 详情', () => {
  FID3 = handler('/crm/file_item/add/', { crm_id: CRM, name: '详情附件', files: [{ type: 1, name: 'd.png', url: 'http://x/d.png', size: 50 }] }).data.item_id;
  const d = handler('/crm/file_item/detail/', { item_id: FID3 }).data;
  assert.strictEqual(d.file_item.item_id, FID3);
  assert.strictEqual(d.file_item.name, '详情附件');
  assert.strictEqual(d.file_item.files.length, 1);
  assert.strictEqual(d.file_item.files[0].url, 'http://x/d.png');
});
t('item_id 不存在返回 13001', () => {
  assert.strictEqual(handler('/crm/file_item/detail/', { item_id: FX }).code, 13001);
});
t('缺 item_id 返回 10011', () => {
  assert.strictEqual(handler('/crm/file_item/detail/', {}).code, 10011);
});

console.log('\n=== F6 更新附件 ===');
t('files 覆盖更新 + 写更新记录', () => {
  const r = handler('/crm/file_item/update/', { item_id: FID3, name: '更新后附件', description: 'desc2', files: [{ type: 2, name: 'e.pdf', url: 'http://x/e.pdf', size: 999 }] });
  assert.strictEqual(r.code, 0);
  const row = db.prepare('SELECT name, description, files FROM crm_file_items WHERE file_id = ?').get(FID3);
  assert.strictEqual(row.name, '更新后附件');
  assert.strictEqual(row.description, 'desc2');
  const files = JSON.parse(row.files);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].size, 999);
  const rec = db.prepare('SELECT COUNT(*) AS c FROM crm_file_records WHERE file_id = ? AND action = 3').get(FID3);
  assert.strictEqual(rec.c, 1);
});
t('缺 files 返回 10011', () => {
  assert.strictEqual(handler('/crm/file_item/update/', { item_id: FID3 }).code, 10011);
});
t('item_id 不存在返回 13001', () => {
  assert.strictEqual(handler('/crm/file_item/update/', { item_id: FX, files: [{ type: 1 }] }).code, 13001);
});

console.log('\n=== F7 附件操作记录列表 ===');
t('分页返回 records + total_num', () => {
  const d = handler('/crm/file_item/record/list/', { page_index: 1, page_size: 10 }).data;
  assert.ok(d.total_num >= 4, '应有上传/删除/更新记录');
  assert.ok(d.records.length > 0);
  assert.ok(d.records.every((r) => r.record_id > 0 && typeof r.action === 'number'));
});
t('company_id 过滤不报错', () => {
  const d = handler('/crm/file_item/record/list/', { company_id: 6808, page_index: 1, page_size: 5 }).data;
  assert.ok(Array.isArray(d.records));
});

console.log('\n=== F8 附件操作记录详情 ===');
t('返回单条记录', () => {
  const list = handler('/crm/file_item/record/list/', { page_index: 1, page_size: 1 }).data;
  const rid = list.records[0].record_id;
  const d = handler('/crm/file_item/record/detail/', { record_id: rid }).data;
  assert.strictEqual(d.record.record_id, rid);
  assert.ok('action' in d.record && 'operator_name' in d.record);
});
t('record_id 不存在返回 13001', () => {
  assert.strictEqual(handler('/crm/file_item/record/detail/', { record_id: FX }).code, 13001);
});

console.log('\n=== F9 未读附件数 ===');
t('timestamp 前附件计入未读', () => {
  // 独立新建项目附件（F4 测试已软删此前的项目附件）
  const fid = handler('/crm/file_item/add/', { crm_id: CRM, project_id: PROJ, name: '新项目文件', files: [{ type: 1, name: 'p.png', url: 'http://x/p.png', size: 10 }] }).data.item_id;
  assert.ok(fid > 0);
  const d = handler('/crm/file_item/unread/count/', { project_id: PROJ, timestamp: 1 }).data;
  assert.strictEqual(d.unread_count, 1);
});
t('timestamp 之后附件不计入', () => {
  const d = handler('/crm/file_item/unread/count/', { project_id: PROJ, timestamp: Date.now() + 100000 }).data;
  assert.strictEqual(d.unread_count, 0);
});
t('缺 project_id 返回 10011', () => {
  assert.strictEqual(handler('/crm/file_item/unread/count/', { timestamp: 1 }).code, 10011);
});

// ---- 清理 ----
db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_file_items WHERE crm_id >= 900000000 OR project_id >= 900000000 OR file_id >= 900000000").run();
db.prepare("DELETE FROM crm_file_records WHERE record_id >= 900000000 OR file_id >= 900000000").run();
db.prepare("DELETE FROM crm_field_settings WHERE field_id >= 900000000").run();
db.prepare("DELETE FROM crm_status WHERE status_id >= 900000000").run();
db.prepare("DELETE FROM local_records WHERE entity='customer' AND CAST(record_id AS INTEGER) >= 900000000").run();
db.prepare("DELETE FROM local_records WHERE entity IN ('crm_file_item','crm_file_record') AND CAST(record_id AS INTEGER) >= 900000000").run();
try { db.prepare("DELETE FROM projects WHERE project_id >= 900000000").run(); } catch (e) {}
db.close();

console.log('\n==============================');
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
