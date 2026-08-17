/**
 * 企业后台（houtai）种子数据迁移
 * ---------------------------------------------------------------
 * 数据源优先级：
 *  1. E:/Program Files (x86)/000000/api_data/*.json —— 原站企业后台接口的真实响应快照
 *  2. ./company-seed-data.js —— houtai mock 数据转录（回退）
 * 服务启动时（local-api.js）检测到 company_* 表为空自动执行；也可手动运行：
 *   node server/seed-company.js
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { COMPANY_SCHEMA_SQL } = require('./company-schema');
const fallback = require('./company-seed-data');

const API_DATA_DIR = process.env.API_DATA_DIR || 'E:/Program Files (x86)/000000/api_data';

function readApi(name) {
  const p = path.join(API_DATA_DIR, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

// houtai mock 我的模板阶段（转录自 houtai/src/api/data.ts）
const jianyiStages = [
  { name: '户型改建', days: '第5-9天 共5天', tasks: [{ name: '拆墙工程' }, { name: '砌墙工程' }], notices: [], methods: [] },
  { name: '水电排放阶段', days: '第10-25天 共16天', tasks: [{ name: '水路改造' }, { name: '电路改造' }], notices: [{ title: '强弱电需分离布线', remark: '水电工、项目管家', detail: '-' }], methods: [] },
  { name: '泥瓦工阶段', days: '第38-55天 共18天', tasks: [{ name: '防水施工' }, { name: '瓷砖铺贴' }], notices: [{ title: '防水完成需做48小时闭水试验', remark: '泥瓦工、质检员', detail: '-' }], methods: [] },
  { name: '油漆阶段', days: '第55-76天 共22天', tasks: [{ name: '墙面腻子' }, { name: '乳胶漆涂刷' }], notices: [], methods: [] },
  { name: '木作安装阶段', days: '第76-81天 共6天', tasks: [{ name: '套装门安装' }, { name: '木地板铺装' }], notices: [], methods: [] },
  { name: '水电安装阶段', days: '第81-85天 共5天', tasks: [{ name: '灯具安装' }, { name: '洁具安装' }], notices: [], methods: [] },
  { name: '软装进场', days: '第90-96天 共7天', tasks: [{ name: '家具进场' }], notices: [], methods: [] },
  { name: '圆满交房', days: '第96-100天 共5天', tasks: [{ name: '整体验收' }, { name: '交付钥匙' }], notices: [], methods: [] },
];
const gongyuStages = [
  { name: '进场阶段', days: '第1-2天 共2天', tasks: [{ name: '进场交底' }], notices: [], methods: [] },
  { name: '开工阶段', days: '第2-3天 共2天', tasks: [{ name: '开工交底' }, { name: '砌墙材料进场验收' }, { name: '新砌墙体验收' }], notices: [{ title: '砌墙材料需业主验收签字', remark: '砌墙工、项目经理、工班长', detail: '-' }], methods: [] },
  { name: '拆除、除旧', days: '第3-5天 共3天', tasks: [{ name: '拆除工程' }, { name: '垃圾清运' }], notices: [], methods: [] },
  { name: '对图放线', days: '第9-11天 共3天', tasks: [{ name: '放线定位' }], notices: [], methods: [] },
  { name: '主材选样', days: '第5-35天 共31天', tasks: [{ name: '主材选定' }], notices: [], methods: [] },
  { name: '水电排放阶段', days: '第10-25天 共16天', tasks: [{ name: '水路改造' }, { name: '电路改造' }], notices: [{ title: '水电改造验收需业主签字确认', remark: '水电工、项目管家', detail: '-' }], methods: [] },
  { name: '木工阶段', days: '第25-43天 共19天', tasks: [{ name: '吊顶安装' }, { name: '柜体定制' }], notices: [], methods: [] },
  { name: '泥瓦工阶段', days: '第38-55天 共18天', tasks: [{ name: '防水施工' }, { name: '瓷砖铺贴' }], notices: [{ title: '瓷砖铺贴完成后需做48小时闭水试验', remark: '泥瓦工、质检员', detail: '-' }], methods: [] },
  { name: '油漆阶段', days: '第55-76天 共22天', tasks: [{ name: '墙面腻子' }, { name: '乳胶漆涂刷' }], notices: [], methods: [] },
  { name: '木作安装阶段', days: '第76-81天 共6天', tasks: [{ name: '套装门安装' }, { name: '木地板铺装' }], notices: [], methods: [] },
  { name: '水电安装阶段', days: '第81-85天 共5天', tasks: [{ name: '灯具安装' }, { name: '洁具安装' }], notices: [], methods: [] },
  { name: '清场竣工', days: '第85-90天 共6天', tasks: [{ name: '现场清理' }], notices: [], methods: [] },
  { name: '软装进场', days: '第90-96天 共7天', tasks: [{ name: '家具进场' }, { name: '家电安装' }], notices: [], methods: [] },
  { name: '圆满交房', days: '第96-100天 共5天', tasks: [{ name: '整体验收' }, { name: '交付钥匙' }], notices: [{ title: '验收合格后交付钥匙', remark: '项目经理、业主', detail: '-' }], methods: [] },
];
const bieshuStages = [
  { name: '进场阶段', days: '第1-2天 共2天', tasks: [{ name: '进场交底' }], notices: [], methods: [] },
  { name: '开工阶段', days: '第2-3天 共2天', tasks: [{ name: '开工交底' }], notices: [], methods: [] },
  { name: '拆除、除旧', days: '第3-5天 共3天', tasks: [{ name: '拆除工程' }, { name: '垃圾清运' }], notices: [], methods: [] },
  { name: '对图放线', days: '第9-11天 共3天', tasks: [{ name: '放线定位' }], notices: [], methods: [] },
  { name: '主材选样', days: '第5-45天 共41天', tasks: [{ name: '主材选定' }], notices: [], methods: [] },
  { name: '水电排放阶段', days: '第10-40天 共31天', tasks: [{ name: '水路改造' }, { name: '电路改造' }], notices: [], methods: [] },
  { name: '木工阶段', days: '第40-75天 共36天', tasks: [{ name: '吊顶安装' }, { name: '柜体定制' }], notices: [], methods: [] },
  { name: '泥瓦工阶段', days: '第75-110天 共36天', tasks: [{ name: '防水施工' }, { name: '瓷砖铺贴' }], notices: [], methods: [] },
  { name: '油漆阶段', days: '第110-150天 共41天', tasks: [{ name: '墙面腻子' }, { name: '乳胶漆涂刷' }], notices: [], methods: [] },
  { name: '木作安装阶段', days: '第150-158天 共9天', tasks: [{ name: '套装门安装' }, { name: '木地板铺装' }], notices: [], methods: [] },
  { name: '水电安装阶段', days: '第158-164天 共7天', tasks: [{ name: '灯具安装' }, { name: '洁具安装' }], notices: [], methods: [] },
  { name: '清场竣工', days: '第164-170天 共7天', tasks: [{ name: '现场清理' }], notices: [], methods: [] },
  { name: '软装进场', days: '第170-177天 共8天', tasks: [{ name: '家具进场' }], notices: [], methods: [] },
  { name: '圆满交房', days: '第177-180天 共4天', tasks: [{ name: '整体验收' }, { name: '交付钥匙' }], notices: [], methods: [] },
];

/**
 * 执行种子迁移（幂等：先清空 company_* 表再插入）
 * @param {DatabaseSync} db
 */
