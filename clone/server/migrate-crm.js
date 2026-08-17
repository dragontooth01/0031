/**
 * 客户模块数据迁移脚本（模式 A：本地权威，一次性从官方云端拉取存量数据）
 * 用法:
 *   node server/migrate-crm.js                迁移客户列表(公司全量+个人带电话) + 字典
 *   node server/migrate-crm.js --with-detail  同时拉取每个客户详情
 *   node server/migrate-crm.js --with-follow  同时拉取每个客户跟进记录
 * 说明:
 *   - 复用本地管理员账号（users 表）登录官方云端，不额外配置
 *   - 幂等：重复执行按 crm_id upsert，不会产生重复数据
 *   - 同时会把本地已新建的客户（local_records, 9 亿号段）归并进 crm_customers
 */
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { CRM_SCHEMA_SQL } = require('./crm-schema');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'local.db');
const API_HOST = 'lzapi.e-shigong.com';
const API_BASE = '/api';
const PAGE_SIZE = 100;
const MAX_PAGES = 500;

const db = new DatabaseSync(DB_PATH);
db.exec(CRM_SCHEMA_SQL);
// 兼容已建库：crm_sources 补充来源类型列
try { db.exec('ALTER TABLE crm_sources ADD COLUMN source_type TEXT DEFAULT \'self\''); } catch {}

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

// 云端登录（platform=1 浏览器模式会话，与代理层一致）
async function cloudLogin(phone, pwd) {
  const j = await cloudPost('/user/login/', { type: 1, phone_number: phone, pwd: String(pwd) });
  if (j.code === 0 && j.data) {
    return { session_id: j.data.session_id, user_id: j.data.user_id, company_id: j.data.company_id, phone: j.data.user_phone };
  }
  return null;
}

// 凭证失效(10012)时用管理员凭证重新登录后重试一次
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
// 由云端列表项构造数据库行（展开常用列 + 原样存 list_json）；列名自动对齐避免手写错误
function upsertCustomer(item, opts) {
  const o = opts || {};
  const crmId = Number(item.crm_id || item.id || 0);
  if (!crmId) return;
  const row = {
    crm_id: crmId,
    customer_name: item.customer_name || item.name || '',
    customer_phone: item.customer_phone || item.phone_number || '',
    customer_gender: item.customer_gender || 0,
    gender: item.gender || 0,
    room_type: item.room_type || '',
    room_size: item.room_size || '0',
    address: item.address || '',
    crm_status: item.crm_status || 0,
    status_map_id: item.status_map_id || 0,
    status_name: item.status_name || '',
    color_value: item.color_value || '',
    customer_type_id: item.customer_type_id || 0,
    customer_type_name: item.customer_type_name || '',
    source: item.source || 0,
    source_name: item.source_name || '',
    owner_id: item.owner_id || 0,
    owner_name: item.owner_name || '',
    owner_phone: item.owner_phone || '',
    designer_id: item.designer_id || 0,
    designer_name: item.designer_name || '',
    pm_name: item.pm_name || '',
    create_user_id: item.create_user_id || 0,
    create_user_name: item.create_user_name || '',
    create_time: item.create_time || '',
    update_time: item.update_time || '',
    is_aborted: item.is_aborted || 0,
    crm_sn: item.crm_sn || '',
    project_id: item.project_id || 0,
    budget_id: item.budget_id || 0,
    budget_num: item.budget_num || 0,
    contract_num: item.contract_num || 0,
    file_item_uploaded_num: item.file_item_uploaded_num || 0,
    remind_enable: item.remind_enable || 0,
    next_remind_date: item.next_remind_date || '',
    tag_ids: Array.isArray(item.tag_ids) ? JSON.stringify(item.tag_ids) : String(item.tag_ids || ''),
    list_json: JSON.stringify(item),
    is_local: o.is_local ? 1 : 0,
    deleted: o.deleted ? 1 : 0,
    created_at: now(),
    updated_at: now()
  };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols.filter((c) => c !== 'crm_id').map((c) => `${c}=excluded.${c}`).join(',');
  db.prepare(`INSERT INTO crm_customers (${cols.join(',')}) VALUES (${placeholders})
    ON CONFLICT(crm_id) DO UPDATE SET ${updates}`).run(...Object.values(row));
}

function updateDetail(crmId, detail) {
  db.prepare('UPDATE crm_customers SET detail_json = ?, updated_at = ? WHERE crm_id = ?')
    .run(JSON.stringify(detail), now(), Number(crmId));
}

