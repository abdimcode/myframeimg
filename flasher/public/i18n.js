// MyFrame Flasher — i18n.
// Language resolution order: URL `?lang=` → localStorage → navigator.language → 'zh'.

const STRINGS = {
  zh: {
    "design.eyebrow": "固件与设备设置",
    "design.prepare": "准备固件",
    "design.prepare_hint": "选择本批次的工单固件包。",
    "design.connect": "连接设备",
    "design.connect_hint": "授权新相框，即可开始烧录。",
    "design.help": "连接帮助",
    "design.footer": "珍藏每一个重要时刻。",

    "help.port.title": "未检测到设备端口？（未选择端口）",
    "help.port.cable": "检查线缆：使用支持数据传输的 USB 线，不能仅支持充电。",
    "help.port.power": "检查电源：确认设备电源指示灯已亮起。",
    "help.port.browser": "浏览器支持：请使用已启用 Web Serial 的 Google Chrome 或 Microsoft Edge。",
    "help.port.download": "在 WCH 页面中，请点击带下载图标的蓝色按钮。",
    "help.port.restart": "安装驱动后，请重启浏览器，重新连接设备并再次授权，然后选择串口。",
    "help.port.platform": "Windows 和 Mac（Silicon Labs）",

    // Header
    'app.title':          '生产中心',
    'app.subtitle':       '准备固件，连接相框，让美好即刻呈现。',
    'app.brand':          'Flasher',
    'header.workmode.dev':        'Develop',
    'header.workmode.prod':       'Production',

    // Env check
    'env.serial.ok':       'Web Serial API 可用',
    'env.serial.fail':     'Web Serial API 不可用（请用 Chrome 89+ 或 Edge 89+）',
    'env.crypto.ok':       'WebCrypto 可用',
    'env.crypto.fail':     'WebCrypto 不可用',
    'env.secure.ok':       '安全上下文 (https / localhost) ✓',
    'env.secure.fail':     '需要 https 或 localhost',

    // Workorder card
    'wo.id':              '工单',
    'wo.short_code':      '短码',
    'wo.firmware':        '固件',
    'wo.quota':           '配额剩余',
    'wo.sn_rule':         'SN 规则',
    'wo.sn_preview':      '预览',
    'wo.license':         'License',
    'wo.license_status':  '{used} / {quota} · 剩 {remaining}',
    'wo.license_exhausted': '⚠ License 已用完 · 无法继续烧录',
    'wo.license_expires': '有效至 {date}',
    'err.quota_exhausted': 'License 配额已用完 ({used}/{quota})，请联系管理员申请新 License',

    // Actions
    'action.connect':      '授权新设备（首次插入需授权）',
    'action.clear':        '清空列表',
    'action.rescan':       '重新扫描已授权设备',
    'mode.dev':           'DEV 模式 (mock 后端)',
    'mode.prod':          '生产模式 · 工单 {id}',
    'hint.autoflash':     '已授权的设备插上即自动烧录 · 支持多设备并发',

    // Empty grid
    'grid.empty':         '请插入设备',

    // Slot fields
    'slot.board':         '板 {idx}',
    'slot.chip':          'Chip',
    'slot.mac':           'MAC',
    'slot.sn':            'SN',
    'slot.stage':         '阶段',
    'slot.elapsed':       '耗时',
    'slot.dash':          '—',

    // States
    'state.working':      '工作中',
    'state.done':         '完成 ✓',
    'state.failed':       '失败 ✕',

    // Stages
    'stage.connect':      '连接串口',
    'stage.detect':       '检测芯片',
    'stage.readmac':      '读取 MAC',
    'stage.reserve_sn':   '领取 SN',
    'stage.download':     '下载固件',
    'stage.decrypt':      '解密固件',
    'stage.flashing':     '烧录中',
    'stage.reset_smoke':  '重启 + smoke test',
    'stage.consume':      '上报成功',
    'stage.done':         '完成',
    'stage.failed':       '失败: {reason}',

    // Log lines
    'log.wo_status':      '工单 {id} · 配额 {remain} / {total}',
    'log.port_picked':    '已选择串口，开始烧录…',
    'log.fw_bytes':       '固件字节数 {n}',
    'log.smoke_ok':       'smoke test 通过 · 收到 {n} 字节',
    'log.smoke_partial':  'smoke test 未匹配 pattern · 收到 {n} 字节 · 前 200:\n{sample}',
    'log.sn_ok':          'SN 回读校验通过 · {sn}',
    'log.sn_bad':         'SN 回读校验失败: {reason}',
    'log.flash_fail':     '烧录失败 · {msg}',
    'log.report_fail':    '上报失败也失败了: {msg}',
    'log.baud_fallback':  '升速失败，回落到 {baud}: {msg}',

    // Errors
    'err.wrong_chip':     '非 MyFrame 主板 (检测到 {chip})',
    'err.chip_undetected':'未识别到 MyFrame 主板 · 请按住 BOOT 键再上电后重试，或检查 USB 连接',
    'err.smoke_timeout':  '主板启动检查超时：未收到启动信号',
    'err.env_blocked':    '环境不满足要求，无法烧录。请用 Chrome 89+ 或 Edge 89+ 并通过 localhost / https 访问。',
    'err.wo_load':        '工单加载失败：{msg}',
    'err.boot_fail':      '启动失败：{msg}',
    'err.op_fail':        '操作失败：{msg}',

    // Lang switcher
    'lang.switch':        'EN',

    // Admin page
    'admin.login.title':     '管理员登录',
    'admin.login.subtitle':  '生产工单 · License · 固件包管理',
    'admin.login.password':  '密码',
    'admin.login.submit':    '登录',
    'admin.login.hint':      'Demo 密码：',
    'admin.login.failed':    '登录失败',
    'admin.panel.crumb':     'Admin · 生产中心',
    'admin.panel.open_flasher': '打开烧录页 ↗',
    'admin.panel.logout':    '退出登录',
    'admin.build.title':     '生成工单固件包',
    'admin.build.workorder': '工单号',
    'admin.build.firmware':  '固件',
    'admin.build.sn_rule':   'SN 规则',
    'admin.build.quota':     '烧写数量',
    'admin.build.expires':   '有效期至',
    'admin.build.button':    '生成固件包',
    'admin.build.working':   '生成中…',
    'admin.build.downloading': '下载中…',
    'admin.build.saved':     '保存到浏览器下载',
    'admin.build.new_wo':    '新建工单',
    'admin.build.new_wo_button': '创建',
    'admin.build.new_wo_missing': '请填入工单号',
    'admin.build.creating':  '创建中…',
    'admin.build.download_myfw':  '⬇ 下载 .myfw 包',
    'admin.build.downloading_myfw': '下载包中…',
    'admin.build.download_failed': '下载失败：{msg}',
    'admin.build.no_free_wo': '⚠ 所有工单已构建 · 请新建',
    'admin.fw.title':        '固件源管理 · Firmware Sources',
    'admin.fw.hint':         '管理员可上传新的 .bin 固件版本。上传的版本存服务端 Blob，可随时删除；git 内建版本只可读，不能通过界面删除。',
    'admin.fw.upload':       '上传新固件',
    'admin.fw.pick':         '选择 .bin 文件',
    'admin.fw.list':         '当前可用',
    'admin.fw.empty':        '暂无固件源 · 请上传或部署 built-in',
    'admin.fw.delete':       '删除',
    'admin.fw.uploading':    '上传 {name} 中…',
    'admin.fw.confirm_delete': '确定删除固件 {name}？此操作不可撤销。',
    'admin.audit.title':     '烧录审计 · SN ↔ MAC 追溯',
    'admin.audit.hint':      '每一次成功烧录都在服务器落库。任何一台产品出问题，用 MAC 或 SN 都能反查到对应工单和烧录时间。',
    'admin.audit.query':     '查询',
    'admin.audit.querying':  '查询中…',
    'admin.audit.col_time':  '时间 (UTC)',
    'admin.audit.col_fw':    '固件版本',
    'admin.audit.col_smoke': 'Smoke',
    'admin.audit.col_error': '错误 · Error',
    'admin.audit.empty':     '该工单暂无烧录记录',
    'admin.audit.failed':    '查询失败',
    'admin.log.title':       '操作日志',
    'admin.status.remaining': '工单 {wo} · License {lic} · 固件 {fw} · 已烧 {used}/{quota} · 剩 {remain}',

    // Log filter
    'log.filter_label':   '过滤',
    'log.filter_all':     '全部',
    'log.clear':          '清空日志',

    // Debug + firmware
    'debug.on':           'DEBUG',
    'debug.toggle':       '切换 Debug',
    'fw.section':         '工单固件包 · Workorder Package',
    'fw.pick_myfw':       '选择 .myfw 文件',
    'fw.myfw_hint':       '请选择管理员生成的 .myfw 工单文件（含 License + 加密固件）',
    'fw.selected':        '已选：',
    'fw.none':            '⚠ 未上传 .myfw · 请点击「选择 .myfw 文件」上传后才能烧写',
    'fw.status.reading':      '⏳ 读取 {name} ({size} MB)…',
    'fw.status.parsing_hdr':  '⏳ 读取文件头…',
    'fw.status.parsing_lic':  '⏳ 解析 license 元数据…',
    'fw.status.syncing':      '⏳ 同步服务器工单状态…',
    'fw.status.ready':        '✓ 已就绪 · {name} ({size} MB)',
    'fw.status.not_myfa':     '✕ 不是有效的 .myfw · 缺 MYFA 头',
    'fw.status.wo_mismatch':  '✕ 工单不匹配 · URL={url} · 文件={file}',
    'fw.status.no_bearer':    '⚠ 旧版 .myfw · 请让管理员重新生成',
    'fw.status.load_fail':    '✕ 加载失败: {msg}',
    'err.no_token':           '缺少 ?token= 授权令牌 · 请从管理页「打开烧录页」按钮打开此工单',
    'err.no_myfw':            '请先在页面上传 .myfw 工单固件包',
    'err.wrong_file_type':    '上传的文件不是 .myfw 加密包（缺 MYFA 头）· 请重新上传正确的工单固件包',
    'guide.ready_to_flash':   '✓ 就绪 · 请插入板子开始烧录',
    'guide.next_open_flasher':'✓ 固件包已生成 · 下一步 → 打开烧录页 ↗',
    'guide.empty_wo_hint':    '所有工单已构建 · 请在下方「新建工单」建一个新的',
    'action.clear_confirm':   '有 {n} 块板正在烧录 · 确认清空？',
    'admin.audit.export':     '导出 CSV',
    'err.disconnect_mid':     '⚠ 烧录中检测到板子拔出 · 请重新插入板子重试',
    'admin.login.locked':     '登录被锁定 · 请 15 分钟后重试',
    'admin.login.attempts_left':'密码错误 · 还剩 {n} 次机会',
    'guide.legacy_myfw':      '此 .myfw 是旧版（无 bearer）· 请管理员在管理页重新生成一个',
    'guide.wo_mismatch_link': '前往 {file} 的烧录页 →',
    'big.pass':           '通过',
    'big.fail':           '失败',
  },

  en: {
    "design.eyebrow": "Firmware & device setup",
    "design.prepare": "Prepare firmware",
    "design.prepare_hint": "Select the work order package for this batch.",
    "design.connect": "Connect your devices",
    "design.connect_hint": "Authorize each new frame to begin flashing.",
    "design.help": "Connection help",
    "design.footer": "Made for moments that matter.",

    "help.port.title": "Device port not detected? (No port selected)",
    "help.port.cable": "Check cable: use a USB cable that supports data transfer, not just charging.",
    "help.port.power": "Check power: confirm the device power indicator light is on.",
    "help.port.browser": "Browser support: use Google Chrome or Microsoft Edge with Web Serial enabled.",
    "help.port.download": "On WCH pages, use the blue button with the download icon.",
    "help.port.restart": "After installing the driver, restart your browser, reconnect the device, and authorize it again to select its port.",
    "help.port.platform": "Windows & Mac (Silicon Labs)",

    'app.title':          'Production center',
    'app.subtitle':       'Prepare your firmware. Connect a frame. Bring it to life.',
    'app.brand':          'Flasher',
    'header.workmode.dev':        'Develop',
    'header.workmode.prod':       'Production',

    'env.serial.ok':       'Web Serial API available',
    'env.serial.fail':     'Web Serial API not available (need Chrome 89+ or Edge 89+)',
    'env.crypto.ok':       'WebCrypto available',
    'env.crypto.fail':     'WebCrypto not available',
    'env.secure.ok':       'Secure context (https / localhost) ✓',
    'env.secure.fail':     'Requires https or localhost',

    'wo.id':              'Work order',
    'wo.short_code':      'Short code',
    'wo.firmware':        'Firmware',
    'wo.quota':           'Quota left',
    'wo.sn_rule':         'SN rule',
    'wo.sn_preview':      'Preview',
    'wo.license':         'License',
    'wo.license_status':  '{used} / {quota} · {remaining} left',
    'wo.license_exhausted': '⚠ License exhausted · flashing disabled',
    'wo.license_expires': 'Valid until {date}',
    'err.quota_exhausted': 'License quota exhausted ({used}/{quota}). Please request a new license from admin.',

    'action.connect':      'Authorize new device (first time only)',
    'action.clear':        'Clear list',
    'action.rescan':       'Rescan authorized devices',
    'mode.dev':           'DEV mode (mock backend)',
    'mode.prod':          'Prod mode · WO {id}',
    'hint.autoflash':     'Plugging in an already-authorized device auto-starts a flash · concurrent devices supported',

    'grid.empty':         'Please plug in a device',

    'slot.board':         'Board {idx}',
    'slot.chip':          'Chip',
    'slot.mac':           'MAC',
    'slot.sn':            'SN',
    'slot.stage':         'Stage',
    'slot.elapsed':       'Elapsed',
    'slot.dash':          '—',

    'state.working':      'Working',
    'state.done':         'Done ✓',
    'state.failed':       'Failed ✕',

    'stage.connect':      'Opening serial',
    'stage.detect':       'Detecting chip',
    'stage.readmac':      'Reading MAC',
    'stage.reserve_sn':   'Reserving SN',
    'stage.download':     'Downloading firmware',
    'stage.decrypt':      'Decrypting firmware',
    'stage.flashing':     'Flashing',
    'stage.reset_smoke':  'Reset + smoke test',
    'stage.consume':      'Reporting success',
    'stage.done':         'Done',
    'stage.failed':       'Failed: {reason}',

    'log.wo_status':      'Work order {id} · quota {remain} / {total}',
    'log.port_picked':    'Port selected, starting flash…',
    'log.fw_bytes':       'Firmware size {n} bytes',
    'log.smoke_ok':       'Smoke test passed · received {n} bytes',
    'log.smoke_partial':  'Smoke test patterns not matched · {n} bytes received · first 200:\n{sample}',
    'log.sn_ok':          'SN readback verified · {sn}',
    'log.sn_bad':         'SN readback verification failed: {reason}',
    'log.flash_fail':     'Flash failed · {msg}',
    'log.report_fail':    'Report also failed: {msg}',
    'log.baud_fallback':  'Baud escalation failed, falling back to {baud}: {msg}',

    'err.wrong_chip':     'Not a MyFrame board (detected {chip})',
    'err.chip_undetected':'MyFrame board not detected · hold BOOT while powering on and retry, or check USB',
    'err.smoke_timeout':  'Board boot check timed out: no boot signal received',
    'err.env_blocked':    'Environment check failed. Use Chrome 89+ or Edge 89+ via localhost / https.',
    'err.wo_load':        'Failed to load work order: {msg}',
    'err.boot_fail':      'Boot failed: {msg}',
    'err.op_fail':        'Operation failed: {msg}',

    'lang.switch':        '中',

    'admin.login.title':     'Administrator login',
    'admin.login.subtitle':  'Workorders · License · Firmware packages',
    'admin.login.password':  'Password',
    'admin.login.submit':    'Log in',
    'admin.login.hint':      'Demo password: ',
    'admin.login.failed':    'Login failed',
    'admin.panel.crumb':     'Admin · Production Center',
    'admin.panel.open_flasher': 'Open flasher ↗',
    'admin.panel.logout':    'Log out',
    'admin.build.title':     'Build workorder package',
    'admin.build.workorder': 'Workorder',
    'admin.build.firmware':  'Firmware',
    'admin.build.sn_rule':   'SN rule',
    'admin.build.quota':     'Burn quota',
    'admin.build.expires':   'Expires at',
    'admin.build.button':    'Build package',
    'admin.build.working':   'Building…',
    'admin.build.downloading': 'Downloading…',
    'admin.build.saved':     'saved to browser downloads',
    'admin.build.new_wo':    'New workorder',
    'admin.build.new_wo_button': 'Create',
    'admin.build.new_wo_missing': 'Enter a workorder id',
    'admin.build.creating':  'Creating…',
    'admin.build.download_myfw':  '⬇ Download .myfw',
    'admin.build.downloading_myfw': 'Downloading package…',
    'admin.build.download_failed': 'Download failed: {msg}',
    'admin.build.no_free_wo': '⚠ All workorders built · create a new one',
    'admin.fw.title':        'Firmware Sources',
    'admin.fw.hint':         'Admins can upload new .bin firmware versions. Uploaded versions live in server-side Blob and can be deleted; git built-in versions are read-only and not deletable through the UI.',
    'admin.fw.upload':       'Upload firmware',
    'admin.fw.pick':         'Choose .bin file',
    'admin.fw.list':         'Available',
    'admin.fw.empty':        'No firmware sources · upload one or deploy a built-in',
    'admin.fw.delete':       'Delete',
    'admin.fw.uploading':    'Uploading {name}…',
    'admin.fw.confirm_delete': 'Delete firmware {name}? This cannot be undone.',
    'admin.audit.title':     'Burn audit · SN ↔ MAC trace',
    'admin.audit.hint':      'Every successful burn is logged server-side. Given any MAC or SN, you can trace back to the workorder and timestamp.',
    'admin.audit.query':     'Query',
    'admin.audit.querying':  'Querying…',
    'admin.audit.col_time':  'Time (UTC)',
    'admin.audit.col_fw':    'Firmware',
    'admin.audit.col_smoke': 'Smoke',
    'admin.audit.col_error': 'Error',
    'admin.audit.empty':     'No burn records for this workorder yet',
    'admin.audit.failed':    'Query failed',
    'admin.log.title':       'Operation log',
    'admin.status.remaining': 'WO {wo} · License {lic} · firmware {fw} · burned {used}/{quota} · {remain} remaining',

    'log.filter_label':   'Filter',
    'log.filter_all':     'All boards',
    'log.clear':          'Clear log',

    'debug.on':           'DEBUG',
    'debug.toggle':       'Toggle debug',
    'fw.section':         'Workorder package',
    'fw.pick_myfw':       'Select .myfw file',
    'fw.myfw_hint':       'Pick the .myfw workorder file the admin generated (contains license + encrypted firmware)',
    'fw.selected':        'Selected: ',
    'fw.none':            '⚠ No .myfw uploaded · click "Choose .myfw file" first — flashing is blocked until then',
    'fw.status.reading':      '⏳ Reading {name} ({size} MB)…',
    'fw.status.parsing_hdr':  '⏳ Reading file header…',
    'fw.status.parsing_lic':  '⏳ Parsing license metadata…',
    'fw.status.syncing':      '⏳ Syncing workorder from server…',
    'fw.status.ready':        '✓ Ready · {name} ({size} MB)',
    'fw.status.not_myfa':     '✕ Not a valid .myfw · missing MYFA magic',
    'fw.status.wo_mismatch':  '✕ Workorder mismatch · URL={url} · file={file}',
    'fw.status.no_bearer':    '⚠ Legacy .myfw · ask admin to rebuild',
    'fw.status.load_fail':    '✕ Load failed: {msg}',
    'err.no_token':           'Missing ?token= · open this workorder from the admin console',
    'err.no_myfw':            'Please upload the .myfw workorder package first',
    'err.wrong_file_type':    'Uploaded file is not a .myfw package (missing MYFA magic); re-upload the correct workorder package',
    'guide.ready_to_flash':   '✓ Ready · plug a board to start flashing',
    'guide.next_open_flasher':'✓ Package built · next → open flasher ↗',
    'guide.empty_wo_hint':    'All workorders are built · create a new one in the field below',
    'action.clear_confirm':   '{n} board(s) still flashing · clear anyway?',
    'admin.audit.export':     'Export CSV',
    'err.disconnect_mid':     '⚠ Board disconnected during flash · re-plug and retry',
    'admin.login.locked':     'Locked out · try again in 15 min',
    'admin.login.attempts_left':'Wrong password · {n} attempt(s) left',
    'guide.legacy_myfw':      'This .myfw is legacy (no bearer) · ask the admin to rebuild it in the console',
    'guide.wo_mismatch_link': 'Open flasher for {file} →',
    'big.pass':           'PASS',
    'big.fail':           'FAIL',
  },
};

