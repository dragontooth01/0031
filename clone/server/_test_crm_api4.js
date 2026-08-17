// crm 第四批 3 接口单元测试：F10 project/group/info + G2 internet_customer/detail + G3 follow/record/export
// 测试数据 9 亿号段，测后清理（含 local_records 残留，避免归并污染）
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
  assert.ok(r.fileName && r.fileName.endsWith('.xlsx'), '文件名为 .xlsx: ' + r.fileName);
};
const handler = (path, body, headers) => localApi.match('POST', path)({ body, query: {}, headers: headers || {} });
const H = {};
const sess = db.prepare('SELECT * FROM sessions LIMIT 1').get();
if (sess) H['session-id'] = sess.session_id;
const uid = sess ? Number(sess.user_id || sess.cloud_user_id || 0) : 1;

// ---- 测试数据（9 亿号段，测后清理）----
const CRM = 900700001, CRM_MIG = 900700002, CRM_NONE = 900700003, CRM_DEL = 900700004, PUB = 900700005;
db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_follow_records WHERE crm_id >= 900000000").run();
db.prepare("DELETE FROM crm_public_customers WHERE public_customer_id >= 900000000").run();
try { db.prepare("DELETE FROM projects WHERE project_id >= 900000000").run(); } catch (e) {}
db.prepare("DELETE FROM local_records WHERE entity='customer' AND CAST(record_id AS INTEGER) >= 900000000").run();
db.prepare("DELETE FROM local_records WHERE entity='project' AND CAST(record_id AS INTEGER) >= 900000000").run();

// 主客户（F10 本地项目 + G2 详情 + G3 跟进）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,customer_gender,source,source_name,room_size,address,detail_json,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM, '第四批客户', '13600000044', 1, 1068, '网单', '89', '西城区XX小区',
    JSON.stringify({ share_type: 1, other_content: '微信分享来的', city_name: '测试市测试区' }));
// 迁移项目匹配客户（customer_name + phone 匹配场景）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM_MIG, '迁移客户', '13600000033');
db.prepare("INSERT INTO projects (project_id,project_name,customer_name,phone_number,status,deleted,created_at,updated_at) VALUES (?,?,?,?,1,0,datetime('now'),datetime('now'))")
  .run(CRM_MIG, '迁移匹配项目', '迁移客户', '13600000033');
// 无项目客户（F10 10805 场景）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,0,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM_NONE, '无项目客户', '13600000055');
// 软删客户（F10/G2 13001 场景）
db.prepare("INSERT INTO crm_customers (crm_id,customer_name,customer_phone,deleted,create_time,update_time,created_at,updated_at) VALUES (?,?,?,1,datetime('now'),datetime('now'),datetime('now'),datetime('now'))")
  .run(CRM_DEL, '已删客户', '13600000066');
// 公海线索（G2 internet_customer_id 兜底场景）
db.prepare("INSERT INTO crm_public_customers (public_customer_id,customer_name,customer_phone,room_size,address_detail,status,deleted,create_time,created_at,updated_at) VALUES (?,?,?,?,?,0,0,datetime('now'),datetime('now'),datetime('now'))")
  .run(PUB, '公海线索', '13600000077', '100', '朝阳区XX路');
// 跟进记录（G3 导出）
db.prepare("INSERT INTO crm_follow_records (crm_id,follow_id,content,follow_type,follow_type_name,follow_time,create_user_id,create_user_name,deleted,created_at,updated_at) VALUES (?,?,?,?,?,datetime('now'),?,?,0,datetime('now'),datetime('now'))")
  .run(CRM, 900700101, '第一次电话沟通', 2, '电话', uid, '测试用户');
db.prepare("INSERT INTO crm_follow_records (crm_id,follow_id,content,follow_type,follow_type_name,follow_time,create_user_id,create_user_name,deleted,created_at,updated_at) VALUES (?,?,?,?,?,datetime('now'),?,?,0,datetime('now'),datetime('now'))")
  .run(CRM, 900700102, '上门量房完成', 3, '量房', uid, '测试用户');

console.log('\n=== F10 客户名下项目信息 ===');
let localProjectId = 0;
t('本地项目按 list_json.crm_id 关联命中', () => {
  const c = handler('/project/v2/create/', { crm_id: CRM, area_name: '测试小区', room_number: '101' });
  assert.strictEqual(c.code, 0);
  assert.ok(c.data.project_id > 0);
  localProjectId = c.data.project_id;
  const r = handler('/crm/project/group/info/', { crm_id: CRM });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.project_id, localProjectId);
});
t('迁移项目按 customer_name+phone 精确匹配', () => {
  const r = handler('/crm/project/group/info/', { crm_id: CRM_MIG });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.project_id, CRM_MIG);
});
t('无项目返回 10805（前端弹"创建项目"依赖此码）', () => {
  const r = handler('/crm/project/group/info/', { crm_id: CRM_NONE });
  assert.strictEqual(r.code, 10805);
});
t('软删客户返回 13001', () => {
  const r = handler('/crm/project/group/info/', { crm_id: CRM_DEL });
  assert.strictEqual(r.code, 13001);
});
t('本地无此客户返回 null（回退云端代理）', () => {
  assert.strictEqual(handler('/crm/project/group/info/', { crm_id: 900799999 }), null);
});
t('缺 crm_id 返回 10011', () => {
  assert.strictEqual(handler('/crm/project/group/info/', {}).code, 10011);
});

