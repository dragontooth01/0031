/**
 * 项目模块数据迁移脚本（模式 A：本地权威，一次性从官方云端拉取存量数据）
 * 用法:
 *   node server/migrate-project.js              迁移项目列表 + 公司级全局数据（筛选/模板/角色等）
 *   node server/migrate-project.js --with-detail  同时拉取每个项目的详情与子资源（区域/任务/周计划/待办/施工日志/描述/角色）
 * 说明:
 *   - 复用本地管理员账号（users 表）登录官方云端，不额外配置
 *   - 幂等：重复执行按 project_id upsert / INSERT OR REPLACE，不会产生重复数据
 *   - 项目主表存列表/详情 JSON；子资源按 project_payloads(project_id, kind) 存完整响应 data
 */
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { CRM_SCHEMA_SQL } = require('./crm-schema');
const { PROJECT_SCHEMA_SQL } = require('./project-schema');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'local.db');
const API_HOST = 'lzapi.e-shigong.com';
const API_BASE = '/api';
const PAGE_SIZE = 100;
const MAX_PAGES = 500;

const db = new DatabaseSync(DB_PATH);
db.exec(CRM_SCHEMA_SQL);
db.exec(PROJECT_SCHEMA_SQL);

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
function upsertProject(item, o) {
  const pid = Number(item.project_id || item.id || 0);
  if (!pid) return;
  const opts = o || {};
  const row = {
    project_id: pid,
    project_name: item.project_name || item.name || '',
    status: item.status || 0,
    project_status: item.project_status || item.status || 0,
    start_date: item.start_date || '',
    end_date: item.end_date || '',
    completed_date: item.completed_date || item.complete_time || '',
    delay_status: item.delay_status || 0,
    complete_rate: item.complete_rate || 0,
    plan_project_rate: item.plan_project_rate || item.plan_rate || 0,
    area_name: item.area_name || '',
    room_number: item.room_number || '',
    customer_name: item.customer_name || '',
    customer_gender: item.customer_gender || 0,
    phone_number: item.phone_number || '',
    room_type: item.room_type || '',
    template_id: item.template_id || 0,
    template_name: item.template_name || '',
    budget_id: item.budget_id || 0,
    list_json: JSON.stringify(item),
    is_local: opts.is_local ? 1 : 0,
    deleted: opts.deleted ? 1 : 0,
    created_at: now(),
    updated_at: now()
  };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols.filter((c) => c !== 'project_id').map((c) => `${c}=excluded.${c}`).join(',');
  db.prepare(`INSERT INTO projects (${cols.join(',')}) VALUES (${placeholders})
    ON CONFLICT(project_id) DO UPDATE SET ${updates}`).run(...Object.values(row));
}

function upsertPayload(pid, kind, data) {
  db.prepare('INSERT OR REPLACE INTO project_payloads (project_id, kind, payload, updated_at) VALUES (?,?,?,?)')
    .run(Number(pid), kind, JSON.stringify(data || {}), now());
}

function upsertGlobal(kind, data) {
  db.prepare('INSERT OR REPLACE INTO project_globals (kind, payload, updated_at) VALUES (?,?,?)')
    .run(kind, JSON.stringify(data || {}), now());
}

// 归并本地已新建项目（local_records, entity=project）到 projects 表
function mergeLocalProjects() {
  const rows = db.prepare("SELECT * FROM local_records WHERE entity = 'project'").all();
  let merged = 0, deleted = 0;
  for (const row of rows) {
    const pid = Number(row.record_id);
    if (row.deleted) {
      db.prepare('UPDATE projects SET deleted = 1, updated_at = ? WHERE project_id = ?').run(now(), pid);
      deleted++;
      continue;
    }
    let p = {};
    try { p = JSON.parse(row.payload || '{}'); } catch {}
    upsertProject({
      project_id: pid,
      project_name: p.project_name || [p.area_name, p.room_number].filter(Boolean).join('') || ('本地项目' + pid),
      status: p.status || 1,
      start_date: p.start_date || String(row.created_at || '').slice(0, 10),
      end_date: p.end_date || '',
      area_name: p.area_name || '',
      room_number: p.room_number || ''
    }, { is_local: true });
    merged++;
  }
  if (merged || deleted) console.log(`  归并本地已建项目 ${merged} 条，本地删除标记 ${deleted} 条`);
}

