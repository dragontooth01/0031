/**
 * 亮宅 / 易施工 本地克隆系统 — 服务器
 *
 * 复刻并扩展原版「亮宅 Web 版」服务器（zero-dependency Node）：
 *  1. 静态托管前台（vendor/liangzhai，原桌面端 dist）与后台（vendor/enterprise，装企后台管理系统 SPA）
 *  2. /api/* 反向代理 → https://lzapi.e-shigong.com（解决 CORS；Set-Cookie 改写以适配本地域名）
 *  3. 录制 / 回放：API 响应自动录制到 fixtures/，原 API 不可用时自动回放（LZ_FIXTURE_MODE）
 *  4. 前台 IPC 兼容层（/__ipc, /__ipc-sync）+ SSE 事件推送（/__events）+ 下载/预览（/__download, /__preview）
 *
 * 零第三方依赖，Node 12+ 即可运行。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------- 配置 ----------------
const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const LZ_DIST = path.join(ROOT, 'vendor', 'liangzhai');     // 前台（亮宅操作端）
const ENT_DIST = path.join(ROOT, 'vendor', 'enterprise');   // 后台（装企后台管理系统）
const STATIC_DIR = path.join(LZ_DIST, 'static');            // 协议/政策/监控/地图等静态页
const SHIM_FILE = path.join(ROOT, 'shim.js');
const CACHE_DIR = path.join(ROOT, 'cache');
const LOG_DIR = path.join(ROOT, 'logs');
const FIXTURE_DIR = path.join(ROOT, 'fixtures');

const API_ORIGIN = 'https://lzapi.e-shigong.com';
const API_HOST = 'lzapi.e-shigong.com';

// 后台 SPA 的 webpack publicPath 为 "/"，懒加载/图片按根路径绝对引用 → 根路径兜底映射到后台资源
const ENT_ROOT_PREFIXES = ['/js/', '/css/', '/fonts/', '/favicon.ico', '/moxie.min.js', '/plupload.full.min.js', '/resize.js'];

// 数据模式: auto(默认, 真实优先+成功即录制+失败回放) | live(纯代理不录制) | offline(纯回放不联网)
const FIXTURE_MODE = (process.env.LZ_FIXTURE_MODE || 'auto').toLowerCase();

// 代理时伪装 UA：前台伪装成桌面端（防止后端按客户端类型限功能），后台用正常浏览器 UA
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Liangzhai/2.18.5 Chrome/91.0.4472.164 Electron/13.1.9 Safari/537.36';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FAKE_UA = process.env.LZ_FAKE_UA !== '0';

const ALLOW_HOSTS = (process.env.LZ_ALLOW_HOSTS
  || 'e-shigong.com,nos.netease.com,netease.com,netease.im,nosdn.127.net,qiniu.com,'
    + 'qiniucdn.com,qnssl.com,qbox.me,126.net,127.net').split(',').map(s => s.trim().toLowerCase());

function hostAllowed(u) {
  try { u = new URL(u); } catch (e) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (ALLOW_HOSTS.length === 1 && ALLOW_HOSTS[0] === '*') return true;
  const h = u.hostname.toLowerCase();
  return ALLOW_HOSTS.some(s => h === s || h.endsWith('.' + s));
}

function isFromEnterprise(req) {
  return /\/enterprise\//i.test(req.headers.referer || '');
}

// ---------------- 会话（前台 IPC 用） ----------------
const sessions = new Map(); // sid -> { sharedData, hashLinkByWin, tabs }
const tabStore = new Map(); // res -> { sid, win }

function getSession(req, res) {
  let sid = null;
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)lz_sid=([0-9a-f]{16,})/.exec(cookie);
  if (m) sid = m[1];
  if (sid && sessions.has(sid)) return sessions.get(sid);
  sid = crypto.randomBytes(12).toString('hex');
  const session = { sharedData: { isMac: false }, hashLinkByWin: {}, tabs: new Map() };
  sessions.set(sid, session);
  res.setHeader('Set-Cookie', 'lz_sid=' + sid + '; Path=/; SameSite=Lax');
  return session;
}

function sseSend(res, channel, data) {
  try {
    res.write('data: ' + JSON.stringify({ channel: channel, data: data }) + '\n\n');
  } catch (e) { /* ignore */ }
}

function sendToWin(session, win, channel, data) {
  const set = session.tabs.get(String(win));
  if (set) set.forEach(res => sseSend(res, channel, data));
}
function sendToMain(session, channel, data) { sendToWin(session, '-1', channel, data); }
function sendAll(session, channel, data) {
  session.tabs.forEach(set => set.forEach(res => sseSend(res, channel, data)));
}
function broadcastShared(session) { sendAll(session, 'get-shared-data', session.sharedData); }

// ---------------- 小工具 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.cur': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.m4a': 'audio/mp4', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.bcmap': 'application/octet-stream', '.properties': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
};
function mimeOf(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj === undefined ? null : obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 64 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb({}); }
  });
  req.on('error', () => { try { cb({}); } catch (e) {} });
}

function safeName(name) {
  name = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 160);
  return name || 'file';
}

function nowStamp() {
  const d = new Date(), p = n => (n < 10 ? '0' + n : '' + n);
  return '' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + '-' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

// ---------------- fixtures（录制 / 回放） ----------------
function fixtureName(req, body) {
  let u;
  try { u = new URL(req.url, 'http://local'); } catch (e) { return null; }
  u.searchParams.sort();
  const qs = u.searchParams.toString();
  let name = (req.method || 'GET').toLowerCase() + '_' + (u.pathname || '/').replace(/[^\w\-.]/g, '_');
  if (qs) name += '_q' + sha1(qs).slice(0, 10);
  if (body && body.length) name += '_b' + sha1(body).slice(0, 10);
  if (name.length > 160) name = sha1(name).slice(0, 40);
  return name + '.json';
}

function saveFixture(name, status, headers, buf) {
  if (!name) return;
  try {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const meta = {
      savedAt: nowStamp(),
      status: status,
      headers: { 'content-type': headers['content-type'] || 'application/json; charset=utf-8' }
    };
    // 下载类（导出 excel 等二进制）响应：base64 存储，离线回放时还原为字节流
    if (headers['content-disposition']) meta.headers['content-disposition'] = headers['content-disposition'];
    // 严格文本判断：以 text/ 或 application/json|javascript|xml 开头才按文本存（vnd.openxmlformats-* 等二进制必须走 base64）
    const textish = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)\b)/i.test(meta.headers['content-type']);
    let bodyStr, encoding;
    if (textish) {
      bodyStr = buf.toString('utf8');
    } else {
      bodyStr = buf.toString('base64');
      encoding = 'base64';
    }
    if (encoding) meta.encoding = encoding;
    const out = JSON.stringify({ meta: meta, body: bodyStr });
    fs.writeFileSync(path.join(FIXTURE_DIR, name), out, 'utf8');
  } catch (e) { /* ignore */ }
}

