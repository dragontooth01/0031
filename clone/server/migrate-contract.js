/**
 * 合同模块数据迁移脚本（模式 A：本地权威，一次性从官方云端拉取存量数据）
 * 用法:
 *   node server/migrate-contract.js              迁移合同列表（有合同的客户维度）+ 审核/审核人设置等公司级全局
 *   node server/migrate-contract.js --with-detail  同时拉取每合同的预算价格与预付款列表
 * 说明:
 *   - 复用本地管理员账号（users 表）登录官方云端，不额外配置
 *   - 幂等：重复执行按 contract_id upsert / INSERT OR REPLACE，不会产生重复数据
 *   - 合同列表按 crm_id 维度：迁移范围 = crm_customers 中 contract_num > 0 的客户
 */
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { CONTRACT_SCHEMA_SQL } = require('./contract-schema');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'local.db');
const API_HOST = 'lzapi.e-shigong.com';
const API_BASE = '/api';

const db = new DatabaseSync(DB_PATH);
db.exec(CONTRACT_SCHEMA_SQL);

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
function upsertContract(item, crmId) {
  const cid = Number(item.contract_id || item.id || 0);
  if (!cid) return;
  const row = {
    contract_id: cid,
    crm_id: Number(crmId || item.crm_id || 0),
    contract_type: Number(item.contract_type || 0),
    contract_name: item.contract_name || '',
    contract_title: item.contract_title || '',
    contact_name: item.contact_name || '',
    sort_order: Number(item.order || 0),
    has_read: Number(item.has_read || 0),
    update_time: item.update_time || '',
    list_json: JSON.stringify(item),
    deleted: 0,
    created_at: now(),
    updated_at: now()
  };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols.filter((c) => c !== 'contract_id').map((c) => `${c}=excluded.${c}`).join(',');
  db.prepare(`INSERT INTO contracts (${cols.join(',')}) VALUES (${placeholders})
    ON CONFLICT(contract_id) DO UPDATE SET ${updates}`).run(...Object.values(row));
}

function upsertContractPayload(cid, kind, data) {
  db.prepare('INSERT OR REPLACE INTO contract_payloads (contract_id, kind, payload, updated_at) VALUES (?,?,?,?)')
    .run(Number(cid), kind, JSON.stringify(data || {}), now());
}

function upsertContractGlobal(kind, data) {
  db.prepare('INSERT OR REPLACE INTO contract_globals (kind, payload, updated_at) VALUES (?,?,?)')
    .run(kind, JSON.stringify(data || {}), now());
}

// ---------------- 主流程 ----------------
async function main() {
  const args = process.argv.slice(2);
  const withDetail = args.includes('--with-detail');

  const admin = db.prepare('SELECT * FROM users WHERE is_administrator = 1 ORDER BY id ASC LIMIT 1').get();
  if (!admin || !admin.password_plain) {
    console.error('本地未找到管理员账号，请先启动服务器并完成一次本地登录后重试');
    process.exit(1);
  }

  console.log('[1/4] 云端登录:', admin.phone);
  const session = await cloudLogin(admin.phone, admin.password_plain);
  if (!session) {
    console.error('云端登录失败：请检查网络连接或账号密码');
    process.exit(1);
  }
  console.log('      登录成功 company_id=' + session.company_id);
  const cred = { phone: admin.phone, pwd: admin.password_plain };

  console.log('[2/4] 拉取合同公司级全局数据');
  const globals = [
    ['pc_check_list', '/finance/v2/pc/contract/check/list/', {}],
    ['app_check_list', '/finance/contract/check/list/', {}],
    ['check_filter_info', '/finance/v2/pc/contract/check/filter/info/', {}],
    ['reviewer_setting', '/finance/company/contract/reviewer/setting/get/', {}]
  ];
  for (const [kind, api, body] of globals) {
    const j = await cloudCall(api, body, session, cred);
    if (j.code === 0 && j.data) { upsertContractGlobal(kind, j.data); console.log('  ' + kind + ' OK'); }
    else console.log('  ' + kind + ' 跳过:', j.msg || j.code || '响应异常');
  }

  console.log('[3/4] 按客户拉取合同列表（contract_num > 0 的客户）');
  const crms = db.prepare('SELECT crm_id FROM crm_customers WHERE crm_id < 900000000 AND CAST(contract_num AS INTEGER) > 0 ORDER BY crm_id ASC').all();
  console.log('  目标客户 ' + crms.length + ' 个');
  let contractCount = 0;
  for (const c of crms) {
    const j = await cloudCall('/finance/contract/list/', { crm_id: c.crm_id }, session, cred);
    if (j.code !== 0 || !j.data) { console.log('  客户 ' + c.crm_id + ' 合同列表失败:', j.msg || '响应异常'); continue; }
    const contracts = j.data.contracts || [];
    for (const item of contracts) upsertContract(item, c.crm_id);
    contractCount += contracts.length;
  }
  console.log('  合同总计 ' + contractCount + ' 条');

  console.log('[4/4] ' + (withDetail ? '拉取每合同子资源（预算价格/预付款）' : '跳过子资源（--with-detail 开启）'));
  if (withDetail) {
    const all = db.prepare('SELECT contract_id FROM contracts WHERE contract_id < 900000000 ORDER BY contract_id ASC').all();
    for (const r of all) {
      const cid = r.contract_id;
      const bp = await cloudCall('/finance/contract/budget/price/', { contract_id: cid }, session, cred);
      if (bp.code === 0 && bp.data) upsertContractPayload(cid, 'budget_price', bp.data);
      const pp = await cloudCall('/finance/contract/add_prepay/list/', { contract_id: cid }, session, cred);
      if (pp.code === 0 && pp.data) upsertContractPayload(cid, 'prepay_list', pp.data);
    }
    console.log('  子资源完成（' + all.length + ' 个合同）');
  }

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM contracts').get().c;
  console.log('\n迁移完成：合同表总计 ' + cnt + ' 条');
  if (!withDetail) {
    console.log('提示：合同子资源可后续补拉  node server/migrate-contract.js --with-detail');
  }
}

main().catch((e) => { console.error('迁移异常', e); process.exit(2); });
