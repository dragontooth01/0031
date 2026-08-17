# 亮宅 · 易施工 本地克隆系统

将「亮宅」整套系统 1:1 克隆到本地：**前台**（亮宅操作端，原 Electron 桌面客户端的 Web 版）与**后台**（装企后台管理系统）均为原站编译产物原样复用，界面、按钮、弹窗与线上完全一致；**后端**为零依赖 Node 服务器，负责静态托管 + API 代理 + 响应录制/离线回放。

## 快速开始

1. 安装 [Node.js](https://nodejs.org/)（12+ 即可，无需 npm install，零第三方依赖）
2. 双击 `start.bat`（默认端口 8000），或 `node server.js`
3. 浏览器打开：
   - 门户：http://localhost:8000/
   - 前台（亮宅操作端）：http://localhost:8000/liangzhai/ —— 账号 `18300000001` / `123456789`
   - 后台（装企后台管理系统）：http://localhost:8000/enterprise/ —— 账号 `18300000001` / `123456`

> 换端口：`set PORT=9000 && node server.js`

## 功能

| 能力 | 说明 |
| --- | --- |
| 前台 1:1 | 原桌面端编译产物（`vendor/liangzhai`），含 IPC 兼容层（子窗口、下载进度、预览、SSE 事件推送） |
| 后台 1:1 | 装企后台 SPA 原样托管（`vendor/enterprise`），14 个导航页面：成员、角色、企业信息、分公司、权限、设置、材料、项目定额、预算模板、材料模板、供应商、施工模板、我的模板、技术术语；history 路由全部支持直接访问与刷新（`/enterprise/*`、`/budget/*`、`/supplier/*`、`/template/*`、`/user/login`） |
| API 代理 | `/api/*` 反向代理到 `https://lzapi.e-shigong.com`（后台登录 cookie 的 Domain/Secure 自动改写以适配本地） |
| 录制/回放 | 代理成功的 JSON 响应自动录制到 `fixtures/`；原 API 不可达时自动回放，克隆永不失效 |
| 下载/预览 | 前台的文件下载（带进度事件）与 PDF/图片/音视频预览 |
| 图片本地化 | 静态图片全部落地本地（`/img/` 等）；动态数据图片经 `/__img` 代理拉取并缓存到 `cache/img/`，离线可回放；登录页/模板示意图/表情/echarts 均已本地化 |
| 外网最小化 | 已禁用 Sentry 上报；除 API 数据、NIM 聊天、文件上传/直播等实时功能外无外网依赖 |

## 本地 API 层（LOCAL_MODE）

后端已内置**本地数据库层**（复用旧项目 `E:\erpkok-02\webqianduan` 的 SQLite 实现：544 个本地接口 + `data/local.db` 种子数据 + `data/mock/`）：

| 模式 | 行为 |
| --- | --- |
| `on`（默认） | `/api/*` 先查本地 handlers：**命中 → SQLite 本地处理**（离线可用、可写可持久）；未命中 → 原站代理；黑名单接口 → 原站代理 |
| `observe` | 本地影子运行 + 原站响应，自动双跑对比，日志报告结构差异（DIFF） |
| `off` | 完全原站代理（旧行为） |

- **黑名单**（`LOCAL_BLOCK`，默认含前台接口前缀与待重写接口）：结构失真或未验收的接口继续走原站，修复一个移除一个；动态数据接口（商品单位/厂家）保持代理+录制兜底
- **写接口保护**：本地命中的**写接口（增删改/状态/排序/转移等）跳过 DIFF 后台对比**——对比请求会把写操作真实打到云端并污染真实数据（已发生并清理过，机制已修复）；读接口保留双跑对比
- **混合认证**：本地登录自动同步云端 company 会话，代理云端接口时映射凭证（session-id/cookie/platform 按会话类型处理）
- **当前阶段**：
  - 阶段 1：后台本地登录/角色/术语/设置/分公司/权限等结构一致接口本地化 ✅
  - 阶段 2：材料库/工程定额/规格/预算模板/预算说明（excel+pdf）/商品分类/供应商类型等结构失真接口按原站响应重写（快照表种子）✅
  - 阶段 3：**写操作本地持久化** ✅ —— 组织架构（部门增删改排序/成员增删改调岗/已删除成员/数据转移）、材料（新增/编辑/停用/删除落快照表）、模板（新增/停用/删除落快照表）、术语、分公司等写接口全部落库，读接口即时合并显示；**材料编辑弹窗链路本地化**（detail 回填/一级二级分类/类型/保存全部走本地快照，保存字段映射对齐 SPA：sale_price=出库价、market_price=报价；单位/厂家等动态数据保持代理+录制）；页面临界验证：添加成员、新建部门、已删除成员列表、材料编辑（改名后列表即时刷新）、预算模板新建/删除、自动登录（7 天免登录 cookie 含 company_name/phone_number）均通过
  - 阶段 4（当前）：**前台操作端本地化** —— 登录链路（密码/验证码/自动登录 + 权限 + 公司列表 + 版本 + 节假日快照）✅；**CRM 客户模块** ✅（列表个人/公司视角、筛选条件/状态/表头/部门负责人、详情（本地新建+种子表）、添加/编辑/删除/状态/跟进/标签等写接口全部本地落库，双跑结构一致；**添加客户页面级全流程**：子窗口表单（电话/称呼/房屋/来源/类型/公司/服务团队两步向导）→ /crm/add/ 本地解析嵌套 body 落库 → 列表即时可见 → 软删清理 ✅；**客户详情面板 + 写跟进** ✅（修复详情结构缺 follow_records 导致白屏崩溃 + 跟进字段 follow_content 不匹配两个 bug；页面级：客户档案/跟进记录（本地 12 条）/服务团队/项目文件/预算/合同/收款/付款操作区完整渲染，写跟进弹窗→提交→本地落库验证通过）；**项目模块** ✅（项目详情/PC 列表/任务列表（60 条本地任务）/角色成员/区域/待办/周计划/巡检等 40+ 接口本地化，双跑结构零差异，页面级：项目详情（延期天数/计划/实际/施工群业主群）与任务列表子窗口渲染正常）；**预算编辑器** ✅（138 条本地预算种子，detail/list/save/区域/汇总/表头等接口本地化，页面级：预算详情（客户/设计师/空间8个/套餐表格完整渲染）与保存写链路（改名→详情即时反映→恢复）验证通过）；**商品/库存** ✅（51 商品/3 仓库/出入库记录，record/list（修复 record_type:-1=全部 过滤 bug）/content/warehouse/material 等读接口 + 采购入库/领料出库/退料入库/冲销等写接口本地化，页面级：库存管理页（#/workbench/stock-management，出入库记录/金额汇总完整渲染）+ 写链路（采购→记录+1→冲销）验证通过）；**离线全页面回归** ✅（LZ_FIXTURE_MODE=offline：登录/全部客户/库存/财务收款/材料订单/我的预算 6 页全部正常，本地 SQLite + 代理接口 fixture 回放（382 个录制））；**前台全页面走查** ✅（32 个主窗口页面 + 深页面（财务收款详情/任务详情/客户收款详情/付款审批）全部渲染无错误）；**财务详情收款记录** ✅（项目收款详情：合同/收款汇总/一期二期三期应收已收/收款记录列表（微信/小君/已审核/编辑打印）完整渲染）；**后台 14 页全面回归** ✅（14/14 通过无回归）；**后台常用语页面级添加** ✅（弹窗 textarea → /company/terminology/add/ 本地 json 存储 → 列表即时显示 → 清理）；**分公司模块** ✅（云端对比一致：max_sub_company_num=0 → "分公司数量已达到上限"为原站真实行为，1:1 正确）；**后台角色管理页** ✅（/company/role/* 全本地化：role/list 按本地成员动态重算计数、role/detail 与 role/member/list 对齐云端（任意角色返回系统默认岗位职责+权限组参考快照 role_detail_defaults.json；未启用角色 member/list 返回空对象 data:{}）、sys_role_type 的 selected 按公司角色配置动态计算；role/add、role/del 写接口本地落 role_store.json，绝不写云端；修复 company-api 原版路径别名把 /company/role/add/ 误映射到旧 v2/admin 角色组实现（写错 company_role_groups 表）的问题；页面级全流程：添加角色弹窗（选副总经理→右侧"选中角色/岗位职责：这是副总经理/角色权限"与云端 1:1）→ 确定 → 列表即时显示 副总经理 (0) → 删除确认弹窗 → 消失，全程本地零云端写；读接口双跑结构全部一致，离线模式角色页全接口可用）；**阶段5 前台财务模块** ✅（项目收款 /finance/list/（61 客户快照，跟随/完成/废弃计数+分页）、付款申请及审批（apply/list 按 status 快照 1:1（云端状态怪癖：0=空/1=已审核/2=已付款/4、5=全部/-1=我的）+ company/project/list + all_conditions）、项目应收汇总（summary 按 is_bad 快照，默认日期窗口内容为空与云端一致）、项目付款（/finance/paid/list/ 云端对当前 SPA 版本返回"软件版本过低"12002，1:1 镜像）、收款审核（contract/check/list 按 query_type×status 四池快照 + filter/info）、收付款分析（analysis/paid 快照）、项目流水（financial/record/list 快照，保留云端分页原始序列）、公司账户管理（account/list 快照 4 账户）、项目收款详情子窗口（/finance/detail/ 按 61 客户快照，支持 crm_id 与 crm_finance_id 双参数；financial-income-detail?id= 完整渲染：客户档案/合同收款汇总/一期二期三期/已收已审/编辑按钮区）**；全部双跑结构一致、页面级渲染验证通过（tab 切换/列表/合计/无 JS 错误）、离线模式全接口可用）；**财务详情写接口本地化** ✅（收款/退款记录增改删（/finance/paid/record/* 与 /finance/v2/paid/record/* 双路径；v2 body 无 crm_finance_id 时按 finance_contract_id 反查客户、phase_no→收款名、company_account_id→收款方式）、合同增改删/排序/坏账（/finance/contract/* 与 /finance/v2/contract/*）、凭证增删（/finance/file/*）、预付款增删（/finance/contract/add_prepay/*）、基础信息编辑（/finance/set/）、删除项目收款（/finance/crm/del/ → 详情 data_exist=0 + 列表移除）——全部 local_records 宽容落库、读时合并进详情快照，云端零写；页面级：添加收款弹窗（类型/金额/账户）→ 确定 → 列表即时出现 1,234.00 三期 → 本地删除还原；离线模式写链路同样可用）；**付款申请及审批（请款）本地化** ✅（apply/list 按状态动态重建（计数用快照、items 按 status 过滤、-1=我的保留存储池、本地状态/置顶/删除操作联动）、apply/detail 按 41 条请款详情快照 1:1（项目/金额/报销类型/工种/收款人/审批流程完整渲染，pay-ment-detail?fid= 子窗口）、状态写接口 review/reject/paid/withdraw/resubmit/set_top/del 全部本地落库并联动列表与详情（审核通过→待付款→已付款→撤回→还原验证通过）、新增请款落 finance_globals 并入列表；**收款审核/编辑/收款详情镜像** ✅（/finance/contract/check/detail/ 与 /finance/edit/paid/detail/ 云端恒 10032"数据不存在"、/finance/paid/detail/ 恒空对象、/finance/edit/record/list/ 恒空 records——按云端实测行为 1:1 镜像）；**新建请款页面级全流程** ✅（申请列表 tab → 项目款申请弹窗：选项目/付款类型/工种（96 工种）/收款账号/收款人/金额 → /finance/project/apply/ 本地落库（9 亿号段）→ 列表即时可见（-1 我的视图合并本地新增）→ 详情可读 → 清理还原）；**财务写接口全覆盖** ✅（128 个 /finance/ 路径 93 个本地 handler + 全部写接口本地化或安全兜底（analysis/business fee/paid edit/apply_type/self fee/woker fee/material fee/用户锁/批量审核付款/导入等宽容落库，云端零写）；**isWriteApi 写保护加固** ✅（关键词补 apply/paid/review/withdraw/resubmit/top/lock——此前 /finance/project/apply/ 等未命中写接口识别，DIFF 后台对比会把写操作真实执行到云端（曾致云端新增测试请款，已定位并修复）；写接口现在绝不触发云端对比）；**财务快照与云端同步刷新** ✅（finance_list/analysis/journal/account/company_project_list/apply 各状态池/61 客户详情/reviewer 设置/收款审核四池全部按当前云端状态重新抓取，云端配置变动（期数 3→4、审核人头像等）已对齐；pay_setting/get 云端恒 12002"软件版本过低"已 1:1 镜像；最终 18/18 读接口双跑 MATCH、离线 12/12、前台 32/32 回归通过）；采用 LOCAL_WHITE 白名单机制按页渐进放行
  - 阶段 6：**前台剩余高频读接口本地化（汇总/看板/展厅）** ✅ —— 商品展厅（/company/showroom/commodity_content/list/ 4 分类 + /company/showroom/material/list/ 51 材料，云端快照 1:1，页面级：商品展厅页分类/材料列表完整渲染）；**材料订单**（/material_apply/v3/decorator/order/list/ 44 订单快照 + 材料订单页完整渲染）；**老板看板**（/company/overview/data + /company/statistics/data + 部门排名 dept_ranking 7 部门，合同总额/销售签约排名/设计师排名/折扣分布完整渲染）；**项目巡检汇总**（/project/inspection/company/list/ 60 条）；**工地打卡汇总**（/project/attendance/company/list/ 29 条 + 打卡人数）；**考勤报表**（/oa/attendance/company/month/check/statistic/ 旷工 12 与云端一致）；**业务数据分析**（部门业绩排名 7 部门表完整渲染）；全部为云端快照 + 本地 handler（分页/筛选），双跑结构一致后放行；页面级验证：材料订单/老板看板/巡检汇总/工地汇总/考勤报表/业务数据分析/商品展厅/库存汇总 8 页全部渲染无错误；**离线全页面回归** ✅（LZ_FIXTURE_MODE=offline：前台 12 页全部通过——全部客户/库存管理/财务收款/材料订单/我的预算/老板看板/巡检汇总/工地汇总/考勤报表/业务数据分析/商品展厅/库存汇总；后台 13/14 通过，唯一 FAIL 为「账号功能权限」页静态图片 pic_wuchengyuan.*.png 404（资源缺失，非接口/功能问题））
  - 阶段 6 深化：**导出 excel 离线兜底** ✅ —— 代理层新增**二进制响应录制/回放**：`saveFixture` 对非文本响应（xlsx 等）按 base64 存储并记录 content-disposition（修正 textish 误判：`vnd.openxmlformats` 含 "xml" 会把 xlsx 当 utf8 文本存储导致损坏，已改为严格 `text/`|`application/json|javascript|xml` 前缀判断）；`doProxy` 对导出类接口（路径含 export/excel 且 content-type 为 spreadsheet/octet-stream）即使非 JSON 也缓冲录制；offline 模式与上游不可达回放统一走 `respondFixture`（base64 还原字节流 + 透传下载头）；已录制 2 个导出接口（项目付款页 /finance/company/project/apply/export/excel/ → 付款审批.xlsx、财务流水页 /finance/v2/financial/record/export/ → 项目流水.xlsx），页面级验证：在线与离线点导出均成功下载且字节数一致（10046/11619），离线全页面回归 12 页无回归
  - 阶段 7：**后台财务设置页（个性化设置·财务管理 tab）** ✅ —— 探测发现后台「个性化设置」页含财务管理 tab（非独立导航页），8 个读接口云端快照 1:1 本地化：/company/project/payment/setting/（付款限额 enable=1/limit_rate=20）、/company/material/apply/setting/contract/types/（11 种合同类型+suppliers）、/company/material/apply/setting/commodity/contents/（4 商品分类）、/company/list/、/finance/add/sub_company/account/setting/（分公司账户 open_status=0）、/oa/reimbursement/review/mode/get/（报销同级/逐级审核人）、/finance/project/apply_type/list/（4 付款类型：设计费/板材/电线/水泥黄沙）、/finance/analysis/setting/（收付款分析导出权限）；5 个写接口宽容落库防云端污染（analysis/setting/set、sub_company/account/setting/set、reimbursement/review/mode/set、payment/setting/edit、material/apply/setting/edit）；页面级验证：财务管理 tab 完整渲染（自定义费用子类列表/导出权限/分公司账户/报销审核设置）+ 写接口全部本地 code:0，离线模式同样可用；**顺手修复后台「无成员」占位图缺失**（/img/pic_wuchengyuan.46f09896.png 原站下载补全，此前导致账号功能权限页 404），后台离线回归升至 **14/14 全过**
- 切换：`set LOCAL_MODE=off && node server.js` 一键回到纯代理

```
set LOCAL_MODE=observe && node server.js   # 双跑对比模式（改接口后验收用）
set LOCAL_BLOCK=接口前缀 && node server.js  # 自定义黑名单
```

## 数据模式（LZ_FIXTURE_MODE）

- `auto`（默认）：真实 API 优先，成功即录制，连不上时回放录制数据
- `live`：仅真实代理，不录制不回放
- `offline`：完全不联网，仅回放 `fixtures/` 中已录制的数据

```bat
set LZ_FIXTURE_MODE=offline && node server.js
```

## 目录结构

```
clone/
  server.js                 克隆后端（静态托管 + API 代理 + 录制回放 + IPC/SSE/下载/预览）
  shim.js                   前台 ipcRenderer 兼容层（来自原版 web/shim.js）
  start.bat / package.json  启动入口
  scripts/patch-vendored.ps1 对 vendored SPA 做本地化预改写（API 基址、shim 注入、静态页路径、预览代理）
  overlay/                  自定义覆盖层（本地 office-viewer.html 预览页 + SheetJS/mammoth 库，vendor 重新同步后自动补回）
  vendor/
    liangzhai/              前台 SPA（复制自原安装目录 resources/app/dist，已预改写）
    enterprise/             后台 SPA（下载自 enterprise.e-shigong.com，已预改写）
  fixtures/                 API 录制数据（自动生成，可随系统分发用于离线模式）
  cache/ logs/              运行期目录（自动创建）
```

## 重新同步 vendor（可选）

```powershell
# 前台：从原安装目录重新复制
robocopy "E:\Program Files (x86)\000000\Liangzhai\resources\app\dist" vendor\liangzhai /E
# 后台：重新下载线上资源（见 scripts/download-enterprise.ps1）
# 然后重新执行本地化改写：
npm run patch
```

## 已知差异（浏览器固有限制，与原 Web 版一致）

1. 下载的文件进入浏览器下载目录，不会自动打开/定位
2. 无全局快捷键、系统托盘、任务栏角标、自动更新
3. 监控直播/地图/协议页已本地化（`/__static/`），NIM 即时通讯走网易云信原服务
4. 录制数据为抓取时的真实数据快照；离线模式下**后台管理写操作（部门/成员/材料/模板等）已本地持久化**（SQLite local_records + 快照表），刷新后仍在；CRM 客户/项目/预算/合同等本地写接口见阶段 3 之后的深化项
5. 文件预览已本地化：PDF 用原版 pdf.js 查看器（`/web/viewer.html`，前台 dist 自带），Excel/Word 用本地渲染页（`/web/office-viewer.html`，SheetJS/mammoth，替代原站引用的微软在线预览 view.officeapps.live.com）；文件统一经 `/__file` 本地代理拉取（CDN 的 CORS 预检不完整，跨域 Range 会被浏览器拦截）