// ---------------- 分页拉取项目列表 ----------------
async function pullProjectList(session, cred, apiPath, onItem, label) {
  let page = 1, pulled = 0;
  while (page <= MAX_PAGES) {
    const j = await cloudCall(apiPath, { page_index: page, page_size: PAGE_SIZE }, session, cred);
    if (j.code !== 0 || !j.data) {
      console.error('  ' + label + ' 第 ' + page + ' 页失败:', j.msg || j.raw || JSON.stringify(j).slice(0, 200));
      break;
    }
    const list = j.data.project_list || [];
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

  const admin = db.prepare('SELECT * FROM users WHERE is_administrator = 1 ORDER BY id ASC LIMIT 1').get();
  if (!admin || !admin.password_plain) {
    console.error('本地未找到管理员账号，请先启动服务器并完成一次本地登录后重试');
    process.exit(1);
  }

  console.log('[1/5] 云端登录:', admin.phone);
  const session = await cloudLogin(admin.phone, admin.password_plain);
  if (!session) {
    console.error('云端登录失败：请检查网络连接或账号密码');
    process.exit(1);
  }
  console.log('      登录成功 company_id=' + session.company_id);
  const cred = { phone: admin.phone, pwd: admin.password_plain };

  console.log('[2/5] 归并本地已建项目到 projects');
  mergeLocalProjects();

  // 项目列表（PC 完整列表）
  console.log('[3/5] 分页拉取项目列表');
  const pcCount = await pullProjectList(session, cred, '/project/pc/list/', upsertProject, '项目列表(PC)');
  // 移动端列表结构不同，单独存 mobile_json；/project/list/ 不支持分页参数（传 page_* 会返回空）
  const mobileJ = await cloudCall('/project/list/', {}, session, cred);
  let mobileCount = 0;
  if (mobileJ.code === 0 && mobileJ.data && Array.isArray(mobileJ.data.projects)) {
    for (const item of mobileJ.data.projects) {
      if (!item.project_id) continue;
      upsertProject(item, {});
      // 合并移动端字段到 mobile_json（键名与 PC 不同）
      db.prepare('UPDATE projects SET mobile_json = ?, area_name = ?, updated_at = ? WHERE project_id = ?')
        .run(JSON.stringify(item), item.area_name || '', now(), Number(item.project_id));
      mobileCount++;
    }
    console.log('  项目列表(移动) ' + mobileCount + ' 条（共 ' + (mobileJ.data.projects.length) + '）');
  } else {
    console.log('  项目列表(移动) 跳过:', mobileJ.msg || '响应异常');
  }
  // 已完成项目（补 customer 信息）
  const completed = await cloudCall('/project/completed/project/list/', { page_index: 1, page_size: PAGE_SIZE }, session, cred);
  if (completed.code === 0 && completed.data) {
    const list = completed.data.project_list || [];
    for (const item of list) {
      if (item.project_id) upsertProject(item, {});
      else upsertGlobal('completed_list_' + (item.project_id || 0), item); // project_id=0 的兜底行
    }
    upsertGlobal('completed_list', completed.data);
    console.log('  已完成项目 ' + list.length + ' 条');
  }

  // 公司级全局数据
  console.log('[4/5] 拉取公司级全局数据');
  const globals = [
    ['filter_settings', '/project/filter/list/', {}],
    ['pc_filter_project', '/project/pc/filter/project/info/', {}],
    ['pc_filter_role_user', '/project/pc/filter/role_user/info/', {}],
    ['template_list', '/project/template/list/', {}],
    ['todo_filter', '/project/todo/filter/info/', {}],
    ['step_labels', '/project/step/label/list/', {}],
    ['company_project_list', '/project/company/project/list/', {}]
  ];
  for (const [kind, api, body] of globals) {
    const j = await cloudCall(api, body, session, cred);
    if (j.code === 0 && j.data) { upsertGlobal(kind, j.data); console.log('  ' + kind + ' OK'); }
    else console.log('  ' + kind + ' 跳过:', j.msg || '响应异常');
  }

  // 每项目详情 + 子资源
  console.log('[5/5] ' + (withDetail ? '拉取每项目详情与子资源' : '跳过详情（--with-detail 开启）'));
  let detailCount = 0;
  if (withDetail) {
    const all = db.prepare('SELECT project_id FROM projects WHERE project_id < 900000000 ORDER BY project_id ASC').all();
    const subs = [
      ['areas', '/project/area/list/', (pid) => ({ project_id: pid })],
      ['tasks', '/project/task/list/', (pid) => ({ project_id: pid })],
      ['v2_tasks', '/project/v2/task/list/', (pid) => ({ project_id: pid })],
      ['all_tasks', '/project/all/task/list/', (pid) => ({ project_id: pid })],
      ['handled_tasks', '/project/handled/task/list/', (pid) => ({ project_id: pid })],
      ['weekly_plans', '/project/weekly_plan/list/', (pid) => ({ project_id: pid })],
      ['todos', '/project/todo/list/', (pid) => ({ project_id: pid })],
      ['construction_logs', '/project/construction_log/list/', (pid) => ({ project_id: pid })],
      ['desc', '/project/desc/list/', (pid) => ({ project_id: pid })],
      ['roles', '/project/role/list/', (pid) => ({ project_id: pid })],
      ['decorated_areas', '/project/decorated_area/list/', (pid) => ({ project_id: pid })]
    ];
    for (const r of all) {
      const pid = r.project_id;
      const d = await cloudCall('/project/detail/', { project_id: pid }, session, cred);
      if (d.code === 0 && d.data) {
        db.prepare('UPDATE projects SET detail_json = ?, updated_at = ? WHERE project_id = ?')
          .run(JSON.stringify(d.data), now(), pid);
        detailCount++;
      }
      for (const [kind, api, mkBody] of subs) {
        const j = await cloudCall(api, mkBody(pid), session, cred);
        if (j.code === 0 && j.data) upsertPayload(pid, kind, j.data);
      }
      // 周计划详情（按 weekly_plan_id 存 kind=weekly_plan_detail_<id>）
      const wp = db.prepare('SELECT payload FROM project_payloads WHERE project_id = ? AND kind = ?').get(pid, 'weekly_plans');
      if (wp) {
        try {
          const wpl = JSON.parse(wp.payload).weekly_planes || [];
          for (const w of wpl) {
            if (!w.weekly_plan_id) continue;
            const wd = await cloudCall('/project/weekly_plan/detail/', { weekly_plan_id: w.weekly_plan_id }, session, cred);
            if (wd.code === 0 && wd.data) upsertPayload(pid, 'weekly_plan_detail_' + w.weekly_plan_id, wd.data);
          }
        } catch {}
      }
      if (detailCount % 10 === 0) console.log('  已处理 ' + detailCount + '/' + all.length + ' 个项目');
    }
  }

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  console.log('\n迁移完成：项目列表 ' + pcCount + ' 条（PC）+ ' + mobileCount + ' 条（移动）' +
    (withDetail ? '，详情 ' + detailCount + ' 个' : '') + '，项目表总计 ' + cnt + ' 条');
  if (!withDetail) {
    console.log('提示：项目详情/子资源可后续补拉  node server/migrate-project.js --with-detail');
  }
}

main().catch((e) => { console.error('迁移异常', e); process.exit(2); });
