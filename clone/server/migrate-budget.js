/**
 * 预算模块数据迁移脚本（模式 A：本地权威，一次性从官方云端拉取存量数据）
 * 用法:
 *   node server/migrate-budget.js              迁移预算列表 + 公司级全局数据（按客户列表/说明/审核/模板/工艺/商品）
 *   node server/migrate-budget.js --with-detail  同时拉取每个预算详情与子资源（成本/人工/审核记录/表头）
 * 说明:
 *   - 复用本地管理员账号（users 表）登录官方云端，不额外配置
 *   - 幂等：重复执行按 budget_id upsert / INSERT OR REPLACE，不会产生重复数据
 */
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { BUDGET_SCHEMA_SQL } = require('./budget-schema');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'local.db');
const API_HOST = 'lzapi.e-shigong.com';
const API_BASE = '/api';
const PAGE_SIZE = 100;

const db = new DatabaseSync(DB_PATH);
db.exec(BUDGET_SCHEMA_SQL);

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
function upsertBudget(item) {
  const bid = Number(item.budget_id || item.id || 0);
  if (!bid) return;
  const row = {
    budget_id: bid,
    crm_id: Number(item.crm_id || 0),
    project_id: Number(item.project_id || 0),
    name: item.name || item.budget_name || '',
    status: Number(item.status || 0),
    selected: Number(item.selected || 0),
    contract_price: String(item.contract_price || '0'),
    total_price: String(item.total_price || item.total_sale_price || '0'),
    create_user_name: item.create_user_name || '',
    area_num: Number(item.area_num || 0),
    list_json: JSON.stringify(item),
    deleted: 0,
    created_at: now(),
    updated_at: now()
  };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols.filter((c) => c !== 'budget_id').map((c) => `${c}=excluded.${c}`).join(',');
  db.prepare(`INSERT INTO budgets (${cols.join(',')}) VALUES (${placeholders})
    ON CONFLICT(budget_id) DO UPDATE SET ${updates}`).run(...Object.values(row));
}

function upsertBudgetPayload(bid, kind, data) {
  db.prepare('INSERT OR REPLACE INTO budget_payloads (budget_id, kind, payload, updated_at) VALUES (?,?,?,?)')
    .run(Number(bid), kind, JSON.stringify(data || {}), now());
}

function upsertBudgetGlobal(kind, data) {
  db.prepare('INSERT OR REPLACE INTO budget_globals (kind, payload, updated_at) VALUES (?,?,?)')
    .run(kind, JSON.stringify(data || {}), now());
}