// 跟进记录：/crm/follow/record/ 返回 data.follow_records
function upsertFollows(crmId, data) {
  const list = (data && (data.follow_records || data.follow_list)) || [];
  if (!Array.isArray(list) || !list.length) return 0;
  const stmt = db.prepare('INSERT OR IGNORE INTO crm_follow_records (crm_id, follow_id, content, follow_type, follow_time, create_user_id, create_user_name, extra_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const ts = now();
  for (const f of list) {
    stmt.run(
      Number(crmId),
      Number(f.record_id || f.follow_id || f.id || 0),
      f.content || '',
      Number(f.follow_type || 0),
      f.create_time || f.follow_time || '',
      Number(f.create_user_id || 0),
      f.create_user_name || '',
      JSON.stringify(f),
      ts, ts
    );
  }
  return list.length;
}

// 归并本地已新建的客户（local_records, entity=customer）到 crm_customers
function mergeLocalCustomers() {
  const rows = db.prepare("SELECT * FROM local_records WHERE entity = 'customer'").all();
  let merged = 0, deleted = 0;
  for (const row of rows) {
    const crmId = Number(row.record_id);
    if (row.deleted) {
      db.prepare('UPDATE crm_customers SET deleted = 1, updated_at = ? WHERE crm_id = ?').run(now(), crmId);
      deleted++;
      continue;
    }
    let p = {};
    try { p = JSON.parse(row.payload || '{}'); } catch {}
    const item = {
      crm_id: crmId,
      customer_name: p.customer_name || p.name || '',
      customer_phone: p.customer_phone || p.phone_number || p.phone || '',
      customer_gender: p.customer_gender || p.gender || 0,
      gender: p.customer_gender || p.gender || 0,
      room_type: p.room_type || '',
      room_size: p.room_size || '0',
      address: p.address || '',
      crm_status: p.crm_status || 1,
      status_name: p.status_name || '潜在客户',
      customer_type_name: p.customer_type_name || '',
      source: p.source || 0,
      source_name: p.source_name || '',
      create_user_name: p.create_user_name || '本地用户',
      create_time: String(row.created_at || '').slice(0, 10),
      update_time: String(row.updated_at || '').slice(0, 10),
      owner_name: p.owner_name || p.create_user_name || '本地用户'
    };
    upsertCustomer(item, { is_local: true });
    merged++;
  }
  if (merged || deleted) console.log(`  归并本地已建客户 ${merged} 条，本地删除标记 ${deleted} 条`);
}

// ---------------- 字典迁移 ----------------
async function migrateDicts(session, cred, firstCrmId) {
  // 状态字典（需任意 crm_id 参数）
  const st = await cloudCall('/crm/company/crm/status/', { crm_id: firstCrmId }, session, cred);
  const statusList = st.data && st.data.status_list;
  if (Array.isArray(statusList)) {
    const stmt = db.prepare('INSERT OR REPLACE INTO crm_status (status_id, name, color_value, is_selected, updated_at) VALUES (?,?,?,?,?)');
    const ts = now();
    for (const s of statusList) stmt.run(Number(s.status_map_id || s.id || 0), s.status_name || s.name || '', s.color_value || '', s.can_select ? 1 : (s.is_selected || 0), ts);
    console.log(`  状态字典 ${statusList.length} 条`);
  } else {
    console.log('  [跳过] 状态字典:', st.msg || '响应结构异常');
  }

  // 标签字典
  const tg = await cloudCall('/crm/tag/list/', {}, session, cred);
  const tagList = tg.data && tg.data.tag_list;
  if (Array.isArray(tagList)) {
    const stmt = db.prepare('INSERT OR REPLACE INTO crm_tags (tag_id, name, is_selected, updated_at) VALUES (?,?,?,?)');
    const ts = now();
    for (const t of tagList) stmt.run(Number(t.tag_id || t.id || 0), t.tag_name || t.name || '', t.is_selected || 0, ts);
    console.log(`  标签字典 ${tagList.length} 条`);
  } else {
    console.log('  [跳过] 标签字典:', tg.msg || '响应结构异常');
  }

  // 来源字典（系统来源 + 公司自定义来源）
  const so = await cloudCall('/company/crm/source/list/', {}, session, cred);
  const sys = (so.data && so.data.sys_sources) || [];
  const self = (so.data && so.data.self_sources) || [];
  const sourceList = [...sys.map((s) => ({ ...s, _type: 'sys' })), ...self.map((s) => ({ ...s, _type: 'self' }))];
  if (sourceList.length) {
    const stmt = db.prepare('INSERT OR REPLACE INTO crm_sources (source_id, name, enable, source_type, updated_at) VALUES (?,?,?,?,?)');
    const ts = now();
    for (const s of sourceList) stmt.run(Number(s.id || s.source_id || 0), s.name || '', s.enable === undefined ? 1 : s.enable, s._type, ts);
    console.log(`  来源字典 ${sourceList.length} 条（系统 ${sys.length} + 自定义 ${self.length}）`);
  } else {
    console.log('  [跳过] 来源字典:', so.msg || '响应结构异常');
  }
}

// ---------------- 分页拉取列表 ----------------
async function pullList(session, cred, apiPath, onItem, label) {
  let page = 1, pulled = 0;
  while (page <= MAX_PAGES) {
    const j = await cloudCall(apiPath, { page_index: page, page_size: PAGE_SIZE }, session, cred);
    if (j.code !== 0 || !j.data) {
      console.error('  ' + label + ' 第 ' + page + ' 页失败:', j.msg || j.raw || JSON.stringify(j).slice(0, 200));
      break;
    }
    const list = j.data.crm_list || [];
    for (const item of list) { onItem(item); pulled++; }
    console.log('  ' + label + ' 第 ' + page + ' 页：' + list.length + ' 条（共 ' + (j.data.total_num || 0) + '）');
    if (list.length < PAGE_SIZE) break;
    page++;
  }
  return pulled;
}

// ---------------- 主流程 ----------------
async function main() {
  const args = process.argv.slice(2);
  const withDetail = args.includes('--with-detail');
  const withFollow = args.includes('--with-follow');

  // 本地管理员凭证
  const admin = db.prepare('SELECT * FROM users WHERE is_administrator = 1 ORDER BY id ASC LIMIT 1').get();
  if (!admin || !admin.password_plain) {
    console.error('本地未找到管理员账号，请先启动服务器并完成一次本地登录后重试');
    process.exit(1);
  }

  console.log('[1/4] 云端登录:', admin.phone);
  const session = await cloudLogin(admin.phone, admin.password_plain);
  if (!session) {
    console.error('云端登录失败：请检查网络连接或账号密码（password_plain 需为明文密码）');
    process.exit(1);
  }
  console.log('      登录成功 company_id=' + session.company_id);
  const cred = { phone: admin.phone, pwd: admin.password_plain };

  console.log('[2/4] 归并本地已建客户到 crm_customers');
  mergeLocalCustomers();

  // 先拉一页公司列表，取得 crm_id 供状态字典使用
  const firstPage = await cloudCall('/crm/v2/pc/company/crm/list/', { page_index: 1, page_size: 2 }, session, cred);
  const firstCrmId = (firstPage.data && firstPage.data.crm_list && firstPage.data.crm_list[0] && firstPage.data.crm_list[0].crm_id) || 0;

  console.log('[3/4] 迁移字典（状态/标签/来源）');
  await migrateDicts(session, cred, firstCrmId);

  console.log('[4/4] 分页拉取客户列表（每页 ' + PAGE_SIZE + ' 条）');
  const companyCount = await pullList(session, cred, '/crm/v2/pc/company/crm/list/', upsertCustomer, '公司客户');
  const mineCount = await pullList(session, cred, '/crm/v2/pc/list/', upsertCustomer, '个人客户(带电话)');

  // 可选：详情 / 跟进
  let details = 0, follows = 0;
  if (withDetail || withFollow) {
    console.log('  补充拉取详情/跟进...');
    const all = db.prepare('SELECT crm_id FROM crm_customers WHERE crm_id < 900000000 ORDER BY crm_id ASC').all();
    for (const r of all) {
      if (withDetail) {
        const d = await cloudCall('/crm/customer/detail/', { crm_id: r.crm_id }, session, cred);
        if (d.code === 0 && d.data) { updateDetail(r.crm_id, d.data); details++; }
      }
      if (withFollow) {
        const f = await cloudCall('/crm/follow/record/', { crm_id: r.crm_id }, session, cred);
        if (f.code === 0 && f.data) follows += upsertFollows(r.crm_id, f.data);
      }
    }
  }

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM crm_customers').get().c;
  console.log('\n迁移完成：公司客户 ' + companyCount + ' 条，个人客户 ' + mineCount + ' 条，客户表总计 ' + cnt + ' 条' +
    (withDetail ? '，详情 ' + details + ' 条' : '') + (withFollow ? '，跟进 ' + follows + ' 条' : ''));
  if (!withDetail && !withFollow) {
    console.log('提示：详情/跟进可后续补拉  node server/migrate-crm.js --with-detail --with-follow');
  }
}

main().catch((e) => { console.error('迁移异常', e); process.exit(2); });