function seedCompany(db) {
  db.exec(COMPANY_SCHEMA_SQL);
  db.exec('BEGIN');
  try {
    // 清空
    for (const t of [
      'company_departments', 'company_members', 'company_info', 'company_banners', 'company_branches',
      'company_admins', 'company_suppliers', 'company_supplier_types', 'company_materials',
      'company_material_categories', 'company_quota_types', 'company_quotas', 'company_material_costs',
      'company_budget_templates', 'company_market_templates', 'company_my_templates',
      'company_terms', 'company_term_categories', 'company_role_groups', 'company_permission_trees',
    ]) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    /* ---------------- 部门 + 成员（真实快照优先） ---------------- */
    const deptApi = readApi('company_v2_department_list.json');
    const deptList = deptApi && deptApi.data && Array.isArray(deptApi.data.department_list) ? deptApi.data.department_list : [];
    if (deptList.length) {
      deptList.forEach((d, i) => {
        const id = 'D' + (i + 1);
        const users = Array.isArray(d.user_info_list) ? d.user_info_list : [];
        db.prepare('INSERT INTO company_departments (id, name, count, parent_id, owner, data_owner, sort) VALUES (?,?,?,?,?,?,?)')
          .run(id, String(d.name || ''), users.length, '', '', '', i + 1);
        users.forEach((u) => {
          const roles = Array.isArray(u.roles) ? u.roles.map((r) => r.role_name) : [];
          const exists = db.prepare('SELECT id FROM company_members WHERE id = ?').get(Number(u.user_id));
          if (!exists) {
            db.prepare('INSERT INTO company_members (id, name, phone, avatar, roles_json, tag, department_id, department_ids_json, enabled, deleted, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)')
              .run(Number(u.user_id), String(u.user_name || ''), String(u.user_phone || ''), String(u.user_avatar || ''), JSON.stringify(roles),
                u.is_leader ? '主管' : '', id, JSON.stringify([id]), 1, new Date().toISOString());
          }
        });
      });
    } else {
      // 回退：houtai mock 部门/成员
      const deptMock = [
        { id: 'manage', name: '管理部', count: 2 }, { id: 'manage-1', name: '管理一部', count: 0, parentId: 'manage' },
        { id: 'eng', name: '工程部', count: 4 }, { id: 'admin', name: '行政部', count: 3 },
        { id: 'market', name: '市场部', count: 4 }, { id: 'material', name: '材料部', count: 2 },
        { id: 'design', name: '设计部', count: 3 }, { id: 'finance', name: '财务部', count: 2 },
      ];
      deptMock.forEach((d, i) => {
        db.prepare('INSERT INTO company_departments (id, name, count, parent_id, owner, data_owner, sort) VALUES (?,?,?,?,?,?,?)')
          .run(d.id, d.name, d.count, d.parentId || '', '', '', i + 1);
      });
      const memberMock = [
        { id: 1, name: '小君', phone: '18300000001', roles: ['财务', '财务总监', '店面经理', '总经理', '仓库管理员'], tag: '主管', dept: 'finance' },
        { id: 2, name: 'ceshi', phone: '18889898989', roles: ['设计师', '制图员', '设计总监', '店面经理', '总经理'], dept: 'manage' },
        { id: 3, name: '乡非', phone: '13500000003', roles: ['设计师', '设计主管'], dept: 'design' },
        { id: 4, name: '里斯', phone: '13600000004', roles: ['市场总监', '销售'], dept: 'market' },
        { id: 5, name: '王俊民', phone: '13700000005', roles: ['施工部经理', '工班长'], dept: 'eng' },
        { id: 6, name: '李建', phone: '13800000006', roles: ['材料总监', '主材专员'], dept: 'material' },
      ];
      memberMock.forEach((m) => {
        db.prepare('INSERT INTO company_members (id, name, phone, avatar, roles_json, tag, department_id, department_ids_json, enabled, deleted, created_at) VALUES (?,?,?,?,?,?,?,?,1,0,?)')
          .run(m.id, m.name, m.phone, '/assets/cdn.e-shigong.com/brief_default_avatar.png', JSON.stringify(m.roles), m.tag || '', m.dept, JSON.stringify([m.dept]), new Date().toISOString());
      });
    }

    /* ---------------- 角色组（真实快照优先） ---------------- */
    const roleApi = readApi('company_role_list.json');
    if (roleApi && roleApi.data && Array.isArray(roleApi.data.role_types)) {
      roleApi.data.role_types.forEach((rt, i) => {
        const payload = {
          id: i + 1,
          name: rt.role_type_name || '',
          roles: (rt.roles || []).map((r) => ({ id: r.role_id, name: r.role_name })),
        };
        db.prepare('INSERT INTO company_role_groups (id, payload) VALUES (?,?)').run(i + 1, JSON.stringify(payload));
      });
    } else {
      const groups = [
        { name: '管理层角色', roles: ['店面经理', '总经理', '董事长', '系统管理员', '部长', '副部长', '合伙人'] },
        { name: '设计部角色', roles: ['设计师', '制图员', '软装设计', '设计主管', '设计总监', '全屋定制设计师', '机电设计师', '橱柜设计师', '审单员'] },
        { name: '市场部角色', roles: ['家装顾问', '客服', '市场总监', '销售管理', '运营总监', '新媒体', '视频制作', '社群运营', '业务经理', '导购'] },
        { name: '施工部角色', roles: ['质检员', '项目管家', '工班长', '施工部经理', '施工部总监', '监理', '安装员', '仓库管理员', '项目经理'] },
        { name: '材料部角色', roles: ['主材专员', '辅料专员', '预核算专员', '材料总监', '主材经理', '安装总监', '主材采购员'] },
        { name: '行政部角色', roles: ['行政', '人事', '高管助理', '后勤', '行政总监'] },
        { name: '财务部角色', roles: ['财务', '出纳', '财务总监'] },
        { name: '企划部角色', roles: ['企划'] },
        { name: '预算部角色', roles: ['预算员', '预算总监'] },
        { name: '产品部角色', roles: ['数据员'] },
        { name: '成控部', roles: ['成控经理', '成控专员'] },
      ];
      groups.forEach((g, i) => {
        const payload = { id: i + 1, name: g.name, roles: g.roles.map((name, j) => ({ id: j + 1, name })) };
        db.prepare('INSERT INTO company_role_groups (id, payload) VALUES (?,?)').run(i + 1, JSON.stringify(payload));
      });
    }

    /* ---------------- 权限树 ---------------- */
    const permApi = readApi('permission_web_group_permission_list.json');
    if (permApi && permApi.data && Array.isArray(permApi.data.permission_groups)) {
      const tree = permApi.data.permission_groups.map((g) => ({
        id: g.group_id,
        label: g.group_name,
        children: (g.permissions || []).map((p) => ({
          id: p.permission_id,
          label: p.permission_name,
          code: p.permission_code, // 4xxxx 后台权限码（原版对齐）
        })),
      }));
      db.prepare(`INSERT INTO company_permission_trees (id, key, payload) VALUES (1, 'backend', ?)`)
        .run(JSON.stringify(tree));
    } else {
      // 无快照回退：内置后台权限树（对齐原版 4xxxx 权限码）
      const tree = [
        {
          id: 101, label: '企业管理',
          children: [
            { id: 1001, label: '企业成员', code: 40001 },
            { id: 1002, label: '角色管理', code: 40002 },
            { id: 1003, label: '企业介绍', code: 40003 },
            { id: 1004, label: '分公司设置', code: 40004 },
            { id: 1005, label: '管理员权限', code: 40005 },
            { id: 1328, label: '个性化设置_公司权限', code: 40006 },
            { id: 1333, label: '个性化设置_客户管理', code: 40007 },
            { id: 1334, label: '个性化设置_财务管理', code: 40008 },
            { id: 1335, label: '个性化设置_项目管理', code: 40009 },
            { id: 1337, label: '个性化设置_公海管理', code: 40010 },
            { id: 1338, label: '个性化设置_预算管理', code: 40011 },
          ],
        },
        {
          id: 102, label: '成本和预算',
          children: [
            { id: 1101, label: '材料库', code: 41001 },
            { id: 1103, label: '工程定额', code: 41003 },
            { id: 1104, label: '预算模板', code: 41004 },
          ],
        },
        {
          id: 103, label: '供应商管理',
          children: [
            { id: 1201, label: '供应商邀请', code: 42001 },
          ],
        },
        {
          id: 104, label: '施工模版',
          children: [
            { id: 1301, label: '模版市场', code: 43001 },
            { id: 1302, label: '我的模版', code: 43002 },
            { id: 1303, label: '专业术语', code: 43003 },
          ],
        },
      ];
      db.prepare(`INSERT INTO company_permission_trees (id, key, payload) VALUES (1, 'backend', ?)`)
        .run(JSON.stringify(tree));
    }
    db.prepare(`INSERT INTO company_permission_trees (id, key, payload) VALUES (2, 'app', ?)`)
      .run(JSON.stringify(fallback.appPermissionTree));

    /* ---------------- 企业信息（真实快照优先） ---------------- */
    const infoApi = readApi('company_introduce_info.json');
    if (infoApi && infoApi.data) {
      const d = infoApi.data;
      db.prepare('INSERT INTO company_info (id, payload, updated_at) VALUES (1, ?, ?)')
        .run(JSON.stringify({
          name: d.name || '', logo: d.logo || '', province: d.province || '', city: d.city || '',
          district: d.area || '', address: d.address_detail || '', specificCode: d.code || '',
          contact: d.tell_number || d.phone_number || '', intro: d.desc || '',
        }), new Date().toISOString());
    }

    /* ---------------- 轮播图（回退） ---------------- */
    for (const b of fallback.banners) {
      db.prepare('INSERT INTO company_banners (id, title, url, image, enabled, sort) VALUES (?,?,?,?,?,?)')
        .run(b.id, b.title, b.url, b.image, b.enabled ? 1 : 0, b.id);
    }

    /* ---------------- 分公司（真实快照优先，通常为空则回退） ---------------- */
    const branchApi = readApi('company_sub_company_list.json');
    if (branchApi && branchApi.data && Array.isArray(branchApi.data.sub_companies) && branchApi.data.sub_companies.length) {
      branchApi.data.sub_companies.forEach((s, i) => {
        const id = i + 1;
        db.prepare('INSERT INTO company_branches (id, payload, name, city) VALUES (?,?,?,?)')
          .run(id, JSON.stringify({ id, name: s.name || '', city: s.city || '', addedAt: s.create_time || '' }), s.name || '', s.city || '');
      });
    } else {
      for (const b of fallback.branches) {
        db.prepare('INSERT INTO company_branches (id, payload, name, city) VALUES (?,?,?,?)')
          .run(b.id, JSON.stringify(b), b.name, b.city || '');
      }
    }

    /* ---------------- 管理员（真实快照优先） ---------------- */
    const admApi = readApi('company_administrator_list.json');
    if (admApi && admApi.data && Array.isArray(admApi.data.administrators)) {
      admApi.data.administrators.forEach((a, i) => {
        const perms = [];
        for (const g of (a.web_permission_groups || [])) {
          for (const p of (g.permissions || [])) if (p.selected) perms.push(p.permission_name);
        }
        db.prepare('INSERT INTO company_admins (id, name, member_id, type, account, permissions_json) VALUES (?,?,?,?,?,?)')
          .run(i + 1, a.user_name || '', Number(a.user_id) || 0, 'backend', '', JSON.stringify(perms));
      });
    }
    const appApi = readApi('company_application_account_list.json');
    if (appApi && appApi.data && Array.isArray(appApi.data.application_accounts)) {
      appApi.data.application_accounts.forEach((a, i) => {
        const perms = ['财务管理', '企业事项', '装企仓库', '摄像头', '巡检', '考勤', '审批'].filter((_, idx) => (a.permissions || []).includes(idx));
        db.prepare('INSERT INTO company_admins (id, name, member_id, type, account, permissions_json) VALUES (?,?,?,?,?,?)')
          .run(100 + i + 1, a.user_name || '', Number(a.user_id) || 0, 'app', '', JSON.stringify(perms));
      });
    }
    if (!(admApi && admApi.data) && !(appApi && appApi.data)) {
      const admins = [
        { id: 1, name: '张凤', memberId: 5, type: 'backend', permissions: ['企业成员', '角色管理', '材料库', '工程定额', '预算模板', '模版市场'] },
        { id: 2, name: '小君', memberId: 1, type: 'app', permissions: ['财务管理', '企业事项', '装企仓库', '摄像头'] },
        { id: 3, name: '王俊民', memberId: 5, type: 'app', permissions: ['企业事项', '装企仓库'] },
      ];
      for (const a of admins) {
        db.prepare('INSERT INTO company_admins (id, name, member_id, type, account, permissions_json) VALUES (?,?,?,?,?,?)')
          .run(a.id, a.name, a.memberId, a.type, '', JSON.stringify(a.permissions));
      }
    }

    /* ---------------- 供应商（真实快照优先） ---------------- */
    const supApi = readApi('company_supplier_map_list.json');
    if (supApi && supApi.data && Array.isArray(supApi.data.supplier_maps)) {
      supApi.data.supplier_maps.forEach((s, i) => {
        const id = i + 1;
        const types = (s.supplier_types || []).map((t) => t.supplier_type_name).join('、');
        const payload = {
          id, name: s.supplier_nick_name || s.supplier_name || '', type: types, addedAt: s.create_time || '',
          maxUpload: s.max_commodity_num || 1000, address: s.address || '', owner: s.supplier_owner_name || '',
          phone: s.supplier_owner_phone || '', remark: s.description || '',
          status: s.cooperation_status === 1 ? '合作中' : '暂停合作',
          mainFollower: (s.followers || []).map((f) => f.user_name).join('、'),
        };
        db.prepare('INSERT INTO company_suppliers (id, payload, name, contact, phone, type, status, warehouse_enabled) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, JSON.stringify(payload), payload.name, payload.owner, payload.phone, payload.type, payload.status, 0);
      });
    } else {
      const sups = [
        { id: 1, name: '356', type: '模板材料', addedAt: '2024年12月26日', maxUpload: 1000, address: '广东省广州市天河区', owner: '王总', phone: '13565566240', remark: '常用模板材料供应商', status: '合作中', mainFollower: '李建', assistFollower: '里斯' },
        { id: 2, name: '356', type: '水电材料', addedAt: '2023年12月18日', maxUpload: 1000, address: '广东省佛山市', owner: 'U', phone: '13311072828', remark: '水电材料供应商', status: '合作中' },
        { id: 3, name: '得一', type: '软装家具', addedAt: '2022年04月02日', maxUpload: 80, address: '广东省广州市白云区', owner: '看', phone: '14357898766', remark: '软装家具供应商', status: '暂停合作' },
      ];
      for (const s of sups) {
        db.prepare('INSERT INTO company_suppliers (id, payload, name, contact, phone, type, status, warehouse_enabled) VALUES (?,?,?,?,?,?,?,?)')
          .run(s.id, JSON.stringify(s), s.name, s.owner, s.phone, s.type, s.status, 0);
      }
    }

    /* ---------------- 供应商类型（真实快照优先） ---------------- */
    const stApi = readApi('company_supplier_type_list.json');
    const types = [];
    if (stApi && stApi.data) {
      for (const t of (stApi.data.supplier_main_types || [])) types.push(t.supplier_type_name);
      for (const t of (stApi.data.supplier_assist_types || [])) types.push(t.supplier_type_name);
    }
    if (!types.length) types.push(...fallback.termCategories.slice(0, 1), ...fallback.termCategories); // 不应走到
    if (types.length) types.forEach((name, i) => {
      db.prepare('INSERT INTO company_supplier_types (id, name) VALUES (?,?)').run(i + 1, name);
    });

    /* ---------------- 材料（真实快照优先，保留云端原始字段） ---------------- */
    const matApi = readApi('budget_v2_material_list.json');
    let categoryMap = {};
    const ctApi = readApi('commodity_type_list.json');
    if (ctApi && ctApi.data && Array.isArray(ctApi.data.types)) {
      for (const t of ctApi.data.types) categoryMap[t.id] = t.content_name || t.name;
    }
    const matRows = (matApi && matApi.data && Array.isArray(matApi.data.materials)) ? matApi.data.materials.slice(0, 60) : [];
    if (matRows.length) {
      matRows.forEach((m, i) => {
        const id = Number(m.id) || (900001000 + i);
        const subCat = categoryMap[Number(m.commodity_type_id)] || '';
        const payload = {
          ...m, // 保留云端原始字段（同步快照时复用，避免破坏主站结构）
          id, name: m.name || '', category: '主材', subCategory: subCat, brand: m.band || '',
          model: m.model || '', spec: m.specification || '', costUnit: m.cost_unit || '',
          costPrice: Number(m.cost_price) || 0, quoteUnit: m.sale_unit || '', quotePrice: Number(m.sale_price) || 0,
          minQuote: Number(m.min_sale_price) || 0, lossRate: Number(m.loss_rate) || 0,
          supplier: m.is_self_warehouse ? '装企仓库' : '', factory: '', enabled: m.enable === 1,
          source: m.is_self_warehouse ? '装企仓库' : '供应商',
        };
        db.prepare('INSERT INTO company_materials (id, payload, name, category, sub_category, brand, model, spec, source, supplier, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, JSON.stringify(payload), payload.name, payload.category, payload.subCategory, payload.brand, payload.model, payload.spec, payload.source, payload.supplier, payload.enabled ? 1 : 0, new Date().toISOString());
      });
    } else {
      const mats = [
        { id: 1, name: '昆仑玻璃', category: '主材', subCategory: '玻璃', brand: '昆仑', model: 'H090', spec: '80*80', costUnit: '套', costPrice: 100, quoteUnit: '套', quotePrice: 200, minQuote: 100, lossRate: 0, supplier: '装企仓库', factory: '-', enabled: true, source: '装企仓库' },
        { id: 2, name: '装饰玻璃', category: '主材', subCategory: '玻璃', brand: '长虹', model: 'C009', spec: '2.4m*1.8m', costUnit: '片', costPrice: 320, quoteUnit: '片', quotePrice: 480, minQuote: 320, lossRate: 2, supplier: '得一', factory: '长虹玻璃厂', enabled: true, source: '供应商' },
        { id: 3, name: '通体砖', category: '主材', subCategory: '瓷砖类', brand: '东鹏', model: 'DP-808', spec: '800*800mm', costUnit: '㎡', costPrice: 68, quoteUnit: '㎡', quotePrice: 128, minQuote: 68, lossRate: 3, supplier: '356', factory: '东鹏陶瓷', enabled: true, source: '供应商' },
        { id: 4, name: '整体衣柜', category: '主材', subCategory: '全屋定制', brand: '索菲亚', model: 'SOF-01', spec: '定制', costUnit: '㎡', costPrice: 580, quoteUnit: '㎡', quotePrice: 980, minQuote: 580, lossRate: 0, supplier: '装企仓库', factory: '索菲亚定制', enabled: true, source: '装企仓库' },
        { id: 5, name: '水泥', category: '辅材', subCategory: '水泥', brand: '海螺', model: 'PC325', spec: '50KG/袋', costUnit: '袋', costPrice: 28, quoteUnit: '袋', quotePrice: 35, minQuote: 28, lossRate: 1, supplier: '装企仓库', factory: '-', enabled: true, source: '装企仓库' },
        { id: 6, name: '石膏板', category: '辅材', subCategory: '板材', brand: '可耐福', model: 'KN-9.5', spec: '1220×2440×9.5mm', costUnit: '张', costPrice: 45, quoteUnit: '张', quotePrice: 62, minQuote: 45, lossRate: 2, supplier: '装企仓库', factory: '-', enabled: false, source: '装企仓库' },
      ];
      for (const m of mats) {
        db.prepare('INSERT INTO company_materials (id, payload, name, category, sub_category, brand, model, spec, source, supplier, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(m.id, JSON.stringify(m), m.name, m.category, m.subCategory, m.brand, m.model, m.spec, m.source, m.supplier, m.enabled ? 1 : 0, new Date().toISOString());
      }
    }

    /* ---------------- 材料分类（回退） ---------------- */
    fallback.materialCategories.forEach((c, i) => {
      db.prepare('INSERT INTO company_material_categories (id, name, children_json) VALUES (?,?,?)')
        .run(i + 1, c.name, JSON.stringify(c.children.map((name, j) => ({ id: j + 1, name }))));
    });

    /* ---------------- 定额（类型用 houtai mock，条目按名称归类） ---------------- */
    const qTypes = fallback.quotaTypes;
    for (const t of qTypes) {
      db.prepare('INSERT INTO company_quota_types (id, name, parent_id, children_json) VALUES (?,?,0,?)')
        .run(t.id, t.name, '[]');
    }
    const qTypeId = (name) => {
      if (name.includes('拆墙') || name.includes('拆除')) return 3;
      if (name.includes('地面')) return 2;
      return 1;
    };
    for (const q of fallback.quotas) {
      const tid = qTypeId(q.name);
      db.prepare('INSERT INTO company_quotas (id, payload, name, unit, quota_type_id) VALUES (?,?,?,?,?)')
        .run(q.id, JSON.stringify(q), q.name, q.unit, tid);
    }

    /* ---------------- 材料成本（回退） ---------------- */
    for (const c of fallback.materialCosts) {
      db.prepare('INSERT INTO company_material_costs (id, type, unit, spec, price) VALUES (?,?,?,?,?)')
        .run(c.id, c.type, c.unit, c.spec, c.price);
    }

    /* ---------------- 预算模板（真实快照优先） ---------------- */
    const tplApi = readApi('budget_template_list.json');
    if (tplApi && tplApi.data && Array.isArray(tplApi.data.templates) && tplApi.data.templates.length) {
      tplApi.data.templates.forEach((t, i) => {
        const id = i + 1;
        const payload = {
          id, name: t.name || '', editedAt: t.update_time || '', enabled: t.status === 1,
          manageRate: 10, taxRate: 3, spaces: [], quotaCount: 0, materialCount: 0, itemCount: 0,
        };
        db.prepare('INSERT INTO company_budget_templates (id, payload, name, enabled) VALUES (?,?,?,?)')
          .run(id, JSON.stringify(payload), payload.name, payload.enabled ? 1 : 0);
      });
    } else {
      for (const t of fallback.budgetTemplates) {
        db.prepare('INSERT INTO company_budget_templates (id, payload, name, enabled) VALUES (?,?,?,?)')
          .run(t.id, JSON.stringify(t), t.name, t.enabled ? 1 : 0);
      }
    }

    /* ---------------- 模板市场（回退，含完整阶段） ---------------- */
    for (const t of fallback.marketTemplates) {
      db.prepare('INSERT INTO company_market_templates (id, payload, name) VALUES (?,?,?)')
        .run(t.id, JSON.stringify(t), t.name);
    }

    /* ---------------- 我的模板（houtai mock 9 个） ---------------- */
    const myList = [
      { id: 201, name: '简易施工模板', stages: jianyiStages },
      { id: 202, name: '【亮宅】公寓平层精细化施工模板(2)', stages: gongyuStages },
      { id: 203, name: '【亮宅】公寓平层精细化施工模板(2)', stages: gongyuStages },
      { id: 204, name: '【亮宅】公寓平层精细化施工模板(2)', stages: gongyuStages },
      { id: 205, name: '【亮宅】公寓平层精细化施工模板(2)', stages: gongyuStages },
      { id: 206, name: '【亮宅】公寓平层精细化施工模板(2)', stages: gongyuStages },
      { id: 207, name: '【亮宅】别墅、复式精细化施工模板', stages: bieshuStages },
      { id: 208, name: '【亮宅】别墅、复式精细化施工模板', stages: bieshuStages },
      { id: 209, name: '【亮宅】别墅、复式精细化施工模板', stages: bieshuStages },
    ];
    for (const t of myList) {
      const payload = { ...t, bg: 'bg-1', used: false };
      db.prepare('INSERT INTO company_my_templates (id, payload, name, used) VALUES (?,?,?,0)')
        .run(t.id, JSON.stringify(payload), t.name);
    }

    /* ---------------- 常用语（回退） ---------------- */
    for (const t of fallback.terms) {
      db.prepare('INSERT INTO company_terms (id, category, content, use_count) VALUES (?,?,?,?)')
        .run(t.id, t.category, t.content, t.useCount || 0);
    }
    fallback.termCategories.forEach((name, i) => {
      db.prepare('INSERT INTO company_term_categories (id, name) VALUES (?,?)').run(i + 1, name);
    });

    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { seedCompany };

// 手动运行：node server/seed-company.js
if (require.main === module) {
  const db = new DatabaseSync('data/local.db');
  seedCompany(db);
  console.log('[seed-company] 企业后台种子数据迁移完成');
  db.close();
}