function loadFixture(name) {
  if (!name) return null;
  try {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// 回放 fixture（离线模式 / 上游不可达共用）：兼容 JSON 文本与 base64 二进制
function respondFixture(res, f, skipReply, onUpstream) {
  if (!f || !f.meta || typeof f.body !== 'string') return false;
  const buf = f.meta.encoding === 'base64' ? Buffer.from(f.body, 'base64') : Buffer.from(f.body, 'utf8');
  const h = {};
  Object.keys(f.meta.headers || {}).forEach(k => { h[k] = f.meta.headers[k]; });
  h['x-fixture'] = 'replay';
  if (f.meta.encoding === 'base64') h['content-length'] = String(buf.length);
  if (onUpstream) onUpstream(buf);
  if (!skipReply) { res.writeHead(f.meta.status || 200, h); res.end(buf); }
  return true;
}

function isJsonLike(ctype) {
  return /json|text\/plain/i.test(ctype || '');
}

// ---------------- 本地 API 层（LOCAL_MODE: off | observe | on） ----------------
// off      = 全走原站代理
// observe  = 本地 handler 影子运行：响应仍走代理，自动双跑对比并报告结构差异（DIFF）
// on       = 本地命中即本地响应（SQLite 读写）；未命中走代理；本地响应仍后台对比记录
// LOCAL_BLOCK = 逗号分隔的接口路径前缀黑名单（这些接口仍走代理，逐个修复后移除）
// 默认黑名单 = 双跑对比发现结构失真的接口（材料/定额/模板等，阶段2逐个重写）
//             + 前台操作端接口（user/project/crm/im 等，阶段4再做前台本地化）
const LOCAL_MODE = (process.env.LOCAL_MODE || 'on').toLowerCase();
const LOCAL_LOG_OK = process.env.LOCAL_LOG === '1';
const LOCAL_BLOCK_DEFAULT = [
  // 后台：待实现/需参数的接口（阶段3再做）
  '/budget/template/table_header/', '/budget/template/summary_item/', '/template/step/list/',
  '/budget/material/unit/list/',
  // 商品动态数据（单位/品牌/厂家随类型变化，代理+录制兜底）
  '/commodity/band_unit/', '/commodity/company/manufacturer/',
  // 前台操作端（阶段4按页本地化，未验收的路径保持原站代理）
  '/user/', '/project/', '/crm/', '/im/', '/stock/', '/finance/', '/contract/', '/inspection/', '/oa/',
  '/material_apply/', '/workbench/',
  '/commodity/stock/', '/commodity/list/', '/commodity/add/', '/commodity/edit/', '/commodity/del/',
  '/commodity/repeal/', '/commodity/app/', '/commodity/material/'
];
// LOCAL_WHITE = 已验收放行的路径前缀（在黑名单之上优先放行，阶段4逐接口验收后加入）
const LOCAL_WHITE_DEFAULT = [
  // 前台登录链路（阶段4第1块：本地登录 + 权限 + 公司列表）
  '/user/login/', '/user/smscode/', '/user/company/list/', '/user/app/permission/list/',
  '/version/latest/info/', '/area_info/open/list/',
  // 前台基础数据（阶段4逐接口验收后加入）
  '/project/holiday/list/',
  // 前台项目模块（本地 handler 结构已与原站同构，55 个项目种子）
  '/project/detail/', '/project/pc/list/', '/project/list/', '/project/area/list/',
  '/project/task/list/', '/project/v2/task/list/', '/project/all/task/list/',
  '/project/handled/task/list/', '/project/todo/list/', '/project/desc/list/',
  '/project/filter/list/', '/project/step/label/list/', '/project/template/list/',
  '/project/company/project/list/', '/project/completed/project/list/',
  '/project/weekly_plan/list/', '/project/construction_log/list/', '/project/role/list/',
  '/project/decorated_area/list/', '/project/role/member/list/',
  '/project/v2/create/', '/project/v3/create/', '/project/task/add/', '/project/task/save/',
  '/project/task/edit/', '/project/task/start/', '/project/task/handle/',
  '/project/task/commit/', '/project/task/cancel/', '/project/task/del/',
  '/project/area/add/', '/project/area/edit/', '/project/area/del/',
  '/project/todo/create/', '/project/todo/submit/', '/project/todo/resubmit/',
  '/project/todo/review/', '/project/todo/del/', '/project/todo/detail/',
  '/project/weekly_plan/create/', '/project/weekly_plan/edit/',
  '/project/status/setting/update/', '/project/desc/add/', '/project/desc/del/',
  // 前台商品/库存模块（本地 commodity-stock 资产：51 商品/3 仓库/出入库记录）
  '/commodity/stock/', '/commodity/type/list/', '/commodity/sys/content/list/',
  '/commodity/company/material/edit/', '/commodity/company/material/import/',
  // 前台 CRM 列表/筛选/状态/表头（本地 handler 结构已与原站双跑对比一致）
  '/crm/screen/condition/list/', '/crm/status/list/', '/crm/table/header/list/',
  '/crm/department_leader/members/', '/crm/v2/pc/list/', '/crm/v2/pc/company/crm/list/',
  '/crm/detail/', '/crm/customer/detail/', '/crm/add/', '/crm/follow/record/', '/crm/tag/list/',
  '/crm/company/crm/status/', '/crm/screen/conditions/', '/crm/company/crm/screen/conditions/',
  '/crm/follow/type/list/', '/company/crm/source/list/',
  // CRM 写接口本地落库（防真实删除/修改云端客户）
  '/crm/disable/', '/crm/del/', '/crm/aborted_crm/delete/', '/crm/customer/edit/',
  '/crm/status/edit/', '/crm/follow/info/add/', '/crm/tag/add/', '/crm/tag/del/',
  '/crm/crm_tag_map/edit/', '/crm/customer/type/edit/', '/crm/follow_record/read_status/update/',
  '/crm/batch/disable/',
  // 后台验收通过的共用接口（黑名单命中但本地已验收）
  '/budget/template/table_header/', '/budget/template/summary_item/', '/template/step/list/',
  '/budget/material/unit/list/',
  // 前台财务模块（阶段5按页验收放行：项目收款主列表，快照同构）
  '/finance/list/', '/finance/company/project/list/', '/finance/company/project/apply/list/',
  '/finance/company/project/apply/all_conditions/', '/finance/project/receivable/summary/list/',
  '/finance/paid/list/', '/finance/v2/pc/contract/check/', '/finance/v2/analysis/paid/',
  '/finance/v2/financial/record/list/', '/company/account/list/', '/finance/detail/',
  // 财务详情写接口（本地落库）+ 合同子接口（本地 handler 已有）
  '/finance/paid/record/', '/finance/v2/paid/record/', '/finance/contract/', '/finance/v2/contract/',
  '/finance/file/', '/finance/set/', '/finance/crm/del/', '/finance/edit/record/list/',
  // 付款申请及审批（列表/详情/状态操作/置顶/删除/新增）
  '/finance/project/apply/', '/finance/company/project/apply/', '/finance/v2/project/apply/record/edit/',
  // 收款/编辑/审核详情（云端行为镜像）
  '/finance/paid/detail/', '/finance/edit/paid/detail/', '/finance/contract/check/detail/',
  // 汇总类读接口（云端快照 1:1）
  '/material_apply/v3/decorator/order/list/', '/project/inspection/company/list/',
  '/project/attendance/company/list/', '/oa/attendance/company/month/check/statistic/',
  // 后台财务设置（个性化设置页·财务管理 tab：付款/材料申请/分公司账户/报销/付款类型/分析设置）
  '/company/project/payment/setting/', '/company/material/apply/setting/', '/company/list/',
  '/finance/add/sub_company/account/setting/', '/oa/reimbursement/review/mode/',
  '/finance/analysis/setting/',
  // 其余财务写接口安全兜底（宽容落库防云端污染）
  '/finance/analysis/paid_record/', '/finance/business/fee/', '/finance/paid/edit/',
  '/finance/project/apply_type/', '/finance/self_define_fee/', '/finance/woker_fee/',
  '/finance/material_fee/', '/finance/user/status/lock/', '/finance/rejected/project/apply/del/',
  '/finance/company/project/batch/', '/finance/crm/import/', '/finance/project/batch/apply/',
  '/finance/project/receivable/summary/setting/', '/finance/project_type/',
  '/finance/v2/company/contract/pay_setting/', '/finance/company/contract/',
  '/finance/v2/project/receivable/summary/setting/'
];
const LOCAL_WHITE = (process.env.LOCAL_WHITE ? process.env.LOCAL_WHITE.split(',') : LOCAL_WHITE_DEFAULT).map(s => s.trim()).filter(Boolean);
const LOCAL_BLOCK = (process.env.LOCAL_BLOCK ? process.env.LOCAL_BLOCK.split(',') : LOCAL_BLOCK_DEFAULT).map(s => s.trim()).filter(Boolean);
let localApi = null;
try {
  localApi = require('./server/local-api');
  console.log('[local] 本地API已加载（handlers: ' + Object.keys(localApi.handlers || {}).length + '，模式: ' + LOCAL_MODE + (LOCAL_BLOCK.length ? '，黑名单: ' + LOCAL_BLOCK.length + ' 项' : '') + '）');
} catch (e) {
  console.log('[local] 本地API加载失败: ' + e.message + '（继续使用代理模式）');
}

function isLocalBlocked(apiPath) {
  // 验收白名单优先放行（即使命中黑名单前缀）
  if (LOCAL_WHITE.some(p => apiPath.startsWith(p))) return false;
  return LOCAL_BLOCK.some(p => apiPath.startsWith(p));
}

// 写接口识别（跳过 DIFF 后台对比，避免写操作经对比真实打到云端）
const WRITE_API_RE = /\/(add|edit|del|delete|remove|set|update|status|order|change|transfer|disable|enable|copy|restore|import|upload|clear|confirm|recover|repeal|move|sort|sync|mark|assign|batch|toggle|use|push|send|reply|read|close|open|cancel|save|create|modify|reset|reject|pass|audit|sign|agree|setting|apply|paid|review|withdraw|resubmit|top|lock)\/?(\?|$)/i;
function isWriteApi(apiPath) {
  if (WRITE_API_RE.test(apiPath)) return true;
  // 兜底：路径最后一段是动作词
  const seg = apiPath.replace(/\/+$/, '').split('/').pop() || '';
  return /^(add|edit|del|set|update|change|transfer|disable|enable|status|order|copy|restore|import|upload|clear|save|create|modify|reset|toggle|repeal|recover|move|sort|mark|assign|confirm|cancel|batch|setting)$/i.test(seg);
}

function readBodyRaw(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 64 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(''));
}

// 结构对比：返回差异描述（'' = 一致）
function localDiffSummary(local, upstream) {
  try {
    const lc = local && local.code, uc = upstream && upstream.code;
    if (lc !== uc) return 'code ' + lc + ' != ' + uc;
    if (lc !== 0) return '';
    const ld = local.data || {}, ud = upstream.data || {};
    const lk = Object.keys(ld).sort(), uk = Object.keys(ud).sort();
    if (JSON.stringify(lk) !== JSON.stringify(uk)) return 'dataKeys 差: [' + lk.join(',') + '] vs [' + uk.join(',') + ']';
    for (const k of lk) {
      const lv = ld[k], uv = ud[k];
      if (Array.isArray(lv) && Array.isArray(uv)) {
        if (lv.length !== uv.length) return k + ' 长度 ' + lv.length + ' != ' + uv.length;
        if (lv.length && uv.length && typeof lv[0] === 'object' && typeof uv[0] === 'object') {
          const a = Object.keys(lv[0]).sort().join(','), b = Object.keys(uv[0]).sort().join(',');
          if (a !== b) return k + '[0] 字段差: ' + a + ' vs ' + b;
        }
      }
    }
    return '';
  } catch (e) { return '对比异常: ' + e.message; }
}

// JS escape() 等效（自动登录 cookie：SPA boot 用 unescape 读取，CJK 必须 %uXXXX 编码）
function jsEscape(s) {
  return String(s).replace(/[^\x20-\x7E]/g, (ch) => {
    const cp = ch.codePointAt(0);
    return cp > 0xFF ? '%u' + cp.toString(16).toUpperCase().padStart(4, '0') : '%' + cp.toString(16).toUpperCase().padStart(2, '0');
  });
}

function respondLocal(req, res, apiPath, r) {
  const respHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  let s = localApi.getSession(req.headers);
  if (!s && r && r.data && r.data.session_id) s = localApi.getSessionById(r.data.session_id);
  if (s) {
    const cookies = [];
    if (s.cloud_session_id) cookies.push('session_id=' + s.cloud_session_id + '; Path=/');
    if (apiPath.indexOf('/company/login/') === 0) cookies.push('company_session_id=' + s.session_id + '; Path=/; Max-Age=604800');
    // 补充后台"7天自动登录"恢复所需 cookie（与代理层对云端登录的补充一致）
    if (apiPath.indexOf('/company/login/') === 0 && r && r.code === 0 && r.data && Array.isArray(r.data.web_permission_codes)) {
      // 对齐原站实际下发：权限码含 406789（设置页等页面守卫依赖），本地种子可能缺失
      const codes = r.data.web_permission_codes.slice();
      if (!codes.includes(406789)) codes.push(406789);
      if (codes.length !== r.data.web_permission_codes.length) r.data.web_permission_codes = codes;
      const perm = codes.map(x => Buffer.from(String(x)).toString('base64')).join(',');
      cookies.push('autoLogin=1; Path=/; Max-Age=604800');
      cookies.push('permission=' + encodeURIComponent(perm) + '; Path=/; Max-Age=604800');
      if (r.data.company_id !== undefined) cookies.push('company_id=' + r.data.company_id + '; Path=/; Max-Age=604800');
      if (r.data.is_parent !== undefined) cookies.push('is_parent=' + r.data.is_parent + '; Path=/; Max-Age=604800');
      if (r.data.is_superadmin !== undefined) cookies.push('superadmin=' + r.data.is_superadmin + '; Path=/; Max-Age=604800');
      // 自动登录恢复链路（SPA boot 读 company_name / phone_number cookie 并 unescape）：
      // 原站登录响应 Set-Cookie 用 JS escape() 编码（CJK 为 %uXXXX），此处等效
      if (r.data.company_name !== undefined) cookies.push('company_name=' + jsEscape(String(r.data.company_name)) + '; Path=/; Max-Age=604800');
      if (r.data.phone_number !== undefined) cookies.push('phone_number=' + jsEscape(String(r.data.phone_number)) + '; Path=/; Max-Age=604800');
    }
    if (cookies.length) respHeaders['Set-Cookie'] = cookies;
  }
  if (r && r.__binary) {
    res.writeHead(200, {
      'Content-Type': r.contentType || 'application/octet-stream',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(r.fileName || 'export'),
      'Cache-Control': 'no-store'
    });
    res.end(Buffer.isBuffer(r.buffer) ? r.buffer : Buffer.from(r.buffer || ''));
    return;
  }
  res.writeHead(200, respHeaders);
  res.end(JSON.stringify(r));
}

// 返回 true = 已接管（异步完成）；false = 未命中本地，调用方继续走代理
function handleLocalApi(req, res, pathname) {
  if (!localApi) return false;
  const apiPath = pathname.slice('/api'.length);
  // 黑名单接口直接走代理（双跑对比发现结构失真的接口，修好前不启用本地）
  if (isLocalBlocked(apiPath)) return false;
  // 登录类接口在 observe 模式跳过本地对比（本地 handler 含联网 cloudLogin，且登录结构已对齐原版）
  if (LOCAL_MODE === 'observe' && /\/login\/?(\?|$)/.test(apiPath)) return false;
  const handler = localApi.match(req.method, apiPath);
  if (!handler) return false;
  readBodyRaw(req, bodyStr => {
    const bodyBuf = Buffer.from(bodyStr, 'utf8');
    let parsed = {};
    try { parsed = bodyStr ? JSON.parse(bodyStr) : {}; } catch (e) { /* keep {} */ }
    let result;
    try {
      result = handler({ body: parsed, query: req.query, headers: req.headers });
    } catch (e) {
      console.log('[local] handler throw ' + req.method + ' ' + apiPath + ': ' + e.message);
      proxyToApi(req, res, null, false, bodyBuf);
      return;
    }
    // observe 模式竞速：handler 4 秒未完成则放弃对比直接代理（避免慢 handler 拖慢响应）
    let settled = false;
    const raceTimer = setTimeout(() => {
      if (!settled) { settled = true; proxyToApi(req, res, null, false, bodyBuf); }
    }, 4000);
    Promise.resolve(result).then(r => {
      if (settled) return;
      settled = true;
      clearTimeout(raceTimer);
      if (r === null || r === undefined) { proxyToApi(req, res, null, false, bodyBuf); return; }
      if (LOCAL_MODE === 'on') {
        respondLocal(req, res, apiPath, r);
        // 后台对比记录（不阻塞响应）。
        // 写接口（增删改/状态/排序/转移等）跳过对比：对比请求会把写操作真实发到云端，
        // 云端用本地会话映射的凭证执行后即污染真实数据（此前 member/材料等测试已触发该隐患）。
        if (!isWriteApi(apiPath)) {
          proxyToApi(req, res, (upBuf) => {
            try {
              const up = JSON.parse(upBuf.toString('utf8'));
              if (up && typeof up === 'object') {
                const diff = localDiffSummary(r, up);
                if (diff) console.log('[local][DIFF] ' + req.method + ' ' + apiPath + '  ' + diff);
              }
            } catch (e) { /* ignore */ }
          }, true, bodyBuf);
        }
      } else {
        // observe：影子运行 + 代理响应
        proxyToApi(req, res, (upBuf) => {
          let up = null;
          try { up = JSON.parse(upBuf.toString('utf8')); } catch (e) { /* ignore */ }
          if (!up || typeof up !== 'object') { console.log('[local][SKIP] ' + req.method + ' ' + apiPath + '（上游非JSON，跳过对比）'); return; }
          const diff = localDiffSummary(r, up);
          if (diff) console.log('[local][DIFF] ' + req.method + ' ' + apiPath + '  ' + diff);
          else if (LOCAL_LOG_OK) console.log('[local][OK]   ' + req.method + ' ' + apiPath);
        }, false, bodyBuf);
      }
    }).catch(err => {
      console.log('[local] handler error ' + req.method + ' ' + apiPath + ': ' + err.message);
      proxyToApi(req, res, null, false, bodyBuf);
    });
  });
  return true;
}

// ---------------- 反向代理 ----------------
// preBody 传入时使用已缓冲的请求体（本地层回退代理场景），否则从 req 流收集
function proxyToApi(req, res, onUpstream, skipReply, preBody) {
  const finish = (body) => {
    const headers = {};
    Object.keys(req.headers).forEach(k => {
      if (/^(host|connection|keep-alive|proxy-|upgrade|te|trailer)$/i.test(k)) return;
      headers[k] = req.headers[k];
    });
    headers.host = API_HOST;
    if (FAKE_UA) headers['user-agent'] = isFromEnterprise(req) ? BROWSER_UA : ELECTRON_UA;
    if (body.length) headers['content-length'] = body.length;
    // 混合模式：本地登录后浏览器带的是本地会话，代理云端接口时映射为云端凭证
    if (LOCAL_MODE === 'on' && localApi) {
      try {
        const cloud = localApi.getCloudSession(req.headers);
        if (cloud && cloud.session_id) {
          headers['session-id'] = cloud.session_id;
          if (cloud.user_id) headers['user-id'] = String(cloud.user_id);
          if (cloud.company_id) headers['company-id'] = String(cloud.company_id);
          // user 会话（前台 cloudLogin）需要 platform=1 与 phone-number；
          // company 会话（后台 cloudCompanyLogin，无 user_id）必须移除 phone-number 头
          // （云端会按 phone-number 走 user 会话校验，导致 10012），platform 保留浏览器原值
          if (cloud.user_id) {
            headers['platform'] = '1';
            if (cloud.phone) headers['phone-number'] = cloud.phone;
          } else {
            delete headers['phone-number'];
          }
          // 云端后台接口按 cookie 中的 company_session_id 认证：同时替换 Cookie 里的会话值
          if (headers.cookie) {
            let ck = headers.cookie
              .replace(/company_session_id=[^;]*/, 'company_session_id=' + cloud.session_id)
              .replace(/session_id=[^;]*/, 'session_id=' + cloud.session_id);
            if (cloud.user_id) ck = ck.replace(/user_id=[^;]*/, 'user_id=' + cloud.user_id);
            headers.cookie = ck;
          }
        }
      } catch (e) { /* ignore */ }
    }
    const fname = FIXTURE_MODE === 'live' ? null : fixtureName(req, body);
    console.log('[api]', req.method, req.url);
    // 无云端会话模式（LZ_NO_CLOUD_SYNC=1）：代理接口云端必然 10012/10305，
    // 若透传给前端，axios 拦截器会清除登录凭证并弹回登录页（登录"失败"）。
    // 此模式下将认证错误宽容改写为空成功响应，保持本地登录稳定。
    const noCloudMode = process.env.LZ_NO_CLOUD_SYNC === '1';

    // offline 模式：完全不联网，直接回放录制数据
    if (FIXTURE_MODE === 'offline') {
      const f = loadFixture(fname);
      if (respondFixture(res, f, skipReply, onUpstream)) return;
      if (!skipReply) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('offline mode: no recorded fixture for ' + req.method + ' ' + req.url);
      }
      return;
    }

    doProxy(req.method, req.url, headers, body, 5, fname, res, onUpstream, skipReply, noCloudMode);
  };
  if (preBody !== undefined) { finish(preBody); return; }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => finish(Buffer.concat(chunks)));
  req.on('error', () => { try { res.destroy(); } catch (e) {} });
}

