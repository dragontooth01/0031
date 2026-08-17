/**
 * 工作台杂项数据迁移脚本（节假日 + 公司到期提醒）
 * 用法: node server/migrate-misc.js
 * 说明:
 *   - 节假日按年存 project_globals（kind=holiday_<year>，payload={holidays:[{name,date,year}]}）
 *   - 到期提醒存 project_globals（kind=expire_remind，payload=云端 data）
 *   - 幂等：INSERT OR REPLACE
 */
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { PROJECT_SCHEMA_SQL } = require('./project-schema');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'local.db');
const API_HOST = 'lzapi.e-shigong.com';
const API_BASE = '/api';

const db = new DatabaseSync(DB_PATH);
db.exec(PROJECT_SCHEMA_SQL);
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
        try { resolve(JSON.parse(buf)); } catch { resolve({ code: 1, msg: '非JSON响应', raw: String(buf).slice(0, 200) }); }
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

function upsertGlobal(kind, data) {
  db.prepare('INSERT OR REPLACE INTO project_globals (kind, payload, updated_at) VALUES (?,?,?)')
    .run(kind, JSON.stringify(data || {}), now());
}

async function main() {
  const admin = db.prepare('SELECT * FROM users WHERE is_administrator = 1 ORDER BY id ASC LIMIT 1').get();
  if (!admin || !admin.password_plain) { console.error('本地未找到管理员账号'); process.exit(1); }

  console.log('[1/2] 云端登录:', admin.phone);
  const session = await cloudLogin(admin.phone, admin.password_plain);
  if (!session) { console.error('云端登录失败'); process.exit(1); }
  console.log('      登录成功 company_id=' + session.company_id);

  console.log('[2/2] 拉取杂项数据');
  // 节假日：按年落库（2023-2028）
  const years = [2023, 2024, 2025, 2026, 2027, 2028];
  const hj = await cloudPost('/project/holiday/list/', { years }, session);
  if (hj.code === 0 && hj.data && Array.isArray(hj.data.holidays)) {
    const byYear = {};
    for (const h of hj.data.holidays) {
      const y = h.year || Number(String(h.date).slice(0, 4));
      (byYear[y] = byYear[y] || []).push(h);
    }
    for (const [y, list] of Object.entries(byYear)) {
      upsertGlobal('holiday_' + y, { holidays: list });
      console.log('  holiday_' + y + ' OK (' + list.length + ' 条)');
    }
  } else {
    console.log('  节假日拉取失败:', hj.msg || hj.code);
  }

  // 到期提醒（公司级快照）
  const exp = await cloudPost('/company/expire/remind/info/', {}, session);
  if (exp.code === 0 && exp.data) {
    upsertGlobal('expire_remind', exp.data);
    console.log('  expire_remind OK', JSON.stringify(exp.data));
  } else {
    console.log('  到期提醒拉取失败:', exp.msg || exp.code);
  }

  const cnt = db.prepare("SELECT COUNT(*) AS c FROM project_globals WHERE kind LIKE 'holiday_%' OR kind = 'expire_remind'").get().c;
  console.log('\n迁移完成：杂项共 ' + cnt + ' 条');
}

main().catch((e) => { console.error('迁移异常', e); process.exit(2); });
