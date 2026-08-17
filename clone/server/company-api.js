/**
 * 企业后台（houtai Next.js 复刻版）接口实现
 * ---------------------------------------------------------------
 * 打通方案：houtai 后台与 webqianduan 前端操作端共享同一套本地 API + SQLite 数据库。
 * - 接口命名空间 /company/v2/admin/*（后台专用，与主站已有 /company/* 接口互不冲突）
 * - 所有接口本地权威落 SQLite（company_* 表，见 company-schema.js）
 * - 写操作联动主站快照：成员/部门 → crm_globals.department_members；
 *   材料/定额/预算模板 → budget_globals.*（前端操作端通过已有接口立即可读）
 * - houtai 通过 next.config rewrites 把 /api/* 代理到本服务（8080），
 *   请求头带 session-id（POST /company/login/ 返回）
 * ---------------------------------------------------------------
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { COMPANY_SCHEMA_SQL } = require('./company-schema');

// 9 亿号段起点（与主站"本地新建 id 走 9 亿号段"约定一致，永不与云端冲突）
const LOCAL_ID_BASE = 900000000;
// 模板市场云端快照路径（相对本文件所在 server 目录）
const MOCK_DIR_G = path.join(__dirname, '..', 'data', 'mock');

/**
 * 创建企业后台接口集
 * @param {import('node:sqlite').DatabaseSync} db 共享数据库实例
 * @param {{ok:Function, parseJson:Function, getSession:Function, dbNow:Function}} H 本地 API 辅助函数
 */