function doProxy(method, targetPath, headers, body, redirectsLeft, fname, res, onUpstream, skipReply, noCloudMode) {
  console.log('[proxy-headers]', method, targetPath, JSON.stringify(headers));
  const preq = https.request({
    protocol: 'https:', host: API_HOST, path: targetPath, method: method, headers: headers
  }, pres => {
    console.log('[proxy-res]', method, targetPath, 'status=' + pres.statusCode);
    if (pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location && redirectsLeft > 0) {
      let loc = pres.headers.location;
      pres.resume();
      try { loc = new URL(loc, API_ORIGIN).toString(); } catch (e) { /* keep */ }
      try {
        if (new URL(loc).hostname !== API_HOST) {
          const h = {};
          Object.keys(pres.headers).forEach(k => {
            if (k === 'set-cookie') { h[k] = rewriteSetCookie(pres.headers[k]); return; }
            if (!/^(transfer-encoding|connection)$/i.test(k)) h[k] = pres.headers[k];
          });
          res.writeHead(pres.statusCode, h); res.end(); return;
        }
      } catch (e) { /* ignore */ }
      const target = new URL(loc);
      const isHttps = target.protocol === 'https:';
      const mod = isHttps ? https : http;
      const preq2 = mod.request({
        protocol: target.protocol, host: target.hostname, port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search, method: method, headers: headers
      }, pres2 => {
        const h = {};
        Object.keys(pres2.headers).forEach(k => {
          if (k === 'set-cookie') { h[k] = rewriteSetCookie(pres2.headers[k]); return; }
          if (!/^(transfer-encoding|connection)$/i.test(k)) h[k] = pres2.headers[k];
        });
        res.writeHead(pres2.statusCode, h);
        pres2.pipe(res);
      });
      preq2.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Bad Gateway'); });
      if (body.length) preq2.write(body);
      preq2.end();
      return;
    }

    if (skipReply) { pres.resume(); return; }

    const h = {};
    Object.keys(pres.headers).forEach(k => {
      if (k === 'set-cookie') { h[k] = rewriteSetCookie(pres.headers[k]); return; }
      if (!/^(transfer-encoding|connection)$/i.test(k)) h[k] = pres.headers[k];
    });
    const ctype = pres.headers['content-type'] || '';

    // 需要录制/回放的数据响应：缓冲后统一处理（JSON 全部录制；导出类接口即使是二进制也录制，供离线回放下载）
    const isExportResp = /export|excel|download/i.test(targetPath) && /spreadsheet|octet-stream|excel|pdf|zip/i.test(ctype);
    if (fname && (isJsonLike(ctype) || isExportResp) && pres.statusCode === 200) {
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => {
        let buf = Buffer.concat(chunks);
        // 无云端会话模式：认证错误（10012 用户未登录 / 10305 公司账户未登录）宽容改写为空成功，
        // 避免前端 axios 拦截器清除登录凭证并弹回登录页
        if (noCloudMode && pres.statusCode === 200) {
          try {
            const j = JSON.parse(buf.toString('utf8'));
            if (j && typeof j === 'object' && (j.code === 10012 || j.code === 10305)) {
              j.code = 0; j.msg = '成功';
              if (!j.data || typeof j.data !== 'object') j.data = {};
              buf = Buffer.from(JSON.stringify(j));
              // body 长度已变，同步修正响应头，否则浏览器报 ERR_CONTENT_LENGTH_MISMATCH
              h['content-length'] = String(buf.length);
            }
          } catch (e) { /* 非 JSON 跳过 */ }
        }
        // 企业后台登录成功：补充前端 JS 会写但本地环境可能丢失的 cookie（autoLogin / permission），
        // 保证刷新与新窗口能自动恢复登录态（原站由前端脚本写入，1:1 等效）
        if (method === 'POST' && /\/company\/login\/?(\?|$)/.test(targetPath)) {
          try {
            const j = JSON.parse(buf.toString('utf8'));
            if (j && j.code === 0 && j.data && Array.isArray(j.data.web_permission_codes)) {
              const perm = j.data.web_permission_codes.map(x => Buffer.from(String(x)).toString('base64')).join(',');
              const extra = ['autoLogin=1; Path=/; Max-Age=604800', 'permission=' + encodeURIComponent(perm) + '; Path=/; Max-Age=604800'];
              if (j.data.is_parent !== undefined) extra.push('is_parent=' + j.data.is_parent + '; Path=/; Max-Age=604800');
              if (j.data.is_superadmin !== undefined) extra.push('superadmin=' + j.data.is_superadmin + '; Path=/; Max-Age=604800');
              h['set-cookie'] = (h['set-cookie'] || []).concat(extra);
            }
          } catch (e) { /* 非 JSON 或解析失败则跳过 */ }
        }
        if (FIXTURE_MODE !== 'offline') saveFixture(fname, pres.statusCode, h, buf);
        if (onUpstream) onUpstream(buf);
        if (skipReply) return;
        res.writeHead(pres.statusCode, h);
        res.end(buf);
      });
      pres.on('error', () => {
        try { if (!res.headersSent) res.writeHead(502); res.end('Bad Gateway'); } catch (e) {}
      });
      return;
    }
    res.writeHead(pres.statusCode, h);
    pres.pipe(res);
  });
  preq.on('error', err => {
    console.log('[api] ERR', method, targetPath, err.message);
    // 上游不可达：auto/offline 模式下回放录制的数据
    if (fname) {
      const f = loadFixture(fname);
      if (respondFixture(res, f, skipReply, null)) return;
    }
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Gateway: ' + (err && err.message || '') + '（可尝试 LZ_FIXTURE_MODE=offline 使用录制数据）');
  });
  if (body.length) preq.write(body);
  preq.end();
}