const SUPPORTED = ['zh', 'en'];
const STORAGE_KEY = 'myframe-flasher-lang';

// Language resolution — the default was Chinese, which surprised English-
// speaking first-time visitors. Rules now:
//   1. ?lang=xx URL param wins (explicit request)
//   2. localStorage carries the last manual choice across visits
//   3. Otherwise default to English regardless of navigator.language
// The "EN"/"中文" toggle in the header still switches at any time.
function detectLang() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('lang');
  if (fromUrl && SUPPORTED.includes(fromUrl)) return fromUrl;

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED.includes(stored)) return stored;

  return 'en';
}

let currentLang = detectLang();

// Interpolate {key} placeholders. Silently returns the key when a string is
// missing, so mistakes surface visibly during dev without breaking the UI.
export function t(key, params) {
  const table = STRINGS[currentLang] || STRINGS.zh;
  const template = table[key] ?? STRINGS.zh[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

export function getLang() { return currentLang; }

export function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  // Notify subscribers to re-render.
  window.dispatchEvent(new CustomEvent('mff:lang-change', { detail: { lang } }));
}

export function toggleLang() {
  setLang(currentLang === 'zh' ? 'en' : 'zh');
}

// Apply translations to elements with data-i18n / data-i18n-attr attributes.
// Call after every UI mutation, or wire a MutationObserver for auto-apply.
export function applyDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    // Format: "attr:key,attr:key" — e.g. "aria-label:action.connect"
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    }
  });
}

if (typeof window !== 'undefined') {
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
}
