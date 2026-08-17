/**
 * 巡检模块迁移脚本（读接口本地化用）
 * 用法: node server/migrate-inspection.js
 * 说明:
 *   - 分页拉取 /project/inspection/company/list/ 全量巡检记录 → inspections 表（幂等 upsert）
 *   - 筛选下拉数据（projects/create_users）→ inspection_globals(kind=filter)
 */
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { INSPECTION_SCHEMA_SQL } = require('./inspection-schema');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'local.db');
const API_HOST = 'lzapi.e-shigong.com';
const API_BASE = '/api';

const db = new DatabaseSync(DB_PATH);
db.exec(INSPECTION_SCHEMA_SQL);
const now = () => new Date().toISOString();

function cloudPost(apiPath, body, session, _tries) {
  const tries = _tries || 0;
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'platform': '1', 'accept-encoding': 'identity' };
    if (session) {
      headers['session-id'] = session.session_id;
      headers['user-id'] = String(session.user_id);
      headers['company-id'] = String(session.company_id);
      if (session.phone) headers['phone-number'] = session.phone;
    }
    const r = https.request({ host: API_HOST, port: 443, method: 'POST', path: API_BASE + apiPath, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ code: 1, msg: '非JSON响应' }); }
      });
    });
    r.on('error', (e) => (tries < 1 ? resolve(cloudPost(apiPath, body, session, tries + 1)) : resolve({ code: 1, msg: '网络错误: ' + e.message })));
    r.setTimeout(20000, () => r.destroy());
    r.write(data); r.end();
  });
}

async function cloudLogin(phone, pwd) {
  const j = await cloudPost('/user/login/', { type: 1, phone_number: phone, pwd: String(pwd) });
  if (j.code === 0 && j.data) {
    return { session_id: j.data.session_id, user_id: j.data.user_id, company_id: j.data.company_id, phone: j.data.user_phone };
  }
  return null;
}

function upsertInspection(item) {
  const cols = ['id', 'project_name', 'create_user_name', 'inspection_content', 'handle_content', 'create_time', 'deadline', 'status', 'list_json', 'updated_at'];
  const row = {
    id: Number(item.id),
    project_name: String(item.project_name || ''),
    create_user_name: String(item.create_user_name || ''),
    inspection_content: String(item.inspection_content || ''),
    handle_content: String(item.handle_content || ''),
    create_time: String(item.create_time || ''),
    deadline: String(item.deadline || ''),
    status: Number(item.status || 0),
    list_json: JSON.stringify(item),
    updated_at: now()
  };
  db.prepare('INSERT INTO inspections (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ') ON CONFLICT(id) DO UPDATE SET project_name=excluded.project_name, create_user_name=excluded.create_user_name, inspection_content=excluded.inspection_content, handle_content=excluded.handle_content, create_time=excluded.create_time, deadline=excluded.deadline, status=excluded.status, list_json=excluded.list_json, updated_at=excluded.updated_at, deleted=0')
    .run(...cols.map((c) => row[c]));
}

async function main() {
  const admin = db.prepare('SELECT * FROM users WHERE is_administrator = 1 ORDER BY id ASC LIMIT 1').get();
  if (!admin || !admin.password_plain) { console.error('本地未找到管理员账号'); process.exit(1); }

  console.log('[1/3] 云端登录:', admin.phone);
  const session = await cloudLogin(admin.phone, admin.password_plain);
  if (!session) { console.error('云端登录失败'); process.exit(1); }
  console.log('      登录成功 company_id=' + session.company_id);

  console.log('[2/3] 分页拉取巡检列表');
  let all = [];
  let filter = null;
  for (let page = 1; page <= 20; page++) {
    const j = await cloudPost('/project/inspection/company/list/', {
      company_id: session.company_id, status: -1, project_ids: [], create_user_ids: [], page_index: page, page_size: 100, role_ids: []
    }, session);
    if (j.code !== 0 || !j.data) { console.log('  第 ' + page + ' 页拉取失败:', j.msg || j.code); break; }
    if (!filter) filter = { projects: j.data.projects || [], create_users: j.data.create_users || [] };
    const list = j.data.inspection_list || [];
    all = all.concat(list);
    console.log('  第 ' + page + ' 页 ' + list.length + ' 条');
    if (list.length === 0 || all.length >= (j.data.total_num || 0)) break;
  }
  console.log('  共 ' + all.length + ' 条');

  console.log('[3/3] 落库');
  for (const item of all) upsertInspection(item);
  if (filter) {
    db.prepare('INSERT OR REPLACE INTO inspection_globals (kind, payload, updated_at) VALUES (?,?,?)')
      .run('filter', JSON.stringify(filter), now());
    console.log('  filter 快照 OK（projects ' + filter.projects.length + ' / create_users ' + filter.create_users.length + '）');
  }
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM inspections').get().c;
  console.log('\n迁移完成：inspections 共 ' + cnt + ' 条');
}

main().catch((e) => { console.error('迁移异常', e); process.exit(2); });