// Set-Cookie 改写：去掉 Domain（本地域名无法接收 .e-shigong.com 的 cookie）与 Secure/SameSite=None（本地 http）
function rewriteSetCookie(cookies) {
  if (!Array.isArray(cookies)) cookies = [cookies];
  return cookies.map(c => String(c)
    .replace(/;\s*Domain=[^;]*/ig, '')
    .replace(/;\s*Secure/ig, '')
    .replace(/;\s*SameSite=None/ig, '; SameSite=Lax'));
}

// ---------------- 远程拉取（下载/预览共用，带进度） ----------------
function fetchRemote(urlStr, onProgress, cb) {
  let redirects = 4;
  let settled = false;
  const reqUrl = new URL(urlStr);
  function fail(err) { if (!settled) { settled = true; cb(err); } }
  function go(u) {
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const started = Date.now();
    let transferred = 0, total = 0, lastT = started, lastB = 0;
    const req = mod.request({
      protocol: u.protocol, host: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiangzhaiWeb/1.0', accept: '*/*' }
    }, pres => {
      if (pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location && redirects-- > 0) {
        pres.resume();
        try { go(new URL(pres.headers.location, u)); } catch (e) { fail(new Error('redirect failed')); }
        return;
      }
      if (pres.statusCode !== 200) {
        pres.resume();
        fail(new Error('HTTP ' + pres.statusCode)); return;
      }
      total = parseInt(pres.headers['content-length'] || '0', 10) || 0;
      onProgress && onProgress({
        percent: 0, speed: 0,
        size: { transferred: 0, total: total },
        time: { elapsed: 0, remaining: 0 }
      });
      pres.on('data', chunk => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - lastT >= 150) {
          const dt = (now - lastT) / 1000;
          const speed = dt > 0 ? (transferred - lastB) / dt : 0;
          lastT = now; lastB = transferred;
          const elapsed = (now - started) / 1000;
          const remaining = speed > 0 && total > 0 ? (total - transferred) / speed : 0;
          onProgress && onProgress({
            percent: total ? transferred / total : 0, speed: speed,
            size: { transferred: transferred, total: total },
            time: { elapsed: elapsed, remaining: remaining }
          });
        }
      });
      pres.on('error', fail);
      if (!settled) { settled = true; cb(null, { stream: pres, total: total }); }
    });
    req.on('error', fail);
    req.end();
  }
  go(reqUrl);
}

// ---------------- IPC 通道处理（服务端部分） ----------------
function handleIpc(channel, payload, session, res) {
  switch (channel) {
    case 'set-custom-data':
      if (payload && payload.key !== undefined) session.sharedData[payload.key] = payload.value;
      broadcastShared(session);
      break;
    case 'set-role-name':
      if (!session.sharedData.userInfo || typeof session.sharedData.userInfo !== 'object') session.sharedData.userInfo = {};
      session.sharedData.userInfo.role_name = payload;
      broadcastShared(session);
      break;
    case 'refresh-win-data': {
      if (!payload || !payload.type) break;
      sendToMain(session, payload.type);
      if (payload.subWin && Array.isArray(payload.index)) {
        payload.index.forEach(i => sendToWin(session, String(i), payload.type));
      }
      break;
    }
    case 'logger': {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const name = safeName(payload && payload.name || 'app');
        fs.appendFileSync(path.join(LOG_DIR, 'log-' + name + '.txt'),
          nowStamp() + '__' + String(payload && payload.data || '') + '\n');
      } catch (e) { /* ignore */ }
      break;
    }
    case 'chat':
    case 'project-chat':
    case 'forward-msg':
    case 'silent-send-custom-msg':
      sendToMain(session, channel, payload);
      break;
    case 'update-forward-status':
      sendToWin(session, '11', 'update-forward-status', payload);
      break;
    case 'chat-msg-info':
    case 'chat-msg-count':
    case 'update':
    case 'updateNow':
      break; // 桌面端仅做托盘/角标/自动更新，Web 无对应能力
    case 'openSubWin':
      return handleOpenSubWin(payload, session);
    case 'preview-file':
      return handlePreviewFile(payload, session, res);
    default:
      break;
  }
  return null;
}

