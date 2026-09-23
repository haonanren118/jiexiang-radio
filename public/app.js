/* jiexiang-radio 前端：所有播放都走本站代理，不在浏览器里直连外部源 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  /** 一次取一组元素。同一类控件可能在多个页面各有一份（「我的电台」和「订阅源管理」），
   *  所以统一按 data-role 绑定，不要再写死 id。 */
  function qa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  var state = { sources: [], stations: [], favorites: [], history: [] };
  var filterText = { mine: '', disc: '' };
  var filterCat = { mine: '' };
  var tab = 'home';
  var discLoaded = false;
  var viewMode = localStorage.getItem('jxr-view') || 'grid';
  var themeMode = localStorage.getItem('jxr-theme') || 'auto';

  /* ---------------------------------------------------------------- *
   * 多语言
   * t(key)   —— 界面文案（词表在 i18n.js）
   * td(v)    —— 显示层翻译：内置源名 / 国别 / 占位名等「库里存的中文数据」，
   *             只在渲染时换语言，不回写数据库，避免污染已入库的数据
   * ---------------------------------------------------------------- */
  var I18N = window.I18N;
  var t = window.t;
  function td(v) { return I18N.msg(v); }

  /* ---------------------------------------------------------------- *
   * 工具
   * ---------------------------------------------------------------- */
  function enc(s) { return encodeURIComponent(s); }

  /** 绝对地址 -> 服务端 HLS 重写代理路径 */
  function hlsSrc(url, ref) {
    var p = '/hls/' + enc(url);
    if (ref) p += (p.indexOf('?') >= 0 ? '&' : '?') + 'ref=' + enc(ref);
    return p;
  }
  /** 绝对地址 -> 服务端通用流代理 */
  function proxySrc(url, ref) {
    var p = '/proxy?url=' + enc(url);
    if (ref) p += '&ref=' + enc(ref);
    return p;
  }
  function isHls(url) { return /\.m3u8(\?|$)/i.test(url) || /^https?:\/\/.*\bm3u8\b/i.test(url); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 后端存的是 UTC ISO 字符串，这里转成本机时区显示（否则会看着像"昨天没更新"） */
  function fmtTs(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var toastTimer = null;
  function toast(msg, bad) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (bad ? ' bad' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; el.hidden = true; }, bad ? 4000 : 2200);
  }

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }
  function del(path) { return api(path, { method: 'DELETE' }); }

  /* ---------------------------------------------------------------- *
   * 收藏 / 足迹（本地持久化）
   * ---------------------------------------------------------------- */
  function loadLocal() {
    try { state.favorites = JSON.parse(localStorage.getItem('jxr-fav') || '[]'); } catch (e) { state.favorites = []; }
    try { state.history = JSON.parse(localStorage.getItem('jxr-hist') || '[]'); } catch (e) { state.history = []; }
  }
  function saveFav() { localStorage.setItem('jxr-fav', JSON.stringify(state.favorites)); }
  function isFav(id) { return state.favorites.indexOf(id) >= 0; }
  function toggleFav(id) {
    var i = state.favorites.indexOf(id);
    if (i >= 0) state.favorites.splice(i, 1); else state.favorites.push(id);
    saveFav();
  }
  function pushHistory(st) {
    state.history = state.history.filter(function (x) { return x.id !== st.id; });
    state.history.unshift({ id: st.id, name: st.name, url: st.url, logo: st.logo || '',
      referer: st.referer || '', sourceName: st.sourceName || '', country: st.country || '',
      group: st.group || '', ts: Date.now() });
    if (state.history.length > 200) state.history.length = 200;
    localStorage.setItem('jxr-hist', JSON.stringify(state.history));
  }
  function dayKey(ts) {
    var d = new Date(ts), n = new Date();
    var k = function (x) { return x.getFullYear() + '-' + (x.getMonth() + 1) + '-' + x.getDate(); };
    if (k(d) === k(n)) return t('day.today');
    n.setDate(n.getDate() - 1);
    if (k(d) === k(n)) return t('day.yesterday');
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------------------------------------------------------------- *
   * 电台索引 / 快照水合
   *
   * 收藏与足迹（localStorage）里存的是**快照**：只有 id/name/url/logo…，
   * 没有 sources 源池，也没有 ok / noProbe 这些测速字段。
   * 直接拿快照去播，选源菜单就只剩一条「主源 · 未测」，排序无从谈起，
   * 主源播不通时也没有任何备用源可顺延（RadioDroid 兜底一并失效）。
   * 所以播放 / 开菜单前，一律按 id 换成服务器最新的电台对象。
   * ---------------------------------------------------------------- */
  var stIndex = null;
  var stIndexSrc = null;   // 记住索引对应的数组引用，state.stations 一换就自动失效
  function stationIndex() {
    if (!stIndex || stIndexSrc !== state.stations) {
      stIndex = {};
      stIndexSrc = state.stations;
      state.stations.forEach(function (s) { if (s && s.id != null) stIndex[s.id] = s; });
    }
    return stIndex;
  }
  function hydrate(st) {
    if (!st) return st;
    var fresh = (st.id != null) ? stationIndex()[st.id] : null;
    var use = (fresh && fresh.url) ? fresh : st;
    // 服务器对象没有、但快照里有的本地字段（足迹分组、来源名、台标）补齐
    if (st.group && !use.group) use.group = st.group;
    if (st.sourceName && !use.sourceName) use.sourceName = st.sourceName;
    if (st.logo && !use.logo) use.logo = st.logo;
    if (st.referer && !use.referer) use.referer = st.referer;
    if (typeof use.noProbe !== 'boolean') use.noProbe = false;
    if (!use.sources || !use.sources.length) {
      if (st.sources && st.sources.length) use.sources = st.sources;
      else use.sources = [{
        url: use.url, type: isHls(use.url) ? 'hls' : 'mp3',
        from: use.sourceName || '主源', noProbe: false,
        ok: null, latency: null, dead: false, checkedAt: 0
      }];
    }
    use.sources.forEach(function (s) {
      if (typeof s.noProbe !== 'boolean') s.noProbe = false;
      if (typeof s.dead !== 'boolean') s.dead = false;
      if (s.ok !== true && s.ok !== false) s.ok = null;
      if (typeof s.latency !== 'number') s.latency = null;
    });
    use.poolCount = use.sources.length;
    return use;
  }

  /* ---------------------------------------------------------------- *
   * 图标
   * ---------------------------------------------------------------- */
  var I = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/>',
    radio: '<rect x="3" y="8.5" width="18" height="12" rx="2.5"/><path d="M8 8.5 16.5 3.5"/><circle cx="8.5" cy="14.5" r="2"/><path d="M14 12.5h4M14 16.5h4"/>',
    heart: '<path d="M12 20s-7.2-4.4-7.2-9.4A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.2 3c0 5-7.2 9.4-7.2 9.4z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.4 2"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.6-3.6"/>',
    shuffle: '<path d="M16 3.5h4.5V8"/><path d="M20.5 3.5 4 20"/><path d="M16 20.5h4.5V16"/><path d="M4 3.5l5.2 5.2"/><path d="M14.6 15.4l5.9 5.1"/>',
    list: '<path d="M8 6.5h12M8 12h12M8 17.5h12"/><circle cx="4" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>',
    grids: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M19.1 4.9l-1.6 1.6M6.5 17.5l-1.6 1.6"/>',
    moon: '<path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9H15"/>',
    link: '<path d="M10 13.8a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7L11.5 6.6"/><path d="M14 10.2a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    download: '<path d="M12 3.5v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
    trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>',
    play: '<path d="M7 4.8v14.4L19.5 12z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>',
    pauseS: '<rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>',
    wifi: '<path d="M2.5 8.5a15 15 0 0 1 19 0"/><path d="M6 12.2a10 10 0 0 1 12 0"/><path d="M9.3 15.9a5 5 0 0 1 5.4 0"/><circle cx="12" cy="19.3" r="1.2" fill="currentColor" stroke="none"/>'
  };
  function ico(name, cls) {
    return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (I[name] || '') + '</svg>';
  }

  /* ---------------------------------------------------------------- *
   * 主题 / 视图
   * ---------------------------------------------------------------- */
  function applyTheme() {
    document.documentElement.dataset.theme = themeMode;
    $('btn-theme').innerHTML = ico(themeMode === 'dark' ? 'sun' : 'moon');
    $('btn-theme').title = themeMode === 'dark' ? t('title.themeLight') : t('title.themeDark');
  }
  function applyView() {
    document.body.dataset.view = viewMode;
    $('btn-view').innerHTML = ico(viewMode === 'grid' ? 'list' : 'grids');
    $('btn-view').title = viewMode === 'grid' ? t('title.viewList') : t('title.viewGrid');
  }

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */
  function renderStatus() {
    $('stat').textContent = t('count.summary', state.stations.length, state.sources.length);
  }

  function go(t) {
    tab = t;
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
      b.classList.toggle('active', b.dataset.tab === t);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) {
      p.classList.toggle('active', p.id === 'pane-' + t);
    });
    if (t === 'home') $('home-title').textContent = heroTitle();
    if (t === 'mine') renderMine();
    if (t === 'fav') renderFav();
    if (t === 'history') renderHistory();
  }

  function heroTitle() {
    var n = state.history.length ? state.history[0] : null;
    return n ? t('hero.continue') + ' · ' + n.name : t('home.title');
  }

  function renderHero() {
    $('home-title').textContent = heroTitle();
    var need = !!state.history.length;
    var hero = $('hero-card');
    /* 以前这里是 hero.disabled = !need —— 结果没有任何收听记录时，
     * 首页那张最大的卡片是禁用的，用户点了完全没反应（像坏了一样）。
     * 改成永远可点：有记录就续播，没记录就随机播一个。 */
    hero.disabled = false;
    hero.classList.remove('disabled');
    hero.dataset.tab = need ? 'continue' : 'random';
    $('hero-label').textContent = need ? t('hero.continue') : t('hero.random');
    $('hero-sub').textContent = need
      ? t('hero.continueSub', state.history[0].name)
      : t('hero.randomSub', state.stations.length);
  }

  /** 首页大卡片：有收听记录就续播上一条 */
  function continueLast() {
    var last = state.history[0];
    if (!last) return randomPlay();
    toast(t('toast.continue', last.name));
    play(last);
  }

  function trackOf(st) {
    var i = state.history.findIndex(function (x) { return x.id === st.id; });
    return i >= 0 ? i + 1 : 0;
  }

  /* ---------------------------------------------------------------- *
   * 台标：优先用源里带的 tvg-logo；没有或加载失败才用本地生成的头像兜底
   *
   * 重要：图片一律经 /img 让服务端去取，浏览器不直连外部图床。
   * 原因——内置列表的 tvg-logo 原本指向 live.fanmingming.com，该域名在
   * 国内多数宽带上不可达（TCP 能连、数据不来，最后超时），浏览器直连
   * 必然全部失败，用户看到的就是「台标全没了」。
   * ---------------------------------------------------------------- */
  var logoFailed = {};

  /** 站内图片地址：本地烘焙台标（/logo/...）与服务端解析的台标（/favicon/...）
   *  直接返回，其余走 /img 代理 */
  function imgSrc(url, sid) {
    if (!url) return '';
    if (url.charAt(0) === '/') return url;
    // 带上电台 id：万一上游台标已失效，服务端会顺手换一张真台标返回，
    // 换不到则回 404，由 onerror 降级成首字头像（不再是千篇一律的占位图）
    return '/img?url=' + enc(url) + (sid ? '&st=' + enc(sid) : '');
  }

  /** 台标兜底。
   *  以前这里会按台名去猜 fastly.jsdelivr.net 上的 fanmingming 图 —— 但该域名
   *  在国内宽带上不可达，浏览器每次都要等一次必然失败的请求才退回头像，白闪一下。
   *  现在补图统一由服务端做（presets/logo-index.json：喜马拉雅官方封面 +
   *  fanmingming 归一化清单），服务端没给出 logo 就是这个台真的没有封面，
   *  直接返回空串让调用方用首字头像，不再发无谓请求。 */
  function guessLogo() {
    return '';
  }

  function hashCode(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  /** 生成台标节点：<img> 优先，加载失败/无图则降级为本地头像 */
  function logoNode(st, cls) {
    cls = cls || 'slogo';
    var name = st && st.name ? st.name : '';
    // 注意：必须是 «源里带的 logo» 优先，猜图只在完全没有 logo 时才用，
    // 并且猜图不能因为一次失败就把真 logo 也顶掉
    var raw = (st && st.logo) || guessLogo(name);

    if (raw) {
      var img = document.createElement('img');
      img.className = cls;
      // 服务端 /img 已内置占位图，正常不会触发 onerror；这里只是最后保险
      img.src = imgSrc(raw, st && st.id);
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      var tries = 0;
      img.onerror = function () {
        // 图片挂了：有原生 logo 就保留占位不污染缓存，直接用本地头像顶上
        if (!(st && st.logo)) logoFailed[name] = true;
        // 站内台标（/favicon/...）是「按需解析 + 限并发」的：第一波超出并发会被
        // 婉拒成 404，这里等 8 秒重试一次（那时多半已解析完并进了磁盘缓存），
        // 第二次仍失败才降级为首字头像。
        if (String(raw).charAt(0) === '/' && tries < 1) {
          tries++;
          var retryUrl = raw + (raw.indexOf('?') >= 0 ? '&' : '?') + 'r=' + Date.now();
          setTimeout(function () { if (img.parentNode) img.src = retryUrl; }, 8000);
          return;
        }
        img.replaceWith(avatarNode(name, cls));
      };
      return img;
    }
    return avatarNode(name, cls);
  }

  function avatarNode(name, cls) {
    var s = String(name || '');
    var ch = (s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').charAt(0) || '📻').toUpperCase();
    var h = hashCode(s || '?') % 360;
    var el = document.createElement('span');
    el.className = 'av ' + (cls || 'slogo');
    el.style.setProperty('--h', h);
    el.textContent = ch;
    return el;
  }

  function stationCard(st, opts) {
    opts = opts || {};
    var fav = isFav(st.id);
    var el = document.createElement('div');
    el.className = 'card station' + (current && current.id === st.id ? ' playing' : '');
    var sub = [];
    if (st.group) sub.push(st.group);
    if (st.country) sub.push(td(st.country));
    if (st.countryCode && !st.country) sub.push(st.countryCode);
    if (st.sourceName && opts.showSource !== false) sub.push(td(st.sourceName));
    if (st.bitrate) sub.push((st.codec || '') + ' ' + st.bitrate + 'k');
    var head = document.createElement('div');
    head.className = 'shead';
    head.appendChild(logoNode(st, 'slogo'));
    head.insertAdjacentHTML('beforeend',
      '<div class="stitle"><strong>' + esc(st.name) + '</strong>' +
      (st.poolCount > 1 ? '<em class="srcbadge" title="' + esc(t('tip.poolCount', st.poolCount)) + '">🔗' + st.poolCount + '</em>' : '') +
      '<span>' + esc(sub.join(' · ')) + '</span></div>');
    el.appendChild(head);
    el.insertAdjacentHTML('beforeend',
      '<div class="sactions">' +
      (opts.noFav ? '' : '<button data-act="fav" class="icon-btn" title="' + esc(t('title.fav')) + '">' + ico('heart') + '</button>') +
      (opts.canDelete ? '<button data-act="rm" class="icon-btn" title="' + esc(t('title.del')) + '">' + ico('trash') + '</button>' : '') +
      '<button data-act="play" class="play-btn" title="' + esc(t('title.play')) + '">' + ico('play') + '</button>' +
      '</div>');
    if (fav) el.querySelector('[data-act="fav"]').classList.add('on');
    el.querySelector('[data-act="play"]').onclick = function (e) { e.stopPropagation(); play(st); };
    head.onclick = function () { play(st); };
    var fb = el.querySelector('[data-act="fav"]');
    if (fb) fb.onclick = function (e) {
      e.stopPropagation();
      toggleFav(st.id);
      toast(isFav(st.id) ? t('toast.favOn') : t('toast.favOff'));
      renderAll();
    };
    var rb = el.querySelector('[data-act="rm"]');
    if (rb) rb.onclick = function (e) {
      e.stopPropagation();
      del('/api/stations?id=' + enc(st.id)).then(function (j) {
        state.stations = j.stations; renderAll(); toast(t('toast.deleted'));
      });
    };
    return el;
  }

  function matches(st, kw) {
    if (!kw) return true;
    var k = kw.toLowerCase();
    return (st.name || '').toLowerCase().indexOf(k) >= 0 ||
      (st.group || '').toLowerCase().indexOf(k) >= 0 ||
      (st.country || '').toLowerCase().indexOf(k) >= 0;
  }

  function renderMine() {
    var kw = filterText.mine;
    var cat = filterCat.mine;
    var ungrouped = t('group.ungrouped');
    var arr = state.stations.filter(function (s) {
      if (cat && (s.group || ungrouped) !== cat) return false;
      return matches(s, kw);
    });
    var grid = $('mine-list'), list = $('list-mine');
    grid.innerHTML = ''; list.innerHTML = '';
    arr.forEach(function (st) {
      grid.appendChild(stationCard(st, { canDelete: true }));
      list.appendChild(stationCard(st, { canDelete: true }));
    });
    $('mine-empty').hidden = arr.length > 0 || state.stations.length > 0;
    $('mine-count').textContent = (cat ? t('count.cat', cat) : '')
      + (kw
        ? t('count.filtered', arr.length, state.stations.length)
        : t('count.summary', state.stations.length, state.sources.length));
    buildCatChips();
  }

  /** 按 group 聚合出分类 chip 栏，点击即筛选「我的电台」 */
  function buildCatChips() {
    var bar = $('cat-chips');
    if (!bar) return;
    var ungrouped = t('group.ungrouped');
    var counts = {};
    state.stations.forEach(function (s) {
      var g = s.group || ungrouped;
      counts[g] = (counts[g] || 0) + 1;
    });
    var cats = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    bar.innerHTML = '';
    bar.appendChild(catChip(t('cat.all'), state.stations.length, ''));
    cats.forEach(function (c) { bar.appendChild(catChip(c, counts[c], c)); });
  }

  function catChip(label, n, val) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cat-chip' + (filterCat.mine === val ? ' on' : '');
    b.textContent = label + ' ' + n;
    b.addEventListener('click', function () { filterCat.mine = val; renderMine(); });
    return b;
  }

  function renderFav() {
    var set = {};
    state.stations.forEach(function (s) { set[s.id] = s; });
    var arr = state.favorites.map(function (id) { return set[id]; }).filter(Boolean);
    $('fav-count').textContent = t('count.stations', arr.length);
    $('fav-empty').hidden = arr.length > 0;
    var grid = $('fav-list'), list = $('list-fav');
    grid.innerHTML = ''; list.innerHTML = '';
    arr.forEach(function (st) {
      grid.appendChild(stationCard(st, { canDelete: true }));
      list.appendChild(stationCard(st, { canDelete: true }));
    });
  }

  function renderHistory() {
    var box = $('hist-list');
    box.innerHTML = '';
    $('hist-count').textContent = t('count.records', state.history.length);
    var clearBtn = $('btn-clear-hist');
    if (clearBtn) clearBtn.disabled = state.history.length === 0;
    $('hist-empty').hidden = state.history.length > 0;
    var lastDay = null;
    state.history.forEach(function (h) {
      var d = dayKey(h.ts);
      if (d !== lastDay) {
        lastDay = d;
        var dl = document.createElement('div');
        dl.className = 'daylabel';
        dl.textContent = d;
        box.appendChild(dl);
      }
      /* 注意：这里千万别写 var t —— 会遮蔽全局的翻译函数 t()，
       * 导致同一作用域里的 t('title.replay') 抛 "t is not a function"。 */
      var dt = new Date(h.ts);
      var hh = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
      var row = document.createElement('div');
      row.className = 'hist-item';
      row.appendChild(logoNode(h, 'hlogo'));
      row.insertAdjacentHTML('beforeend',
        '<div class="hmeta"><strong>' + esc(h.name) + '</strong>'
        + '<span>' + esc([h.group, td(h.sourceName)].filter(Boolean).join(' · ')) + '</span></div>'
        + '<time>' + hh + '</time>'
        + '<button data-a="play" class="play-btn" title="' + esc(t('title.replay')) + '">' + ico('play') + '</button>');
      row.querySelector('[data-a="play"]').onclick = function () { play(h); };
      row.querySelector('.hmeta').onclick = function () { play(h); };
      box.appendChild(row);
    });
  }

  function renderSources() {
    var boxes = [$('src-list'), $('src-list-full')].filter(Boolean);
    var countEl = $('src-count');
    if (countEl) countEl.textContent = state.sources.length ? t('src.countN', state.sources.length) : '';
    var emptyEl = $('src-empty');
    if (emptyEl) emptyEl.hidden = state.sources.length > 0;

    boxes.forEach(function (box) {
      box.innerHTML = '';
      if (!state.sources.length) {
        if (box.id === 'src-list') {
          box.innerHTML = '<div class="empty">' + esc(t('src.inlineEmpty')) + '</div>';
        }
        return;
      }
      state.sources.forEach(function (src) { box.appendChild(sourceRow(src)); });
    });
    var kw = ($('q-src') && $('q-src').value.trim().toLowerCase()) || '';
    filterSourceRows(kw);
  }

  function sourceRow(src) {
    var row = document.createElement('div');
    row.className = 'src-item';
    row.dataset.name = (src.name || '').toLowerCase();
    var loadState = src.count
      ? t('count.stations', src.count)
      : (src.error ? '<b class="err">' + esc(I18N.msg(src.error)) + '</b>' : t('src.notLoaded'));
    row.innerHTML =
      '<div class="toggle' + (src.enabled === false ? '' : ' on') + '" data-a="en" title="' + esc(t('title.toggleSrc')) + '"></div>' +
      '<div class="rmeta"><strong>' + esc(td(src.name)) + '</strong>' +
      '<span class="url">' + esc(src.url) + '</span>' +
      '<span class="rmeta-sub">' +
      loadState +
      (src.lastLoad ? ' · ' + esc(fmtTs(src.lastLoad)) : '') +
      '</span></div>' +
      '<div class="sactions">' +
      '<button data-a="refresh" class="icon-btn" title="' + esc(t('title.reloadSrc')) + '">' + ico('refresh') + '</button>' +
      '<button data-a="del" class="icon-btn danger" title="' + esc(t('title.del')) + '">' + ico('trash') + '</button>' +
      '</div>';

    var tg = row.querySelector('[data-a="en"]');
    tg.onclick = function () {
      src.enabled = src.enabled === false;
      tg.classList.toggle('on', src.enabled !== false);
      toast(src.enabled === false ? t('toast.srcOff') : t('toast.srcOn'));
    };
    row.querySelector('[data-a="refresh"]').onclick = function () {
      toast(t('toast.srcLoading'));
      post('/api/sources/refresh', { id: src.id }).then(function (j) {
        state.sources = j.sources; state.stations = j.stations;
        renderAll(); toast(t('toast.srcRefreshed'));
      }).catch(function (e) { toast(I18N.msg(String(e.message)), true); });
    };
    row.querySelector('[data-a="del"]').onclick = function () {
      del('/api/sources?id=' + enc(src.id)).then(function (j) {
        state.sources = j.sources; state.stations = j.stations;
        renderAll(); toast(t('toast.deleted'));
      });
    };
    return row;
  }

  function filterSourceRows(kw) {
    Array.prototype.forEach.call(document.querySelectorAll('.src-item'), function (r) {
      r.hidden = !!(kw && r.dataset.name.indexOf(kw) < 0);
    });
  }

  function renderDisc(list) {
    var grid = $('disc-list'), lst = $('list-disc');
    grid.innerHTML = ''; if (lst) lst.innerHTML = '';
    $('disc-empty').hidden = list.length > 0;
    $('disc-count').textContent = list.length ? t('count.stations', list.length) : '';
    list.forEach(function (st) {
      grid.appendChild(stationCard(st, {}));
      if (lst) lst.appendChild(stationCard(st, {}));
    });
  }

  function renderAll() {
    renderStatus(); renderHero(); renderHome(); renderMine();
    if (tab === 'fav') renderFav();
    if (tab === 'history') renderHistory();
    renderSources();
  }

  /** 首页：我的电台上限 8 个 + 最近收听横滑条 */
  function renderHome() {
    var grid = $('home-mine');
    grid.innerHTML = '';
    var top = state.stations.slice(0, 8);
    top.forEach(function (st) { grid.appendChild(stationCard(st, { canDelete: true })); });
    $('home-mine-count').textContent = t('count.stations', state.stations.length);
    $('home-empty').hidden = state.stations.length > 0;

    var box = $('home-hist');
    box.innerHTML = '';
    var h = state.history.slice(0, 12);
    $('home-hist-empty').hidden = h.length > 0;
    h.forEach(function (item) {
      var dt = new Date(item.ts);   // 同上：不要用 var t，会遮蔽翻译函数
      var hh = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
      var row = document.createElement('div');
      row.className = 'hist-item';
      row.appendChild(logoNode(item, 'hlogo'));
      row.insertAdjacentHTML('beforeend',
        '<div class="hmeta"><strong>' + esc(item.name) + '</strong>'
        + '<span>' + esc([dayKey(item.ts), td(item.sourceName)].filter(Boolean).join(' · ')) + '</span></div>'
        + '<time>' + hh + '</time>'
        + '<button data-a="play" class="play-btn" title="' + esc(t('title.replay')) + '">' + ico('play') + '</button>');
      row.querySelector('[data-a="play"]').onclick = function () { play(item); };
      row.querySelector('.hmeta').onclick = function () { play(item); };
      box.appendChild(row);
    });
  }

  /* ---------------------------------------------------------------- *
   * 播放
   * ---------------------------------------------------------------- */
  var audio = null;
  var hls = null;
  var current = null;
  var playing = false;

  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'none';
    audio.crossOrigin = 'anonymous';
    audio.volume = (parseFloat(localStorage.getItem('jxr-vol') || '80') || 80) / 100;
    audio.addEventListener('playing', function () { setPlaying(true); });
    audio.addEventListener('pause', function () { setPlaying(false); });
    audio.addEventListener('waiting', function () { setSub('play.buffering'); });
    audio.addEventListener('error', function () { /* 由 tryXxx 的超时/错误逻辑处理 */ });
    return audio;
  }

  function destroyHls() {
    if (hls) { try { hls.destroy(); } catch (e) { } hls = null; }
  }
  function stopAudio() {
    try { ensureAudio().pause(); } catch (e) { }
    try { ensureAudio().removeAttribute('src'); ensureAudio().load(); } catch (e) { }
  }
  function stopAll() { destroyHls(); stopAudio(); }

  function setPlaying(p) {
    playing = p;
    $('btn-play').innerHTML = ico(p ? 'pauseS' : 'play');
    if (p && current) setSub('play.playing');
  }
  /* 状态栏：不存成品文本，只存「词条 key + 参数」，切语言时才能就地重放换语言 */
  var subState = null;
  function setSub(key, a, b) {
    subState = (key == null) ? null : { kind: 'text', key: key, args: [a, b] };
    paintSub();
  }
  function setSubStatus(key, ok, a, b) {
    subState = (key == null) ? null : { kind: 'status', key: key, ok: !!ok, args: [a, b] };
    paintSub();
  }
  function paintSub() {
    var el = $('np-sub');
    if (!subState) { el.textContent = ''; el.className = 'np-status'; return; }
    var txt = t.apply(null, [subState.key].concat(subState.args));
    if (subState.kind === 'text') { el.textContent = txt; return; }
    el.innerHTML = ico(subState.ok ? 'wifi' : 'refresh') + '<span>' + esc(txt) + '</span>';
    el.className = 'np-status' + (subState.ok ? ' ok' : '');
  }

  /** 用 hls.js 播一个已代理的 m3u8 */
  function playHls(url) {
    return new Promise(function (resolve, reject) {
      if (typeof window.Hls === 'undefined' || !window.Hls.isSupported()) {
        return reject(new Error('HLS_UNSUPPORTED'));
      }
      destroyHls();
      var el = ensureAudio();
      var h = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 4
      });
      hls = h;
      var done = false;
      var gotData = false;
      var watchdog = setTimeout(function () {
        if (!gotData) finish(function () { reject(new Error('HLS_NO_DATA')); });
      }, 15000);

      function finish(fn) {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        fn();
      }

      h.on(window.Hls.Events.FRAG_BUFFERED, function () {
        gotData = true;
        finish(resolve);
      });
      h.on(window.Hls.Events.MANIFEST_PARSED, function () {
        el.play().catch(function () { /* 自动播放限制，用户点击后即可 */ });
      });
      h.on(window.Hls.Events.ERROR, function (evt, data) {
        if (!data || !data.fatal) return;
        var etype = data.type;
        if (etype === window.Hls.ErrorTypes.NETWORK_ERROR) {
          try { h.startLoad(); } catch (e) { finish(function () { reject(new Error('HLS_NETWORK')); }); }
          return;
        }
        finish(function () { reject(new Error('HLS_' + (etype || 'FATAL') + (data.details ? ':' + data.details : ''))); });
      });

      h.loadSource(url);
      h.attachMedia(el);
    });
  }

  /** 用原生 audio 播一个已代理的地址 */
  function playNative(url) {
    return new Promise(function (resolve, reject) {
      destroyHls();
      var el = ensureAudio();
      var done = false;
      var timer = setTimeout(function () {
        finish(function () { reject(new Error('NATIVE_TIMEOUT')); });
      }, 15000);
      function finish(fn) { if (done) return; done = true; clearTimeout(timer); cleanup(); fn(); }
      function onPlaying() { finish(resolve); }
      function onError() {
        var code = el.error ? el.error.code : 0;
        finish(function () { reject(new Error('NATIVE_ERR' + code)); });
      }
      function cleanup() {
        el.removeEventListener('playing', onPlaying);
        el.removeEventListener('error', onError);
      }
      el.addEventListener('playing', onPlaying);
      el.addEventListener('error', onError);
      el.src = url;
      el.play().catch(function (e) { finish(function () { reject(e && e.message ? e : new Error('PLAY_BLOCKED')); }); });
    });
  }

  function setNowPlaying(st, msg) {
    current = st;
    $('np-name').textContent = st ? st.name : t('player.idle');

    var host = $('np-art');
    host.innerHTML = '';
    if (st) host.appendChild(logoNode(st, 'nplogo'));
    else {
      var ph = document.createElement('span');
      ph.className = 'np-ph';
      ph.id = 'np-ph';
      ph.textContent = '📻';
      ph.onclick = function () { go('mine'); };
      host.appendChild(ph);
    }

    var meta = st ? [td(st.sourceName || st.country), st.group].filter(Boolean).join(' · ') : '';
    $('np-meta').textContent = meta || (st ? t('player.station') : t('player.hint'));
    var sb = $('btn-src');
    if (sb) {
      var n = (st && st.poolCount) || (st && st.sources ? st.sources.length : 0);
      if (n > 1) { sb.hidden = false; $('np-srcn').textContent = n; }
      else sb.hidden = true;
    }
    if (msg) setSub(msg);
  }

  var playToken = 0;   // 每次播放自增；作废在途的旧播放链，避免「电台A 把正在播放的电台B 顶掉」
  function play(st, chosenUrl) {
    st = hydrate(st);                    // 足迹/收藏的快照在这里换成服务器最新对象（带源池）
    if (!st || !st.url) return;
    var myToken = ++playToken;   // 本次播放的令牌；任何更晚的 play() 都会让本令牌失效

    // 源尝试顺序：用户指定 > 已测通断且最快 > 其余 > noProbe 备用源（RadioDroid 等）。
    // 当主源不可用，自动顺延到下一个源，直到播通或所有源耗尽（含 RadioDroid 兜底）。
    var seen = {};
    var urls = [];
    function push(u) { if (u && !seen[u] && /^https?:/i.test(u)) { seen[u] = 1; urls.push(u); } }
    var primary = (chosenUrl && st.sources && st.sources.some(function (x) { return x.url === chosenUrl; })) ? chosenUrl : st.url;
    push(primary);
    var ranked = (st.sources || []).slice().sort(function (a, b) {
      var oa = (a.ok && !a.dead), ob = (b.ok && !b.dead);
      if (oa !== ob) return oa ? -1 : 1;
      var la = a.latency == null ? 1e9 : a.latency, lb = b.latency == null ? 1e9 : b.latency;
      return la - lb;
    });
    ranked.forEach(function (s) { push(s.url); });

    stopAll();
    pushHistory(st);
    setNowPlaying(st, 'play.connecting');
    setPlaying(false);

    /** 本台源池已耗尽：报「无法播放」 */
    function giveUp() {
      setNowPlaying(st);
      setSubStatus('play.cantPlayShort', false);
      toast(t('play.cantPlay', st.name), true);
    }

    /* 源池里所有源都播不通时，按台名去 RadioDroid 全量目录找备用源（服务端实测可放才返回）。
     * 找到的流会并入 st.sources 并标 noProbe，选源菜单里就能看到蓝色备用源。 */
    var droidAsked = false;
    function askDroid() {
      if (myToken !== playToken) return;
      if (droidAsked) { giveUp(); return; }
      droidAsked = true;
      setSubStatus('play.tryingDroid', false, st.name);
      api('/api/fallback?name=' + enc(st.name) + '&exclude=' + enc(urls.join(',')))
        .then(function (j) {
          if (myToken !== playToken) return;
          var got = (j.streams || []).filter(function (x) { return x && x.url && !seen[x.url]; });
          if (!got.length) { giveUp(); return; }
          if (!st.sources) st.sources = [];
          got.forEach(function (x) {
            seen[x.url] = 1;
            urls.push(x.url);
            if (!st.sources.some(function (s) { return s.url === x.url; })) {
              st.sources.push({
                url: x.url, type: isHls(x.url) ? 'hls' : 'mp3',
                from: x.from || 'RadioDroid 电台（内置）', noProbe: true,
                ok: true, latency: x.latency == null ? null : x.latency, dead: false,
                checkedAt: Date.now(), note: 'fallback'
              });
            }
          });
          st.poolCount = st.sources.length;
          setNowPlaying(st);
          toast(t('play.droidAdded', got.length));
          tryUrl();
        })
        .catch(function () { if (myToken === playToken) giveUp(); });
    }

    var si = 0;   // 当前尝试到第几个源
    function tryUrl() {
      if (myToken !== playToken) return;            // 已切台，放弃整条回退链
      if (si >= urls.length) { askDroid(); return; }   // 全部源失败 → 找 RadioDroid 兜底
      var u = urls[si++];
      var label = urls.length > 1 ? t('play.srcIndex', si, urls.length) : '';
      var chain = [];
      if (isHls(u)) {
        chain.push({ nameKey: 'chain.hlsProxy', run: function () { return playHls(hlsSrc(u, st.referer)); } });
        chain.push({ nameKey: 'chain.nativeHls', run: function () { return playNative(hlsSrc(u, st.referer)); } });
      }
      chain.push({ nameKey: 'chain.directProxy', run: function () { return playNative(proxySrc(u, st.referer)); } });
      var ci = 0;
      function next() {
        if (myToken !== playToken) return;          // 已切台，忽略
        if (ci >= chain.length) { tryUrl(); return; }   // 当前源所有方式都失败 → 试下一个源
        var step = chain[ci++];
        var stepName = t(step.nameKey);
        stopAll();
        setSubStatus('play.connectingChain', false, label, stepName);
        step.run().then(function () {
          if (myToken !== playToken) return;
          st.manualUrl = u;   // 记下实际在播的源，菜单高亮
          setNowPlaying(st);
          setSubStatus('play.playingChain', true, stepName);
          setPlaying(true);
          refreshCurrentViews();
        }).catch(function (e) {
          if (myToken !== playToken) return;
          console.warn('[jiexiang-radio] ' + label + stepName + ' 失败：', e && e.message);
          next();
        });
      }
      next();
    }
    tryUrl();
  }

  /* ---------------------------------------------------------------- *
   * 选源菜单
   *
   * 打开菜单时若还有「未测」的源，后台自动向 /api/probe 发起一次实测
   * （服务端并发 4、单条 6s 超时、最多 8 条，且复用 12h 健康缓存），
   * 结果回来后就地刷新菜单 —— 所以「未测」只是短暂过渡，不再长期挂着。
   * RadioDroid 备用源（noProbe）按设计不主动探测，点播时按需验证。
   * ---------------------------------------------------------------- */
  var probeBusy = false;

  function renderSrcMenu(st) {
    var pop = $('src-pop'); if (!pop || !st) return;
    st = hydrate(st);                     // 快照 → 服务器最新对象（带源池/测速结果）
    if (!st.url) return;
    var cur = st.manualUrl || st.url;
    var list = (st.sources || []).slice();
    // 兜底：万一这台还没建源池（老数据 / 刚入库），至少给出它自己的当前源，
    // 菜单不能只剩一个标题。
    if (!list.length && st.url) {
      list = [{ url: st.url, from: t('src.primary'), ok: null, latency: null, dead: false, noProbe: false }];
    }
    // 排序分级：① 实测可放（延迟升序）② RadioDroid 备用源（按来源名稳定排序）
    //          ③ 未测（保持原顺序，马上就会被后台测速改写成 ①/④）④ 死链
    // 以前 ③④ 同级，排出来死链会夹在未测中间，看着就像「没排序」。
    function rankOf(x) {
      if (x.ok === false || x.dead) return [3, 0];
      if (x.ok) return [0, x.latency == null ? 1e9 : x.latency];
      if (x.noProbe) return [1, (x.from || '')];
      return [2, 0];
    }
    var srcs = list.slice().sort(function (a, b) {
      var ra = rankOf(a), rb = rankOf(b);
      if (ra[0] !== rb[0]) return ra[0] - rb[0];
      if (ra[0] === 1) return ra[1] < rb[1] ? -1 : (ra[1] > rb[1] ? 1 : 0); // 备用源按来源名字典序
      return ra[1] - rb[1];
    });
    // 自动会选中的源（与服务器 pickBest 同逻辑）：可用的最快源，否则第一个备用源
    function willUse() {
      var avail = srcs.filter(function (s) { return s.ok && !s.dead; });
      if (avail.length) return avail[0].url;
      var bk = srcs.filter(function (s) { return s.noProbe; });
      if (bk.length) return bk[0].url;
      return st.url;
    }
    var useUrl = willUse();
    var untested = srcs.filter(function (x) {
      return !x.noProbe && x.ok == null && !x.dead && /^https?:/i.test(x.url);
    });
    var html = '<div class="srcmenu-h"><span>' + esc(t('srcmenu.title')) + '</span>' +
      '<button type="button" class="srcmenu-rb" data-a="reprobe">' + esc(t('srcmenu.reprobe')) + '</button></div>';
    // 整台都只有 RadioDroid 备用源时，给一句说明，避免误以为「源没测」是 bug
    if (srcs.length && srcs.every(function (x) { return x.noProbe; })) {
      html += '<div class="srcmenu-note">' + esc(t('srcmenu.allBackup')) + '</div>';
    } else if (untested.length) {
      html += '<div class="srcmenu-note probing" id="srcmenu-probing">' + esc(t('srcmenu.probing', untested.length)) + '</div>';
    }
    srcs.forEach(function (x, i) {
      var isCur = (x.url === cur);
      var isUse = (x.url === useUrl);
      var statCls, statTxt;
      if (x.ok === false || x.dead) { statCls = 'dead'; statTxt = t('stat.dead'); }
      else if (x.ok) { statCls = 'ok'; statTxt = (x.latency != null ? (x.latency + 'ms') : t('stat.playable')); }
      else if (x.noProbe) { statCls = 'bk'; statTxt = t('stat.backup'); }
      else { statCls = ''; statTxt = t('stat.untested'); }
      var tag = isUse ? '<span class="srci-use">' + esc(t('srcmenu.willUse')) + '</span>' : '';
      html += '<button class="srci' + (isCur ? ' cur' : '') + (isUse ? ' use' : '') + '" data-u="' + esc(x.url) + '">' +
        '<span class="srci-rank">' + (i + 1) + '</span>' +
        '<span class="srci-from">' + esc(td(x.from) || t('src.generic')) + '</span>' +
        tag +
        '<span class="srci-stat ' + statCls + '">' + statTxt + '</span></button>';
    });
    pop.innerHTML = html;
    Array.prototype.forEach.call(pop.querySelectorAll('.srci'), function (b) {
      b.onclick = function () {
        var u = b.getAttribute('data-u');
        pop.hidden = true;
        st.manualUrl = u; // 本地即时标记当前源，菜单高亮不滞后
        play(st, u);
        post('/api/station/' + enc(st.id) + '/select', { url: u }).catch(function () {});
      };
    });
    var rb = pop.querySelector('[data-a="reprobe"]');
    if (rb) rb.onclick = function () { scheduleProbe(st, srcs, true); };
    // 未测的源：开菜单就顺手测掉（不阻塞渲染，结果回来再刷一次）
    if (untested.length) scheduleProbe(st, srcs, false);
  }

  /** 后台测速：把源池里待测/需重测的地址交给服务端实测，回来后就地刷新菜单 */
  function scheduleProbe(st, srcs, force) {
    if (probeBusy) return;
    var targets = srcs.filter(function (x) {
      if (x.noProbe) return false;                  // 备用源按设计不主动探测
      if (!/^https?:/i.test(x.url)) return false;
      if (force) return true;                       // 手动「重新测速」：含死链一起重测
      return x.ok == null && !x.dead;               // 自动：只测没结论的
    }).map(function (x) { return x.url; }).slice(0, 8);
    if (!targets.length) return;
    probeBusy = true;
    var pop = $('src-pop');
    var note = pop ? pop.querySelector('.srcmenu-note.probing') : null;
    if (note) note.textContent = t('srcmenu.probing', targets.length);
    post('/api/probe', { urls: targets, force: !!force }).then(function (j) {
      var by = {};
      (j.results || []).forEach(function (r) { by[r.url] = r; });
      (st.sources || []).forEach(function (s) {
        var r = by[s.url];
        if (!r) return;
        s.ok = !!r.ok;
        s.latency = r.latency == null ? null : r.latency;
        s.dead = !r.ok;
        s.checkedAt = Date.now();
      });
      st.poolCount = (st.sources || []).length;
      if (current === st && pop && !pop.hidden) renderSrcMenu(st);
    }).catch(function (e) {
      toast(t('toast.probeFail', (e && e.message) || ''), true);
    }).then(function () {
      probeBusy = false;
      var n = $('srcmenu-probing');
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  }
  function toggleSrcMenu() {
    var pop = $('src-pop'); if (!pop || !current) return;
    if (!pop.hidden) { pop.hidden = true; return; }
    renderSrcMenu(current);
    pop.hidden = false;
  }

  function refreshCurrentViews() {
    Array.prototype.forEach.call(document.querySelectorAll('.station.playing'), function (el) {
      el.classList.remove('playing');
    });
    if (current) {
      Array.prototype.forEach.call(document.querySelectorAll('.station'), function (el) {
        var nm = el.querySelector('.stitle strong');
        if (nm && nm.textContent === current.name) el.classList.add('playing');
      });
    }
    if (tab === 'history') renderHistory();
    renderHero();
  }

  function toggle() {
    var el = ensureAudio();
    if (!current) return;
    if (playing) { el.pause(); setPlaying(false); }
    else if (el.src) { el.play().catch(function (e) { toast(t('play.blocked', e.message || e), true); }); }
    else { play(current); }
  }

  /* ---------------------------------------------------------------- *
   * 事件绑定
   * ---------------------------------------------------------------- */
  function bindTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.addEventListener('click', function () {
        var tabId = b.dataset.tab;
        if (tabId === 'search') { openSearch(); return; }
        if (tabId === 'settings') { go('sources'); return; }
        if (tabId === 'random') { randomPlay(); return; }
        if (tabId === 'continue') { continueLast(); return; }
        if (tabId === 'discover') { go('discover'); if (!discLoaded) doDiscover(); return; }
        if (tabId === 'rb') { go('rb'); if (!rbLoaded) doRbBrowse(); return; }
        go(tabId);
      });
    });
  }

  function openSearch() {
    go('mine');
    setTimeout(function () { $('q-mine').focus(); }, 30);
  }

  function randomPlay() {
    var pool = state.stations.slice();
    if (!pool.length) return toast(t('toast.noStation'), true);
    var st = pool[Math.floor(Math.random() * pool.length)];
    toast(t('toast.random', st.name));
    play(st);
  }

  function bindIcons() {
    var sb = $('btn-src'); if (sb) sb.onclick = toggleSrcMenu;
    $('btn-theme').addEventListener('click', function () {
      themeMode = themeMode === 'dark' ? 'light' : 'dark';
      localStorage.setItem('jxr-theme', themeMode);
      applyTheme();
    });
    $('btn-view').addEventListener('click', function () {
      viewMode = viewMode === 'grid' ? 'list' : 'grid';
      localStorage.setItem('jxr-view', viewMode);
      applyView();
    });
  }

  /** 语言切换：简体中文 / English 双向下拉。
   *  下拉必须能点开、能选、能关（点外部 / Esc）——之前那只是个静态 div，没绑定任何事件。 */
  function bindLang() {
    var btn = $('btn-lang');
    var menu = $('lang-menu');
    var label = $('lang-label');
    if (!btn || !menu) return;

    /* 语言名一律用「本族语写法」（简体中文 / English），不跟着界面语言翻译，
     * 否则英文界面下中文选项会变成 Chinese，用户反而认不出来。 */
    function nativeName(code) { return code === 'en' ? 'English' : '简体中文'; }
    function shortName(code) { return code === 'en' ? 'English' : '中文'; }

    function syncLabel() {
      var cur = I18N.get();
      if (label) label.textContent = '🌐 ' + shortName(cur);
      qa('[data-lang]', menu).forEach(function (b) {
        b.classList.toggle('on', b.dataset.lang === cur);
      });
    }
    function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); syncLabel(); }
    function close() { if (!menu.hidden) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } }

    btn.addEventListener('click', function (e) { e.stopPropagation(); if (menu.hidden) open(); else close(); });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    qa('[data-lang]', menu).forEach(function (b) {
      b.addEventListener('click', function () {
        var next = b.dataset.lang;
        if (next === I18N.get()) { close(); return; }
        I18N.set(next);        // 落盘 + 回填静态文案
        syncLabel();
        close();
        resyncDynamicText();   // 重建 JS 渲染出来的部分
        toast(t('lang.switched', nativeName(next)));
      });
    });

    document.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    syncLabel();
  }

  /** 语言切换后重放动态内容：静态 HTML 已由 I18N.set() 回填，
   *  这里只补 JS 渲染出来的部分（统计、卡片、分类、源列表、播放器状态）。 */
  function resyncDynamicText() {
    // 分类 chip 里的「未分组」文案随语言变，旧的筛选值会失配，直接重置
    filterCat.mine = '';
    renderAll();
    if (state.stations.length === 0) renderSources();   // 空态文案也要换语言
    applyTheme();
    applyView();
    paintSub();
  }

  function bindForms() {
    $('q-mine').addEventListener('input', function () {
      filterText.mine = this.value.trim();
      renderMine();
    });

    $('q-src').addEventListener('input', function () {
      filterSourceRows(this.value.trim().toLowerCase());
    });

    /* 下面这些表单/按钮在「我的电台」和「订阅源管理」两个页面各有一份，
     * 统一按 data-role 绑定，逻辑只写一次。 */
    qa('[data-role="station-form"]').forEach(function (f) {
      f.addEventListener('submit', function (e) { e.preventDefault(); submitManualStation(f); });
    });

    qa('[data-role="source-form"]').forEach(function (f) {
      f.addEventListener('submit', function (e) { e.preventDefault(); submitSource(f); });
    });

    qa('[data-role="import"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var box = btn.closest('.src-block');
        importPaste(box ? box.querySelector('[data-role="paste"]') : null);
      });
    });

    qa('[data-role="export"]').forEach(function (btn) {
      btn.addEventListener('click', function () { exportM3U(); });
    });

    qa('[data-role="clear"]').forEach(function (btn) {
      btn.addEventListener('click', function () { clearAllStations(); });
    });

    $('btn-clear-hist').addEventListener('click', function () {
      if (!state.history.length) return;
      if (!confirm(t('hist.confirm'))) return;
      state.history = [];
      localStorage.setItem('jxr-hist', '[]');
      renderHistory(); renderHero();
      toast(t('toast.histCleared'));
    });

    $('btn-disc').addEventListener('click', doDiscover);
    $('q-disc').addEventListener('keydown', function (e) { if (e.key === 'Enter') doDiscover(); });

    $('btn-rb').addEventListener('click', function () { rbOffset = 0; rbLoaded = false; doRbBrowse(); });
    $('q-rb').addEventListener('keydown', function (e) { if (e.key === 'Enter') { rbOffset = 0; rbLoaded = false; doRbBrowse(); } });
    $('rb-country').addEventListener('change', function () { rbOffset = 0; rbLoaded = false; doRbBrowse(); });
    $('btn-rb-more').addEventListener('click', doRbBrowse);

    $('btn-play').addEventListener('click', toggle);
    $('vol').addEventListener('input', function () {
      var v = parseInt(this.value, 10) / 100;
      ensureAudio().volume = v;
      localStorage.setItem('jxr-vol', this.value);
    });
    document.addEventListener('keydown', function (e) {
      var tag = e.target.tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
        e.preventDefault(); toggle();
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * 表单动作（多页面复用）
   * ---------------------------------------------------------------- */

  /** 手动添加单个电台 */
  function submitManualStation(f) {
    // 注意：form.name 是 <form> 自己的 name 属性（字符串），不是名为 name 的输入框，
    // 必须用 f.elements.namedItem('name')，否则用户填的电台名会被忽略、只能从 URL 推导。
    var el = f.elements;
    var payload = {
      name: (el.namedItem('name').value || '').trim(),
      url: (el.namedItem('url').value || '').trim(),
      sourceName: '手动添加'
    };
    if (!/^https?:\/\//i.test(payload.url)) return toast(t('toast.badUrl'), true);
    if (!payload.name) payload.name = payload.url.split('/').pop().split('?')[0] || t('form.defaultStationName');
    var btn = f.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    post('/api/stations', payload).then(function (j) {
      state.stations = j.stations; renderAll();
      f.reset(); toast(t('toast.added', payload.name));
    }).catch(function (err) {
      toast(I18N.msg(String(err.message)), true);
    }).then(function () { if (btn) btn.disabled = false; });
  }

  /** 新增订阅源 */
  function submitSource(f) {
    var el = f.elements;
    var payload = { name: (el.namedItem('name').value || '').trim(), url: (el.namedItem('url').value || '').trim() };
    if (!/^https?:\/\//i.test(payload.url)) return toast(t('toast.badUrl'), true);
    var btn = f.querySelector('button[type="submit"]');
    var old = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = t('toast.srcLoading'); }
    post('/api/sources', payload).then(function (j) {
      state.sources = j.sources; state.stations = j.stations;
      renderAll(); f.reset();
      toast(t('toast.sourceAdded'));
    }).catch(function (err) {
      toast(I18N.msg(String(err.message)), true);
    }).then(function () { if (btn) { btn.disabled = false; btn.innerHTML = old; } });
  }

  /** 粘贴 M3U / 纯文本导入 */
  function importPaste(box) {
    if (!box) return toast(t('toast.noPasteBox'), true);
    var txt = box.value.trim();
    if (!txt) return toast(t('toast.pasteFirst'), true);
    var re = /#EXTINF[^\n]*,(.*)\r?\n(https?:\/\/[^\s]+)/g;
    var items = [], m;
    while ((m = re.exec(txt)) !== null) items.push({ name: m[1].trim(), url: m[2].trim() });
    if (!items.length) {
      var re2 = /^(https?:\/\/[^\s]+)$/gm;
      while ((m = re2.exec(txt)) !== null) items.push({ name: m[1], url: m[1] });
    }
    if (!items.length) return toast(t('toast.noUrlParsed'), true);
    var ok = 0, fail = 0;
    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () {
        return post('/api/stations', {
          name: it.name, url: it.url, sourceName: '粘贴导入'
        }).then(function (j) { state.stations = j.stations; ok++; })
          .catch(function () { fail++; });
      });
    });
    chain.then(function () {
      box.value = '';
      renderAll();
      toast(fail ? t('toast.importedSkip', ok, fail) : t('toast.imported', ok));
    });
  }

  /** 导出当前全部电台为 M3U 文件 */
  function exportM3U() {
    var src = state.stations;
    if (!src.length) return toast(t('toast.exportEmpty'), true);
    var lines = ['#EXTM3U'];
    src.forEach(function (s) {
      // 站内相对路径的台标（/favicon/...）补成绝对地址，别的播放器才认得
      var lg = s.logo || '';
      if (lg.charAt(0) === '/') lg = location.origin + lg;
      var attrs = ' tvg-logo="' + lg + '" group-title="' + (s.group || '') + '"';
      lines.push('#EXTINF:-1' + attrs + ',' + s.name);
      lines.push(s.url);
    });
    var blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jiexiang-radio-' + Date.now() + '.m3u';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast(t('toast.exported', src.length));
  }

  /** 清空全部电台（保留订阅源） */
  function clearAllStations() {
    if (!state.stations.length) return toast(t('toast.alreadyEmpty'));
    if (!confirm(t('toast.clearConfirm', state.stations.length))) return;
    var chain = Promise.resolve();
    state.stations.slice().forEach(function (s) {
      chain = chain.then(function () {
        return del('/api/stations?id=' + enc(s.id)).then(function (j) { state.stations = j.stations; });
      });
    });
    chain.then(function () { renderAll(); toast(t('toast.cleared')); });
  }

  function doDiscover() {
    var q = $('q-disc').value.trim();
    var c = $('country').value;
    var ps = new URLSearchParams();
    if (q) ps.set('q', q);
    if (c) ps.set('country', c);
    ps.set('limit', '80');
    $('btn-disc').disabled = true;
    $('disc-empty').textContent = t('disc.searching');
    $('disc-empty').hidden = false;
    api('/api/discover?' + ps.toString()).then(function (j) {
      filterText.disc = q;
      renderDisc(j.stations || []);
      discLoaded = true;
      $('disc-empty').textContent = t('disc.noResult');
    }).catch(function (e) {
      toast(t('toast.searchFail', e.message), true);
      $('disc-empty').textContent = t('toast.searchFail', e.message);
      $('disc-empty').hidden = false;
    }).then(function () { $('btn-disc').disabled = false; });
  }

  /* ---------------------------------------------------------------- *
   * RadioDroid 全量目录（服务端 /api/rb 分页浏览）
   * ---------------------------------------------------------------- */
  var rbLoaded = false;
  var rbOffset = 0;
  var rbQ = '';
  var rbCountry = '';
  function doRbBrowse() {
    var q = $('q-rb').value.trim();
    var c = $('rb-country').value;
    rbQ = q; rbCountry = c;
    var ps = new URLSearchParams();
    if (q) ps.set('q', q);
    if (c) ps.set('country', c);
    ps.set('offset', String(rbOffset));
    ps.set('limit', '60');
    $('btn-rb-more').disabled = true;
    if (rbOffset === 0) { $('rb-empty').textContent = t('rb.loading'); $('rb-empty').hidden = false; }
    api('/api/rb?' + ps.toString()).then(function (j) {
      var list = j.stations || [];
      renderRb(list, rbOffset > 0);
      rbLoaded = true;
      rbOffset += list.length;
      $('rb-empty').textContent = t('disc.noResult');
      $('rb-empty').hidden = list.length > 0 || rbOffset > 0;
      $('rb-more-wrap').hidden = !j.hasMore;
      $('rb-count').textContent = t('count.stations', j.total || 0);
    }).catch(function (e) {
      toast(t('toast.loadFail', e.message), true);
      $('rb-empty').textContent = t('toast.loadFail', e.message);
      $('rb-empty').hidden = false;
    }).then(function () { $('btn-rb-more').disabled = false; });
  }

  function renderRb(list, append) {
    var grid = $('rb-list'), lst = $('list-rb');
    if (!append) { grid.innerHTML = ''; if (lst) lst.innerHTML = ''; }
    list.forEach(function (st) {
      grid.appendChild(stationCard(st, {}));
      if (lst) lst.appendChild(stationCard(st, {}));
    });
  }

  /* ---------------------------------------------------------------- *
   * 启动
   * ---------------------------------------------------------------- */
  function boot() {
    I18N.apply(document);       // 按已选语言回填静态文案（i18n.js 在 <head> 里已 init 过一次）
    loadLocal();
    applyTheme();
    applyView();
    bindTabs();
    bindIcons();
    bindLang();
    bindForms();
    $('vol').value = localStorage.getItem('jxr-vol') || '80';
    setNowPlaying(null);
    setSubStatus('player.hint', false);
    go('home');

    api('/api/sources').then(function (j) {
      state.sources = j.sources || [];
      state.stations = j.stations || [];
      /* 渲染异常单独兜住：接口成功了就不该报「后端连接失败」，
       * 否则一个前端小错会被误报成后端挂了（曾经就踩过）。 */
      try { renderAll(); } catch (err) { console.error('[renderAll]', err); }
    }).catch(function (e) {
      $('stat').textContent = t('toast.backendFail', e.message);
    });
  }

  window.jxrPlay = play;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
