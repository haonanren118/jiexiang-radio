/* jiexiang-radio 多语言（简体中文 / English）
 *
 * 设计要点：
 *  1. 词表以「语义 key」为准（nav.home、toast.deleted…），不用中文原文当 key——
 *     原文当 key 会在改文案时静默漏翻。
 *  2. 静态 HTML 用 data-i18n / data-i18n-ph / data-i18n-title / data-i18n-aria 标注，
 *     由 apply() 统一回填；动态文案在 app.js 里直接调 t()。
 *  3. 服务端返回的提示（sendError 的文案）与库里存的中文数据（内置源名、国别标签）
 *     保持中文不动，只在「显示层」用 msg() 翻译，避免污染已入库的数据。
 *  4. 语言存 localStorage['jxr-lang']；首次访问按 navigator.language 自动判断。
 */
(function (global) {
  'use strict';

  /* ---------------- 简体中文 ---------------- */
  var ZH = {
    'app.title': '杰翔电台 · jiexiang-radio',
    'brand.name': '杰翔电台',
    'brand.loading': '加载中…',

    'nav.home': '首页',
    'nav.mine': '我的电台',
    'nav.fav': '收藏',
    'nav.history': '足迹',

    'top.search': '搜索电台',
    'top.theme': '切换主题',
    'top.settings': '订阅源设置',
    'top.lang': '切换语言',
    'lang.switched': '界面语言：{0}',

    'title.themeDark': '切换到深色',
    'title.themeLight': '切换到浅色',
    'title.viewList': '切换列表视图',
    'title.viewGrid': '切换网格视图',

    'home.title': '聆听世界，音乐无界',
    'home.view': '切换视图',
    'hero.continue': '继续收听',
    'hero.continueSub': '上次听到「{0}」，点击接着听',
    'hero.random': '随机发现',
    'hero.randomSub': '从 {0} 个电台里随便挑一个开始',
    'hero.search': '搜索',
    'hero.searchSub': '找到喜欢的',
    'hero.history': '足迹',
    'hero.historySub': '查看访问记录',
    'hero.fav': '收藏',
    'hero.favSub': '收藏的电台',
    'card.mine': '我的电台',
    'card.recent': '最近收听',
    'link.allHistory': '全部足迹 →',
    'home.empty': '还没有电台。到「我的电台」页面添加订阅源，或直接手动添加单个电台。',
    'home.histEmpty': '还没有收听记录。',

    'src.section': '🔗 M3U 订阅源',
    'src.searchPh': '搜索订阅源…',
    'src.addNamePh': '源名称（可留空）',
    'src.addUrlPh': 'https://…/index.m3u',
    'src.addBtn': '添加源',
    'src.inlineEmpty': '还没有订阅源。用下面的输入框加一个 m3u / pls / xspf 列表试试。',
    'src.notLoaded': '尚未加载',
    'src.countN': '{0} 个',
    'src.countSuffix': '个源',
    'title.toggleSrc': '启用/停用',
    'title.reloadSrc': '重新拉取',
    'toast.srcOn': '已启用',
    'toast.srcOff': '已停用（仅本地标记）',
    'toast.srcLoading': '正在拉取…',
    'toast.srcRefreshed': '已刷新',

    'block.manual': '⊕ 手动添加 / 粘贴导入',
    'form.stNamePh': '电台名称',
    'form.stUrlPh': '流地址 https://….mp3/.m3u8',
    'form.addBtn': '添加',
    'form.pastePh': '或直接粘贴 M3U 内容（支持 #EXTINF 格式），然后点「解析导入」',
    'form.defaultStationName': '未命名电台',
    'btn.import': '解析导入',
    'btn.export': '⬇ 导出 M3U',
    'btn.clear': '清空',
    'btn.clearAll': '清空全部电台',

    'mine.searchPh': '搜索电台名称 / 分组…',
    'mine.empty': '还没有电台。上面添加一个订阅源，或手动添加单个电台。',
    'cat.all': '全部',
    'group.ungrouped': '未分组',
    'count.summary': '共 {0} 个电台 · {1} 个订阅源',
    'count.cat': '分类「{0}」 ',
    'count.filtered': '筛选出 {0} / 共 {1} 个电台',
    'count.stations': '共 {0} 个电台',
    'count.records': '共 {0} 条记录',

    'fav.title': '♡ 我的收藏',
    'fav.hint': '点电台卡片上的爱心即可收藏，收藏记录保存在本机浏览器。',
    'fav.empty': '还没有收藏任何电台。',

    'hist.title': '🕘 收听足迹',
    'hist.clear': '清空记录',
    'hist.empty': '还没有收听记录。',
    'hist.confirm': '确定清空收听记录吗？',
    'toast.histCleared': '已清空记录',
    'title.replay': '再听一次',
    'day.today': '今天',
    'day.yesterday': '昨天',

    'disc.title': '🌍 发现电台',
    'disc.hint': '数据来自 radio-browser（与 global-radio 同源），多个官方镜像自动容灾。',
    'disc.searchPh': '搜索全球电台名（留空按热度）',
    'disc.empty': '输入关键词或选择国家/地区后点搜索。',
    'disc.searching': '搜索中…',
    'disc.noResult': '没有结果，换个关键词试试。',
    'toast.searchFail': '搜索失败：{0}',

    'rb.title': '🛰 RadioDroid 全球电台',
    'rb.hint': '来自 RadioDroid（radio-browser.info）全量目录，持久内置。海量台不主动测通断（避免压垮 NAS），点击时按需验证连通性。',
    'rb.searchPh': '搜索全球电台名（留空按热度）',
    'rb.empty': '输入关键词或选择国家/地区后点搜索。',
    'rb.loading': '加载中…',
    'rb.loadMore': '加载更多 ↓',
    'toast.loadFail': '加载失败：{0}',

    'country.ph': '按国家/地区',
    'country.all': '按国家/地区（全部）',
    'country.cn': '中国 CN',
    'country.tw': '中国台湾 TW',
    'country.hk': '中国香港 HK',
    'country.jp': '日本 JP',
    'country.kr': '韩国 KR',
    'country.us': '美国 US',
    'country.gb': '英国 GB',
    'country.sg': '新加坡 SG',
    'btn.search': '搜索',

    'sources.title': '⚙ 订阅源管理',
    'sources.hint': '粘贴内容或填写 URL 都会自动识别格式，无需手动选择：',
    'chip.perLine': '纯文本每行一条',
    'sources.addTitle': '🔗 添加订阅源',
    'sources.addHint': '添加后会立刻拉取一次，解析出的电台自动进入「我的电台」。',
    'sources.manualTitle': '⊕ 手动添加单个电台 / 粘贴导入',
    'sources.current': '当前订阅源',
    'sources.empty': '还没有订阅源。',

    'player.idle': '未在播放',
    'player.hint': '选一个电台开始收听',
    'player.station': '电台',
    'player.playPause': '播放/暂停',
    'player.volume': '音量',
    'title.play': '播放',
    'title.fav': '收藏',
    'title.del': '删除',
    'tip.poolCount': '{0} 个播放源可用',

    'play.connecting': '连接中',
    'play.buffering': '缓冲中…',
    'play.playing': '正在播放',
    'play.connectingChain': '正在连接 · {0}{1}',
    'play.playingChain': '正在播放 · {0}',
    'play.srcIndex': '源 {0}/{1} · ',
    'play.cantPlayShort': '无法播放（试试换个源）',
    'play.cantPlay': '无法播放：{0}',
    'play.blocked': '播放被浏览器拦截：{0}',
    'play.tryingDroid': '当前源都连不上，正去 RadioDroid 找「{0}」的备用源…',
    'play.droidAdded': '已从 RadioDroid 补充 {0} 个备用源，继续尝试',
    'chain.hlsProxy': 'HLS 代理',
    'chain.nativeHls': '原生 HLS',
    'chain.directProxy': '直连代理',

    'srcmenu.title': '播放源（绿=可放 · 红=死链 · 蓝=RadioDroid 备用源，点播时按需验证）',
    'srcmenu.allBackup': '此台全部为 RadioDroid 备用源，未提前测通断（避免上万条流地址压垮 NAS）。点播时会自动验证，连不上顺延下一个。',
    'srcmenu.willUse': '▶ 将使用',
    'srcmenu.probing': '正在测速 {0} 个源…',
    'srcmenu.reprobe': '重新测速',
    'stat.dead': '死链',
    'stat.playable': '可放',
    'stat.backup': '备用·点播验证',
    'stat.untested': '未测',
    'src.primary': '主源',
    'src.generic': '源',

    'toast.continue': '继续收听：{0}',
    'toast.random': '随机发现：{0}',
    'toast.favOn': '已收藏',
    'toast.favOff': '已取消收藏',
    'toast.deleted': '已删除',
    'toast.added': '已添加：{0}',
    'toast.sourceAdded': '已添加源',
    'toast.noStation': '还没有电台，先加个订阅源',
    'toast.badUrl': '地址必须以 http(s):// 开头',
    'toast.noPasteBox': '找不到粘贴框',
    'toast.pasteFirst': '先粘贴 M3U 内容',
    'toast.noUrlParsed': '没解析出有效地址',
    'toast.imported': '导入完成：成功 {0} 个',
    'toast.importedSkip': '导入完成：成功 {0} 个，跳过 {1} 个（重复或无效）',
    'toast.exported': '已导出 {0} 个电台',
    'toast.exportEmpty': '没有电台可导出',
    'toast.alreadyEmpty': '本来就是空的',
    'toast.clearConfirm': '确定清空全部 {0} 个电台吗？订阅源会保留。',
    'toast.cleared': '已清空',
    'toast.backendFail': '后端连接失败：{0}',
    'toast.probeFail': '测速失败：{0}'
  };

  /* ---------------- English ---------------- */
  var EN = {
    'app.title': 'Jiexiang Radio · jiexiang-radio',
    'brand.name': 'Jiexiang Radio',
    'brand.loading': 'Loading…',

    'nav.home': 'Home',
    'nav.mine': 'My Stations',
    'nav.fav': 'Favorites',
    'nav.history': 'History',

    'top.search': 'Search stations',
    'top.theme': 'Toggle theme',
    'top.settings': 'Source settings',
    'top.lang': 'Switch language',
    'lang.switched': 'Language: {0}',

    'title.themeDark': 'Switch to dark',
    'title.themeLight': 'Switch to light',
    'title.viewList': 'Switch to list view',
    'title.viewGrid': 'Switch to grid view',

    'home.title': 'The world on air',
    'home.view': 'Toggle view',
    'hero.continue': 'Continue listening',
    'hero.continueSub': 'Last played “{0}” — tap to resume',
    'hero.random': 'Surprise me',
    'hero.randomSub': 'Pick one from {0} stations',
    'hero.search': 'Search',
    'hero.searchSub': 'Find your favorites',
    'hero.history': 'History',
    'hero.historySub': 'See what you played',
    'hero.fav': 'Favorites',
    'hero.favSub': 'Your saved stations',
    'card.mine': 'My Stations',
    'card.recent': 'Recently played',
    'link.allHistory': 'All history →',
    'home.empty': 'No stations yet. Add a source on the “My Stations” page, or add one manually.',
    'home.histEmpty': 'Nothing played yet.',

    'src.section': '🔗 M3U sources',
    'src.searchPh': 'Search sources…',
    'src.addNamePh': 'Source name (optional)',
    'src.addUrlPh': 'https://…/index.m3u',
    'src.addBtn': 'Add source',
    'src.inlineEmpty': 'No sources yet. Add an m3u / pls / xspf list with the box below.',
    'src.notLoaded': 'Not loaded',
    'src.countN': '{0}',
    'src.countSuffix': 'sources',
    'title.toggleSrc': 'Enable / disable',
    'title.reloadSrc': 'Fetch again',
    'toast.srcOn': 'Enabled',
    'toast.srcOff': 'Disabled (local flag only)',
    'toast.srcLoading': 'Fetching…',
    'toast.srcRefreshed': 'Refreshed',

    'block.manual': '⊕ Add manually / paste import',
    'form.stNamePh': 'Station name',
    'form.stUrlPh': 'Stream URL https://….mp3/.m3u8',
    'form.addBtn': 'Add',
    'form.pastePh': 'Or paste M3U content (supports #EXTINF), then click “Parse & import”',
    'form.defaultStationName': 'Unnamed station',
    'btn.import': 'Parse & import',
    'btn.export': '⬇ Export M3U',
    'btn.clear': 'Clear',
    'btn.clearAll': 'Clear all stations',

    'mine.searchPh': 'Search station name / group…',
    'mine.empty': 'No stations yet. Add a source above, or add one manually.',
    'cat.all': 'All',
    'group.ungrouped': 'Ungrouped',
    'count.summary': '{0} stations · {1} sources',
    'count.cat': 'Category “{0}” ',
    'count.filtered': '{0} of {1} stations',
    'count.stations': '{0} stations',
    'count.records': '{0} records',

    'fav.title': '♡ My Favorites',
    'fav.hint': 'Tap the heart on a station card to save it. Favorites live in this browser.',
    'fav.empty': 'No favorites yet.',

    'hist.title': '🕘 Listening History',
    'hist.clear': 'Clear history',
    'hist.empty': 'Nothing played yet.',
    'hist.confirm': 'Clear your listening history?',
    'toast.histCleared': 'History cleared',
    'title.replay': 'Play again',
    'day.today': 'Today',
    'day.yesterday': 'Yesterday',

    'disc.title': '🌍 Discover',
    'disc.hint': 'Data from radio-browser (same source as global-radio), with automatic mirror failover.',
    'disc.searchPh': 'Search stations worldwide (blank = popular)',
    'disc.empty': 'Type a keyword or pick a region, then search.',
    'disc.searching': 'Searching…',
    'disc.noResult': 'No results — try another keyword.',
    'toast.searchFail': 'Search failed: {0}',

    'rb.title': '🛰 RadioDroid Global Stations',
    'rb.hint': 'The full RadioDroid (radio-browser.info) catalog, stored locally. Tens of thousands of streams are not probed upfront (to keep the NAS healthy) — connectivity is verified on demand when you play.',
    'rb.searchPh': 'Search stations worldwide (blank = popular)',
    'rb.empty': 'Type a keyword or pick a region, then search.',
    'rb.loading': 'Loading…',
    'rb.loadMore': 'Load more ↓',
    'toast.loadFail': 'Load failed: {0}',

    'country.ph': 'Country / Region',
    'country.all': 'Country / Region (all)',
    'country.cn': 'China CN',
    'country.tw': 'Taiwan, China TW',
    'country.hk': 'Hong Kong, China HK',
    'country.jp': 'Japan JP',
    'country.kr': 'South Korea KR',
    'country.us': 'United States US',
    'country.gb': 'United Kingdom GB',
    'country.sg': 'Singapore SG',
    'btn.search': 'Search',

    'sources.title': '⚙ Source Manager',
    'sources.hint': 'Pasted content and URLs are detected automatically — no format picking needed:',
    'chip.perLine': 'Plain text, one per line',
    'sources.addTitle': '🔗 Add a source',
    'sources.addHint': 'It is fetched right away; parsed stations land in “My Stations”.',
    'sources.manualTitle': '⊕ Add one station / paste import',
    'sources.current': 'Current sources',
    'sources.empty': 'No sources yet.',

    'player.idle': 'Nothing playing',
    'player.hint': 'Pick a station to start',
    'player.station': 'Station',
    'player.playPause': 'Play / pause',
    'player.volume': 'Volume',
    'title.play': 'Play',
    'title.fav': 'Favorite',
    'title.del': 'Delete',
    'tip.poolCount': '{0} playable sources',

    'play.connecting': 'Connecting',
    'play.buffering': 'Buffering…',
    'play.playing': 'Playing',
    'play.connectingChain': 'Connecting · {0}{1}',
    'play.playingChain': 'Playing · {0}',
    'play.srcIndex': 'Source {0}/{1} · ',
    'play.cantPlayShort': 'Cannot play (try another source)',
    'play.cantPlay': 'Cannot play: {0}',
    'play.blocked': 'Playback blocked by the browser: {0}',
    'play.tryingDroid': 'No source is reachable — searching RadioDroid for a "{0}" backup…',
    'play.droidAdded': 'Added {0} RadioDroid backup source(s), still trying',
    'chain.hlsProxy': 'HLS proxy',
    'chain.nativeHls': 'Native HLS',
    'chain.directProxy': 'Direct proxy',

    'srcmenu.title': 'Playback sources (green = OK · red = dead · blue = RadioDroid backup, verified on demand)',
    'srcmenu.allBackup': 'Every source here is a RadioDroid backup: not probed upfront, so tens of thousands of stream URLs cannot overwhelm the NAS. Playback verifies on demand and falls through to the next one.',
    'srcmenu.willUse': '▶ will use',
    'srcmenu.probing': 'Probing {0} source(s)…',
    'srcmenu.reprobe': 'Re-probe',
    'stat.dead': 'Dead',
    'stat.playable': 'OK',
    'stat.backup': 'Backup · on demand',
    'stat.untested': 'Untested',
    'src.primary': 'Primary',
    'src.generic': 'Source',

    'toast.continue': 'Resuming: {0}',
    'toast.random': 'Random pick: {0}',
    'toast.favOn': 'Added to favorites',
    'toast.favOff': 'Removed from favorites',
    'toast.deleted': 'Deleted',
    'toast.added': 'Added: {0}',
    'toast.sourceAdded': 'Source added',
    'toast.noStation': 'No stations yet — add a source first',
    'toast.badUrl': 'URL must start with http(s)://',
    'toast.noPasteBox': 'Paste box not found',
    'toast.pasteFirst': 'Paste some M3U content first',
    'toast.noUrlParsed': 'No valid URL found',
    'toast.imported': 'Imported: {0}',
    'toast.importedSkip': 'Imported: {0}, skipped {1} (duplicate or invalid)',
    'toast.exported': 'Exported {0} stations',
    'toast.exportEmpty': 'Nothing to export',
    'toast.alreadyEmpty': 'It is already empty',
    'toast.clearConfirm': 'Clear all {0} stations? Your sources will be kept.',
    'toast.cleared': 'Cleared',
    'toast.backendFail': 'Backend unreachable: {0}',
    'toast.probeFail': 'Probe failed: {0}'
  };

  /* ---------------- 显示层翻译：库里的中文数据 / 服务端中文提示 ---------------- */
  var EN_DATA = {
    '国内电台（内置）': 'China stations (built-in)',
    'hacks.tools FM 电台（每日同步）': 'hacks.tools FM (daily sync)',
    '蜻蜓FM 电台（内置）': 'Qingting FM (built-in)',
    '喜马拉雅电台（内置）': 'Ximalaya (built-in)',
    '综合电台（内置）': 'Mixed stations (built-in)',
    '听FM 四川电台（内置）': 'TingFM Sichuan (built-in)',
    'RadioDroid 电台（内置）': 'RadioDroid (built-in)',
    '手动添加': 'Manual',
    '粘贴导入': 'Paste import',
    '主源': 'Primary source',
    '同名源': 'Same-name source',
    'fallback': 'Fallback',
    '未命名电台': 'Unnamed station',
    '中国台湾': 'Taiwan, China',
    '中国香港': 'Hong Kong, China',
    '中国澳门': 'Macao, China',
    '中国': 'China',
    'url 无效': 'Invalid URL',
    '该源已存在': 'This source already exists',
    '该电台已存在': 'This station already exists',
    '该地址不在本台源池中': 'That URL is not in this station\'s source pool'
  };

  var DICT = { 'zh-CN': ZH, 'en': EN };
  var STORE_KEY = 'jxr-lang';
  var current = 'zh-CN';
  var listeners = [];

  /** 把任意语言标识归一化成支持的两个之一 */
  function normalize(code) {
    if (!code) return 'zh-CN';
    return String(code).toLowerCase().indexOf('en') === 0 ? 'en' : 'zh-CN';
  }

  function initial() {
    // 1) URL 上显式指定优先：?lang=en / ?lang=zh-CN（方便分享指定语言的链接、也方便自动化验证）
    var m = /[?&]lang=([^&#]+)/.exec(global.location ? global.location.search : '');
    if (m) {
      var picked = normalize(decodeURIComponent(m[1]));
      try { localStorage.setItem(STORE_KEY, picked); } catch (e) { }
      return picked;
    }
    // 2) 用户上次选过的
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { }
    if (saved) return normalize(saved);
    // 3) 首次访问：跟随浏览器
    var nav = (global.navigator && (global.navigator.language || global.navigator.userLanguage)) || '';
    return normalize(nav || 'zh-CN');
  }

  /** 取词。{0}/{1}… 依次用后续参数替换 */
  function t(key) {
    var table = DICT[current] || ZH;
    var s = table[key];
    if (s == null) s = ZH[key];
    if (s == null) return key;          // 缺词直接暴露 key，方便发现漏翻
    if (arguments.length > 1) {
      var args = arguments;
      s = String(s).replace(/\{(\d+)\}/g, function (m, d) {
        var v = args[parseInt(d, 10) + 1];
        return v == null ? '' : String(v);
      });
    }
    return s;
  }

  /** 显示层翻译：库里存的中文数据、服务端返回的中文提示。
   *  中文界面原样返回；英文界面查表，查不到就原样返回（英文内容本来就该保持）。 */
  function msg(text) {
    if (text == null) return '';
    var s = String(text);
    if (current === 'zh-CN' || !s) return s;
    if (Object.prototype.hasOwnProperty.call(EN_DATA, s)) return EN_DATA[s];
    return s;
  }

  function each(root, sel, fn) {
    var nodes = (root || document).querySelectorAll(sel);
    Array.prototype.forEach.call(nodes, fn);
  }

  /** 回填静态 HTML 上的文案标注 */
  function apply(root) {
    each(root, '[data-i18n]', function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    each(root, '[data-i18n-ph]', function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    each(root, '[data-i18n-title]', function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
    each(root, '[data-i18n-aria]', function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  }

  function get() { return current; }

  /** 切换语言：落盘 + 同步 <html lang> + 回填静态文案 + 通知订阅者重渲染 */
  function set(code) {
    var next = normalize(code);
    var changed = next !== current;
    current = next;
    try { localStorage.setItem(STORE_KEY, current); } catch (e) { }
    document.documentElement.setAttribute('lang', current === 'en' ? 'en' : 'zh-CN');
    document.title = t('app.title');
    apply(document);
    listeners.forEach(function (fn) { try { fn(current, changed); } catch (e) { } });
    return current;
  }

  function onChange(fn) { listeners.push(fn); }

  /** 启动：读持久化/浏览器语言并立刻套用，避免中文界面一闪而过 */
  function init() { return set(initial()); }

  global.I18N = {
    t: t, msg: msg, apply: apply, set: set, get: get,
    init: init, onChange: onChange,
    normalize: normalize, langs: ['zh-CN', 'en']
  };
  global.t = t;   // app.js 里直接写 t('key') 更方便；显示层翻译走 I18N.msg()
})(window);
