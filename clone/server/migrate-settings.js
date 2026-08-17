/**
 * 客户列表设置项 + 组织架构 全局数据迁移脚本（模式 A：本地权威，一次性从官方云端拉取）
 * 用法: node server/migrate-settings.js
 * 说明:
 *   - 复用本地管理员账号（users 表）登录官方云端，不额外配置
 *   - 幂等：重复执行 INSERT OR REPLACE，不会产生重复数据
 *   - 落库 crm_globals（kind 主键）：screen_conditions / status_list / table_header / department_members / department_leaders
 */
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { CRM_SCHEMA_SQL } = require('./crm-schema');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'local.db');
const API_HOST = 'lzapi.e-shigong.com';
const API_BASE = '/api';

const db = new DatabaseSync(DB_PATH);
db.exec(CRM_SCHEMA_SQL);

const now = () => new Date().toISOString();

// ---------------- 云端请求 ----------------
function cloudPost(apiPath, body, session, _tries) {
  const tries = _tries || 0;
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'platform': '1',
      'accept-encoding': 'identity'
    };
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
    r.on('error', (e) => {
      if (tries < 1) { resolve(cloudPost(apiPath, body, session, tries + 1)); return; }
      resolve({ code: 1, msg: '网络错误: ' + e.message });
    });
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

async function cloudCall(apiPath, body, session, cred) {
  let j = await cloudPost(apiPath, body, session);
  if (j.code === 10012) {
    console.log('  云端会话失效，重新登录...');
    const fresh = cred ? await cloudLogin(cred.phone, cred.pwd) : null;
    if (fresh) {
      Object.assign(session, fresh);
      j = await cloudPost(apiPath, body, session);
    }
  }
  return j;
}

// ---------------- 本地写入 ----------------
function upsertGlobal(kind, data) {
  db.prepare('INSERT OR REPLACE INTO crm_globals (kind, payload, updated_at) VALUES (?,?,?)')
    .run(kind, JSON.stringify(data || {}), now());
}

// ---------------- 主流程 ----------------
async function main() {
  const admin = db.prepare('SELECT * FROM users WHERE is_administrator = 1 ORDER BY id ASC LIMIT 1').get();
  if (!admin || !admin.password_plain) {
    console.error('本地未找到管理员账号，请先启动服务器并完成一次本地登录后重试');
    process.exit(1);
  }

  console.log('[1/2] 云端登录:', admin.phone);
  const session = await cloudLogin(admin.phone, admin.password_plain);
  if (!session) {
    console.error('云端登录失败：请检查网络连接或账号密码');
    process.exit(1);
  }
  console.log('      登录成功 company_id=' + session.company_id);
  const cred = { phone: admin.phone, pwd: admin.password_plain };

  console.log('[2/2] 拉取客户列表设置项 + 组织架构全局数据');
  const targets = [
    ['screen_conditions', '/crm/screen/condition/list/', {}],
    ['status_list', '/crm/status/list/', {}],
    ['table_header', '/crm/table/header/list/', {}],
    ['department_members', '/company/v2/department/member/all/', { company_id: session.company_id }],
    ['department_leaders', '/crm/department_leader/members/', {}]
  ];
  let okCount = 0;
  for (const [kind, api, body] of targets) {
    const j = await cloudCall(api, body, session, cred);
    if (j.code === 0 && j.data) { upsertGlobal(kind, j.data); okCount++; console.log('  ' + kind + ' OK (' + JSON.stringify(j.data).length + 'B)'); }
    else console.log('  ' + kind + ' 跳过:', j.msg || j.code || '响应异常');
  }

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM crm_globals').get().c;
  console.log('\n迁移完成：crm_globals 总计 ' + cnt + ' 条（本次成功 ' + okCount + '/5）');
}

main().catch((e) => { console.error('迁移异常', e); process.exit(2); });
