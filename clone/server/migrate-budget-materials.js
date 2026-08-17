/**
 * 预算材料库 + 区域属性定义迁移脚本
 * 用法: node server/migrate-budget-materials.js
 * 说明:
 *   - /budget/material/list/ 分页拉取全量材料 → budget_materials（addAreaItem 按 material_ids 建项用）
 *   - /budget/template/area/attribute/list/ 区域属性定义 → budget_globals(kind=area_attribute_list)
 *   - 幂等：INSERT OR REPLACE
 */
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { BUDGET_SCHEMA_SQL } = require('./budget-schema');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'local.db');
const API_HOST = 'lzapi.e-shigong.com';
const API_BASE = '/api';

const db = new DatabaseSync(DB_PATH);
db.exec(BUDGET_SCHEMA_SQL);
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

async function main() {
  const admin = db.prepare('SELECT * FROM users WHERE is_administrator = 1 ORDER BY id ASC LIMIT 1').get();
  if (!admin || !admin.password_plain) { console.error('本地未找到管理员账号'); process.exit(1); }

  console.log('[1/3] 云端登录:', admin.phone);
  const session = await cloudLogin(admin.phone, admin.password_plain);
  if (!session) { console.error('云端登录失败'); process.exit(1); }
  console.log('      登录成功 company_id=' + session.company_id);

  console.log('[2/3] 拉取材料库（分页）');
  let page = 1, total = 0, saved = 0;
  while (true) {
    const r = await cloudPost('/budget/material/list/', { page_index: page, page_size: 100 }, session);
    if (r.code !== 0 || !r.data || !Array.isArray(r.data.materials)) { console.log('  第 ' + page + ' 页拉取失败:', r.msg || r.code || JSON.stringify(r).slice(0, 200)); break; }
    const list = r.data.materials;
    if (!list.length) break;
    for (const m of list) {
      db.prepare('INSERT OR REPLACE INTO budget_materials (material_id, payload, commodity_type_id, band, model, specification, name, supplier_id, sale_price, cost_price, unit, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(Number(m.id), JSON.stringify(m), Number(m.commodity_type_id || 0), m.band || '', m.model || '', m.specification || '', m.name || '',
          Number(m.supplier_id || 0), String(m.sale_price || '0'), String(m.cost_price || '0'), m.sale_unit || m.cost_unit || '', now());
      saved++;
    }
    total = r.data.total_num || list.length;
    console.log('  第 ' + page + ' 页 ' + list.length + ' 条（累计 ' + saved + ' / total ' + total + '）');
    if (saved >= total || list.length < 100) break;
    page++;
  }

  console.log('[3/3] 拉取区域属性定义');
  const attr = await cloudPost('/budget/template/area/attribute/list/', { budget_id: 100631 }, session);
  if (attr.code === 0 && attr.data && Array.isArray(attr.data.area_attribute_list)) {
    db.prepare('INSERT OR REPLACE INTO budget_globals (kind, payload, updated_at) VALUES (?,?,?)')
      .run('area_attribute_list', JSON.stringify(attr.data.area_attribute_list), now());
    console.log('  area_attribute_list OK (' + attr.data.area_attribute_list.length + ' 项)');
  } else {
    console.log('  区域属性定义拉取失败:', attr.msg || attr.code);
  }

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM budget_materials').get().c;
  console.log('\n迁移完成：材料库 ' + cnt + ' 条');
}

main().catch((e) => { console.error('迁移异常', e); process.exit(2); });
