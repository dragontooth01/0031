/**
 * crm 客户管理第一批接口（模式 A：本地权威，写操作直接落库 SQLite）
 * 对应开发计划 P1 §2.1 第一批 8 项：
 *   A1  /crm/aborted_crm/list/            废单列表
 *   A2  /crm/disable/aborted_crm/list/    已作废客户列表（按 crm_ids 复核）
 *   A4  /crm/company/crm/list/            公司客户列表
 *   C1  /crm/assign_owner/                分配负责人
 *   C3  /crm/batch/reassign_owner/        批量转交负责人
 *   D1  /crm/batch/disable/               批量作废（写 crm_aborted_records 留痕）
 *   D9  /crm/v2/check/                    手机号查重
 *   B1  /crm/public/customer/list/        公海线索列表
 */
const ExcelJS = require('exceljs');

function createCrmApi(db, deps) {
  const { ok, getSession, dbNow, buildCrmItem, queryCrmList, localNextId } = deps;
  const handlers = {};

  // ---------- Excel 导出辅助（server.js 二进制协议：{__binary, contentType, fileName, buffer}） ----------
  async function buildXlsx(fileName, sheetName, headers, rows, fields) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName || 'Sheet1');
    ws.columns = headers.map((h) => ({ header: h, width: Math.max(10, h.length * 2 + 4) }));
    for (const r of rows) {
      ws.addRow(fields.map((f) => {
        const v = r[f];
        return v === undefined || v === null ? '' : v;
      }));
    }
    const buf = await wb.xlsx.writeBuffer();
    return { __binary: true, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName, buffer: buf };
  }

  // ---------- 内部辅助 ----------
  const sessionUserId = (headers) => {
    const s = getSession(headers);
    return s ? Number(s.user_id || s.cloud_user_id || 0) : 0;
  };
  // 用户名称反查：users 表优先，company_members 兜底
  const userName = (uid) => {
    const n = Number(uid);
    if (!n) return '';
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(n);
    if (u && u.name) return u.name;
    const m = db.prepare('SELECT name FROM company_members WHERE id = ?').get(n);
    return m ? (m.name || '') : '';
  };
  const pager = (b) => ({
    page_index: Math.max(1, Number(b.page_index || 1)),
    page_size: Math.max(1, Number(b.page_size || 20))
  });
  const idsOf = (v) => (Array.isArray(v) ? v : []).map(Number).filter((x) => x > 0);
  const errParam = () => ({ code: 10011, msg: '参数错误', data: {} });
  // 公海线索行 → 列表项
  const buildPublicItem = (r) => ({
    public_customer_id: Number(r.public_customer_id),
    customer_name: r.customer_name, customer_gender: r.customer_gender, customer_phone: r.customer_phone,
    source_type_id: r.source_type_id, province_code: r.province_code, city_code: r.city_code, area_code: r.area_code,
    community_name: r.community_name, room_number: r.room_number, room_size: r.room_size, address_detail: r.address_detail,
    status: r.status, owner_id: r.owner_id, owner_name: r.owner_name,
    create_time: r.create_time, create_user_name: r.create_user_name
  });
  // 公海分配核心逻辑：线索 → status=1 + 负责人；同步创建/更新正式客户
  const assignPublic = (publicIds, ownerId) => {
    const ownerName = userName(ownerId);
    const now = dbNow();
    let okCount = 0;
    for (const pid of publicIds) {
      const row = db.prepare('SELECT * FROM crm_public_customers WHERE public_customer_id = ? AND deleted = 0').get(pid);
      if (!row) continue;
      db.prepare('UPDATE crm_public_customers SET status = 1, owner_id = ?, owner_name = ?, assign_time = ?, update_time = ? WHERE public_customer_id = ?')
        .run(ownerId, ownerName, now, now, pid);
      let crm = null;
      if (row.customer_phone) {
        crm = db.prepare('SELECT crm_id FROM crm_customers WHERE customer_phone = ? AND deleted = 0').get(row.customer_phone);
      }
      if (crm) {
        db.prepare('UPDATE crm_customers SET owner_id = ?, owner_name = ?, updated_at = ? WHERE crm_id = ?')
          .run(ownerId, ownerName, now, crm.crm_id);
      } else {
        const crmId = localNextId('crm_public_customer');
        db.prepare(`INSERT INTO crm_customers
          (crm_id, customer_name, customer_phone, customer_gender, crm_status, status_name,
           owner_id, owner_name, create_user_id, create_user_name, create_time, update_time,
           created_at, updated_at, is_local)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`)
          .run(crmId, row.customer_name, row.customer_phone, row.customer_gender || 0, 1, '潜在客户',
            ownerId, ownerName, ownerId, ownerName, now, now, now, now);
      }
      okCount++;
    }
    return okCount;
  };

  // ---------- A1 废单列表：is_aborted=1 的客户 ----------
  handlers['POST /crm/aborted_crm/list/'] = (req) => {
    const b = req.body || {};
    return queryCrmList({ ...b, aborted: 1, search_word: b.search_key || b.search_word || '' }, false);
  };

  // ---------- A2 已作废客户列表（按 crm_ids 复核） ----------
  handlers['POST /crm/disable/aborted_crm/list/'] = (req) => {
    const b = req.body || {};
    const ids = idsOf(b.crm_ids);
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0', 'is_aborted = 1'];
    const params = [];
    if (ids.length) { where.push('crm_id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_customers WHERE ' + whereSql + ' ORDER BY crm_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ total_num: total, crm_list: rows.map(buildCrmItem) });
  };

  // ---------- A4 公司客户列表（aborted_list 状态组兼容） ----------
  handlers['POST /crm/company/crm/list/'] = (req) => {
    const b = req.body || {};
    const aborted = (Array.isArray(b.aborted_list) && b.aborted_list.map(Number).includes(1)) ? 1 : b.aborted;
    return queryCrmList({ ...b, aborted, search_word: b.search_key || b.search_word || '' }, true);
  };

  // ---------- C1 分配负责人 ----------
  handlers['POST /crm/assign_owner/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const ownerId = Number(b.owner_id || 0);
    if (!crmId || !ownerId) return errParam();
    const row = db.prepare('SELECT crm_id FROM crm_customers WHERE crm_id = ? AND deleted = 0').get(crmId);
    if (!row) return { code: 13001, msg: '客户不存在', data: {} };
    const ownerName = userName(ownerId);
    db.prepare('UPDATE crm_customers SET owner_id = ?, owner_name = ?, updated_at = ? WHERE crm_id = ?')
      .run(ownerId, ownerName, dbNow(), crmId);
    return ok({ crm_id: crmId, owner_id: ownerId, owner_name: ownerName });
  };

  // ---------- C3 批量转交负责人 ----------
  handlers['POST /crm/batch/reassign_owner/'] = (req) => {
    const b = req.body || {};
    const ids = idsOf(b.crm_ids);
    const ownerId = Number(b.owner_id || 0);
    if (!ids.length || !ownerId) return errParam();
    const ownerName = userName(ownerId);
    let okCount = 0;
    for (const id of ids) {
      const r = db.prepare('UPDATE crm_customers SET owner_id = ?, owner_name = ?, updated_at = ? WHERE crm_id = ? AND deleted = 0')
        .run(ownerId, ownerName, dbNow(), id);
      if (r.changes > 0) okCount++;
    }
    if (okCount === 0) return { code: 13001, msg: '客户不存在', data: {} };
    const fail = ids.length - okCount;
    if (fail > 0) return { code: 25002, msg: '部分客户处理失败', data: { success_num: okCount, fail_num: fail } };
    return ok({ success_num: okCount, fail_num: 0 });
  };

  // ---------- D1 批量作废（is_aborted=1 + 作废记录留痕） ----------
  handlers['POST /crm/batch/disable/'] = (req) => {
    const b = req.body || {};
    const ids = idsOf(b.crm_ids);
    if (!ids.length) return errParam();
    const uid = sessionUserId(req.headers);
    const uname = userName(uid);
    const now = dbNow();
    let okCount = 0;
    for (const id of ids) {
      const r = db.prepare('UPDATE crm_customers SET is_aborted = 1, updated_at = ? WHERE crm_id = ? AND deleted = 0').run(now, id);
      if (r.changes > 0) {
        okCount++;
        db.prepare('INSERT INTO crm_aborted_records (crm_id, operator_id, operator_name, reason, aborted_time, deleted, created_at) VALUES (?,?,?,?,?,0,?)')
          .run(id, uid, uname, String(b.reason || ''), now, now);
      }
    }
    if (okCount === 0) return { code: 13001, msg: '客户不存在', data: {} };
    const fail = ids.length - okCount;
    if (fail > 0) return { code: 25002, msg: '部分客户处理失败', data: { success_num: okCount, fail_num: fail } };
    return ok({ success_num: okCount, fail_num: 0 });
  };

  // ---------- D9 手机号查重 ----------
  handlers['POST /crm/v2/check/'] = (req) => {
    const b = req.body || {};
    const phone = String(b.customer_phone || b.phone || b.phone_number || '').trim();
    if (!phone) return errParam();
    const row = db.prepare('SELECT * FROM crm_customers WHERE customer_phone = ? AND deleted = 0').get(phone);
    if (!row) return ok({ exist: 0, crm_id: 0 });
    return ok({
      exist: 1,
      crm_id: Number(row.crm_id),
      customer_name: row.customer_name,
      status_name: row.status_name,
      owner_name: row.owner_name
    });
  };

  // ---------- B1 公海线索列表 ----------
  handlers['POST /crm/public/customer/list/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0'];
    const params = [];
    const kw = b.search_key || b.search_word || b.keyword;
    if (kw) { where.push('(customer_name LIKE ? OR customer_phone LIKE ? OR community_name LIKE ?)'); params.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%'); }
    const st = b.status;
    if (st !== undefined && st !== '' && st !== null && Number(st) >= 0) { where.push('status = ?'); params.push(Number(st)); }
    const sids = Array.isArray(b.source_ids) ? b.source_ids.map(Number).filter((x) => x > 0) : [];
    if (sids.length) { where.push('source_type_id IN (' + sids.map(() => '?').join(',') + ')'); params.push(...sids); }
    if (b.start_date) { where.push('create_time >= ?'); params.push(String(b.start_date)); }
    if (b.end_date) { where.push('create_time <= ?'); params.push(String(b.end_date) + ' 23:59:59'); }
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_public_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_public_customers WHERE ' + whereSql + ' ORDER BY public_customer_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ total_count: total, public_customers: rows.map(buildPublicItem) });
  };

  // ---------- B2 公海线索新增 ----------
  handlers['POST /crm/public/customer/add/'] = (req) => {
    const b = req.body || {};
    const name = String(b.customer_name || b.name || '').trim();
    const phone = String(b.customer_phone || b.phone_number || '').trim();
    if (!name || !phone) return errParam();
    const uid = sessionUserId(req.headers);
    const now = dbNow();
    const pid = localNextId('crm_public_customer');
    db.prepare(`INSERT INTO crm_public_customers
      (public_customer_id, customer_name, customer_gender, customer_phone, source_type_id,
       province_code, city_code, area_code, community_name, room_number, room_size, address_detail,
       status, create_user_id, create_user_name, create_time, update_time, deleted, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,0,?,?)`)
      .run(pid, name, Number(b.customer_gender || 0), phone, Number(b.source_type_id || 0),
        String(b.province_code || ''), String(b.city_code || ''), String(b.area_code || ''),
        String(b.community_name || ''), String(b.room_number || ''), String(b.room_size || ''), String(b.address_detail || ''),
        uid, userName(uid), now, now, now, now);
    return ok({ public_customer_id: pid });
  };

  // ---------- B3 公海线索编辑 ----------
  handlers['POST /crm/public/customer/edit/'] = (req) => {
    const b = req.body || {};
    const pid = Number(b.public_customer_id || 0);
    if (!pid) return errParam();
    const row = db.prepare('SELECT * FROM crm_public_customers WHERE public_customer_id = ? AND deleted = 0').get(pid);
    if (!row) return { code: 13001, msg: '公海线索不存在', data: {} };
    const fields = {
      customer_name: b.customer_name !== undefined ? String(b.customer_name) : row.customer_name,
      customer_gender: b.customer_gender !== undefined ? Number(b.customer_gender) : row.customer_gender,
      customer_phone: b.customer_phone !== undefined ? String(b.customer_phone) : row.customer_phone,
      source_type_id: b.source_type_id !== undefined ? Number(b.source_type_id) : row.source_type_id,
      province_code: b.province_code !== undefined ? String(b.province_code) : row.province_code,
      city_code: b.city_code !== undefined ? String(b.city_code) : row.city_code,
      area_code: b.area_code !== undefined ? String(b.area_code) : row.area_code,
      community_name: b.community_name !== undefined ? String(b.community_name) : row.community_name,
      room_number: b.room_number !== undefined ? String(b.room_number) : row.room_number,
      room_size: b.room_size !== undefined ? String(b.room_size) : row.room_size,
      address_detail: b.address_detail !== undefined ? String(b.address_detail) : row.address_detail
    };
    db.prepare(`UPDATE crm_public_customers SET
      customer_name=?, customer_gender=?, customer_phone=?, source_type_id=?,
      province_code=?, city_code=?, area_code=?, community_name=?, room_number=?, room_size=?, address_detail=?, update_time=?
      WHERE public_customer_id = ?`)
      .run(fields.customer_name, fields.customer_gender, fields.customer_phone, fields.source_type_id,
        fields.province_code, fields.city_code, fields.area_code, fields.community_name,
        fields.room_number, fields.room_size, fields.address_detail, dbNow(), pid);
    return ok({});
  };

  // ---------- B4 公海线索分配（单条） ----------
  handlers['POST /crm/public/customer/assign/'] = (req) => {
    const b = req.body || {};
    const pid = Number(b.public_customer_id || 0);
    const ownerId = Number(b.owner_id || 0);
    if (!pid || !ownerId) return errParam();
    const okCount = assignPublic([pid], ownerId);
    if (!okCount) return { code: 13001, msg: '公海线索不存在', data: {} };
    return ok({ success_num: okCount, fail_num: 0 });
  };

  // ---------- B5 公海线索批量分配 ----------
  handlers['POST /crm/public/customer/batch/assign/'] = (req) => {
    const b = req.body || {};
    const ids = idsOf(b.public_customer_ids || (b.public_customer_id ? [b.public_customer_id] : []));
    const ownerId = Number(b.owner_id || 0);
    if (!ids.length || !ownerId) return errParam();
    const okCount = assignPublic(ids, ownerId);
    if (okCount === 0) return { code: 13001, msg: '公海线索不存在', data: {} };
    const fail = ids.length - okCount;
    if (fail > 0) return { code: 25002, msg: '部分线索处理失败', data: { success_num: okCount, fail_num: fail } };
    return ok({ success_num: okCount, fail_num: 0 });
  };

  // ---------- B6 分配确认列表（线索对应的正式客户） ----------
  handlers['POST /crm/public/customer/assign/crm/list/'] = (req) => {
    const b = req.body || {};
    const ids = idsOf(b.crm_ids);
    // 确认列表：未指定 crm_ids 时无确认对象，返回空
    if (!ids.length) return ok({ total_num: 0, crm_list: [] });
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0', 'crm_id IN (' + ids.map(() => '?').join(',') + ')'];
    const params = [...ids];
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_customers WHERE ' + whereSql + ' ORDER BY crm_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ total_num: total, crm_list: rows.map(buildCrmItem) });
  };

  // ---------- B7 分配统计 ----------
  handlers['POST /crm/public/customer/assign/info/'] = (req) => {
    const b = req.body || {};
    const where = ['deleted = 0'];
    const params = [];
    if (b.start_date) { where.push('create_time >= ?'); params.push(String(b.start_date)); }
    if (b.end_date) { where.push('create_time <= ?'); params.push(String(b.end_date) + ' 23:59:59'); }
    const whereSql = where.join(' AND ');
    const total_count = db.prepare('SELECT COUNT(*) AS c FROM crm_public_customers WHERE ' + whereSql).get(...params).c;
    const assigned_count = db.prepare('SELECT COUNT(*) AS c FROM crm_public_customers WHERE ' + whereSql + ' AND status = 1').get(...params).c;
    const unassigned_count = db.prepare('SELECT COUNT(*) AS c FROM crm_public_customers WHERE ' + whereSql + ' AND status = 0').get(...params).c;
    const reclaimed_count = db.prepare('SELECT COUNT(*) AS c FROM crm_public_customers WHERE ' + whereSql + ' AND status = 2').get(...params).c;
    return ok({ total_count, assigned_count, unassigned_count, reclaimed_count });
  };

  // ---------- B8 公海筛选条件 ----------
  handlers['POST /crm/public/customer/filter/list/'] = (req) => {
    const sources = db.prepare('SELECT source_id AS id, name FROM crm_sources WHERE enable = 1 ORDER BY source_id').all();
    return ok({
      source_list: sources,
      status_list: [
        { id: 0, name: '待分配' },
        { id: 1, name: '已分配' },
        { id: 2, name: '已回收' }
      ]
    });
  };

  // ---------- B14 回收列表 ----------
  handlers['POST /crm/reclaim/public/customer/list/'] = (req) => {
    const b = req.body || {};
    const ids = idsOf(b.public_customer_ids);
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0', 'status = 2'];
    const params = [];
    if (ids.length) { where.push('public_customer_id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_public_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_public_customers WHERE ' + whereSql + ' ORDER BY public_customer_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ total_count: total, public_customers: rows.map(buildPublicItem) });
  };

  // ---------- E1 服务团队列表 ----------
  handlers['POST /crm/service/team/member/list/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    if (!crmId) return errParam();
    const crm = db.prepare('SELECT designer_id, designer_name FROM crm_customers WHERE crm_id = ? AND deleted = 0').get(crmId);
    const main_designer = crm && crm.designer_id ? { user_id: Number(crm.designer_id), user_name: crm.designer_name || '' } : null;
    const followers = db.prepare('SELECT user_id, user_name FROM crm_service_team WHERE crm_id = ? AND deleted = 0 AND team_role = 0 ORDER BY id').all(crmId)
      .map((r) => ({ user_id: Number(r.user_id), user_name: r.user_name }));
    return ok({ main_designer, followers });
  };

  // ---------- E2 服务团队添加协办成员 ----------
  handlers['POST /crm/service/team/member/add/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const fids = idsOf(b.followers || b.user_ids || []);
    if (!crmId || !fids.length) return errParam();
    const uid = sessionUserId(req.headers);
    const uname = userName(uid);
    const now = dbNow();
    for (const fid of fids) {
      const exists = db.prepare('SELECT id FROM crm_service_team WHERE crm_id = ? AND user_id = ? AND deleted = 0').get(crmId, fid);
      if (exists) continue;
      db.prepare(`INSERT INTO crm_service_team (crm_id, user_id, user_name, team_role, create_user_id, create_user_name, create_time, deleted, created_at, updated_at)
        VALUES (?,?,?,0,?,?,?,0,?,?)`)
        .run(crmId, fid, userName(fid), uid, uname, now, now, now);
    }
    return ok({});
  };

  // ---------- E3 服务团队移除协办成员 ----------
  handlers['POST /crm/service/team/member/del/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const fids = idsOf(b.followers || b.user_ids || []);
    if (!crmId || !fids.length) return errParam();
    db.prepare('UPDATE crm_service_team SET deleted = 1, updated_at = ? WHERE crm_id = ? AND deleted = 0 AND team_role = 0 AND user_id IN (' + fids.map(() => '?').join(',') + ')')
      .run(dbNow(), crmId, ...fids);
    return ok({});
  };

  // ---------- E4 移除主设计师 ----------
  handlers['POST /crm/service/team/main_designer/del/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const mainId = Number(b.main_designer_id || 0);
    if (!crmId || !mainId) return errParam();
    const crm = db.prepare('SELECT designer_id FROM crm_customers WHERE crm_id = ? AND deleted = 0').get(crmId);
    if (!crm) return { code: 13001, msg: '客户不存在', data: {} };
    db.prepare('UPDATE crm_customers SET designer_id = 0, designer_name = ?, updated_at = ? WHERE crm_id = ?')
      .run('', dbNow(), crmId);
    db.prepare('UPDATE crm_service_team SET deleted = 1, updated_at = ? WHERE crm_id = ? AND team_role = 1')
      .run(dbNow(), crmId);
    return ok({});
  };

  // ================= 第三批：D2~D7 配置 + F1~F9 附件 =================

  // ---------- 内部辅助：附件行 → 列表项 ----------
  const buildFileItem = (r) => {
    let files = [];
    try { files = JSON.parse(r.files || '[]'); } catch {}
    const ftype = Number(r.file_type || 0);
    return {
      item_id: Number(r.file_id),
      crm_id: Number(r.crm_id || 0),
      project_id: Number(r.project_id || 0),
      file_type: ftype,
      type: ftype,
      name: r.name || '',
      description: r.description || '',
      url: r.url || '',
      files,
      create_user_id: Number(r.create_user_id || 0),
      create_user_name: r.create_user_name || '',
      create_time: r.create_time || ''
    };
  };
  // 内部辅助：落附件操作记录（F2/F4/F6 调用）
  const addFileRecord = (headers, o) => {
    const uid = sessionUserId(headers);
    const now = dbNow();
    const recordId = localNextId('crm_file_record');
    db.prepare(`INSERT INTO crm_file_records
      (record_id, crm_id, project_id, file_id, action, content, operator_id, operator_name, create_time, deleted, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,?)`)
      .run(recordId, Number(o.crm_id || 0), Number(o.project_id || 0),
        Number(o.file_id || 0), Number(o.action || 0), String(o.content || ''),
        uid, userName(uid), now, now);
    // 记录号段占位，保证 localNextId 持续递增
    db.prepare("INSERT OR IGNORE INTO local_records (entity, record_id, payload, deleted, created_at, updated_at) VALUES ('crm_file_record', ?, '{}', 0, ?, ?)")
      .run(String(recordId), now, now);
  };
  // 内部辅助：配置行 upsert（D4~D7 幂等写 crm_field_settings；field_id 全局主键唯一）
  const upsertFieldSetting = (fieldId, fieldType, patch) => {
    const row = db.prepare('SELECT * FROM crm_field_settings WHERE field_id = ?').get(fieldId);
    const now = dbNow();
    if (row) {
      db.prepare('UPDATE crm_field_settings SET enable = ?, sort_order = ?, updated_at = ? WHERE field_id = ?')
        .run(patch.enable === undefined ? row.enable : patch.enable,
          patch.sort_order === undefined ? row.sort_order : patch.sort_order, now, fieldId);
    } else {
      db.prepare('INSERT INTO crm_field_settings (field_id, field_type, name, enable, sort_order, updated_at) VALUES (?,?,?,?,?,?)')
        .run(fieldId, fieldType, patch.name || '', patch.enable === undefined ? 1 : patch.enable,
          patch.sort_order === undefined ? 0 : patch.sort_order, now);
    }
  };

  // ---------- D2 作废标签启用开关 ----------
  handlers['POST /crm/aborted_tag/enable/'] = (req) => {
    const b = req.body || {};
    if (b.enable !== 0 && b.enable !== 1) return errParam();
    const ids = idsOf(b.aborted_list);
    // enable=0 时 aborted_list 可为空数组（原版行为）；仅当 enable=1 且无 id 时视为参数错误
    if (b.enable === 1 && !ids.length) return errParam();
    const now = dbNow();
    for (const sid of ids) {
      db.prepare('UPDATE crm_status SET enable = ?, updated_at = ? WHERE status_id = ?').run(b.enable, now, sid);
    }
    return ok({});
  };

  // ---------- D3 状态标签启用开关 ----------
  handlers['POST /crm/status_tag/enable/'] = (req) => {
    const b = req.body || {};
    if (b.enable !== 0 && b.enable !== 1) return errParam();
    const ids = idsOf(b.status_list || (b.status_id ? [b.status_id] : []));
    if (!ids.length) return errParam();
    const now = dbNow();
    for (const sid of ids) {
      const r = db.prepare('UPDATE crm_status SET enable = ?, updated_at = ? WHERE status_id = ?').run(b.enable, now, sid);
      if (!r.changes) return { code: 13001, msg: '状态不存在', data: {} };
    }
    return ok({});
  };

  // ---------- D4 筛选条件显隐 ----------
  handlers['POST /crm/screen/condition/enable/update/'] = (req) => {
    const b = req.body || {};
    const fieldId = Number(b.field_id || 0);
    if (!fieldId || (b.enable !== 0 && b.enable !== 1)) return errParam();
    upsertFieldSetting(fieldId, 0, { enable: b.enable });
    return ok({});
  };

  // ---------- D5 筛选条件排序 ----------
  handlers['POST /crm/screen/condition/order/update/'] = (req) => {
    const b = req.body || {};
    if (!Array.isArray(b.fields)) return errParam();
    b.fields.forEach((f, i) => {
      const fid = Number(f.field_id || f.id || 0);
      if (!fid) return;
      upsertFieldSetting(fid, 0, { sort_order: f.sort_order !== undefined ? Number(f.sort_order) : i });
    });
    return ok({});
  };

  // ---------- D6 列表表头显隐 ----------
  handlers['POST /crm/table/header/enable/update/'] = (req) => {
    const b = req.body || {};
    const fieldId = Number(b.field_id || 0);
    if (!fieldId || (b.enable !== 0 && b.enable !== 1)) return errParam();
    upsertFieldSetting(fieldId, 1, { enable: b.enable });
    return ok({});
  };

  // ---------- D7 列表表头排序 ----------
  handlers['POST /crm/table/header/order/update/'] = (req) => {
    const b = req.body || {};
    if (!Array.isArray(b.fields)) return errParam();
    b.fields.forEach((f, i) => {
      const fid = Number(f.field_id || f.id || 0);
      if (!fid) return;
      upsertFieldSetting(fid, 1, { sort_order: f.sort_order !== undefined ? Number(f.sort_order) : i });
    });
    return ok({});
  };

  // ---------- F1 附件列表 ----------
  handlers['POST /crm/file_item/list/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const projectId = Number(b.project_id || 0);
    if (!crmId && !projectId) return errParam();
    const where = ['deleted = 0'];
    const params = [];
    if (crmId) { where.push('crm_id = ?'); params.push(crmId); }
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (b.type !== undefined && b.type !== '' && b.type !== null) { where.push('file_type = ?'); params.push(Number(b.type)); }
    const rows = db.prepare('SELECT * FROM crm_file_items WHERE ' + where.join(' AND ') + ' ORDER BY id DESC').all(...params);
    return ok({ file_items: rows.map(buildFileItem), total_num: rows.length });
  };

  // ---------- F2 新增附件 ----------
  handlers['POST /crm/file_item/add/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const files = Array.isArray(b.files) ? b.files : [];
    if (!crmId || !files.length) return errParam();
    const uid = sessionUserId(req.headers);
    const now = dbNow();
    const fileId = localNextId('crm_file_item');
    const ftype = Number(b.type || (files[0] && files[0].type) || 0);
    const name = String(b.name || (files[0] && files[0].name) || '');
    const url = String(b.url || (files[0] && files[0].url) || '');
    const projectId = Number(b.project_id || 0);
    db.prepare(`INSERT INTO crm_file_items
      (file_id, crm_id, project_id, file_type, name, url, description, files, create_user_id, create_user_name, create_time, deleted, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`)
      .run(fileId, crmId, projectId, ftype, name, url, String(b.description || ''), JSON.stringify(files),
        uid, userName(uid), now, now, now);
    // 号段占位，保证 localNextId 持续递增（否则连续新增返回相同 id）
    db.prepare("INSERT OR IGNORE INTO local_records (entity, record_id, payload, deleted, created_at, updated_at) VALUES ('crm_file_item', ?, '{}', 0, ?, ?)")
      .run(String(fileId), now, now);
    addFileRecord(req.headers, { crm_id: crmId, project_id: projectId, file_id: fileId, action: 0, content: JSON.stringify({ name, files }) });
    return ok({ item_id: fileId });
  };

  // ---------- F3 重命名附件/文件夹 ----------
  handlers['POST /crm/file_item/edit/'] = (req) => {
    const b = req.body || {};
    const itemId = Number(b.item_id || 0);
    if (!itemId || b.name === undefined || b.name === null || String(b.name) === '') return errParam();
    const row = db.prepare('SELECT * FROM crm_file_items WHERE file_id = ? AND deleted = 0').get(itemId);
    if (!row) return { code: 13001, msg: '附件不存在', data: {} };
    db.prepare('UPDATE crm_file_items SET name = ?, description = ?, updated_at = ? WHERE file_id = ?')
      .run(String(b.name), b.description !== undefined ? String(b.description) : row.description, dbNow(), itemId);
    addFileRecord(req.headers, { crm_id: row.crm_id, project_id: row.project_id, file_id: itemId, action: 2, content: String(b.name) });
    return ok({});
  };

  // ---------- F4 删除附件 ----------
  handlers['POST /crm/file_item/del/'] = (req) => {
    const b = req.body || {};
    const ids = idsOf(b.item_ids);
    if (!ids.length) return errParam();
    const now = dbNow();
    let okCount = 0;
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM crm_file_items WHERE file_id = ? AND deleted = 0').get(id);
      if (!row) continue;
      db.prepare('UPDATE crm_file_items SET deleted = 1, updated_at = ? WHERE file_id = ?').run(now, id);
      addFileRecord(req.headers, { crm_id: row.crm_id, project_id: row.project_id, file_id: id, action: 1, content: row.name || '' });
      okCount++;
    }
    if (okCount === 0) return { code: 13001, msg: '附件不存在', data: {} };
    const fail = ids.length - okCount;
    if (fail > 0) return { code: 25002, msg: '部分附件处理失败', data: { success_num: okCount, fail_num: fail } };
    return ok({ success_num: okCount, fail_num: 0 });
  };

  // ---------- F5 附件详情 ----------
  handlers['POST /crm/file_item/detail/'] = (req) => {
    const b = req.body || {};
    const itemId = Number(b.item_id || 0);
    if (!itemId) return errParam();
    const row = db.prepare('SELECT * FROM crm_file_items WHERE file_id = ? AND deleted = 0').get(itemId);
    if (!row) return { code: 13001, msg: '附件不存在', data: {} };
    return ok({ file_item: buildFileItem(row) });
  };

  // ---------- F6 更新附件（改文件） ----------
  handlers['POST /crm/file_item/update/'] = (req) => {
    const b = req.body || {};
    const itemId = Number(b.item_id || 0);
    const files = Array.isArray(b.files) ? b.files : [];
    if (!itemId || !files.length) return errParam();
    const row = db.prepare('SELECT * FROM crm_file_items WHERE file_id = ? AND deleted = 0').get(itemId);
    if (!row) return { code: 13001, msg: '附件不存在', data: {} };
    db.prepare('UPDATE crm_file_items SET name = ?, description = ?, files = ?, updated_at = ? WHERE file_id = ?')
      .run(b.name !== undefined && b.name !== null && String(b.name) !== '' ? String(b.name) : row.name,
        b.description !== undefined ? String(b.description) : row.description,
        JSON.stringify(files), dbNow(), itemId);
    addFileRecord(req.headers, { crm_id: row.crm_id, project_id: row.project_id, file_id: itemId, action: 3, content: JSON.stringify({ name: b.name, files }) });
    return ok({});
  };

  // ---------- F7 附件操作记录列表 ----------
  handlers['POST /crm/file_item/record/list/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    // company_id 仅作兼容入参（本地记录表为公司级单库，无需按公司过滤）
    const whereSql = 'deleted = 0';
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_file_records WHERE ' + whereSql).get().c;
    const rows = db.prepare('SELECT * FROM crm_file_records WHERE ' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(page_size, (page_index - 1) * page_size);
    return ok({
      total_num: total,
      records: rows.map((r) => ({
        record_id: Number(r.record_id),
        crm_id: Number(r.crm_id || 0),
        project_id: Number(r.project_id || 0),
        file_id: Number(r.file_id || 0),
        action: Number(r.action || 0),
        content: r.content || '',
        operator_name: r.operator_name || '',
        create_time: r.create_time || ''
      }))
    });
  };

  // ---------- F8 附件操作记录详情 ----------
  handlers['POST /crm/file_item/record/detail/'] = (req) => {
    const b = req.body || {};
    const recordId = Number(b.record_id || 0);
    if (!recordId) return errParam();
    const r = db.prepare('SELECT * FROM crm_file_records WHERE record_id = ? AND deleted = 0').get(recordId);
    if (!r) return { code: 13001, msg: '记录不存在', data: {} };
    return ok({
      record: {
        record_id: Number(r.record_id),
        crm_id: Number(r.crm_id || 0),
        project_id: Number(r.project_id || 0),
        file_id: Number(r.file_id || 0),
        action: Number(r.action || 0),
        content: r.content || '',
        operator_name: r.operator_name || '',
        create_time: r.create_time || ''
      }
    });
  };

  // ---------- F9 未读附件数 ----------
  handlers['POST /crm/file_item/unread/count/'] = (req) => {
    const b = req.body || {};
    const projectId = Number(b.project_id || 0);
    if (!projectId) return errParam();
    const ts = Number(b.timestamp || 0);
    let unread_count = 0;
    const rows = db.prepare('SELECT create_time FROM crm_file_items WHERE project_id = ? AND deleted = 0').all(projectId);
    for (const r of rows) {
      if (!r.create_time) continue;
      const t = new Date(r.create_time).getTime();
      if (!Number.isNaN(t) && t > ts) unread_count++;
    }
    return ok({ unread_count });
  };

  // ---------- F10 客户名下项目信息：code 0 + data.project_id；无项目返回 10805 ----------
  // 前端消费（openProject）：10805 → "您还没有项目，请先创建项目！"；0 → 跳转项目详情
  handlers['POST /crm/project/group/info/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    if (!crmId) return errParam();
    const crm = db.prepare('SELECT * FROM crm_customers WHERE crm_id = ?').get(crmId);
    if (!crm) return null; // 本地无此客户，回退云端代理兜底
    if (crm.deleted) return { code: 13001, msg: '客户不存在', data: {} };
    // 项目关联：① 本地新建项目（list_json 内 crm_id 匹配）② 迁移项目（customer_name + phone_number 精确匹配）
    const rows = db.prepare('SELECT * FROM projects WHERE deleted = 0').all();
    let project = null;
    for (const r of rows) {
      let lj = {};
      try { lj = JSON.parse(r.list_json || '{}'); } catch {}
      if (Number(lj.crm_id) === crmId) { project = r; break; }
    }
    if (!project && crm.customer_name && crm.customer_phone) {
      project = rows.find((r) => r.customer_name === crm.customer_name && r.phone_number === crm.customer_phone) || null;
    }
    if (!project) return { code: 10805, msg: '您还没有项目，请先创建项目！', data: {} };
    return ok({ project_id: Number(project.project_id) });
  };

  // ---------- G2 网单客户详情：internet_customer_id 或 crm_id ----------
  // 前端对话框消费字段：customer_name/customer_gender/customer_phone/share_type/source/source_name/other_content/city_name/room_size
  const buildInternetDetail = (row) => {
    let dj = {};
    try { dj = JSON.parse(row.detail_json || '{}'); } catch {}
    return {
      crm_id: Number(row.crm_id),
      customer_name: row.customer_name || dj.name || '',
      customer_gender: Number(row.customer_gender != null ? row.customer_gender : (dj.gender || 0)),
      customer_phone: row.customer_phone || dj.phone_number || '',
      share_type: Number(dj.share_type || 0),
      source: Number(row.source || 0),
      source_name: row.source_name || dj.source_name || '',
      other_content: dj.other_content || '',
      city_name: dj.city_name || row.address || '',
      room_size: row.room_size || dj.room_size || '0'
    };
  };
  const buildInternetPublicDetail = (r) => ({
    crm_id: Number(r.public_customer_id),
    customer_name: r.customer_name || '',
    customer_gender: Number(r.customer_gender || 0),
    customer_phone: r.customer_phone || '',
    share_type: 0,
    source: Number(r.source_type_id || 0),
    source_name: '',
    other_content: '',
    city_name: r.address_detail || '',
    room_size: r.room_size || '0'
  });
  handlers['POST /crm/internet_customer/detail/'] = (req) => {
    const b = req.body || {};
    const internetId = Number(b.internet_customer_id || 0);
    const crmId = Number(b.crm_id || 0);
    if (!internetId && !crmId) return errParam();
    const row = db.prepare('SELECT * FROM crm_customers WHERE crm_id = ?').get(crmId || internetId);
    if (!row) {
      // internet_customer_id 兜底：公海线索（本地网单客户数据源）
      if (internetId) {
        const pub = db.prepare('SELECT * FROM crm_public_customers WHERE public_customer_id = ? AND deleted = 0').get(internetId);
        if (pub) return ok(buildInternetPublicDetail(pub));
      }
      return null; // 本地无此客户，回退云端代理兜底
    }
    if (row.deleted) return { code: 13001, msg: '客户不存在', data: {} };
    return ok(buildInternetDetail(row));
  };

  // ---------- G3 跟进记录导出：真 xlsx 文件流（前端 exportFollowUpRecord 以 blob 消费） ----------
  handlers['POST /crm/follow/record/export/'] = async (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    if (!crmId) return errParam();
    let where = 'crm_id = ? AND deleted = 0';
    const params = [crmId];
    if (b.follow_type !== undefined && b.follow_type !== '' && Number(b.follow_type) > 0) {
      where += ' AND follow_type = ?';
      params.push(Number(b.follow_type));
    }
    const rows = db.prepare('SELECT * FROM crm_follow_records WHERE ' + where + ' ORDER BY follow_time DESC, id DESC').all(...params);
    const exportRows = rows.map((r) => {
      let extra = {};
      try { extra = JSON.parse(r.extra_json || '{}'); } catch {}
      return {
        record_id: r.follow_id,
        create_user_name: r.create_user_name || extra.create_user_name || '',
        create_time: r.follow_time,
        follow_type: r.follow_type,
        follow_type_name: r.follow_type_name || extra.follow_type_name || '',
        content: r.content || ''
      };
    });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return buildXlsx('跟进记录_' + day + '.xlsx', '跟进记录',
      ['记录ID', '跟进人', '跟进时间', '跟进类型', '跟进内容'], exportRows,
      ['record_id', 'create_user_name', 'create_time', 'follow_type_name', 'content']);
  };

  // ================= 第四批剩余 23 项（H1~H6 / A5~A11 / B9~B13 / C2 / C4~C5 / D8 / D10 / G1） =================
  // 公海线索行（B9 导出 / B13 搜索 / G1 网单列表共用）
  const buildPublicRow = (r) => ({
    public_customer_id: Number(r.public_customer_id),
    customer_name: r.customer_name || '',
    customer_gender: Number(r.customer_gender || 0),
    customer_phone: r.customer_phone || '',
    source_type_id: Number(r.source_type_id || 0),
    province_code: r.province_code || '', city_code: r.city_code || '', area_code: r.area_code || '',
    community_name: r.community_name || '', room_number: r.room_number || '',
    room_size: r.room_size || '', address_detail: r.address_detail || '',
    status: Number(r.status || 0), owner_id: Number(r.owner_id || 0), owner_name: r.owner_name || '',
    create_time: r.create_time || ''
  });

  // ---------- A5 需跟进客户列表 ----------
  handlers['POST /crm/v2/need/follow/list/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0', 'is_aborted = 0'];
    const params = [];
    const ct = Number(b.customer_type_id || 0);
    if (ct > 0) { where.push('customer_type_id = ?'); params.push(ct); }
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_customers WHERE ' + whereSql + ' ORDER BY update_time DESC, crm_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ total_num: total, crm_list: rows.map(buildCrmItem) });
  };

  // ---------- A6 部门维度客户统计 ----------
  handlers['POST /crm/company/crm/all_department/'] = (req) => {
    const rows = db.prepare('SELECT * FROM company_departments ORDER BY sort, id').all();
    const contents = rows.map((r) => ({ id: String(r.id), name: r.name || '', child_departments: [] }));
    return ok({ contents });
  };

  // ---------- A7 成员维度客户统计 ----------
  handlers['POST /crm/company/crm/all_user/'] = (req) => {
    const b = req.body || {};
    const deps = Array.isArray(b.department_ids) ? b.department_ids.map(String).filter(Boolean) : [];
    const where = deps.length ? ' WHERE department_id IN (' + deps.map(() => '?').join(',') + ')' : '';
    const rows = db.prepare('SELECT id, name FROM company_members' + where + ' ORDER BY id').all(...deps);
    const contents = rows.map((r) => ({ user_id: Number(r.id), user_name: r.name || '' }));
    return ok({ contents });
  };

  // ---------- A8 客户类型字典 ----------
  handlers['POST /crm/company/crm/customer_type/list/'] = (req) => {
    const rows = db.prepare("SELECT customer_type_id, customer_type_name FROM crm_customers WHERE deleted = 0 AND customer_type_id > 0 AND customer_type_name != '' GROUP BY customer_type_id, customer_type_name ORDER BY customer_type_id").all();
    return ok({ customer_type_list: rows.map((r) => ({ customer_type_id: Number(r.customer_type_id), name: r.customer_type_name, description: '' })) });
  };

  // ---------- A9 角色成员列表 ----------
  handlers['POST /crm/company/crm/role/member/list/'] = (req) => {
    const rows = db.prepare('SELECT id, name FROM company_members ORDER BY id').all();
    return ok({ members: rows.map((r) => ({ user_id: Number(r.id), user_name: r.name || '', is_leave: 0 })) });
  };

  // ---------- A10 销售分析（原版返回 echarts HTML，本地回退云端代理） ----------
  handlers['GET /crm/statistic/'] = () => null;

  // ---------- B9 公海线索导出：真 xlsx 文件流（前端 exportCustomer 以 blob 消费） ----------
  handlers['POST /crm/public/customer/export/excel/'] = async (req) => {
    const b = req.body || {};
    const ids = idsOf(b.public_customer_ids);
    let where = 'deleted = 0';
    const params = [];
    if (ids.length) { where += ' AND public_customer_id IN (' + ids.map(() => '?').join(',') + ')'; params.push(...ids); }
    const rows = db.prepare('SELECT * FROM crm_public_customers WHERE ' + where + ' ORDER BY public_customer_id DESC').all(...params);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return buildXlsx('公海线索导出_' + day + '.xlsx', '公海线索',
      ['线索名称', '性别', '电话', '线索来源', '省份', '城市', '区县', '小区', '房号', '房屋面积', '地址详情'],
      rows.map(buildPublicRow),
      ['customer_name', 'customer_gender', 'customer_phone', 'source_type_id', 'province_code', 'city_code', 'area_code', 'community_name', 'room_number', 'room_size', 'address_detail']);
  };

  // ---------- B10 线索导入模板：真 xlsx 文件流（前端 getTemplate 以 blob 消费） ----------
  handlers['GET /crm/public/customer/download/excel/'] = () => buildXlsx('线索批量导入模板.xlsx', '线索模板',
    ['线索名称', '性别', '电话', '线索来源', '省份', '城市', '区县', '小区', '房号', '房屋面积', '地址详情'], [], []);

  // ---------- B11/B12 线索上传导入：本地不解析 xlsx，回退云端代理 ----------
  handlers['POST /crm/public/customer/upload/excel/'] = () => null;
  handlers['POST /crm/public/customer/confirm/excel/'] = () => null;

  // ---------- B13 公海搜索 ----------
  handlers['POST /crm/open_sea/search/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    const kw = String(b.search_key || '').trim();
    let where = 'deleted = 0';
    const params = [];
    if (kw) {
      where += ' AND (customer_name LIKE ? OR customer_phone LIKE ? OR address_detail LIKE ? OR community_name LIKE ?)';
      const like = '%' + kw + '%';
      params.push(like, like, like, like);
    }
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_public_customers WHERE ' + where).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_public_customers WHERE ' + where + ' ORDER BY create_time DESC, public_customer_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ total_count: total, public_customers: rows.map(buildPublicRow) });
  };

  // ---------- C2 单条转交负责人（同 C1） ----------
  handlers['POST /crm/reassign_owner/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const ownerId = Number(b.owner_id || 0);
    if (!crmId || !ownerId) return errParam();
    const row = db.prepare('SELECT crm_id FROM crm_customers WHERE crm_id = ? AND deleted = 0').get(crmId);
    if (!row) return { code: 13001, msg: '客户不存在', data: {} };
    const ownerName = userName(ownerId);
    db.prepare('UPDATE crm_customers SET owner_id = ?, owner_name = ?, updated_at = ? WHERE crm_id = ?')
      .run(ownerId, ownerName, dbNow(), crmId);
    return ok({ crm_id: crmId, owner_id: ownerId, owner_name: ownerName });
  };

  // ---------- C4 转交确认列表（按 crm_ids） ----------
  handlers['POST /crm/reassign/owner/list/'] = (req) => {
    const b = req.body || {};
    const ids = idsOf(b.crm_ids);
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0'];
    const params = [];
    if (ids.length) { where.push('crm_id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_customers WHERE ' + whereSql + ' ORDER BY crm_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ total_num: total, crm_list: rows.map(buildCrmItem) });
  };

  // ---------- C5 转主设计师（客户 + 服务团队 team_role=1） ----------
  handlers['POST /crm/reassign_main_designer/'] = (req) => {
    const b = req.body || {};
    const crmId = Number(b.crm_id || 0);
    const mdId = Number(b.main_designer_id || 0);
    if (!crmId || !mdId) return errParam();
    const row = db.prepare('SELECT crm_id FROM crm_customers WHERE crm_id = ? AND deleted = 0').get(crmId);
    if (!row) return { code: 13001, msg: '客户不存在', data: {} };
    const mdName = userName(mdId);
    const now = dbNow();
    db.prepare('UPDATE crm_customers SET designer_id = ?, designer_name = ?, updated_at = ? WHERE crm_id = ?').run(mdId, mdName, now, crmId);
    const st = db.prepare('SELECT id FROM crm_service_team WHERE crm_id = ? AND team_role = 1 AND deleted = 0').get(crmId);
    if (st) {
      db.prepare('UPDATE crm_service_team SET user_id = ?, user_name = ?, updated_at = ? WHERE id = ?').run(mdId, mdName, now, st.id);
    } else {
      const uid = sessionUserId(req.headers);
      db.prepare('INSERT INTO crm_service_team (crm_id, user_id, user_name, team_role, create_user_id, create_user_name, create_time, deleted, created_at, updated_at) VALUES (?,?,?,1,?,?,?,0,?,?)')
        .run(crmId, mdId, mdName, uid, userName(uid), now, now, now);
    }
    return ok({ crm_id: crmId, main_designer_id: mdId, main_designer_name: mdName });
  };

  // ---------- D8 新增客户初始数据（本地无区域快照，返回空默认，待校准） ----------
  handlers['POST /crm/add_info/get/'] = () => ok({
    province_code: '', province_name: '', city_code: '', city_name: '', area_code: '', area_name: ''
  });

  // ---------- D10 相似房源检查 ----------
  handlers['POST /crm/house/similar/check/'] = (req) => {
    const b = req.body || {};
    const room = b.room_info || {};
    const { page_index, page_size } = pager(b);
    const addr = String(room.address || room.address_detail || room.community_name || '').trim();
    const roomSize = String(room.room_size || '').trim();
    if (!addr && !roomSize) return ok({ total_num: 0, crm_list: [] });
    const where = ['deleted = 0'];
    const params = [];
    if (addr) { where.push('(address LIKE ? OR detail_json LIKE ?)'); const like = '%' + addr + '%'; params.push(like, like); }
    if (roomSize) { where.push('room_size = ?'); params.push(roomSize); }
    const crmId = Number(b.crm_id || 0);
    if (crmId) { where.push('crm_id != ?'); params.push(crmId); }
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_customers WHERE ' + whereSql + ' ORDER BY update_time DESC, crm_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    return ok({ total_num: total, crm_list: rows.map(buildCrmItem) });
  };

  // ---------- G1 网单客户列表（本地线索数据源 = crm_public_customers） ----------
  handlers['POST /crm/internet_customer/list/'] = (req) => {
    const b = req.body || {};
    const { page_index, page_size } = pager(b);
    const where = ['deleted = 0'];
    const params = [];
    if (b.status !== undefined && b.status !== '' && b.status !== null) { where.push('status = ?'); params.push(Number(b.status)); }
    const kw = String(b.search_key || '').trim();
    if (kw) { where.push('(customer_name LIKE ? OR customer_phone LIKE ? OR address_detail LIKE ?)'); const like = '%' + kw + '%'; params.push(like, like, like); }
    const whereSql = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) AS c FROM crm_public_customers WHERE ' + whereSql).get(...params).c;
    const rows = db.prepare('SELECT * FROM crm_public_customers WHERE ' + whereSql + ' ORDER BY create_time DESC, public_customer_id DESC LIMIT ? OFFSET ?')
      .all(...params, page_size, (page_index - 1) * page_size);
    const crm_list = rows.map((r) => ({
      crm_id: Number(r.public_customer_id),
      customer_name: r.customer_name || '',
      customer_gender: Number(r.customer_gender || 0),
      customer_phone: r.customer_phone || '',
      source: Number(r.source_type_id || 0),
      source_name: '',
      address: r.address_detail || '',
      room_size: r.room_size || '0',
      owner_id: Number(r.owner_id || 0),
      owner_name: r.owner_name || '',
      status: Number(r.status || 0),
      create_time: r.create_time || ''
    }));
    return ok({ total_num: total, crm_list });
  };

  // ---------- H1 客户导入模板：真 xlsx 文件流（前端 getCustomerTemp 以 blob 消费） ----------
  handlers['GET /crm/download/excel/'] = () => buildXlsx('客户模板.xlsx', '客户模板',
    ['客户名称', '性别', '联系电话', '客户来源', '客户类型', '省份', '城市', '区县', '小区', '房号', '房屋面积', '地址详情', '备注'], [], []);

  // ---------- H2/H3 客户上传导入：本地不解析 xlsx / 无导入临时数据，回退云端代理 ----------
  handlers['POST /crm/upload/excel/'] = () => null;
  handlers['GET /crm/confirm/excel/'] = () => null;

  // ---------- H4 客户数据导出：真 xlsx 文件流（前端 exportCustomer 以 blob 消费） ----------
  handlers['GET /crm/customer/data/'] = async (req) => {
    const q = req.query || {};
    const r = queryCrmList({ ...q, page_index: 1, page_size: 10000, search_word: q.search_key || q.search_word || '' }, false);
    const rows = (r && r.data && r.data.crm_list) || [];
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return buildXlsx('客户数据_' + day + '.xlsx', '客户数据',
      ['客户名称', '性别', '联系电话', '客户类型', '客户来源', '所在小区', '房屋面积', '负责人', '设计师', '客户状态', '创建时间'], rows,
      ['customer_name', 'customer_gender', 'customer_phone', 'customer_type_name', 'source_name', 'address', 'room_size', 'owner_name', 'designer_name', 'status_name', 'create_time']);
  };

  // ---------- H5 客户列表导出：真 xlsx 文件流（前端 exportCustomer 以 blob 消费） ----------
  handlers['POST /crm/v2/export/'] = async (req) => {
    const b = req.body || {};
    const r = queryCrmList({ ...b, page_index: 1, page_size: Math.max(1, Number(b.page_size || 10000)), search_word: b.search_key || b.search_word || '' }, false);
    const rows = (r && r.data && r.data.crm_list) || [];
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return buildXlsx('客户列表_' + day + '.xlsx', '客户列表',
      ['客户名称', '性别', '联系电话', '客户类型', '客户来源', '所在小区', '房屋面积', '负责人', '设计师', '客户状态', '创建时间'], rows,
      ['customer_name', 'customer_gender', 'customer_phone', 'customer_type_name', 'source_name', 'address', 'room_size', 'owner_name', 'designer_name', 'status_name', 'create_time']);
  };

  return handlers;
}

module.exports = { createCrmApi };
