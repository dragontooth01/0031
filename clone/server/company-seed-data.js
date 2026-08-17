/**
 * 企业后台（houtai）种子数据（回退版）
 * 从 houtai/src/api/data.ts + client.ts 的 mock 数据转录。
 * seed-company.js 优先使用 E:/Program Files (x86)/000000/api_data 的
 * 真实接口快照（原站后台真实数据），该目录缺失时才回退到本文件数据。
 */
module.exports = {
  // 轮播图（houtai mockBanners）
  banners: [
    { id: 1, title: '亮宅品牌宣传', url: 'https://mp.weixin.qq.com/s/D_5jAgJW87-mtdsx-tuDkw', enabled: true, image: '' },
    { id: 2, title: '装修开工大吉', url: 'https://mp.weixin.qq.com/s/xExample', enabled: false, image: '' },
  ],
  // 分公司（houtai mockBranches）
  branches: [
    { id: 1, name: '广州分公司', addedAt: '2023-04-15', projectCount: 12, memberCount: 8, contact: '王总', phone: '13800138000', specificCode: 'GZ01', warehouseEnabled: true, supplierEnabled: true, supplierCount: 3, province: '广东省', city: '广州市', district: '天河区', address: '和美路1288号', managerPhone: '13800138000', password: '' },
  ],
  // 前端应用权限树（houtai mockPermissionTree）
  appPermissionTree: [
    { label: '项目', children: ['项目看板', '所有项目', '新建项目', '项目巡检汇总查看权限', '工地打卡汇总查看权限', '公司售后汇总查看权限', '延期申请汇总', '待办事项汇总'] },
    { label: '企业OA', children: ['新建会议记录', '会议记录总览', '审批管理', '考勤统计', '请假申请'] },
    { label: 'CRM系统', children: ['销售管理', '文件管理', '合同文件上传', '公司公海管理', '公司废单管理'] },
    { label: '预算模块', children: ['预算概览', '我的预算', '材料审批', '仓库订单管理', '查看全部材料订单的权限'] },
    { label: '考勤模块', children: ['考勤管理', '考勤流程审批'] },
    { label: '财务模块', children: ['录入合同权限', '业务数据分析权限', '客户收款查看', '合同赠品查看'] },
  ],
  // 材料分类（houtai mockMaterialCategories）
  materialCategories: [
    { name: '主材', children: ['玻璃', '瓷砖类', '全屋定制', '地板', '洁具', '门窗'] },
    { name: '辅材', children: ['水泥', '砂浆', '防水', '板材', '五金'] },
  ],
  // 定额类型（houtai mockQuotaTypes）
  quotaTypes: [
    { id: 1, name: '泥工定额' }, { id: 2, name: '地面定额' }, { id: 3, name: '拆除定额' },
    { id: 4, name: '木工定额' }, { id: 5, name: '油工定额' }, { id: 6, name: '套餐定额' },
  ],
  // 定额条目（houtai mockQuotas 16 条）
  quotas: [
    { id: 1, name: '瓷砖墙面铺贴30*60cm', desc: '处理基层-找规矩-打底灰-排砖放线-面砖预处理-挂浆镶贴-勾缝擦缝。含人工、水泥砂浆、釉面砖。', unit: '㎡', lossRate: 0, costMain: 17.5, costAux: 15, costLabor: 62, quoteMain: 50, quoteAux: 18, quoteLabor: 80, materialNote: '主材:釉面砖 辅料:水泥砂浆' },
    { id: 2, name: '新砌墙12CM九五砖（1/2砖墙）', desc: '85或95型红砖，按展开面积计算，不含水泥砂浆刮糙。', unit: '㎡', lossRate: 0, costMain: 90, costAux: 4, costLabor: 32, quoteMain: 85, quoteAux: 12, quoteLabor: 45, materialNote: '主材:九五砖 辅料:水泥砂浆' },
    { id: 3, name: '拆墙', desc: '拆除砖墙，含垃圾清运。', unit: '㎡', lossRate: 0, costMain: 5, costAux: 5, costLabor: 22, quoteMain: 0, quoteAux: 0, quoteLabor: 50, materialNote: '人工拆除' },
    { id: 4, name: '瓷砖墙面铺贴400*800cm', desc: '处理基层-找规矩-打底灰-排砖放线-面砖预处理-挂浆镶贴-勾缝擦缝。工程标准：铺贴牢固，表面平整干净、缝隙均匀。', unit: '㎡', lossRate: 0, costMain: 20, costAux: 16, costLabor: 65, quoteMain: 55, quoteAux: 20, quoteLabor: 85, materialNote: '主材:釉面砖 辅料:水泥砂浆' },
    { id: 5, name: '瓷砖墙面铺贴600*1200cm', desc: '处理基层-排砖放线-面砖预处理-挂浆镶贴-勾缝擦缝。大规格瓷砖需薄贴法施工。', unit: '㎡', lossRate: 2, costMain: 25, costAux: 18, costLabor: 70, quoteMain: 65, quoteAux: 22, quoteLabor: 90, materialNote: '主材:釉面砖 辅料:瓷砖胶' },
    { id: 6, name: '瓷砖墙面铺贴马赛克', desc: '处理基层-排砖放线-面砖预处理-挂浆镶贴-勾缝擦缝。马赛克缝隙均匀一致。', unit: '㎡', lossRate: 5, costMain: 22, costAux: 17, costLabor: 68, quoteMain: 60, quoteAux: 22, quoteLabor: 88, materialNote: '主材:马赛克 辅料:白水泥' },
    { id: 7, name: '瓷砖墙面铺贴文化石', desc: '处理基层-排砖放线-面砖预处理-挂浆镶贴-勾缝擦缝。文化石错缝铺贴，表面平整。', unit: '㎡', lossRate: 5, costMain: 28, costAux: 14, costLabor: 66, quoteMain: 68, quoteAux: 18, quoteLabor: 86, materialNote: '主材:文化石 辅料:水泥砂浆' },
    { id: 8, name: '大理石墙面铺贴', desc: '处理基层-排砖放线-石材预处理-挂浆镶贴-勾缝擦缝。天然石材需做六面防护。', unit: '㎡', lossRate: 3, costMain: 120, costAux: 25, costLabor: 90, quoteMain: 150, quoteAux: 30, quoteLabor: 110, materialNote: '主材:大理石 辅料:石材粘结剂' },
    { id: 9, name: '新砌墙24CM九五砖（1砖墙）', desc: '85或95型红砖，按展开面积计算，不含水泥砂浆刮糙。', unit: '㎡', lossRate: 0, costMain: 95, costAux: 6, costLabor: 38, quoteMain: 90, quoteAux: 16, quoteLabor: 52, materialNote: '主材:九五砖 辅料:水泥砂浆' },
    { id: 10, name: '新砌墙12CM轻质砖', desc: '轻质砖砌筑，按展开面积计算，不含水泥砂浆刮糙。', unit: '㎡', lossRate: 0, costMain: 88, costAux: 5, costLabor: 35, quoteMain: 82, quoteAux: 14, quoteLabor: 48, materialNote: '主材:轻质砖 辅料:水泥砂浆' },
    { id: 11, name: '墙面抹灰批荡', desc: '基层处理-浇水湿润-打底灰-面层抹灰。抹灰表面平整、无空鼓开裂。', unit: '㎡', lossRate: 0, costMain: 10, costAux: 6, costLabor: 28, quoteMain: 15, quoteAux: 8, quoteLabor: 36, materialNote: '辅料:水泥砂浆' },
    { id: 12, name: '地面找平', desc: '基层清理-刷素水泥浆-浇筑找平层。表面平整度允许偏差≤4mm。', unit: '㎡', lossRate: 0, costMain: 12, costAux: 8, costLabor: 30, quoteMain: 16, quoteAux: 10, quoteLabor: 38, materialNote: '辅料:水泥砂浆' },
    { id: 13, name: '地面铺贴600*600地砖', desc: '基层清理-排砖放线-预铺-挂浆铺贴-勾缝擦缝。铺贴牢固，空鼓面积小于总数的5%。', unit: '㎡', lossRate: 3, costMain: 18, costAux: 14, costLabor: 58, quoteMain: 48, quoteAux: 18, quoteLabor: 75, materialNote: '主材:抛光砖 辅料:水泥砂浆' },
    { id: 14, name: '地面铺贴800*800地砖', desc: '基层清理-排砖放线-预铺-挂浆铺贴-勾缝擦缝。大规格地砖缝隙均匀、周边顺直。', unit: '㎡', lossRate: 3, costMain: 22, costAux: 15, costLabor: 60, quoteMain: 55, quoteAux: 19, quoteLabor: 78, materialNote: '主材:抛光砖 辅料:水泥砂浆' },
    { id: 15, name: '卫生间防水处理', desc: '基层处理-涂刷防水涂料两遍-闭水试验。墙面防水高度≥1.8m，闭水试验48小时。', unit: '㎡', lossRate: 0, costMain: 16, costAux: 20, costLabor: 25, quoteMain: 25, quoteAux: 28, quoteLabor: 35, materialNote: '主材:防水涂料 辅料:堵漏王' },
    { id: 16, name: '阳台地面铺贴300*300地砖', desc: '基层清理-排砖放线-预铺-挂浆铺贴-勾缝擦缝。排水坡度正确，无倒泛水积水。', unit: '㎡', lossRate: 5, costMain: 15, costAux: 13, costLabor: 55, quoteMain: 42, quoteAux: 17, quoteLabor: 70, materialNote: '主材:防滑砖 辅料:水泥砂浆' },
  ],
  // 材料成本参考价（houtai mockMaterialCosts）
  materialCosts: [
    { id: 1, type: '集成材', unit: '张', spec: '面板300×600mm', price: 85 },
    { id: 2, type: '建筑专用胶水', unit: 'kg', spec: '20KG/桶', price: 12 },
    { id: 3, type: '九五砖', unit: '块', spec: '240×115×53mm', price: 0.9 },
    { id: 4, type: '砂浆胶', unit: 'kg', spec: '1KG', price: 6 },
    { id: 5, type: '砂子/沙石', unit: 'kg', spec: '粗砂20KG/包', price: 1.2 },
    { id: 6, type: '石膏板', unit: '张', spec: '1220×2440×9.5mm', price: 45 },
    { id: 7, type: '水泥', unit: 'kg', spec: '325级50KG/包', price: 0.56 },
  ],
  // 预算模板（houtai mockBudgetTemplates）
  budgetTemplates: [
    { id: 1, name: '套餐预算', editedAt: '2024-09-26 11:04', enabled: true, manageRate: 10, taxRate: 3, spaces: ['厨房', '阳台', '套餐', '自定义', '基础个性化'], quotaCount: 13, materialCount: 13, itemCount: 0 },
    { id: 2, name: '清单预算', editedAt: '2024-09-26 11:00', enabled: true, manageRate: 10, taxRate: 3, spaces: ['厨房', '卫生间', '客厅', '主卧'], quotaCount: 26, materialCount: 30, itemCount: 2 },
    { id: 3, name: '套餐模版', editedAt: '2024-09-22 16:43', enabled: false, manageRate: 8, taxRate: 3, spaces: ['厨房', '阳台'], quotaCount: 8, materialCount: 8, itemCount: 0 },
  ],
  // 模板市场（houtai mockMarketTemplates 6 个，含完整阶段）
  marketTemplates: [
    { id: 1, name: '亮宅经典全屋套餐模板', desc: '适合三房两厅全屋装修，涵盖户型改建、水电、木工、泥瓦、油漆、安装全流程，标准工期约 55 天。', bg: 'bg-1', used: false, stages: [
      { name: '开工阶段', days: '第1-4天 共4天', tasks: [{ name: '开工交底', area: '全屋' }, { name: '材料进场验收', area: '全屋' }], notices: ['施工前请业主确认水电点位，签字确认后进场施工'], methods: ['标准开工工法'] },
      { name: '户型改建', days: '第5-9天 共5天', tasks: [{ name: '拆墙工程', area: '客厅/餐厅' }, { name: '砌墙工程', area: '客厅/餐厅' }], notices: ['拆除前确认承重墙位置'], methods: ['标准拆除工法'] },
      { name: '水电排放', days: '第10-18天 共9天', tasks: [{ name: '水路改造', area: '卫生间/厨房' }, { name: '电路改造', area: '全屋' }, { name: '弱电布线', area: '客厅/卧室' }], notices: ['强弱电分离'], methods: ['标准水电工法'] },
      { name: '木工', days: '第19-28天 共10天', tasks: [{ name: '吊顶安装', area: '客厅/餐厅' }, { name: '柜体定制', area: '卧室/厨房' }], notices: [], methods: ['标准木工工法'] },
      { name: '泥瓦工', days: '第29-36天 共8天', tasks: [{ name: '防水施工', area: '卫生间/阳台' }, { name: '瓷砖铺贴', area: '卫生间/厨房' }], notices: ['防水试验48小时'], methods: ['标准泥瓦工法'] },
      { name: '油漆', days: '第37-45天 共9天', tasks: [{ name: '墙面腻子', area: '全屋' }, { name: '乳胶漆涂刷', area: '全屋' }], notices: ['乳胶漆墙面需平整无流坠'], methods: ['标准油漆工法'] },
      { name: '木作安装', days: '第46-49天 共4天', tasks: [{ name: '套装门安装', area: '全屋' }, { name: '木地板铺装', area: '卧室' }], notices: [], methods: [] },
      { name: '水电安装', days: '第50-53天 共4天', tasks: [{ name: '灯具安装', area: '全屋' }, { name: '洁具安装', area: '卫生间' }, { name: '开关面板', area: '全屋' }], notices: [], methods: [] },
      { name: '软装进场', days: '第54-55天 共2天', tasks: [{ name: '家具进场', area: '客厅/卧室' }, { name: '家电安装', area: '客厅/厨房' }], notices: [], methods: [] },
      { name: '圆满交房', days: '第56天 共1天', tasks: [{ name: '整体验收', area: '全屋' }, { name: '交付钥匙', area: '全屋' }], notices: ['验收合格后交付'], methods: [] },
    ] },
    { id: 2, name: '轻奢简约风格模板', desc: '以浅色木饰面与隐藏式收纳打造简约轻奢质感，适合现代年轻家庭，标准工期约 35 天。', bg: 'bg-2', used: true, stages: [
      { name: '拆除改造', days: '第1-7天 共7天', tasks: [{ name: '拆旧', area: '全屋' }, { name: '垃圾清运', area: '全屋' }], notices: [], methods: [] },
      { name: '水电', days: '第8-16天 共9天', tasks: [{ name: '水电改造', area: '全屋' }], notices: [], methods: [] },
      { name: '木作', days: '第17-26天 共10天', tasks: [{ name: '木饰面', area: '客厅' }, { name: '隐藏式收纳', area: '卧室' }], notices: [], methods: [] },
      { name: '饰面', days: '第27-35天 共9天', tasks: [{ name: '艺术漆', area: '全屋' }, { name: '大理石背景墙', area: '客厅' }], notices: [], methods: [] },
    ] },
    { id: 3, name: '新中式装修模板', desc: '融合中式柜体、花格隔断与中式漆面，营造沉稳雅致的东方意境，标准工期约 40 天。', bg: 'bg-3', used: false, stages: [
      { name: '基础工程', days: '第1-10天 共10天', tasks: [{ name: '墙体改造', area: '客厅/卧室' }], notices: [], methods: [] },
      { name: '水电工程', days: '第11-20天 共10天', tasks: [{ name: '水电改造', area: '全屋' }], notices: [], methods: [] },
      { name: '木作工程', days: '第21-32天 共12天', tasks: [{ name: '中式柜体', area: '客厅/卧室' }, { name: '花格隔断', area: '客厅' }], notices: [], methods: [] },
      { name: '油漆工程', days: '第33-40天 共8天', tasks: [{ name: '中式漆面', area: '全屋' }], notices: [], methods: [] },
    ] },
    { id: 4, name: '北欧风格整装模板', desc: '简洁明亮的北欧整装方案，注重采光与实用性，标准工期约 45 天。', bg: 'bg-4', used: false, stages: [
      { name: '拆改', days: '第1-6天 共6天', tasks: [{ name: '拆改', area: '全屋' }], notices: [], methods: [] },
      { name: '水电', days: '第7-15天 共9天', tasks: [{ name: '水电', area: '全屋' }], notices: [], methods: [] },
      { name: '木工', days: '第16-25天 共10天', tasks: [{ name: '吊顶', area: '客厅' }, { name: '柜体', area: '卧室' }], notices: [], methods: [] },
      { name: '油漆', days: '第26-33天 共8天', tasks: [{ name: '墙面', area: '全屋' }], notices: [], methods: [] },
      { name: '软装', days: '第34-45天 共12天', tasks: [{ name: '家具进场', area: '客厅/卧室' }], notices: [], methods: [] },
    ] },
    { id: 5, name: '极简奶油风模板', desc: '奶油色系墙面搭配圆弧造型，柔和治愈，适合小户型，标准工期约 38 天。', bg: 'bg-1', used: true, stages: [
      { name: '拆改', days: '第1-5天 共5天', tasks: [{ name: '拆改', area: '全屋' }], notices: [], methods: [] },
      { name: '水电', days: '第6-13天 共8天', tasks: [{ name: '水电改造', area: '全屋' }], notices: [], methods: [] },
      { name: '泥瓦', days: '第14-22天 共9天', tasks: [{ name: '瓷砖铺贴', area: '卫生间/厨房' }], notices: [], methods: [] },
      { name: '木作油漆', days: '第23-33天 共11天', tasks: [{ name: '圆弧造型', area: '客厅' }, { name: '奶油色漆', area: '全屋' }], notices: [], methods: [] },
      { name: '安装软装', days: '第34-38天 共5天', tasks: [{ name: '家具软装', area: '全屋' }], notices: [], methods: [] },
    ] },
    { id: 6, name: '旧房翻新模板', desc: '针对老房翻新，含拆除清运、水电重排、全屋重做，标准工期约 50 天。', bg: 'bg-2', used: false, stages: [
      { name: '拆除清运', days: '第1-8天 共8天', tasks: [{ name: '整体拆除', area: '全屋' }, { name: '垃圾清运', area: '全屋' }], notices: [], methods: [] },
      { name: '水电重排', days: '第9-18天 共10天', tasks: [{ name: '水电重排', area: '全屋' }], notices: [], methods: [] },
      { name: '泥木', days: '第19-30天 共12天', tasks: [{ name: '墙地砖', area: '卫生间/厨房' }, { name: '吊顶柜体', area: '客厅/卧室' }], notices: [], methods: [] },
      { name: '油漆安装', days: '第31-45天 共15天', tasks: [{ name: '墙面粉刷', area: '全屋' }, { name: '安装收尾', area: '全屋' }], notices: [], methods: [] },
      { name: '验收交房', days: '第46-50天 共5天', tasks: [{ name: '整体验收', area: '全屋' }], notices: [], methods: [] },
    ] },
  ],
  // 我的模板（houtai mockMyTemplates 9 个）
  myTemplates: null, // 由 seed-company.js 基于 marketTemplates.stages 动态组装
  // 常用语（houtai mockTerms 8 条）
  terms: [
    { id: 1, category: '店面经理', content: '非常抱歉，让您久等了！', useCount: 0 },
    { id: 2, category: '店面经理', content: '客户第一锤！开工大吉！财源滚滚！吉祥如意！事事顺心！', useCount: 0 },
    { id: 3, category: '店面经理', content: '对于您反映的情况，我们会立即通知相关部门进行处理，在24小时内上门帮您解决，请您放心', useCount: 0 },
    { id: 4, category: '店面经理', content: '请问您所反映的问题工作人员到现场解决了吗？', useCount: 0 },
    { id: 5, category: '店面经理', content: '晚些时候我们会再对处理结果进行回访，如果您有任何问题或意见，请您随时与我们联系。', useCount: 0 },
    { id: 6, category: '店面经理', content: '请问您对工程总体质量和效果满意吗？', useCount: 0 },
    { id: 7, category: '店面经理', content: '今天收到您给公司工队送的锦旗，在此，感谢您对我们工作的认可，我们会在以后的服务中更加努力，确保各方面的工作顺利进行。', useCount: 0 },
    { id: 8, category: '店面经理', content: '您好！有什么需要帮助的吗？', useCount: 0 },
  ],
  termCategories: ['店面经理', '开工交底', '验收标准', '材料进场', '安全文明'],
};