// 归并本地已新建预算（local_records, entity=budget）到 budgets 表
function mergeLocalBudgets() {
  const rows = db.prepare("SELECT * FROM local_records WHERE entity = 'budget'").all();
  let merged = 0, deleted = 0;
  for (const row of rows) {
    const bid = Number(row.record_id);
    if (row.deleted) {
      db.prepare('UPDATE budgets SET deleted = 1, updated_at = ? WHERE budget_id = ?').run(now(), bid);
      deleted++;
      continue;
    }
    let p = {};
    try { p = JSON.parse(row.payload || '{}'); } catch {}
    db.prepare(`INSERT OR IGNORE INTO budgets (budget_id, crm_id, project_id, name, status, contract_price, total_price, create_user_name, list_json, is_local, deleted, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)`)
      .run(bid, Number(p.crm_id || 0), Number(p.project_id || 0), p.name || p.budget_name || '新预算', Number(p.status || 0),
        String(p.contract_price || '0'), String(p.total_price || p.total_sale_price || '0'), p.create_user_name || '本地用户',
        JSON.stringify({ id: bid, name: p.name || p.budget_name || '新预算', area_num: (p.areas || []).length }), now(), now());
    merged++;
  }
  if (merged || deleted) console.log(`  归并本地已建预算 ${merged} 条，本地删除标记 ${deleted} 条`);
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

  console.log('[2/4] 归并本地已建预算到 budgets');
  mergeLocalBudgets();

  console.log('[3/4] 拉取预算列表与公司级全局数据');
  // 预算列表（我的 + 全部，结构一致 {budgets,total_num}）
  const mine = await cloudCall('/budget/mine/budget/list/', {}, session, cred);
  if (mine.code === 0 && mine.data && Array.isArray(mine.data.budgets)) {
    for (const item of mine.data.budgets) upsertBudget(item);
    upsertBudgetGlobal('mine_budget_list', mine.data);
    console.log('  我的预算列表 ' + mine.data.budgets.length + ' 条');
  }
  const allB = await cloudCall('/budget/list/', {}, session, cred);
  if (allB.code === 0 && allB.data && Array.isArray(allB.data.budgets)) {
    for (const item of allB.data.budgets) upsertBudget(item);
    upsertBudgetGlobal('budget_list', allB.data);
    console.log('  全部预算列表 ' + allB.data.budgets.length + ' 条');
  }
  // 按客户预算列表（公司 + 我的）
  const globals = [
    ['budget_crm_list', '/budget/app/company/budget/crm/list/', {}],
    ['my_budget_crm_list', '/budget/app/budget/crm/list/', {}],
    ['all_conditions', '/budget/app/company/budget/crm/all_conditions/', {}],
    ['delete_list', '/budget/delete/list/', {}],
    ['explanation', '/budget/company/budget/explanation/list/', {}],
    ['review_list', '/budget/review/list/', {}],
    ['reviewer_setting', '/budget/company/reviewer/setting/get/', {}],
    ['template_list', '/budget/template/list/', {}],
    ['specification', '/budget/specification/list/', {}],
    ['commodity_content', '/budget/commodity_content/list/', {}]
  ];
  for (const [kind, api, body] of globals) {
    const j = await cloudCall(api, body, session, cred);
    if (j.code === 0 && j.data) { upsertBudgetGlobal(kind, j.data); console.log('  ' + kind + ' OK'); }
    else console.log('  ' + kind + ' 跳过:', j.msg || j.code || '响应异常');
  }
  // 预算模板详情
  const tpl = db.prepare('SELECT payload FROM budget_globals WHERE kind = ?').get('template_list');
  if (tpl) {
    try {
      const templates = JSON.parse(tpl.payload).templates || [];
      for (const t of templates) {
        if (!t.id) continue;
        const td = await cloudCall('/budget/template/detail/', { template_id: t.id }, session, cred);
        if (td.code === 0 && td.data) upsertBudgetGlobal('template_detail_' + t.id, td.data);
      }
    } catch {}
  }

  // 每预算详情 + 子资源
  console.log('[4/4] ' + (withDetail ? '拉取每预算详情与子资源' : '跳过详情（--with-detail 开启）'));
  let detailCount = 0;
  if (withDetail) {
    const all = db.prepare('SELECT budget_id FROM budgets WHERE budget_id < 900000000 ORDER BY budget_id ASC').all();
    for (const r of all) {
      const bid = r.budget_id;
      const d = await cloudCall('/budget/detail/', { budget_id: bid }, session, cred);
      if (d.code === 0 && d.data) {
        db.prepare('UPDATE budgets SET detail_json = ?, crm_id = ?, name = ?, updated_at = ? WHERE budget_id = ?')
          .run(JSON.stringify(d.data), Number(d.data.crm_id || 0), d.data.name || '', now(), bid);
        detailCount++;
      }
      const subs = [
        ['cost_detail', '/budget/cost/detail/', { budget_id: bid }],
        ['worker_summary', '/budget/worker/summary/detail/', { budget_id: bid }],
        ['review_record', '/budget/review/record/detail/', { budget_id: bid }],
        ['table_header', '/budget/table_header/list/', { budget_id: bid }]
      ];
      for (const [kind, api, body] of subs) {
        const j = await cloudCall(api, body, session, cred);
        if (j.code === 0 && j.data) upsertBudgetPayload(bid, kind, j.data);
      }
      if (detailCount % 20 === 0) console.log('  已处理 ' + detailCount + '/' + all.length + ' 个预算');
    }
  }

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM budgets').get().c;
  console.log('\n迁移完成：预算表总计 ' + cnt + ' 条' + (withDetail ? '，详情 ' + detailCount + ' 个' : ''));
  if (!withDetail) {
    console.log('提示：预算详情/子资源可后续补拉  node server/migrate-budget.js --with-detail');
  }
}

main().catch((e) => { console.error('迁移异常', e); process.exit(2); });