function handleOpenSubWin(payload, session) {
  const data = payload.data || {};
  const link = (typeof payload.link === 'string' && payload.link) || data.link || '/';
  session.nextWin = ((session.nextWin || 0) + 1) % 10000;
  const index = session.nextWin;
  const sep = link.indexOf('?') >= 0 ? '&' : '?';
  const hashLink = link + sep + 'win_code=' + index;
  session.hashLinkByWin[String(index)] = hashLink;

  const s = session.sharedData;
  const merge = o => {
    if (!o) return;
    ['meeting_record_id', 'project_task_id', 'project_user_remind_id', 'project_user_notify_id',
      'customerData', 'allCustomerData', 'previewFiles'].forEach(k => {
      if (o[k] !== undefined) s[k] = o[k];
    });
  };
  merge(data); merge(payload);
  broadcastShared(session);

  // 子窗口页挂在 /liangzhai/ 下
  return { winCode: index, url: '/liangzhai/subwin.html#' + hashLink };
}

const PREVIEW_INLINE = /\.(pdf|png|jpe?g|gif|bmp|webp|txt|mp4|webm|mov|m4v|mp3|wav)$/i;
const previewTokens = new Map(); // token -> { file, name }

function handlePreviewFile(payload, session, res) {
  res.__async = true;
  const urlStr = payload && payload.url;
  const name = safeName(payload && payload.name || 'preview');
  const win = payload && payload.winCode !== undefined && payload.winCode !== null && payload.winCode !== '' ? payload.winCode : '-1';
  const key = payload && payload.key;
  if (!urlStr || !hostAllowed(urlStr)) {
    sendToWin(session, win, 'download-file-error', { key: key });
    try { sendJson(res, 400, { error: 'invalid url' }); } catch (e) {}
    return { error: 'invalid url' };
  }
  sendToWin(session, win, 'download-file-start', { key: key });
  const token = crypto.randomBytes(12).toString('hex');
  const dir = path.join(CACHE_DIR, token);
  let filePath = path.join(dir, name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  let done = false;
  let stream = null;
  fetchRemote(urlStr, state => {
    sendToWin(session, win, 'download-file-progress', { key: key, state: state });
  }, (err, info) => {
    if (err) {
      if (!done) { done = true; sendToWin(session, win, 'download-file-error', { key: key }); }
      try { sendJson(res, 502, { error: 'download failed' }); } catch (e) {}
      return;
    }
    stream = info.stream;
    const ws = fs.createWriteStream(filePath);
    info.stream.pipe(ws);
    ws.on('finish', () => {
      if (done) return; done = true;
      previewTokens.set(token, { file: filePath, name: name });
      sendToWin(session, win, 'download-file-end', { key: key });
      sendJson(res, 200, { url: '/__preview/' + token + '?name=' + encodeURIComponent(name), name: name });
    });
    ws.on('error', () => {
      if (done) return; done = true;
      sendToWin(session, win, 'download-file-error', { key: key });
      try { sendJson(res, 502, { error: 'write failed' }); } catch (e) {}
    });
  });
  return null; // 异步完成，稍后直接写响应
}

// ---------------- SSE ----------------
function handleEvents(req, res, session) {
  const win = (req.query && req.query.win) || '-1';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  let set = session.tabs.get(String(win));
  if (!set) { set = new Set(); session.tabs.set(String(win), set); }
  set.add(res);
  tabStore.set(res, { sid: null, win: String(win) });
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch (e) {} }, 25000);
  setTimeout(() => sseSend(res, 'get-shared-data', session.sharedData), 80);
  req.on('close', () => {
    clearInterval(hb);
    set.delete(res);
    if (set.size === 0) session.tabs.delete(String(win));
    tabStore.delete(res);
  });
}