console.log('\n=== G2 网单客户详情 ===');
t('crm_id 查正式客户，字段齐全', () => {
  const r = handler('/crm/internet_customer/detail/', { crm_id: CRM });
  assert.strictEqual(r.code, 0);
  const d = r.data;
  assert.strictEqual(d.customer_name, '第四批客户');
  assert.strictEqual(d.customer_phone, '13600000044');
  assert.strictEqual(d.customer_gender, 1);
  assert.strictEqual(d.share_type, 1);              // 前端 source_name = share_type ? '微信分享' : '未定义'
  assert.strictEqual(d.source, 1068);
  assert.strictEqual(d.source_name, '网单');
  assert.strictEqual(d.other_content, '微信分享来的'); // source=90 时前端改显 other_content
  assert.strictEqual(d.city_name, '测试市测试区');   // 前端空值显示"暂无地址"
  assert.strictEqual(d.room_size, '89');
});
t('internet_customer_id 等价查 crm_customers', () => {
  const r = handler('/crm/internet_customer/detail/', { internet_customer_id: CRM });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.customer_name, '第四批客户');
});
t('internet_customer_id 兜底查公海线索', () => {
  const r = handler('/crm/internet_customer/detail/', { internet_customer_id: PUB });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.customer_name, '公海线索');
  assert.strictEqual(r.data.share_type, 0);
  assert.strictEqual(r.data.city_name, '朝阳区XX路');
});
t('软删客户返回 13001', () => {
  assert.strictEqual(handler('/crm/internet_customer/detail/', { crm_id: CRM_DEL }).code, 13001);
});
t('本地无此客户返回 null（回退云端代理）', () => {
  assert.strictEqual(handler('/crm/internet_customer/detail/', { crm_id: 900799998 }), null);
});
t('缺参返回 10011', () => {
  assert.strictEqual(handler('/crm/internet_customer/detail/', {}).code, 10011);
});

console.log('\n=== G3 跟进记录导出 ===');
t('导出全部跟进记录（倒序，字段完整）', async () => {
  const r = await handler('/crm/follow/record/export/', { crm_id: CRM });
  isXlsx(r);
  assert.ok(/^跟进记录_\d{8}\.xlsx$/.test(r.fileName));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.rowCount, 3, '表头 + 2 行数据');
  const contents = [];
  for (let i = 2; i <= ws.rowCount; i++) contents.push(ws.getRow(i).getCell(5).value);
  assert.ok(contents.includes('上门量房完成'), '量房记录存在');
  assert.ok(contents.includes('第一次电话沟通'));
  assert.strictEqual(ws.getRow(1).getCell(2).value, '跟进人');
});
t('follow_type 过滤只导出对应类型', async () => {
  const r = await handler('/crm/follow/record/export/', { crm_id: CRM, follow_type: 2 });
  isXlsx(r);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.rowCount, 2, '表头 + 1 行');
  assert.strictEqual(ws.getRow(2).getCell(5).value, '第一次电话沟通');
});
t('空跟进记录仅表头', async () => {
  const r = await handler('/crm/follow/record/export/', { crm_id: CRM_NONE });
  isXlsx(r);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  assert.strictEqual(wb.worksheets[0].rowCount, 1, '仅表头');
});
t('缺 crm_id 返回 10011', async () => {
  assert.strictEqual((await handler('/crm/follow/record/export/', {})).code, 10011);
});

// ---- 清理（等全部异步用例完成后再执行） ----
Promise.all(asyncTasks).then(() => {
  db.prepare("DELETE FROM crm_customers WHERE crm_id >= 900000000").run();
  db.prepare("DELETE FROM crm_follow_records WHERE crm_id >= 900000000").run();
  db.prepare("DELETE FROM crm_public_customers WHERE public_customer_id >= 900000000").run();
  try { db.prepare("DELETE FROM projects WHERE project_id >= 900000000").run(); } catch (e) {}
  db.prepare("DELETE FROM local_records WHERE entity='customer' AND CAST(record_id AS INTEGER) >= 900000000").run();
  db.prepare("DELETE FROM local_records WHERE entity='project' AND CAST(record_id AS INTEGER) >= 900000000").run();
  db.close();

  console.log('\n==============================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('测试流程异常: ' + e.message); process.exit(1); });
