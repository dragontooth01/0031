/**
 * 轻量日志模块：核心分支详细日志，写入 data/app.log
 * 说明：console 输出经工具宿主收集会丢失，文件日志可靠；access.log 仍由 server.js apiLog 负责（逐请求简记），
 *      本模块记录分支级详细信息（归并数量/写操作变更/会话刷新结果等），便于排查报错。
 * 用法：
 *   const logger = require('./logger');
 *   logger.info('客户写接口', '编辑客户', { crm_id: 1, fields: ['name'] });
 *   logger.error('代理', '代理请求失败', { apiPath, err: e.message });
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'data', 'app.log');
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}

function _fmt(extra) {
  if (extra === undefined || extra === null) return '';
  if (typeof extra === 'string') return ' ' + extra;
  try { return ' ' + JSON.stringify(extra); } catch { return ' [无法序列化]'; }
}

function _write(level, tag, msg, extra) {
  const line = new Date().toISOString() + ' [' + level + '] [' + tag + '] ' + msg + _fmt(extra);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

const logger = {
  info(tag, msg, extra) { _write('INFO', tag, msg, extra); },
  warn(tag, msg, extra) { _write('WARN', tag, msg, extra); },
  error(tag, msg, extra) { _write('ERROR', tag, msg, extra); }
};

module.exports = logger;