// ---------------- /__file 文件代理（预览用，支持 Range，绕过 CDN CORS 限制） ----------------
function handleFileProxy(req, res) {
  const q = req.query || {};
  const urlStr = q.url;
  if (!urlStr || !hostAllowed(urlStr)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: host not allowed');
    return;
  }
  let u;
  try { u = new URL(urlStr); } catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Request'); return; }
  const mod = u.protocol === 'https:' ? https : http;
  const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiangzhaiWeb/1.0', accept: '*/*' };
  if (req.headers.range) headers.range = req.headers.range;
  const preq = mod.request({
    protocol: u.protocol, host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search, method: 'GET', headers: headers
  }, pres => {
    const h = {};
    Object.keys(pres.headers).forEach(k => {
      if (/^(transfer-encoding|connection)$/i.test(k)) return;
      h[k] = pres.headers[k];
    });
    h['access-control-allow-origin'] = '*';
    if (!h['cache-control']) h['cache-control'] = 'public, max-age=3600';
    res.writeHead(pres.statusCode, h);
    pres.pipe(res);
    pres.on('error', () => { try { res.end(); } catch (e) {} });
  });
  preq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Gateway');
  });
  preq.end();
}

// ---------------- /__img 图片代理（动态数据图片：拉取 + 磁盘缓存，离线可回放） ----------------
const IMG_CACHE_DIR = path.join(CACHE_DIR, 'img');

function handleImgProxy(req, res) {
  const urlStr = req.query && req.query.url;
  if (!urlStr || !hostAllowed(urlStr)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: host not allowed');
    return;
  }
  let u;
  try { u = new URL(urlStr); } catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
  const key = sha1(urlStr).slice(0, 32);
  const ext = (path.extname(u.pathname) || '.img').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.img';
  const file = path.join(IMG_CACHE_DIR, key + ext);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    res.writeHead(200, { 'Content-Type': mimeOf(file), 'Cache-Control': 'public, max-age=604800', 'x-img-cache': 'hit' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const mod = u.protocol === 'https:' ? https : http;
  const preq = mod.request({
    protocol: u.protocol, host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search, method: 'GET',
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiangzhaiWeb/1.0', accept: 'image/*,*/*;q=0.8' }
  }, pres => {
    if (pres.statusCode !== 200) { pres.resume(); res.writeHead(502); res.end('Bad Gateway'); return; }
    try { fs.mkdirSync(IMG_CACHE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
    const ws = fs.createWriteStream(file + '.tmp');
    pres.pipe(ws);
    pres.pipe(res);
    res.writeHead(200, { 'Content-Type': pres.headers['content-type'] || mimeOf(file), 'Cache-Control': 'public, max-age=604800' });
    ws.on('finish', () => { try { fs.renameSync(file + '.tmp', file); } catch (e) { /* ignore */ } });
    ws.on('error', () => { try { fs.unlinkSync(file + '.tmp'); } catch (e) { /* ignore */ } });
  });
  preq.on('error', () => {
    // 联网失败：回放已缓存（上面已查）或 502
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Gateway'); }
  });
  preq.end();
}

// 图片本地化注入脚本：把页面中指向外部 CDN 的 <img> 改写为本地 /__img 代理（含动态数据图片）
const IMG_PROXY_SCRIPT = '<script>(function(){var H=["cdn.e-shigong.com","nos.netease.com","nosdn.127.net","img.t.sinajs.cn","qiniucdn.com","qnssl.com","qbox.me"];function ok(u){if(!u)return false;try{var x=new URL(u,location.href);return H.some(function(d){return x.hostname===d||x.hostname.endsWith("."+d)})}catch(e){return false}}function toLocal(u){return "/__img?url="+encodeURIComponent(u)}var od=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");if(od&&od.set){Object.defineProperty(HTMLImageElement.prototype,"src",{get:function(){return od.get.call(this)},set:function(v){try{var u=new URL(String(v),location.href);if(ok(u.href))v=toLocal(u.href)}catch(e){}return od.set.call(this,v)}})}var osa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if(this.tagName==="IMG"&&(n==="src"||n==="data-src")){try{var u=new URL(String(v),location.href);if(ok(u.href))v=toLocal(u.href)}catch(e){}}return osa.call(this,n,v)};function fix(im){if(!im||im.__lzfix)return;var s=im.src;if(s&&ok(s)){im.__lzfix=1;try{im.src=toLocal(s)}catch(e){}}}function scan(){[].forEach.call(document.querySelectorAll("img"),fix)}scan();new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});})();</script>';