function createCompanyApi(db, H) {
  const { ok, parseJson, getSession, dbNow } = H;

  // ---------------- 通用工具 ----------------
  const j = (v, fb) => parseJson(v, fb);
  const genToken = () => crypto.randomBytes(16).toString('hex');

  // 模板市场快照（懒加载缓存）
  let _marketBundle = null;
  let _marketBundleTried = false;
  function marketBundle() {
    if (!_marketBundleTried) {
      _marketBundleTried = true;
      try {
        _marketBundle = JSON.parse(fs.readFileSync(path.join(MOCK_DIR_G, 'template_market_bundle.json'), 'utf8'));
      } catch (e) {
        _marketBundle = null;
      }
    }
    return _marketBundle;
  }
  function marketDetail(templateId) {
    const b = marketBundle();
    if (!b || !b.details) return null;
    return b.details[Number(templateId)] || null;
  }
  function marketStep(templateId, stepId) {
    const d = marketDetail(templateId);
    if (!d) return null;
    return (d.steps || []).find((s) => Number(s.step_id) === Number(stepId)) || null;
  }

  // JSON 文件快照存储（常用语/企业介绍/角色；我的模板用 my_templates_bundle.json）
  const _jsonCache = {};
  function jsonStore(name, fallback) {
    if (_jsonCache[name] !== undefined) return _jsonCache[name];
    try {
      _jsonCache[name] = JSON.parse(fs.readFileSync(path.join(MOCK_DIR_G, name), 'utf8'));
    } catch (e) {
      _jsonCache[name] = fallback || {};
    }
    return _jsonCache[name];
  }
  function saveStore(name, obj) {
    _jsonCache[name] = obj;
    try {
      fs.writeFileSync(path.join(MOCK_DIR_G, name), JSON.stringify(obj));
    } catch (e) { /* 忽略 */ }
  }
  function myTplBundle() {
    if (_jsonCache['__mytpl'] !== undefined) return _jsonCache['__mytpl'];
    try {
      _jsonCache['__mytpl'] = JSON.parse(fs.readFileSync(path.join(MOCK_DIR_G, 'my_templates_bundle.json'), 'utf8'));
    } catch (e) {
      _jsonCache['__mytpl'] = null;
    }
    return _jsonCache['__mytpl'];
  }
  function myTplDetail(templateId) {
    const b = myTplBundle();
    if (!b || !b.details) return null;
    return b.details[Number(templateId)] || null;
  }
  function myTplStep(templateId, stepId) {
    const d = myTplDetail(templateId);
    if (!d) return null;
    return (d.steps || []).find((s) => Number(s.step_id) === Number(stepId)) || null;
  }
  // 个性化设置快照读写
  function settingsData(key) {
    const s = jsonStore('settings_bundle.json', {});
    const e = s[key];
    if (e && e.ok) return ok(e.data);
    return { code: 1, msg: '配置数据缺失: ' + key, data: {} };
  }
  function settingsSet(key, body) {
    const s = jsonStore('settings_bundle.json', {});
    if (!s[key]) s[key] = { http: 200, ok: true, data: {} };
    s[key].data = { ...(s[key].data || {}), ...(body || {}) };
    saveStore('settings_bundle.json', s);
    return ok({});
  }

  // 取表内最大 id + 1（空表回退 1）
  function nextId(table, idCol) {
    const r = db.prepare(`SELECT MAX(${idCol}) AS m FROM ${table}`).get();
    return (Number(r && r.m) || 0) + 1;
  }

  // 部门 id：'D' + 数字（种子 D1..Dn）
  function nextDeptId() {
    const r = db.prepare("SELECT id FROM company_departments").all();
    let max = 0;
    for (const row of r) {
      const n = Number(String(row.id).replace(/^D/i, ''));
      if (n > max) max = n;
    }
    return 'D' + (max + 1);
  }

  // 会话校验（可选：未登录返回 null 由调用方决定）
  const sessionOf = (headers) => getSession(headers);

  // 成员行 → houtai MockMember 结构
  function memberView(row) {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      avatar: row.avatar,
      roles: j(row.roles_json, []),
      tag: row.tag,
      departmentId: row.department_id,
      departmentIds: j(row.department_ids_json, row.department_id ? [row.department_id] : []),
      enabled: row.enabled ? true : false,
    };
  }
  function memberDeletedView(row) {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      department: row.deleted_by,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
    };
  }

  // ================ 联动：重建主站部门成员快照 ================
  // 保留云端原有部门/成员，把后台（houtai）部门与成员合并进去（按 id 去重）
  function rebuildDeptMembersSnapshot() {
    const old = (() => {
      const r = db.prepare("SELECT payload FROM crm_globals WHERE kind='department_members'").get();
      return r ? j(r.payload, null) : null;
    })();
    const oldDepts = (old && Array.isArray(old.department_list)) ? old.department_list : [];
    const oldMembers = (old && Array.isArray(old.department_member_list)) ? old.department_member_list : [];

    const depts = db.prepare('SELECT * FROM company_departments ORDER BY sort, id').all();
    const members = db.prepare('SELECT * FROM company_members WHERE deleted = 0 ORDER BY id').all();
    // 快照合并"只增不减"的补救：剔除已软删除的后台成员，
    // 否则后台删除成员后主站通讯录/部门成员快照仍残留显示
    const deletedMemberIds = new Set(db.prepare('SELECT id FROM company_members WHERE deleted = 1').all().map((r) => Number(r.id)));

    // 后台部门 → 云端结构（department_id 用稳定数值：D 前缀序号 → 10000+n）
    const deptNo = (did) => {
      const n = Number(String(did).replace(/^D/i, '')) || 0;
      return 10000 + n;
    };
    const deptList = depts.map((d) => ({ department_id: deptNo(d.id), department_name: d.name }));
    // 合并部门（按数值 id 去重）
    const mergedDepts = [...oldDepts];
    for (const d of deptList) {
      if (!mergedDepts.some((x) => Number(x.department_id) === Number(d.department_id))) mergedDepts.push(d);
    }
    // 后台成员 → 云端 user_info 结构
    const memberList = members.map((m) => ({
      department_id: deptNo(m.department_id),
      department_name: (depts.find((d) => d.id === m.department_id) || {}).name || '',
      user_info: [{
        user_id: m.id,
        user_name: m.name,
        user_phone: m.phone,
        user_avatar: m.avatar,
        user_accid: '',
        roles: j(m.roles_json, []).map((name) => ({ role_id: 0, role_name: name })),
        is_leader: 0,
      }],
    }));
    // 合并成员（按 department_id + user_id 去重）
    const mergedMembers = oldMembers
      // 先剔除快照中已软删除的后台成员（其 user_id 命中 company_members.deleted=1）
      .filter((ml) => !(ml.user_info || []).some((u) => deletedMemberIds.has(Number(u.user_id))))
      .map((ml) => {
        // 组内同样剔除已删除成员，避免同一部门内残留
        const kept = (ml.user_info || []).filter((u) => !deletedMemberIds.has(Number(u.user_id)));
        return { ...ml, user_info: kept };
      });
    for (const ml of memberList) {
      const hit = mergedMembers.find((x) => Number(x.department_id) === Number(ml.department_id));
      if (hit) {
        for (const u of ml.user_info) {
          if (!hit.user_info.some((y) => Number(y.user_id) === Number(u.user_id))) hit.user_info.push(u);
        }
      } else {
        mergedMembers.push(ml);
      }
    }
    db.prepare(`INSERT INTO crm_globals (kind, payload, updated_at) VALUES ('department_members', ?, ?)
      ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(JSON.stringify({ department_list: mergedDepts, department_member_list: mergedMembers }), dbNow());
  }

  // ================ 联动：材料 → 主站 material_list 快照 ================
  function syncMaterialSnapshot() {
    const old = (() => {
      const r = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      return r ? j(r.payload, null) : null;
    })();
    const oldData = old && typeof old === 'object' ? old : { bands: [], suppliers: [], main_suppliers: [], assist_suppliers: [], materials: [], total_num: 0 };
    const rows = db.prepare('SELECT * FROM company_materials ORDER BY id').all();
    const mine = rows.map((m) => {
      const p = j(m.payload, {});
      // 种子/编辑保留了云端原始字段（specification/cost_price...）时直接复用，避免破坏主站预算结构
      if (p.specification !== undefined && p.cost_price !== undefined) {
        return { ...p, id: m.id, enable: m.enabled ? 1 : 0, is_local: 1 };
      }
      return {
        id: m.id,
        name: m.name,
        type: 0,
        enable: m.enabled ? 1 : 0,
        commodity_type_id: 0,
        band: m.brand,
        model: m.model,
        specification: m.spec,
        cost_unit: p.costUnit || '',
        sale_unit: p.quoteUnit || '',
        unit_rate: '1',
        profit_rate: '0',
        loss_rate: p.lossRate || 0,
        cost_price: String(p.costPrice ?? 0),
        sale_price: String(p.quotePrice ?? 0),
        min_sale_price: String(p.minQuote ?? 0),
        image: '',
        description: '',
        is_self_warehouse: 1,
        supplier_id: 0,
        supplier_name: m.supplier || '',
        is_local: 1,
      };
    });
    // 主站云端材料按 id 去重，后台材料覆盖/追加
    const cloudMats = Array.isArray(oldData.materials) ? oldData.materials : [];
    const base = cloudMats.filter((x) => !mine.some((y) => Number(y.id) === Number(x.id)));
    const data = { ...oldData, materials: [...base, ...mine], total_num: base.length + mine.length };
    db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('material_list', ?, ?)
      ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(JSON.stringify(data), dbNow());
  }

  // ================ 联动：定额 → 主站定额快照 ================
  function syncQuotaSnapshots() {
    const types = db.prepare('SELECT * FROM company_quota_types ORDER BY id').all();
    const quotas = db.prepare('SELECT * FROM company_quotas ORDER BY id').all();
    const typeTree = types.map((t) => ({
      id: t.id,
      name: t.name,
      dir_class: 0,
      order: 0,
      parent_id: 0,
      enable: 1,
      project_quota_list: quotas
        .filter((q) => q.quota_type_id === t.id)
        .map((q) => ({ id: q.id, name: q.name, unit: q.unit, content: j(q.payload, {}).content || '', enable: 1 })),
    }));
    db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run('project_quota_types', JSON.stringify({ project_quota_types: types.map((t) => ({ id: t.id, name: t.name, enable: 1 })) }), dbNow());
    db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run('project_quota_list', JSON.stringify({ project_quota_list: typeTree }), dbNow());
    db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run('project_quota_contents', JSON.stringify({ project_quota_contents: quotas.map((q) => ({ id: q.id, name: q.name, unit: q.unit, content: j(q.payload, {}).content || '' })) }), dbNow());
  }

  // ================ 联动：预算模板 → 主站 template_list 快照 ================
  function syncTemplateSnapshot() {
    const old = (() => {
      const r = db.prepare("SELECT payload FROM budget_globals WHERE kind='template_list'").get();
      return r ? j(r.payload, null) : null;
    })();
    const oldTemplates = (old && Array.isArray(old.templates)) ? old.templates : [];
    const rows = db.prepare('SELECT * FROM company_budget_templates ORDER BY id').all();
    const mine = rows.map((t) => ({
      id: t.id,
      type: 0,
      status: t.enabled ? 1 : 0,
      is_material_template: 0,
      name: t.name,
      area_num: j(t.payload, {}).areaNum || 0,
      update_time: dbNow().slice(0, 16).replace('T', ' '),
    }));
    const base = oldTemplates.filter((x) => !mine.some((y) => Number(y.id) === Number(x.id)));
    db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('template_list', ?, ?)
      ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(JSON.stringify({ templates: [...base, ...mine] }), dbNow());
  }

  // ================ 接口集 ================
  const handlers = {
    /* ---------------- 部门 ---------------- */
    'POST /company/v2/admin/department/list/': () => {
      const rows = db.prepare('SELECT * FROM company_departments ORDER BY sort, id').all();
      return ok({ departments: rows.map((r) => ({
        id: r.id, name: r.name, count: r.count, parentId: r.parent_id || null, owner: r.owner, dataOwner: r.data_owner,
      })) });
    },
    'POST /company/v2/admin/department/add/': ({ body }) => {
      const name = String((body && body.name) || '').trim();
      if (!name) return { code: 10011, msg: '部门名称不能为空', data: {} };
      const id = nextDeptId();
      db.prepare('INSERT INTO company_departments (id, name, count, parent_id, owner, data_owner, sort, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, name, 0, String((body && body.parentId) || ''), String((body && body.owner) || ''), String((body && body.dataOwner) || ''), nextId('company_departments', 'sort'), dbNow());
      rebuildDeptMembersSnapshot();
      return ok({ department: { id, name, count: 0, parentId: (body && body.parentId) || null, owner: (body && body.owner) || '', dataOwner: (body && body.dataOwner) || '' } });
    },
    'POST /company/v2/admin/department/edit/': ({ body }) => {
      const id = String((body && body.id) || '');
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_departments WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      db.prepare('UPDATE company_departments SET name = ?, owner = ?, data_owner = ? WHERE id = ?')
        .run(String(body.name ?? row.name), String(body.owner ?? row.owner), String(body.dataOwner ?? row.data_owner), id);
      rebuildDeptMembersSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/department/del/': ({ body }) => {
      const id = String((body && body.id) || '');
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('DELETE FROM company_departments WHERE id = ? OR parent_id = ?').run(id, id);
      db.prepare("UPDATE company_members SET department_id = '' WHERE department_id = ?").run(id);
      rebuildDeptMembersSnapshot();
      return ok({});
    },

    /* ---------------- 成员 ---------------- */
    'POST /company/v2/admin/member/list/': ({ body }) => {
      const kw = String((body && body.keyword) || '').toLowerCase();
      let rows = db.prepare('SELECT * FROM company_members WHERE deleted = 0 ORDER BY id').all();
      if (kw) rows = rows.filter((m) => m.name.toLowerCase().includes(kw) || m.phone.includes(kw));
      return ok({ members: rows.map(memberView) });
    },
    'POST /company/v2/admin/member/add/': ({ body }) => {
      const name = String((body && body.name) || '').trim();
      const phone = String((body && body.phone) || '').trim();
      if (!name || !phone) return { code: 10011, msg: '参数错误', data: {} };
      const id = nextId('company_members', 'id');
      const deptId = String((body && body.departmentId) || '');
      const roles = Array.isArray(body.roles) ? body.roles : [];
      db.prepare('INSERT INTO company_members (id, name, phone, avatar, roles_json, tag, department_id, department_ids_json, enabled, deleted, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, name, phone, String((body && body.avatar) || '/images/avatar-default.png'), JSON.stringify(roles),
          String((body && body.tag) || ''), deptId, JSON.stringify([deptId]), 1, 0, dbNow());
      // 同步创建 users 表记录（默认密码 123456），使新成员可用手机号登录主站
      const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (!existing) {
        const admin = db.prepare('SELECT company_id, company_name FROM users WHERE is_administrator = 1 LIMIT 1').get();
        db.prepare('INSERT INTO users (phone, password, password_plain, name, company_id, company_name, is_administrator) VALUES (?, ?, ?, ?, ?, ?, 0)')
          .run(phone, H.md5('123456'), '123456', name, (admin && admin.company_id) || 0, (admin && admin.company_name) || '本地企业');
      }
      rebuildDeptMembersSnapshot();
      return ok({ member: memberView(db.prepare('SELECT * FROM company_members WHERE id = ?').get(id)) });
    },
    'POST /company/v2/admin/member/edit/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_members WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const next = { ...row };
      if (body.name !== undefined) next.name = String(body.name);
      if (body.phone !== undefined) next.phone = String(body.phone);
      if (body.avatar !== undefined) next.avatar = String(body.avatar);
      if (body.roles !== undefined) next.roles_json = JSON.stringify(Array.isArray(body.roles) ? body.roles : []);
      if (body.tag !== undefined) next.tag = String(body.tag);
      if (body.enabled !== undefined) next.enabled = body.enabled ? 1 : 0;
      if (body.departmentId !== undefined) { next.department_id = String(body.departmentId); next.department_ids_json = JSON.stringify([String(body.departmentId)]); }
      db.prepare('UPDATE company_members SET name=?, phone=?, avatar=?, roles_json=?, tag=?, enabled=?, department_id=?, department_ids_json=? WHERE id=?')
        .run(next.name, next.phone, next.avatar, next.roles_json, next.tag, next.enabled, next.department_id, next.department_ids_json, id);
      rebuildDeptMembersSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/member/del/': ({ body }) => {
      const id = Number(body && body.id);
      const mode = (body && body.mode) || 'hard';
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_members WHERE id = ?').get(id);
      if (!row) return ok({});
      if (mode === 'remove') {
        db.prepare('DELETE FROM company_members WHERE id = ?').run(id);
      } else {
        db.prepare('UPDATE company_members SET deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?')
          .run(new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'), '管理员', id);
      }
      rebuildDeptMembersSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/member/adjust/': ({ body }) => {
      const id = Number(body && body.id);
      const deptId = String((body && body.departmentId) || '');
      if (!id || !deptId) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE company_members SET department_id = ?, department_ids_json = ? WHERE id = ?').run(deptId, JSON.stringify([deptId]), id);
      rebuildDeptMembersSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/member/deleted/list/': ({ body }) => {
      const kw = String((body && body.keyword) || '').toLowerCase();
      let rows = db.prepare('SELECT * FROM company_members WHERE deleted = 1 ORDER BY deleted_at DESC').all();
      if (kw) rows = rows.filter((m) => m.name.toLowerCase().includes(kw) || m.phone.includes(kw));
      return ok({ members: rows.map(memberDeletedView) });
    },
    'POST /company/v2/admin/member/restore/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_members WHERE id = ?').get(id);
      if (row) {
        db.prepare("UPDATE company_members SET deleted = 0, deleted_at = '', deleted_by = '' WHERE id = ?").run(id);
        db.prepare("UPDATE company_members SET department_id = 'D1', department_ids_json = ? WHERE id = ? AND department_id = ''").run(JSON.stringify(['D1']), id);
      }
      rebuildDeptMembersSnapshot();
      return ok({});
    },

    /* ---------------- 角色 / 权限 ---------------- */
    'POST /company/v2/admin/role/groups/': () => {
      const rows = db.prepare('SELECT * FROM company_role_groups ORDER BY id').all();
      return ok({ roleGroups: rows.map((r) => ({ id: r.id, payload: j(r.payload, {}) })).map((r) => r.payload) });
    },
    'POST /company/v2/admin/role/add/': ({ body }) => {
      const id = nextId('company_role_groups', 'id');
      const payload = {
        id,
        name: (body && body.name) || '自定义角色组',
        roleIds: (body && body.roleIds) || [],
        duty: (body && body.duty) || '',
        permissions: (body && body.permissions) || [],
      };
      db.prepare('INSERT INTO company_role_groups (id, payload) VALUES (?, ?)').run(id, JSON.stringify(payload));
      return ok({});
    },
    'POST /company/v2/admin/permission/tree/': ({ body }) => {
      const key = (body && body.key) === 'backend' ? 'backend' : 'app';
      const row = db.prepare('SELECT payload FROM company_permission_trees WHERE key = ?').get(key);
      if (!row) return ok({ permissionTree: [] });
      return ok({ permissionTree: j(row.payload, []) });
    },

    /* ---------------- 企业信息 ---------------- */
    'POST /company/v2/admin/company/info/': () => {
      const row = db.prepare('SELECT payload FROM company_info WHERE id = 1').get();
      if (!row) return ok({ companyInfo: {} });
      return ok({ companyInfo: j(row.payload, {}) });
    },
    'POST /company/v2/admin/company/info/update/': ({ body }) => {
      const row = db.prepare('SELECT payload FROM company_info WHERE id = 1').get();
      const cur = row ? j(row.payload, {}) : {};
      const next = { ...cur, ...(body || {}) };
      db.prepare(`INSERT INTO company_info (id, payload, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
        .run(JSON.stringify(next), dbNow());
      return ok({});
    },

    /* ---------------- 轮播图 ---------------- */
    'POST /company/v2/admin/banner/list/': () => {
      const rows = db.prepare('SELECT * FROM company_banners ORDER BY sort, id').all();
      return ok({ banners: rows.map((r) => ({ id: r.id, title: r.title, url: r.url, image: r.image, enabled: r.enabled ? true : false })) });
    },
    'POST /company/v2/admin/banner/add/': ({ body }) => {
      const id = nextId('company_banners', 'id');
      db.prepare('INSERT INTO company_banners (id, title, url, image, enabled, sort) VALUES (?,?,?,?,?,?)')
        .run(id, String((body && body.title) || ''), String((body && body.url) || ''), String((body && body.image) || ''), 1, id);
      return ok({});
    },
    'POST /company/v2/admin/banner/edit/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_banners WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      db.prepare('UPDATE company_banners SET title=?, url=?, image=?, enabled=? WHERE id=?')
        .run(String(body.title ?? row.title), String(body.url ?? row.url), String(body.image ?? row.image), body.enabled === undefined ? row.enabled : (body.enabled ? 1 : 0), id);
      return ok({});
    },
    'POST /company/v2/admin/banner/del/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('DELETE FROM company_banners WHERE id = ?').run(id);
      return ok({});
    },
    'POST /company/v2/admin/banner/toggle/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE company_banners SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
      return ok({});
    },

    /* ---------------- 分公司 ---------------- */
    'POST /company/v2/admin/branch/list/': () => {
      const rows = db.prepare('SELECT * FROM company_branches ORDER BY id').all();
      return ok({ branches: rows.map((r) => j(r.payload, {})) });
    },
    'POST /company/v2/admin/branch/add/': ({ body }) => {
      const id = nextId('company_branches', 'id');
      const payload = { id, ...(body || {}), addedAt: new Date().toLocaleDateString('zh-CN') };
      db.prepare('INSERT INTO company_branches (id, payload, name, city) VALUES (?,?,?,?)')
        .run(id, JSON.stringify(payload), String(payload.name || ''), String(payload.city || ''));
      return ok({});
    },
    'POST /company/v2/admin/branch/edit/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_branches WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const cur = j(row.payload, {});
      const next = { ...cur, ...(body || {}), id };
      db.prepare('UPDATE company_branches SET payload=?, name=?, city=? WHERE id=?')
        .run(JSON.stringify(next), String(next.name || ''), String(next.city || ''), id);
      return ok({});
    },
    'POST /company/v2/admin/branch/copy/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_branches WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const nid = nextId('company_branches', 'id');
      const cur = j(row.payload, {});
      const copy = { ...cur, id: nid, name: (cur.name || '') + ' 副本', addedAt: new Date().toLocaleDateString('zh-CN') };
      db.prepare('INSERT INTO company_branches (id, payload, name, city) VALUES (?,?,?,?)')
        .run(nid, JSON.stringify(copy), String(copy.name || ''), String(copy.city || ''));
      return ok({});
    },

    /* ---------------- 管理员 / 账号 ---------------- */
    'POST /company/v2/admin/admin/list/': ({ body }) => {
      const type = (body && body.type) || 'backend';
      const rows = db.prepare('SELECT * FROM company_admins WHERE type = ? ORDER BY id').all();
      return ok({ admins: rows.map((r) => ({ id: r.id, name: r.name, memberId: r.member_id, type: r.type, account: r.account, permissions: j(r.permissions_json, []) })) });
    },
    'POST /company/v2/admin/admin/add/': ({ body }) => {
      const id = nextId('company_admins', 'id');
      db.prepare('INSERT INTO company_admins (id, name, member_id, type, account, permissions_json) VALUES (?,?,?,?,?,?)')
        .run(id, String((body && body.name) || ''), Number((body && body.memberId) || 0), String((body && body.type) || 'backend'),
          String((body && body.account) || ''), JSON.stringify((body && body.permissions) || []));
      return ok({});
    },
    'POST /company/v2/admin/admin/edit/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_admins WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      db.prepare('UPDATE company_admins SET name=?, member_id=?, permissions_json=? WHERE id=?')
        .run(String(body.name ?? row.name), Number(body.memberId ?? row.member_id),
          JSON.stringify((body && body.permissions) || j(row.permissions_json, [])), id);
      return ok({});
    },
    'POST /company/v2/admin/admin/del/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('DELETE FROM company_admins WHERE id = ?').run(id);
      return ok({});
    },

    /* ---------------- 供应商 ---------------- */
    'POST /company/v2/admin/supplier/list/': ({ body }) => {
      const status = String((body && body.status) || '');
      const kw = String((body && body.keyword) || '').toLowerCase();
      let rows = db.prepare('SELECT * FROM company_suppliers ORDER BY id').all();
      if (status) rows = rows.filter((s) => s.status === status);
      if (kw) rows = rows.filter((s) => s.name.toLowerCase().includes(kw) || s.contact.toLowerCase().includes(kw) || s.phone.includes(kw));
      return ok({ suppliers: rows.map((r) => j(r.payload, {})) });
    },
    'POST /company/v2/admin/supplier/invite/': ({ body }) => {
      const id = nextId('company_suppliers', 'id');
      const payload = {
        id,
        addedAt: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }),
        maxUpload: 1000,
        status: '合作中',
        ...(body || {}),
      };
      db.prepare('INSERT INTO company_suppliers (id, payload, name, contact, phone, type, status, warehouse_enabled) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, JSON.stringify(payload), String(payload.name || ''), String(payload.contact || ''), String(payload.phone || ''),
          String(payload.type || ''), String(payload.status || '合作中'), payload.warehouseEnabled ? 1 : 0);
      return ok({});
    },
    'POST /company/v2/admin/supplier/edit/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_suppliers WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const cur = j(row.payload, {});
      const next = { ...cur, ...(body || {}), id };
      db.prepare('UPDATE company_suppliers SET payload=?, name=?, contact=?, phone=?, type=?, status=?, warehouse_enabled=? WHERE id=?')
        .run(JSON.stringify(next), String(next.name || ''), String(next.contact || ''), String(next.phone || ''),
          String(next.type || ''), String(next.status || '合作中'), next.warehouseEnabled ? 1 : 0, id);
      return ok({});
    },
    'POST /company/v2/admin/supplier/del/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('DELETE FROM company_suppliers WHERE id = ?').run(id);
      return ok({});
    },
    'POST /company/v2/admin/supplier/types/': () => {
      const rows = db.prepare('SELECT * FROM company_supplier_types ORDER BY id').all();
      return ok({ types: rows.map((r) => r.name) });
    },

    /* ---------------- 材料库 ---------------- */
    'POST /company/v2/admin/material/list/': ({ body }) => {
      const f = (body && body.filter) || {};
      let rows = db.prepare('SELECT * FROM company_materials ORDER BY id').all();
      if (f.keyword) {
        const kw = String(f.keyword).toLowerCase();
        rows = rows.filter((m) => m.name.toLowerCase().includes(kw) || m.brand.toLowerCase().includes(kw) || m.model.toLowerCase().includes(kw) || m.spec.toLowerCase().includes(kw) || m.supplier.toLowerCase().includes(kw));
      }
      if (f.source && f.source !== '全部') rows = rows.filter((m) => m.source === f.source);
      if (f.category) {
        const [c1, c2] = String(f.category).split('>');
        rows = rows.filter((m) => m.category === c1 && (!c2 || m.sub_category === c2));
      }
      if (f.enabled === '启用') rows = rows.filter((m) => m.enabled);
      if (f.enabled === '未启用') rows = rows.filter((m) => !m.enabled);
      return ok({ materials: rows.map((r) => j(r.payload, {})) });
    },
    'POST /company/v2/admin/material/categories/': () => {
      const rows = db.prepare('SELECT * FROM company_material_categories ORDER BY id').all();
      return ok({ categories: rows.map((r) => ({ id: r.id, name: r.name, children: j(r.children_json, []) })) });
    },
    'POST /company/v2/admin/material/add/': ({ body }) => {
      const id = nextId('company_materials', 'id');
      const p = {
        id,
        lossRate: 0,
        minQuote: 0,
        enabled: true,
        source: '装企仓库',
        ...(body || {}),
      };
      db.prepare('INSERT INTO company_materials (id, payload, name, category, sub_category, brand, model, spec, source, supplier, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, JSON.stringify(p), String(p.name || ''), String(p.category || ''), String(p.subCategory || ''),
          String(p.brand || ''), String(p.model || ''), String(p.spec || ''), String(p.source || ''), String(p.supplier || ''), p.enabled ? 1 : 0, dbNow());
      syncMaterialSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/material/edit/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_materials WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const cur = j(row.payload, {});
      const next = { ...cur, ...(body || {}), id };
      db.prepare('UPDATE company_materials SET payload=?, name=?, category=?, sub_category=?, brand=?, model=?, spec=?, source=?, supplier=?, enabled=? WHERE id=?')
        .run(JSON.stringify(next), String(next.name || ''), String(next.category || ''), String(next.subCategory || ''),
          String(next.brand || ''), String(next.model || ''), String(next.spec || ''), String(next.source || ''), String(next.supplier || ''), next.enabled ? 1 : 0, id);
      syncMaterialSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/material/del/': ({ body }) => {
      const ids = Array.isArray(body && body.ids) ? body.ids.map(Number) : [];
      if (!ids.length) return { code: 10011, msg: '参数错误', data: {} };
      const ph = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM company_materials WHERE id IN (${ph})`).run(...ids);
      syncMaterialSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/material/toggle/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE company_materials SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, id);
      syncMaterialSnapshot();
      return ok({});
    },

    /* ---------------- 原版材料接口（辅料库 / 启用列表共用） ----------------
       主站 enterprise 前端（辅料库 chunk-3ef68c89、启用列表 chunk-2336781f、材料库
       chunk-4060357f、报价选材 chunk-15032452/21663b50）直接调用 /budget/material/*、
       /company/budget/min_sale/config/*。此处统一以 material_list 快照为数据源，
       写操作同时落 company_materials 表并重建快照，保证与 houtai 材料库同源。
    */
    // 材料列表：支持 辅料库(commodity_type_id/search_key/commodity_content_type) 与 报价选材(status:1) 过滤；
    // 无过滤参数时返回全量（与旧 budgetGlobal 行为一致，兼容主站预算页）
    'POST /budget/material/list/': ({ body }) => {
      const b = body || {};
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (!row) return null; // 无快照回退代理
      const d = j(row.payload, { materials: [], bands: [], suppliers: [] });
      let mats = Array.isArray(d.materials) ? d.materials : [];
      // 合并商品表独有行（辅材如乳胶漆仅存在于 commodity_commodities，不在快照中）
      const snapIds = new Set(mats.map((m) => Number(m.id)));
      const extraRows = db.prepare('SELECT * FROM commodity_commodities').all();
      for (const r of extraRows) {
        if (snapIds.has(Number(r.id))) continue;
        mats.push({
          id: Number(r.id),
          name: r.name,
          type: Number(r.content_type || 0) || (Number(r.commodity_content_id) === 152 ? 1 : 0),
          enable: 1,
          commodity_type_id: Number(r.commodity_type_id) || 0,
          commodity_content_id: Number(r.commodity_content_id) || 0,
          commodity_content_name: r.commodity_content_name || '',
          band: r.band,
          model: r.model,
          specification: r.specification,
          cost_unit_id: 0,
          cost_unit: r.unit || '',
          sale_unit_id: 0,
          sale_unit: r.unit || '',
          unit_rate: '1',
          profit_rate: '0',
          loss_rate: '0',
          cost_price: String(r.sale_price || ''),
          sale_price: String(r.sale_price || ''),
          min_sale_price: String(r.sale_price || ''),
          image: r.image || '',
          description: r.description || '',
          is_self_warehouse: 1,
          supplier_id: 0,
          supplier_name: '装企仓库',
          is_local: 1,
        });
      }
      const cct = b.commodity_content_type !== undefined && b.commodity_content_type !== null && b.commodity_content_type !== '' ? Number(b.commodity_content_type) : null;
      if (cct !== null) {
        mats = mats.filter((m) => (cct === 1) === ((Number(m.type) === 1) || (Number(m.commodity_content_id) === 152)));
      }
      const ctid = b.commodity_type_id !== undefined && b.commodity_type_id !== null && b.commodity_type_id !== '' ? Number(b.commodity_type_id) : null;
      if (ctid) mats = mats.filter((m) => Number(m.commodity_type_id) === ctid);
      const kw = b.search_key ? String(b.search_key).toLowerCase() : '';
      if (kw) mats = mats.filter((m) => [m.name, m.band, m.model, m.specification].some((v) => String(v || '').toLowerCase().includes(kw)));
      const band = b.band_name ? String(b.band_name) : '';
      if (band) mats = mats.filter((m) => String(m.band || '') === band);
      const st = b.status !== undefined && b.status !== null && b.status !== '' ? Number(b.status) : null;
      if (st !== null) mats = mats.filter((m) => Number(m.enable) === st);
      return ok({ ...d, materials: mats, total_num: mats.length, total_material_num: mats.length });
    },
    // 启用列表：按 enable 状态 + 品牌/供应商/搜索 过滤 + 分页（原版 /budget/material/enable/list/）
    'POST /budget/material/enable/list/': ({ body }) => {
      const b = body || {};
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (!row) return null;
      const d = j(row.payload, { materials: [], bands: [], suppliers: [] });
      let mats = Array.isArray(d.materials) ? d.materials : [];
      const st = b.status !== undefined && b.status !== null && b.status !== '' ? Number(b.status) : null;
      if (st !== null) mats = mats.filter((m) => Number(m.enable) === st);
      const sid = Number(b.supplier_id) || 0;
      if (sid) mats = mats.filter((m) => Number(m.supplier_id) === sid);
      const band = b.band_name ? String(b.band_name) : '';
      if (band) mats = mats.filter((m) => String(m.band || '') === band);
      const kw = b.search_key ? String(b.search_key).toLowerCase() : '';
      if (kw) mats = mats.filter((m) => [m.name, m.band, m.model, m.specification].some((v) => String(v || '').toLowerCase().includes(kw)));
      // 发布时间列：优先行内 create_time，回退 company_materials.created_at
      const cmRows = db.prepare('SELECT id, created_at FROM company_materials').all();
      const cmMap = new Map(cmRows.map((r) => [Number(r.id), String(r.created_at || '').slice(0, 10)]));
      const total = mats.length;
      const ps = Number(b.page_size) || 20;
      const pi = Math.max(1, Number(b.page_index) || 1);
      const page = mats.map((m) => ({
        ...m,
        create_time: m.create_time || cmMap.get(Number(m.id)) || '',
      })).slice((pi - 1) * ps, pi * ps);
      return ok({ materials: page, total_material_num: total, bands: d.bands || [], suppliers: d.suppliers || [] });
    },
    // 计量单位下拉：常用单位 + 该类型材料实际使用的单位（原版 /budget/material/unit/list/）
    'POST /budget/material/unit/list/': ({ body }) => {
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      let mats = [];
      if (row) {
        const d = j(row.payload, { materials: [] });
        if (Array.isArray(d.materials)) mats = d.materials;
      }
      const ctid = body && body.commodity_type_id ? Number(body.commodity_type_id) : null;
      if (ctid) mats = mats.filter((m) => Number(m.commodity_type_id) === ctid);
      const names = [];
      const add = (n) => {
        const s = String(n || '').trim();
        if (s && !names.includes(s)) names.push(s);
      };
      ['项', '个', '张', '块', '米', '平方米', '立方米', '桶', '件', '套', '卷', '组', '根', '公斤'].forEach(add);
      mats.forEach((m) => { add(m.sale_unit); add(m.cost_unit); });
      return ok({ units: names.map((name, i) => ({ id: i + 1, name })) });
    },
    // 最低销售价配置：get/set（原版 /company/budget/min_sale/config/get|set/）
    'POST /company/budget/min_sale/config/get/': () => {
      const r = db.prepare("SELECT payload FROM budget_globals WHERE kind='min_sale_config'").get();
      const d = r ? j(r.payload, {}) : {};
      return ok({ main_material_min_sale: Number(d.main_material_min_sale) || 0, project_quota_sale_switch: Number(d.project_quota_sale_switch) || 0 });
    },
    'POST /company/budget/min_sale/config/set/': ({ body }) => {
      const r = db.prepare("SELECT payload FROM budget_globals WHERE kind='min_sale_config'").get();
      const cur = r ? j(r.payload, {}) : {};
      const next = { ...cur, ...(body || {}) };
      db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('min_sale_config',?,?)
        ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
        .run(JSON.stringify(next), dbNow());
      return ok({});
    },
    // 内容分类树（辅料库用）：commodity_content_type=1 仅返回辅材分类（type===1）
    'POST /budget/commodity_content/list/': ({ body }) => {
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='commodity_content'").get();
      if (!row) return null;
      const d = j(row.payload, { contents: [] });
      let contents = Array.isArray(d.contents) ? d.contents : [];
      const cct = body && body.commodity_content_type !== undefined && body.commodity_content_type !== null && body.commodity_content_type !== '' ? Number(body.commodity_content_type) : null;
      if (cct !== null) contents = contents.filter((c) => Number(c.type) === cct);
      return ok({ contents });
    },

    /* ---------------- 模板市场（原版 /template/market/*，数据为云端快照） ---------------- */
    // 云端快照：施工模板市场列表 + 各模板步骤/任务/通知/工法（data/mock/template_market_bundle.json）
    'POST /template/market/list/': () => {
      const b = marketBundle();
      if (!b || !b.list) return { code: 1, msg: '模板市场数据缺失', data: {} };
      return { code: 0, msg: '成功', data: b.list.data || {} };
    },
    'POST /template/market/step/list/': ({ body }) => {
      const d = marketDetail(body && body.template_id);
      if (!d) return { code: 10122, msg: '参数错误', data: {} };
      return ok({ steps: d.steps.map((s) => ({ step_id: s.step_id, step_name: s.step_name, start_day: s.start_day, end_day: s.end_day, step_order: s.step_order })) });
    },
    'POST /template/market/step/task/list/': ({ body }) => {
      const s = marketStep(body && body.template_id, body && body.step_id);
      if (!s) return { code: 10122, msg: '参数错误', data: {} };
      return ok({ tasks: s.tasks || [] });
    },
    'POST /template/market/step/notify/list/': ({ body }) => {
      const s = marketStep(body && body.template_id, body && body.step_id);
      if (!s) return { code: 10122, msg: '参数错误', data: {} };
      return ok({ notifies: s.notifies || [] });
    },
    'POST /template/market/step/craft/list/': ({ body }) => {
      const s = marketStep(body && body.template_id, body && body.step_id);
      if (!s) return { code: 10122, msg: '参数错误', data: {} };
      return ok({ crafts: s.crafts || [] });
    },
    'POST /template/market/import/': ({ body }) => {
      const tid = Number(body && body.template_id) || 0;
      if (!tid) return { code: 10122, msg: '参数错误', data: {} };
      // 记录导入（我的模板页后续读取）
      try {
        const p = path.join(MOCK_DIR_G, 'template_market_imported.json');
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { arr = []; }
        if (!arr.some((x) => Number(x.template_id) === tid)) {
          arr.push({ template_id: tid, name: String(body && body.name || ''), imported_at: dbNow() });
          fs.writeFileSync(p, JSON.stringify(arr));
        }
      } catch (e) { /* 忽略存储失败 */ }
      return ok({});
    },

    /* ---------------- 常用语（原版 /company/terminology/*，云端快照） ---------------- */
    'POST /company/terminology/list/': () => {
      const s = jsonStore('terminology_store.json', { terminologies: [], roles: [] });
      return ok({ terminologies: Array.isArray(s.terminologies) ? s.terminologies : [] });
    },
    'POST /company/terminology/role/list/': () => {
      const s = jsonStore('terminology_store.json', { terminologies: [], roles: [] });
      return ok({ roles: Array.isArray(s.roles) ? s.roles : [] });
    },
    'POST /company/terminology/add/': ({ body }) => {
      const content = String((body && (body.content || body.name)) || '').trim();
      if (!content) return { code: 10011, msg: '参数错误', data: {} };
      const s = jsonStore('terminology_store.json', { terminologies: [], roles: [] });
      const id = (s.terminologies.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0)) + 1;
      s.terminologies.push({ id, content, use_num: 0 });
      saveStore('terminology_store.json', s);
      return ok({ id });
    },
    'POST /company/terminology/del/': ({ body }) => {
      const id = Number(body && body.id) || 0;
      const s = jsonStore('terminology_store.json', { terminologies: [], roles: [] });
      s.terminologies = (s.terminologies || []).filter((t) => Number(t.id) !== id);
      saveStore('terminology_store.json', s);
      return ok({});
    },
    'POST /company/terminology/order/update/': () => ok({}),
    'POST /company/terminology/use/': ({ body }) => {
      const id = Number(body && body.id) || 0;
      const s = jsonStore('terminology_store.json', { terminologies: [], roles: [] });
      (s.terminologies || []).forEach((t) => { if (Number(t.id) === id) t.use_num = Number(t.use_num || 0) + 1; });
      saveStore('terminology_store.json', s);
      return ok({});
    },

    /* ---------------- 我的模板（原版 /template/list/ + /template/step/*，云端快照） ---------------- */
    'POST /template/list/': () => {
      const b = myTplBundle();
      if (!b || !b.list || !b.list.data) return ok({ templates: [] });
      return ok({ templates: Array.isArray(b.list.data.templates) ? b.list.data.templates : [] });
    },
    'POST /template/step/list/': ({ body }) => {
      const d = myTplDetail(body && body.template_id);
      if (!d) return { code: 10122, msg: '参数错误', data: {} };
      return ok({ steps: (d.steps || []).map((s) => ({ step_id: s.step_id, step_name: s.step_name, start_day: s.start_day, end_day: s.end_day, step_order: s.step_order })) });
    },
    'POST /template/step/task/list/': ({ body }) => {
      const s = myTplStep(body && body.template_id, body && body.step_id);
      if (!s) return { code: 10122, msg: '参数错误', data: {} };
      return ok({ tasks: s.tasks || [] });
    },
    'POST /template/step/notify/list/': ({ body }) => {
      const s = myTplStep(body && body.template_id, body && body.step_id);
      if (!s) return { code: 10122, msg: '参数错误', data: {} };
      return ok({ notifies: s.notifies || [] });
    },
    'POST /template/step/craft/list/': ({ body }) => {
      const s = myTplStep(body && body.template_id, body && body.step_id);
      if (!s) return { code: 10122, msg: '参数错误', data: {} };
      return ok({ crafts: s.crafts || [] });
    },

    /* ---------------- 企业介绍（原版 /company/introduce/*，云端快照 + 可写） ---------------- */
    'POST /company/introduce/info/': () => {
      const s = jsonStore('introduce_store.json', { info: {}, roll_images: [] });
      return ok(s.info || {});
    },
    'POST /company/introduce/roll_image/list/': () => {
      const s = jsonStore('introduce_store.json', { info: {}, roll_images: [] });
      return ok({ roll_images: Array.isArray(s.roll_images) ? s.roll_images : [] });
    },
    'POST /company/introduce/base/set/': ({ body }) => {
      const s = jsonStore('introduce_store.json', { info: {}, roll_images: [] });
      s.info = { ...(s.info || {}), ...(body || {}) };
      saveStore('introduce_store.json', s);
      return ok({});
    },
    'POST /company/introduce/roll_image/add/': ({ body }) => {
      const s = jsonStore('introduce_store.json', { info: {}, roll_images: [] });
      if (!Array.isArray(s.roll_images)) s.roll_images = [];
      s.roll_images.push({ url: String((body && body.url) || ''), jump_url: String((body && body.jump_url) || '') });
      saveStore('introduce_store.json', s);
      return ok({});
    },
    'POST /company/introduce/roll_image/del/': ({ body }) => {
      const s = jsonStore('introduce_store.json', { info: {}, roll_images: [] });
      const url = String((body && body.url) || '');
      s.roll_images = (s.roll_images || []).filter((r) => String(r.url) !== url);
      saveStore('introduce_store.json', s);
      return ok({});
    },
    'POST /company/introduce/roll_image/set/': ({ body }) => {
      const s = jsonStore('introduce_store.json', { info: {}, roll_images: [] });
      const url = String((body && body.url) || '');
      s.roll_images = (s.roll_images || []).map((r) => (String(r.url) === url ? { ...r, ...(body || {}) } : r));
      saveStore('introduce_store.json', s);
      return ok({});
    },

    // ---------------- 角色管理 ----------------
    // 注：角色页接口 /company/role/list|detail|member/list|add|del 已在 local-api.js 全本地化
    // （role_store.json + 本地成员动态计数），此处不再定义以免覆盖。
    // 材料编辑（覆盖 local-api 仅改快照的版本）：本地材料落 company_materials + 重建快照；
    // 云端材料（无 company_materials 行）仍只改快照
    'POST /budget/material/edit/': ({ body }) => {
      const mid = Number(body && (body.material_id || body.id));
      if (!mid) return { code: 10011, msg: '参数错误', data: {} };
      const cm = db.prepare('SELECT * FROM company_materials WHERE id = ?').get(mid);
      if (cm) {
        const cur = j(cm.payload, {});
        const next = { ...cur, ...(body || {}), id: mid };
        // 行内编辑只传 sale_unit_id 时，回填单位名称
        if (next.sale_unit_id !== undefined && next.sale_unit_id !== null && next.sale_unit_id !== 0 && !next.sale_unit) {
          const units = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
          if (units) {
            const ud = j(units.payload, { materials: [] });
            const set = new Set();
            (Array.isArray(ud.materials) ? ud.materials : []).forEach((m) => { set.add(m.sale_unit); set.add(m.cost_unit); });
            const names = Array.from(set).filter(Boolean);
            next.sale_unit = names[Number(next.sale_unit_id) - 1] || next.sale_unit;
          }
        }
        db.prepare('UPDATE company_materials SET payload=?, name=?, category=?, sub_category=?, brand=?, model=?, spec=?, source=?, supplier=?, enabled=? WHERE id=?')
          .run(JSON.stringify(next), String(next.name || ''), String(next.category || ''), String(next.subCategory || ''),
            String(next.brand || ''), String(next.model || ''), String(next.spec || ''), String(next.source || ''), String(next.supplier || ''), next.enabled ? 1 : 0, mid);
        syncMaterialSnapshot();
        return ok({});
      }
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const d = j(row.payload, { materials: [] });
      if (!Array.isArray(d.materials)) d.materials = [];
      let found = false;
      for (const m of d.materials) if (Number(m.id) === mid) { Object.assign(m, body); found = true; }
      if (!found) return { code: 10032, msg: '数据不存在', data: {} };
      db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('material_list',?,?)
        ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
        .run(JSON.stringify(d), dbNow());
      return ok({});
    },
    // 材料删除（原版 /budget/material/del/）：兼容 material_ids（辅料库）与 ids（houtai）两种格式
    'POST /budget/material/del/': ({ body }) => {
      const arr = (body && (body.material_ids || body.ids)) || [];
      const ids = Array.isArray(arr) ? arr.map(Number).filter(Boolean) : [];
      if (!ids.length) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (row) {
        const d = j(row.payload, { materials: [] });
        if (Array.isArray(d.materials)) d.materials = d.materials.filter((m) => !ids.includes(Number(m.id)));
        d.total_num = d.materials.length;
        db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('material_list',?,?)
          ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
          .run(JSON.stringify(d), dbNow());
      }
      const ph = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM company_materials WHERE id IN (${ph})`).run(...ids);
      return ok({});
    },
    // 材料启用/禁用（原版 /budget/material/status/set/）：material_ids+status（启用列表）或 id+enabled（houtai）
    'POST /budget/material/status/set/': ({ body }) => {
      const arr = (body && (body.material_ids || body.ids)) || [];
      const ids = Array.isArray(arr) ? arr.map(Number).filter(Boolean) : [];
      if (body && body.id) ids.push(Number(body.id));
      if (!ids.length) return { code: 10011, msg: '参数错误', data: {} };
      const enabled = body && body.status !== undefined && body.status !== null ? Number(body.status) : (body && body.enabled ? 1 : 0);
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (row) {
        const d = j(row.payload, { materials: [] });
        if (Array.isArray(d.materials)) d.materials.forEach((m) => { if (ids.includes(Number(m.id))) { m.enable = enabled; m.enabled = !!enabled; } });
        db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('material_list',?,?)
          ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
          .run(JSON.stringify(d), dbNow());
      }
      const ph = ids.map(() => '?').join(',');
      db.prepare(`UPDATE company_materials SET enabled = ? WHERE id IN (${ph})`).run(enabled, ...ids);
      return ok({});
    },

    /* ---------------- 原版材料库 v2（对齐 enterprise.e-shigong.com /budget/material） ----------------
       挂载 4 接口：/budget/v2/commodity_content/list/（分类树，commodity_content_type 0=主材 1=辅材）、
       /budget/material/count/（来源/供应商/品牌计数下拉）、/budget/v2/material/list/（列表，
       叶子 commodity_type_id 过滤）、/company/budget/min_sale/config/get/（上方已实现）。
       编辑弹窗 5 接口 + 保存接口 /commodity/company/material/edit/。数据源均取
       material_list + commodity_content 快照（快照 id 与 company_materials.id 一致）。
    */
    'POST /budget/v2/commodity_content/list/': ({ body }) => {
      const b = body || {};
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='commodity_content'").get();
      if (!row) return null;
      const allContents = Array.isArray(j(row.payload, { contents: [] }).contents) ? j(row.payload, { contents: [] }).contents : [];
      const ctype = b.commodity_content_type !== undefined && b.commodity_content_type !== null && b.commodity_content_type !== '' ? Number(b.commodity_content_type) : null;
      let contents = allContents;
      if (ctype === 0 || ctype === 1) contents = allContents.filter((c) => Number(c.type) === ctype);
      // 有筛选条件（来源/供应商/品牌/搜索）时，按过滤后的材料重算叶子分类 item_num
      const mrow = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      let mats = mrow ? (j(mrow.payload, { materials: [] }).materials || []) : [];
      const kw = b.keywords ? String(b.keywords).toLowerCase() : '';
      const src = b.source_type !== undefined && b.source_type !== null && b.source_type !== '' ? Number(b.source_type) : null;
      const st = b.status !== undefined && b.status !== null && b.status !== '' ? Number(b.status) : null;
      const sids = Array.isArray(b.supplier_ids) ? b.supplier_ids.map(Number) : null;
      const bands = Array.isArray(b.band_names) ? b.band_names : null;
      const mfrs = Array.isArray(b.manufacturer_ids) ? b.manufacturer_ids.map(Number) : null;
      const hasFilter = Boolean(kw) || src !== null || st !== null || Boolean(sids) || Boolean(bands) || Boolean(mfrs);
      const hitFilter = (m) => {
        if (src !== null && Number(m.is_self_warehouse) !== src) return false;
        if (st !== null && Number(m.enable) !== st) return false;
        if (sids && !sids.includes(Number(m.supplier_id))) return false;
        if (bands && !bands.includes(m.band)) return false;
        if (mfrs && !mfrs.includes(Number(m.manufacturer_id))) return false;
        if (kw && ![m.name, m.band, m.model, m.specification].some((v) => String(v || '').toLowerCase().includes(kw))) return false;
        return true;
      };
      const filtered = hasFilter ? mats.filter(hitFilter) : mats;
      const numOf = (tid) => filtered.filter((m) => Number(m.commodity_type_id) === Number(tid)).length;
      contents = contents.map((c) => ({
        ...c,
        commodity_types: (Array.isArray(c.commodity_types) ? c.commodity_types : []).map((t) => ({ ...t, item_num: numOf(t.id) })).filter((t) => hasFilter ? t.item_num > 0 : true),
      }));
      const mainNum = filtered.filter((m) => {
        const c = allContents.find((x) => (x.commodity_types || []).some((t) => Number(t.id) === Number(m.commodity_type_id)));
        return c && Number(c.type) === 0;
      }).length;
      return ok({ main_material_num: mainNum, assist_material_num: filtered.length - mainNum, contents });
    },
    // 来源/供应商/品牌 计数与下拉（原版 /budget/material/count/）
    'POST /budget/material/count/': ({ body }) => {
      const b = body || {};
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (!row) return null;
      let mats = Array.isArray(j(row.payload, { materials: [] }).materials) ? j(row.payload, { materials: [] }).materials : [];
      const src = b.source_type !== undefined && b.source_type !== null && b.source_type !== '' ? Number(b.source_type) : null;
      if (src !== null) mats = mats.filter((m) => Number(m.is_self_warehouse) === src);
      const st = b.status !== undefined && b.status !== null && b.status !== '' ? Number(b.status) : null;
      if (st !== null) mats = mats.filter((m) => Number(m.enable) === st);
      const supMap = new Map();
      for (const m of mats) if (m.supplier_id != null && m.supplier_name) supMap.set(Number(m.supplier_id), String(m.supplier_name));
      const suppliers = Array.from(supMap.entries()).map(([supplier_id, supplier_name]) => ({ supplier_id, supplier_name }));
      const bandNames = Array.from(new Set(mats.map((m) => m.band).filter(Boolean)));
      return ok({
        supplier_material_num: mats.filter((m) => Number(m.is_self_warehouse) !== 1).length,
        warehouse_material_num: mats.filter((m) => Number(m.is_self_warehouse) === 1).length,
        total_num: mats.length,
        suppliers,
        manufacturers: [],
        band_names: bandNames,
      });
    },
    // 材料列表 v2（原版 /budget/v2/material/list/）
    'POST /budget/v2/material/list/': ({ body }) => {
      const b = body || {};
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (!row) return null;
      let mats = Array.isArray(j(row.payload, { materials: [] }).materials) ? j(row.payload, { materials: [] }).materials : [];
      if (b.commodity_type_id !== undefined && b.commodity_type_id !== null && b.commodity_type_id !== '') mats = mats.filter((m) => Number(m.commodity_type_id) === Number(b.commodity_type_id));
      const kw = b.search_key ? String(b.search_key).toLowerCase() : '';
      if (kw) mats = mats.filter((m) => [m.name, m.band, m.model, m.specification, m.supplier_name].some((v) => String(v || '').toLowerCase().includes(kw)));
      const src = b.source_type !== undefined && b.source_type !== null && b.source_type !== '' ? Number(b.source_type) : null;
      if (src !== null) mats = mats.filter((m) => Number(m.is_self_warehouse) === src);
      const st = b.status !== undefined && b.status !== null && b.status !== '' ? Number(b.status) : null;
      if (st !== null) mats = mats.filter((m) => Number(m.enable) === st);
      if (Array.isArray(b.supplier_ids)) mats = mats.filter((m) => b.supplier_ids.map(Number).includes(Number(m.supplier_id)));
      if (Array.isArray(b.band_names)) mats = mats.filter((m) => b.band_names.includes(m.band));
      if (Array.isArray(b.manufacturer_ids)) mats = mats.filter((m) => b.manufacturer_ids.map(Number).includes(Number(m.manufacturer_id)));
      const total = mats.length;
      const ps = Number(b.page_size) || 20;
      const pi = Math.max(1, Number(b.page_index) || 1);
      const page = mats.slice((pi - 1) * ps, pi * ps);
      return ok({ total_num: total, materials: page });
    },
    // 厂家下拉：由 commodity-stock.js 实现（取 commodity_commodities.band 真实厂家）
    // 材料详情（编辑弹窗回填；原版 /budget/company/material/detail/）
    'POST /budget/company/material/detail/': ({ body }) => {
      const mid = Number(body && (body.material_id || body.id));
      if (!mid) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const m = (j(row.payload, { materials: [] }).materials || []).find((x) => Number(x.id) === mid);
      if (!m) return { code: 10032, msg: '数据不存在', data: {} };
      const crow = db.prepare("SELECT payload FROM budget_globals WHERE kind='commodity_content'").get();
      let cid = 0, cname = '', ctname = '';
      if (crow) {
        for (const c of (j(crow.payload, { contents: [] }).contents || [])) {
          for (const t of (Array.isArray(c.commodity_types) ? c.commodity_types : [])) {
            if (Number(t.id) === Number(m.commodity_type_id)) { cid = Number(c.id); cname = c.name; ctname = t.name; }
          }
        }
      }
      return ok({
        commodity_content_id: cid, commodity_content_name: cname,
        commodity_type_id: Number(m.commodity_type_id || 0), commodity_type_name: ctname,
        commodity_id: Number(m.id), commodity_name: m.name || '',
        description: m.description || '',
        band_name: m.band || '', model: m.model || '', specification: m.specification || '',
        product_place_name: m.product_place_name || '',
        unit_name: m.sale_unit || m.cost_unit || '',
        cost_price: m.cost_price || '', sale_price: m.sale_price || '',
        files: m.image ? [m.image] : [],
        manufacturer_id: Number(m.manufacturer_id || 0),
        panorama_url: m.panorama_url || '',
      });
    },
    // 品牌/单位下拉（原版 /commodity/band_unit/list/）
    'POST /commodity/band_unit/list/': ({ body }) => {
      const b = body || {};
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      let mats = [];
      if (row) {
        const d = j(row.payload, { materials: [] });
        if (Array.isArray(d.materials)) mats = d.materials;
      }
      if (b.type_id) mats = mats.filter((m) => Number(m.commodity_type_id) === Number(b.type_id));
      const bands = Array.from(new Set(mats.map((m) => m.band).filter(Boolean))).map((name, i) => ({ id: i + 1, name }));
      const units = Array.from(new Set(mats.map((m) => m.sale_unit || m.cost_unit).filter(Boolean))).map((name, i) => ({ id: i + 1, name }));
      return ok({ bands, units });
    },
    // 二级分类下拉（原版 /commodity/type/list/）
    'POST /commodity/type/list/': ({ body }) => {
      const b = body || {};
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='commodity_content'").get();
      if (!row) return ok({ types: [] });
      const contents = j(row.payload, { contents: [] }).contents || [];
      const target = contents.filter((c) => Number(c.id) === Number(b.content_id));
      const scope = target.length ? target : contents;
      const kw = b.search_key ? String(b.search_key) : '';
      const types = [];
      for (const c of scope) for (const t of (Array.isArray(c.commodity_types) ? c.commodity_types : [])) {
        if (kw && !String(t.name || '').includes(kw)) continue;
        types.push({ id: t.id, name: t.name, content_id: Number(c.id), content_name: c.name });
      }
      return ok({ types });
    },
    // 一级分类下拉（原版 /commodity/sys/content/list/）
    'POST /commodity/sys/content/list/': () => {
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='commodity_content'").get();
      if (!row) return ok({ contents: [] });
      return ok({ contents: (j(row.payload, { contents: [] }).contents || []).map((c) => ({ id: c.id, name: c.name, type: c.type })) });
    },
    // 添加/编辑保存（原版 /commodity/company/material/edit/）：material_id 缺失 → 新增；存在 → 更新
    // 更新时同步 company_materials 重建快照，保证 houtai/主站同源
    'POST /commodity/company/material/edit/': ({ body }) => {
      const b = body || {};
      const mid = Number(b.material_id || b.commodity_id || b.id);
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const d = j(row.payload, { materials: [] });
      if (!Array.isArray(d.materials)) d.materials = [];
      let m;
      let isNew = false;
      if (mid) {
        m = d.materials.find((x) => Number(x.id) === mid);
        if (!m) return { code: 10032, msg: '数据不存在', data: {} };
      } else {
        isNew = true;
        const nid = nextId('company_materials', 'id');
        m = {
          id: nid, name: '', enable: 1, commodity_type_id: Number(b.commodity_type_id) || 0,
          band: '', model: '', specification: '', cost_unit: '', sale_unit: '',
          unit_rate: '1', profit_rate: '0', loss_rate: '0',
          cost_price: '0', sale_price: '0', min_sale_price: '0', image: '', description: '',
          is_self_warehouse: 1, supplier_id: 6808, supplier_name: '装企仓库',
          manufacturer_id: 0, manufacturer_name: '-', is_local: 1,
        };
        d.materials.push(m);
      }
      Object.assign(m, {
        name: b.commodity_name !== undefined ? b.commodity_name : m.name,
        commodity_type_id: b.commodity_type_id !== undefined ? Number(b.commodity_type_id) : m.commodity_type_id,
        band: b.band_name !== undefined ? b.band_name : m.band,
        model: b.model !== undefined ? b.model : m.model,
        specification: b.specification !== undefined ? b.specification : m.specification,
        product_place_name: b.product_place_name !== undefined ? b.product_place_name : m.product_place_name,
        cost_unit: b.unit_name !== undefined ? b.unit_name : m.cost_unit,
        sale_unit: b.unit_name !== undefined ? b.unit_name : m.sale_unit,
        sale_price: b.sale_price !== undefined ? String(b.sale_price) : m.sale_price,
        cost_price: b.market_price !== undefined ? String(b.market_price) : m.cost_price,
        min_sale_price: b.min_sale_price !== undefined ? String(b.min_sale_price) : (m.min_sale_price || m.sale_price),
        description: b.description !== undefined ? b.description : m.description,
        manufacturer_id: b.manufacturer_id !== undefined ? Number(b.manufacturer_id) : (m.manufacturer_id || 0),
      });
      if (Array.isArray(b.roll_images) && b.roll_images.length) m.image = b.roll_images[0];
      db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('material_list',?,?)
        ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
        .run(JSON.stringify(d), dbNow());
      // 同步 company_materials（新增插行 / 存在更新）；payload 需带全 v2 字段，
      // 否则 syncMaterialSnapshot 重建快照时会丢 commodity_type_id / 供应商等信息
      const existing = db.prepare('SELECT * FROM company_materials WHERE id = ?').get(m.id);
      const cp = existing ? j(existing.payload, {}) : {};
      const next = {
        ...cp,
        id: m.id,
        name: m.name,
        commodity_type_id: m.commodity_type_id,
        band: m.band,
        model: m.model,
        specification: m.specification,
        product_place_name: m.product_place_name,
        cost_unit: m.cost_unit,
        sale_unit: m.sale_unit,
        unit_rate: m.unit_rate,
        profit_rate: m.profit_rate,
        loss_rate: m.loss_rate,
        cost_price: m.cost_price,
        sale_price: m.sale_price,
        min_sale_price: m.min_sale_price,
        description: m.description,
        image: m.image,
        is_self_warehouse: m.is_self_warehouse,
        supplier_id: m.supplier_id,
        supplier_name: m.supplier_name,
        manufacturer_id: m.manufacturer_id,
        manufacturer_name: m.manufacturer_name,
        enable: m.enable,
      };
      if (existing) {
        db.prepare('UPDATE company_materials SET payload=?, name=?, brand=?, model=?, spec=?, enabled=? WHERE id=?')
          .run(JSON.stringify(next), String(next.name || ''), String(next.band || ''), String(next.model || ''), String(next.specification || ''), Number(next.enable) === 1 ? 1 : 0, m.id);
      } else {
        db.prepare("INSERT INTO company_materials (id, payload, name, category, sub_category, brand, model, spec, source, supplier, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(m.id, JSON.stringify(next), String(next.name || ''), '', '', String(next.band || ''), String(next.model || ''), String(next.specification || ''), '装企仓库', '装企仓库', Number(next.enable) === 1 ? 1 : 0, dbNow());
      }
      syncMaterialSnapshot();
      return ok({ commodity_id: m.id });
    },
    // 批量导入（原版 /commodity/company/material/import/）：body 携带 xlsx base64，解析后批量入库
    'POST /commodity/company/material/import/': async ({ body }) => {
      const b = body || {};
      const b64 = b.file_base64 ? String(b.file_base64).replace(/^data:[^;]+;base64,/, '') : '';
      if (!b64) return { code: 10011, msg: '请上传 xlsx 文件', data: {} };
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(Buffer.from(b64, 'base64'));
      } catch (e) {
        return { code: 10011, msg: '文件解析失败，请上传 xlsx 格式模板文件', data: {} };
      }
      const ws = wb.worksheets[0];
      if (!ws) return { code: 10011, msg: '文件为空', data: {} };
      const rows = [];
      ws.eachRow((r, n) => { if (n > 1) rows.push(r); });
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='material_list'").get();
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const d = j(row.payload, { materials: [] });
      if (!Array.isArray(d.materials)) d.materials = [];
      let imported = 0;
      for (const r of rows) {
        const v = (i) => { const c = r.getCell(i); return c && c.value != null ? String(c.value).trim() : ''; };
        const name = v(1); // 商品名称
        if (!name) continue;
        const nid = nextId('company_materials', 'id');
        const m = {
          id: nid, name, enable: 1, commodity_type_id: 0,
          band: v(2), model: v(3), specification: v(4),
          cost_unit: v(6) || '项', sale_unit: v(6) || '项', unit_rate: '1', profit_rate: '0', loss_rate: '0',
          cost_price: v(5) || '0', sale_price: v(5) || '0', min_sale_price: v(5) || '0',
          image: '', description: '', is_self_warehouse: 1, supplier_id: 6808, supplier_name: '装企仓库',
          manufacturer_id: 0, manufacturer_name: '-', is_local: 1,
        };
        d.materials.push(m);
        db.prepare("INSERT INTO company_materials (id, payload, name, category, sub_category, brand, model, spec, source, supplier, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(nid, JSON.stringify(m), m.name, '', '', m.band, m.model, m.specification, '装企仓库', '装企仓库', 1, dbNow());
        imported++;
      }
      if (imported) {
        db.prepare(`INSERT INTO budget_globals (kind, payload, updated_at) VALUES ('material_list',?,?)
          ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
          .run(JSON.stringify(d), dbNow());
        syncMaterialSnapshot();
      }
      return ok({ import_num: imported });
    },

    /* ---------------- 工程定额 ---------------- */
    'POST /company/v2/admin/quota/types/': () => {
      const rows = db.prepare('SELECT * FROM company_quota_types ORDER BY id').all();
      return ok({ quotaTypes: rows.map((r) => ({ id: r.id, name: r.name, children: j(r.children_json, []) })) });
    },
    'POST /company/v2/admin/quota/list/': () => {
      const rows = db.prepare('SELECT * FROM company_quotas ORDER BY id').all();
      return ok({ quotas: rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, content: j(r.payload, {}).content || '' })) });
    },
    'POST /company/v2/admin/quota/add/': ({ body }) => {
      const id = nextId('company_quotas', 'id');
      const p = { ...(body || {}), id, lossRate: (body && body.lossRate) || 0 };
      db.prepare('INSERT INTO company_quotas (id, payload, name, unit, quota_type_id) VALUES (?,?,?,?,?)')
        .run(id, JSON.stringify(p), String(p.name || ''), String(p.unit || ''), Number(p.quotaTypeId || 0));
      syncQuotaSnapshots();
      return ok({});
    },
    'POST /company/v2/admin/quota/del/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('DELETE FROM company_quotas WHERE id = ?').run(id);
      syncQuotaSnapshots();
      return ok({});
    },
    'POST /company/v2/admin/quota/import/': async ({ body }) => {
      const b = body || {};
      const b64 = b.file_base64 ? String(b.file_base64).replace(/^data:[^;]+;base64,/, '') : '';
      if (!b64) return { code: 10011, msg: '请上传 xlsx 文件', data: {} };
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(Buffer.from(b64, 'base64'));
      } catch (e) {
        return { code: 10011, msg: '文件解析失败，请上传 xlsx 格式模板文件', data: {} };
      }
      const ws = wb.worksheets[0];
      if (!ws) return { code: 10011, msg: '文件为空', data: {} };
      const typeId = Number(b.quotaTypeId || 0);
      const rows = [];
      ws.eachRow((r, n) => { if (n > 1) rows.push(r); });
      const v = (r, i) => { const c = r.getCell(i); return c && c.value != null ? String(c.value).trim() : ''; };
      const toNum = (s) => { const n = Number(s); return Number.isFinite(n) && s !== '' ? n : 0; };
      const imported = [];
      for (const r of rows) {
        const name = v(r, 1); // 定额名称
        if (!name) continue;
        const nid = nextId('company_quotas', 'id');
        const q = {
          id: nid, name,
          desc: v(r, 2), unit: v(r, 3) || '㎡', lossRate: toNum(v(r, 4)),
          costMain: toNum(v(r, 5)), costAux: toNum(v(r, 6)), costLabor: toNum(v(r, 7)),
          quoteMain: toNum(v(r, 8)), quoteAux: toNum(v(r, 9)), quoteLabor: toNum(v(r, 10)),
          materialNote: v(r, 11), quotaTypeId: typeId, is_local: 1,
        };
        db.prepare('INSERT INTO company_quotas (id, payload, name, unit, quota_type_id) VALUES (?,?,?,?,?)')
          .run(nid, JSON.stringify(q), q.name, q.unit, typeId);
        imported.push(q);
      }
      if (imported.length) syncQuotaSnapshots();
      return ok({ import_num: imported.length, quotas: imported });
    },
    'POST /company/v2/admin/material/costs/': () => {
      const rows = db.prepare('SELECT * FROM company_material_costs ORDER BY id').all();
      return ok({ materialCosts: rows.map((r) => ({ id: r.id, type: r.type, unit: r.unit, spec: r.spec, price: r.price })) });
    },

    /* ---------------- 预算模板 ---------------- */
    'POST /company/v2/admin/budget-template/list/': () => {
      const rows = db.prepare('SELECT * FROM company_budget_templates ORDER BY id').all();
      return ok({ budgetTemplates: rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled ? true : false, ...j(r.payload, {}) })) });
    },
    'POST /company/v2/admin/budget-template/toggle/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE company_budget_templates SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, id);
      syncTemplateSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/budget-template/copy/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_budget_templates WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const nid = nextId('company_budget_templates', 'id');
      const cur = j(row.payload, {});
      const copy = { ...cur, id: nid, name: (row.name || '') + ' 副本' };
      db.prepare('INSERT INTO company_budget_templates (id, payload, name, enabled) VALUES (?,?,?,?)')
        .run(nid, JSON.stringify(copy), String(copy.name || ''), 1);
      syncTemplateSnapshot();
      return ok({});
    },
    'POST /company/v2/admin/budget-template/del/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('DELETE FROM company_budget_templates WHERE id = ?').run(id);
      syncTemplateSnapshot();
      return ok({});
    },

    /* ---------------- 模板市场 / 我的模板 ---------------- */
    'POST /company/v2/admin/market-template/list/': () => {
      const rows = db.prepare('SELECT * FROM company_market_templates ORDER BY id').all();
      return ok({ marketTemplates: rows.map((r) => ({ id: r.id, name: r.name, ...j(r.payload, {}) })) });
    },
    'POST /company/v2/admin/market-template/import/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      const row = db.prepare('SELECT * FROM company_market_templates WHERE id = ?').get(id);
      if (!row) return { code: 10032, msg: '数据不存在', data: {} };
      const nid = nextId('company_my_templates', 'id');
      const cur = j(row.payload, {});
      const copy = { ...cur, id: nid, name: cur.name, used: false };
      db.prepare('INSERT INTO company_my_templates (id, payload, name, used) VALUES (?,?,?,?)')
        .run(nid, JSON.stringify(copy), String(copy.name || ''), 0);
      return ok({ myTemplateId: nid });
    },
    'POST /company/v2/admin/my-template/list/': () => {
      const rows = db.prepare('SELECT * FROM company_my_templates ORDER BY id').all();
      return ok({ myTemplates: rows.map((r) => ({ id: r.id, name: r.name, ...j(r.payload, {}) })) });
    },

    /* ---------------- 常用语 ---------------- */
    'POST /company/v2/admin/term/list/': ({ body }) => {
      const cat = String((body && body.category) || '');
      let rows = db.prepare('SELECT * FROM company_terms ORDER BY id').all();
      if (cat && cat !== '全部') rows = rows.filter((t) => t.category === cat);
      return ok({ terms: rows.map((r) => ({ id: r.id, category: r.category, content: r.content, useCount: r.use_count })) });
    },
    'POST /company/v2/admin/term/categories/': () => {
      const rows = db.prepare('SELECT * FROM company_term_categories ORDER BY id').all();
      return ok({ categories: rows.map((r) => r.name) });
    },
    'POST /company/v2/admin/term/add/': ({ body }) => {
      const id = nextId('company_terms', 'id');
      db.prepare('INSERT INTO company_terms (id, category, content, use_count) VALUES (?,?,?,0)')
        .run(id, String((body && body.category) || ''), String((body && body.content) || ''));
      return ok({});
    },
    'POST /company/v2/admin/term/del/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('DELETE FROM company_terms WHERE id = ?').run(id);
      return ok({});
    },
    'POST /company/v2/admin/term/use/': ({ body }) => {
      const id = Number(body && body.id);
      if (!id) return { code: 10011, msg: '参数错误', data: {} };
      db.prepare('UPDATE company_terms SET use_count = use_count + 1 WHERE id = ?').run(id);
      return ok({});
    },

    /* ---------------- 预算模板 / 材料选样模板（原版 /budget/template/*，云端快照） ---------------- */
    'POST /budget/template/list/': ({ body }) => {
      const row = db.prepare("SELECT payload FROM budget_globals WHERE kind='template_list'").get();
      if (!row) return null;
      const d = j(row.payload, { templates: [] });
      let list = Array.isArray(d.templates) ? d.templates : [];
      const im = body && body.is_material_template !== undefined && body.is_material_template !== null && body.is_material_template !== '' ? Number(body.is_material_template) : null;
      if (im !== null) list = list.filter((t) => Number(t.is_material_template) === im);
      return ok({ templates: list });
    },

    /* ---------------- 供应商（原版 /company/supplier_map/*，云端快照） ---------------- */
    'POST /company/supplier_map/list/': () => {
      const s = jsonStore('supplier_store.json', { supplier_maps: [], max_supplier_num: 100, total_num: 0 });
      return ok({ supplier_maps: Array.isArray(s.supplier_maps) ? s.supplier_maps : [], max_supplier_num: Number(s.max_supplier_num) || 100, total_num: Number(s.total_num) || 0 });
    },
    'POST /company/supplier_type/list/': () => {
      const s = jsonStore('supplier_store.json', { types: [] });
      return ok({ supplier_assist_types: Array.isArray(s.types) ? s.types : [] });
    },

    /* ---------------- 分公司（原版 /company/sub_company/*，云端快照=空） ---------------- */
    'POST /company/sub_company/list/': () => {
      const s = jsonStore('branch_store.json', { sub_companies: [], max_sub_company_num: 0, total_num: 0 });
      return ok({ sub_companies: Array.isArray(s.sub_companies) ? s.sub_companies : [], max_sub_company_num: Number(s.max_sub_company_num) || 0, total_num: Number(s.total_num) || 0 });
    },

    /* ---------------- 个性化设置（原版配置接口，云端快照 + 可写回） ---------------- */
    // 数据源：data/mock/settings_bundle.json（{ '/path/': {ok, data} }）
    'POST /company/v2/admin/settings/bundle/': () => {
      const s = jsonStore('settings_bundle.json', {});
      const out = {};
      for (const [k, v] of Object.entries(s)) out[k] = v && v.ok ? v.data : null;
      return ok(out);
    },
    'POST /crm/company/status/list/': () => settingsData('/crm/company/status/list/'),
    'POST /crm/company/customer_type/list/': () => settingsData('/crm/company/customer_type/list/'),
    'POST /crm/follow/type/list/': () => settingsData('/crm/follow/type/list/'),
    'POST /crm/reclaim/setting/get/': () => settingsData('/crm/reclaim/setting/get/'),
    'POST /crm/department_leader/notification/get/': () => settingsData('/crm/department_leader/notification/get/'),
    'POST /project/company/project/setting/get/': () => settingsData('/project/company/project/setting/get/'),
    'POST /project/overview/setting/role/list/': () => settingsData('/project/overview/setting/role/list/'),
    'POST /company/self/config/': () => settingsData('/company/self/config/'),
    'POST /oa/reimbursement/review/mode/get/': () => settingsData('/oa/reimbursement/review/mode/get/'),
    'POST /oa/multi/user/clock/enable/': () => settingsData('/oa/multi/user/clock/enable/'),
    'POST /company/material/apply/setting/commodity/contents/': () => settingsData('/company/material/apply/setting/commodity/contents/'),
    'POST /company/material/apply/setting/contract/types/': () => settingsData('/company/material/apply/setting/contract/types/'),
    'POST /company/project/payment/setting/': () => settingsData('/company/project/payment/setting/'),
    'POST /camera/manager/setting/get/': () => settingsData('/camera/manager/setting/get/'),
    'POST /project/company/project_identify/setting/get/': () => settingsData('/project/company/project_identify/setting/get/'),
    'POST /crm/file_item/handle_permission/get/': () => settingsData('/crm/file_item/handle_permission/get/'),
    // 写接口：更新快照文件
    'POST /company/self/config/set/': ({ body }) => settingsSet('/company/self/config/', body),
    'POST /crm/company/status/set/': ({ body }) => settingsSet('/crm/company/status/list/', body),
    'POST /crm/company/customer_type/set/': ({ body }) => settingsSet('/crm/company/customer_type/list/', body),
    'POST /crm/reclaim/setting/set/': ({ body }) => settingsSet('/crm/reclaim/setting/get/', body),
    'POST /crm/department_leader/notification/set/': ({ body }) => settingsSet('/crm/department_leader/notification/get/', body),
    'POST /oa/multi/user/clock/enable/set/': ({ body }) => settingsSet('/oa/multi/user/clock/enable/', body),

    /* ---------------- 状态探测（houtai 服务连通性检查） ---------------- */
    'POST /company/v2/admin/ping/': () => ok({ server: 'webqianduan', time: dbNow() }),
  };

  // ================ 原版路径别名（企业后台 enterprise.e-shigong.com 实际调用路径） ================
  // 背景：本地 houtai 复刻版把后台接口自创在 /company/v2/admin/* 命名空间；
  // 现按原版后台 Web 版 JS（chunk-*.js / app.js）中提取的真实调用路径补齐 /company、/budget、/template 等原版路径。
  // 策略：新增原版路径 + 保留 /company/v2/admin 兼容（旧路径仍可用，前端已切换的页面走原版路径）。
  // 保留 v2/admin 的 12 项见下方"未映射"注释（原版路径已被主站 handler 占用且返回结构不同 / 本地扩展功能无原版对应）。
  const ORIGINAL_PATH_ALIASES = {
    // 部门
    'POST /company/v2/admin/department/list/': 'POST /company/v2/department/list/',
    'POST /company/v2/admin/department/add/': 'POST /company/department/add/',
    'POST /company/v2/admin/department/edit/': 'POST /company/department/edit/',
    'POST /company/v2/admin/department/del/': 'POST /company/department/del/',
    // 成员
    'POST /company/v2/admin/member/list/': 'POST /company/v2/department/member/list/',
    'POST /company/v2/admin/member/edit/': 'POST /company/department/member/edit/',
    'POST /company/v2/admin/member/del/': 'POST /company/department/member/del/',
    'POST /company/v2/admin/member/adjust/': 'POST /company/department/member/change_department/',
    'POST /company/v2/admin/member/deleted/list/': 'POST /company/user/del/record/',
    // 角色 / 权限
    // 注：role/add、role/del 已在 local-api.js 实现原版语义（角色启用/停用落 role_store.json），
    // 此处不再注册别名（否则会覆盖 local-api 的 role/add）；v2/admin/role/add 仅旧后台 UI 使用
    'POST /company/v2/admin/permission/tree/': 'POST /permission/web/group/permission/list/',
    // 企业信息 / 轮播图
    'POST /company/v2/admin/company/info/': 'POST /company/introduce/info/',
    'POST /company/v2/admin/company/info/update/': 'POST /company/introduce/base/set/',
    'POST /company/v2/admin/banner/list/': 'POST /company/introduce/roll_image/list/',
    'POST /company/v2/admin/banner/add/': 'POST /company/introduce/roll_image/add/',
    'POST /company/v2/admin/banner/edit/': 'POST /company/introduce/roll_image/set/',
    'POST /company/v2/admin/banner/del/': 'POST /company/introduce/roll_image/del/',
    // 分公司
    'POST /company/v2/admin/branch/list/': 'POST /company/sub_company/list/',
    'POST /company/v2/admin/branch/add/': 'POST /company/sub_company/add/',
    'POST /company/v2/admin/branch/edit/': 'POST /company/sub_company/edit/',
    'POST /company/v2/admin/branch/copy/': 'POST /company/sub_company/data/copy/',
    // 管理员
    'POST /company/v2/admin/admin/list/': 'POST /company/administrator/list/',
    'POST /company/v2/admin/admin/add/': 'POST /company/administrator/add/',
    'POST /company/v2/admin/admin/edit/': 'POST /company/administrator/edit/',
    'POST /company/v2/admin/admin/del/': 'POST /company/administrator/del/',
    // 供应商
    'POST /company/v2/admin/supplier/list/': 'POST /company/supplier_map/list/',
    'POST /company/v2/admin/supplier/invite/': 'POST /company/supplier_map/invite/',
    'POST /company/v2/admin/supplier/edit/': 'POST /company/v2/supplier_map/edit/',
    'POST /company/v2/admin/supplier/del/': 'POST /company/supplier_map/del/',
    'POST /company/v2/admin/supplier/types/': 'POST /company/supplier_type/list/',
    // 材料库（增/改/分类仍走 v2/admin：原版对应路径已被主站 handler 占用且返回结构不同）
    'POST /company/v2/admin/material/del/': 'POST /budget/material/del/',
    'POST /company/v2/admin/material/toggle/': 'POST /budget/material/status/set/',
    // 工程定额（类型列表仍走 v2/admin：原版 /budget/project_quota_type/list/ 已被主站占用）
    'POST /company/v2/admin/quota/list/': 'POST /budget/project_quota/list/',
    'POST /company/v2/admin/quota/add/': 'POST /budget/project_quota/add/',
    'POST /company/v2/admin/quota/del/': 'POST /budget/project_quota/del/',
    // 材料成本
    'POST /company/v2/admin/material/costs/': 'POST /budget/material/cost_price/list/',
    // 预算模板（列表仍走 v2/admin：原版 /budget/template/list/ 已被主站占用）
    'POST /company/v2/admin/budget-template/toggle/': 'POST /budget/template/status/set/',
    'POST /company/v2/admin/budget-template/copy/': 'POST /budget/template/copy/',
    'POST /company/v2/admin/budget-template/del/': 'POST /budget/template/del/',
    // 模板市场 / 我的模板
    'POST /company/v2/admin/market-template/list/': 'POST /template/market/list/',
    'POST /company/v2/admin/market-template/import/': 'POST /template/market/import/',
    'POST /company/v2/admin/my-template/list/': 'POST /template/list/',
    // 常用语
    'POST /company/v2/admin/term/list/': 'POST /company/terminology/list/',
    'POST /company/v2/admin/term/categories/': 'POST /company/terminology/role/list/',
    'POST /company/v2/admin/term/add/': 'POST /company/terminology/add/',
    'POST /company/v2/admin/term/del/': 'POST /company/terminology/del/',
    'POST /company/v2/admin/term/use/': 'POST /company/terminology/use/',
  };
  // 注册别名：仅当原版路径尚未被占用时挂同一 handler（避免覆盖主站既有实现）
  for (const [localPath, originalPath] of Object.entries(ORIGINAL_PATH_ALIASES)) {
    if (!handlers[originalPath] && handlers[localPath]) handlers[originalPath] = handlers[localPath];
  }

  return handlers;
}

module.exports = { COMPANY_SCHEMA_SQL, createCompanyApi, LOCAL_ID_BASE };