// ---------------- 下载 ----------------
function handleDownload(req, res, session) {
  const q = req.query || {};
  const urlStr = q.url, name = safeName(q.name), key = q.key || '', win = q.win || '-1', eventName = q.event || '';
  if (!urlStr || !hostAllowed(urlStr)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: host not allowed');
    return;
  }
  sendToWin(session, win, 'download-file-start', { key: key });
  fetchRemote(urlStr, state => {
    sendToWin(session, win, 'download-file-progress', { key: key, state: state });
  }, (err, info) => {
    if (err) {
      sendToWin(session, win, 'download-file-error', { key: key });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      try { res.end('Download failed: ' + err.message); } catch (e) {}
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      'Cache-Control': 'no-store'
    });
    info.stream.pipe(res);
    info.stream.on('end', () => {
      sendToWin(session, win, 'download-file-end', { key: key });
      if (eventName) sendToWin(session, win, eventName);
    });
    info.stream.on('error', () => {
      sendToWin(session, win, 'download-file-error', { key: key });
      try { res.end(); } catch (e) {}
    });
    req.on('close', () => { try { info.stream.destroy(); } catch (e) {} });
  });
}

// ---------------- 静态服务（带 Range 支持 + SPA fallback） ----------------
function serveStatic(req, res, root, rel, fallbackFile) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
  if (decoded === '/') decoded = '/index.html';
  decoded = decoded.split('?')[0];
  const filePath = path.resolve(root, '.' + decoded);
  if (!(filePath === root || filePath.startsWith(root + path.sep))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback：history 模式路由（后台 /enterprise /budget /supplier /template /user 等）
    if (fallbackFile && fallbackFile !== decoded) {
      return serveStatic(req, res, root, '/' + fallbackFile);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (root === ENT_DIST || root === LZ_DIST) console.log('[404]', rel);
    res.end('Not Found: ' + rel);
    return;
  }

  const mime = mimeOf(filePath);
  // 可被本地化改写的文件（html/js/css）一律 no-cache，避免浏览器缓存旧版 patch 内容；
  // 图片/字体等静态资源保留短缓存
  const isMutable = /\.(html|js|css|json)$/i.test(filePath);
  const headers = {
    'Content-Type': mime,
    'Cache-Control': isMutable ? 'no-cache' : 'public, max-age=3600'
  };
  // 入口 HTML 注入图片本地化脚本（外部 CDN 图片 → 本地 /__img 代理缓存）
  if ((decoded === '/index.html' || decoded === '/subwin.html')
    && (root === LZ_DIST || root === ENT_DIST)
    && !headers['x-lz-injected']) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const injected = raw.includes(IMG_PROXY_SCRIPT) ? raw : raw.replace('</body>', IMG_PROXY_SCRIPT + '</body>');
    headers['x-lz-injected'] = '1';
    const buf = Buffer.from(injected, 'utf8');
    if (req.headers.range && /^bytes=/.test(req.headers.range)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : buf.length - 1;
        if (isNaN(start)) start = buf.length - end, end = buf.length - 1;
        if (isNaN(end) || end >= buf.length) end = buf.length - 1;
        if (start <= end && start < buf.length) {
          res.writeHead(206, Object.assign({}, headers, {
            'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.length,
            'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes'
          }));
          res.end(buf.slice(start, end + 1));
          return;
        }
      }
    }
    res.writeHead(200, Object.assign({ 'Content-Length': buf.length }, headers));
    res.end(buf);
    return;
  }
  const stat = fs.statSync(filePath);
  if (req.headers.range && /^bytes=/.test(req.headers.range)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start)) start = stat.size - end, end = stat.size - 1;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start <= end && start < stat.size) {
        res.writeHead(206, Object.assign({}, headers, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
          'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes'
        }));
        fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
        return;
      }
    }
    res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
    res.end();
    return;
  }
  res.writeHead(200, Object.assign({ 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' }, headers));
  const rs = fs.createReadStream(filePath);
  rs.on('error', () => { try { res.end(); } catch (e) {} });
  rs.pipe(res);
}

// ---------------- 门户首页 ----------------
const MODE_LABEL = { auto: '自动（真实优先 + 离线回放）', live: '仅真实（不录制）', offline: '离线（仅录制数据）' };
function portalPage(req) {
  const mode = MODE_LABEL[FIXTURE_MODE] || FIXTURE_MODE;
  const host = req.headers.host || ('localhost:' + PORT);
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>亮宅 · 易施工 本地克隆系统</title>'
    + '<style>'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{min-height:100vh;font-family:"Microsoft YaHei","PingFang SC",sans-serif;'
    + 'background:linear-gradient(135deg,#0f2027 0%,#203a43 50%,#2c5364 100%);color:#fff;'
    + 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px}'
    + '.wrap{max-width:880px;width:100%}'
    + 'h1{font-size:30px;letter-spacing:2px;text-align:center}'
    + '.sub{text-align:center;color:#9fb8c4;margin:12px 0 36px;font-size:14px}'
    + '.cards{display:flex;gap:24px;flex-wrap:wrap}'
    + '.card{flex:1;min-width:300px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);'
    + 'border-radius:14px;padding:28px;text-decoration:none;color:#fff;transition:transform .18s ease,background .18s ease}'
    + '.card:hover{transform:translateY(-4px);background:rgba(255,255,255,.12)}'
    + '.card h2{font-size:20px;margin-bottom:10px;display:flex;align-items:center;gap:10px}'
    + '.dot{width:10px;height:10px;border-radius:50%;display:inline-block}'
    + '.card p{color:#b8ccd5;font-size:13px;line-height:1.8}'
    + '.tag{display:inline-block;margin-top:14px;padding:4px 12px;border-radius:20px;font-size:12px;'
    + 'background:rgba(64,196,145,.18);color:#5fe0a9;border:1px solid rgba(64,196,145,.4)}'
    + '.foot{text-align:center;color:#6f8a96;font-size:12px;margin-top:36px;line-height:2}'
    + '</style></head><body><div class="wrap">'
    + '<h1>亮宅 · 易施工 本地克隆系统</h1>'
    + '<div class="sub">前端（操作端 + 装企后台）原样 1:1 复刻 · 后端 API 代理 + 自动录制离线兜底</div>'
    + '<div class="cards">'
    + '<a class="card" href="/liangzhai/"><h2><span class="dot" style="background:#2ecc8f"></span>前台 · 亮宅操作端</h2>'
    + '<p>项目、客户、工程、预算、材料等日常操作端（原桌面客户端 Web 版）。<br>登录：18300000001 / 123456789</p>'
    + '<span class="tag">进入操作端 →</span></a>'
    + '<a class="card" href="/enterprise/"><h2><span class="dot" style="background:#4aa3ff"></span>后台 · 装企后台管理系统</h2>'
    + '<p>企业后台：成员、角色、预算、供应商、模板、技术术语等 14 个导航页面 1:1 复刻。<br>登录：18300000001 / 123456</p>'
    + '<span class="tag">进入企业后台 →</span></a>'
    + '</div>'
    + '<div class="foot">数据模式：' + mode + ' &nbsp;·&nbsp; 本机访问：http://' + host + ' &nbsp;·&nbsp; 原 API：lzapi.e-shigong.com</div>'
    + '</div></body></html>';
}

// ---------------- 主路由 ----------------
function handler(req, res) {
  let u;
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); } catch (e) { res.writeHead(400); res.end(); return; }
  const pathname = u.pathname;
  req.query = {};
  u.searchParams.forEach((v, k) => { req.query[k] = v; });

  try {
    // 门户
    if (pathname === '/' || pathname === '/index.html' || pathname === '/portal.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(portalPage(req));
      return;
    }

    // 前台 SPA（含子窗口 subwin.html）
    if (pathname === '/liangzhai') {
      res.writeHead(302, { Location: '/liangzhai/' });
      res.end();
      return;
    }
    if (pathname.startsWith('/liangzhai/')) {
      serveStatic(req, res, LZ_DIST, pathname.slice('/liangzhai'.length), 'index.html');
      return;
    }

    // 后台 SPA
    if (pathname === '/enterprise') {
      res.writeHead(302, { Location: '/enterprise/' });
      res.end();
      return;
    }
    if (pathname.startsWith('/enterprise/')) {
      serveStatic(req, res, ENT_DIST, pathname.slice('/enterprise'.length), 'index.html');
      return;
    }

    // 后台 SPA 的 history 路由路径（导航页在 /enterprise /budget /supplier /template /user 下）
    if (pathname.startsWith('/budget/') || pathname.startsWith('/supplier/')
      || pathname.startsWith('/template/') || pathname.startsWith('/user/')
      || pathname.startsWith('/preview-profile') || pathname === '/404') {
      serveStatic(req, res, ENT_DIST, pathname, 'index.html');
      return;
    }

    // 后台 webpack publicPath="/" 的绝对路径兜底（/js /css /fonts 等 → 后台资源）
    if (ENT_ROOT_PREFIXES.some(p => pathname === p.slice(0, -1) || pathname.startsWith(p))) {
      serveStatic(req, res, ENT_DIST, pathname);
      return;
    }
    // 后台静态图片等绝对路径（登录页 logo 等）
    if (pathname.startsWith('/img/')) {
      serveStatic(req, res, ENT_DIST, pathname);
      return;
    }
    // 后台版本检查（前端 GET /version.json?t=...，404 会触发 axios 错误提示）
    if (pathname === '/version.json') {
      serveStatic(req, res, ENT_DIST, pathname);
      return;
    }

    // 静态页（协议/政策/监控/地图）
    if (pathname.startsWith('/__static/')) {
      serveStatic(req, res, STATIC_DIR, pathname.slice('/__static'.length));
      return;
    }

    // pdf.js 预览器（前台 dist 自带：/web/viewer.html + /build/pdf.js + cmaps/locale）
    // 后台预算说明 PDF 预览 iframe 引用 /web/viewer.html?file=...
    if (pathname.startsWith('/web/') || pathname.startsWith('/build/')) {
      serveStatic(req, res, LZ_DIST, pathname);
      return;
    }

    if (pathname === '/__shim.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(SHIM_FILE));
      return;
    }
    if (pathname === '/__pending.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>亮宅</title></head><body style="background:#fff;display:flex;align-items:center;justify-content:center;font:14px sans-serif;color:#999">窗口加载中…</body></html>');
      return;
    }

    const session = getSession(req, res);

    if (pathname === '/__events') { handleEvents(req, res, session); return; }

    if (pathname === '/__download') { handleDownload(req, res, session); return; }

    if (pathname === '/__file') { handleFileProxy(req, res); return; }

    if (pathname === '/__img') { handleImgProxy(req, res); return; }

    if (pathname.startsWith('/__preview/')) {
      const token = pathname.slice('/__preview/'.length);
      const info = previewTokens.get(token);
      if (!info || !fs.existsSync(info.file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Preview expired'); return; }
      const stat = fs.statSync(info.file);
      const inline = PREVIEW_INLINE.test(info.name);
      const headers = {
        'Content-Type': mimeOf(info.name),
        'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(info.name),
        'Accept-Ranges': 'bytes'
      };
      const range = req.headers.range;
      if (range && /^bytes=/.test(range)) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
          let start = m[1] ? parseInt(m[1], 10) : 0;
          let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (isNaN(start)) start = stat.size - end, end = stat.size - 1;
          if (isNaN(end) || end >= stat.size) end = stat.size - 1;
          if (start <= end && start < stat.size) {
            res.writeHead(206, Object.assign({}, headers, {
              'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
              'Content-Length': end - start + 1
            }));
            fs.createReadStream(info.file, { start: start, end: end }).pipe(res);
            return;
          }
        }
      }
      res.writeHead(200, Object.assign({ 'Content-Length': stat.size }, headers));
      fs.createReadStream(info.file).pipe(res);
      return;
    }

    if (pathname.startsWith('/api')) {
      // 本地 API 层：on/observe 模式命中本地则接管；否则走原站代理
      if (LOCAL_MODE !== 'off' && handleLocalApi(req, res, pathname)) return;
      proxyToApi(req, res);
      return;
    }

    if (pathname.startsWith('/__ipc-sync/')) {
      const channel = pathname.slice('/__ipc-sync/'.length);
      readBody(req, payload => {
        if (channel === 'get-shared-data-sync') {
          const win = (payload && payload.win) || '-1';
          const out = Object.assign({}, session.sharedData);
          const hl = session.hashLinkByWin[String(win)];
          if (hl) out.hashLink = hl;
          if (!out.userInfo || typeof out.userInfo !== 'object') out.userInfo = {};
          if (!Array.isArray(out.permissions)) out.permissions = [];
          if (out.businessAnalysis === undefined) out.businessAnalysis = 0;
          sendJson(res, 200, { value: out });
        } else {
          sendJson(res, 200, null);
        }
      });
      return;
    }

    if (pathname.startsWith('/__ipc/')) {
      const channel = pathname.slice('/__ipc/'.length);
      readBody(req, payload => {
        const r = handleIpc(channel, payload, session, res);
        if (res.__async) return;
        if (r && r.error) sendJson(res, 502, r);
        else if (!res.headersSent && !res.writableEnded) sendJson(res, 200, r || { ok: true });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found: ' + pathname + '（本系统提供：/ 门户、/liangzhai/ 前台、/enterprise/ 后台）');
  } catch (err) {
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Error');
    } catch (e) { /* ignore */ }
    console.error('[server]', err);
  }
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

function startListener(host, familyLabel) {
  const srv = http.createServer(handler);
  srv.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log('  [' + familyLabel + '] 端口被占用（可能有其它服务在跑），已跳过: ' + err.message);
    } else {
      console.error('  [' + familyLabel + '] 启动失败: ' + err.message);
    }
  });
  srv.listen(PORT, host, () => {
    console.log('  [' + familyLabel + '] 已监听 ' + (host === '::' ? '[::]' : host) + ':' + PORT);
  });
  return srv;
}

startListener('0.0.0.0', 'IPv4');
startListener('::', 'IPv6');

console.log('==============================================');
console.log('  亮宅 · 易施工 本地克隆系统已启动');
console.log('  门户:     http://localhost:' + PORT + '/');
console.log('  前台:     http://localhost:' + PORT + '/liangzhai/');
console.log('  后台:     http://localhost:' + PORT + '/enterprise/');
console.log('  数据模式: ' + FIXTURE_MODE + '（auto=真实+录制+回放 live=仅真实 offline=仅回放）');
console.log('  API 代理: /api -> ' + API_ORIGIN + '（录制目录: ' + FIXTURE_DIR + '）');
const nets = os.networkInterfaces();
Object.keys(nets).forEach(name => {
  (nets[name] || []).forEach(it => {
    if (it.family === 'IPv4' && !it.internal) console.log('  局域网:    http://' + it.address + ':' + PORT + '/');
  });
});
console.log('==============================================');
