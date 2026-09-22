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
    if (k(d) === k(n)) return '今天';
    n.setDate(n.getDate() - 1);
    if (k(d) === k(n)) return '昨天';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
    $('btn-theme').title = themeMode === 'dark' ? '切换到浅色' : '切换到深色';
  }
  function applyView() {
    document.body.dataset.view = viewMode;
    $('btn-view').innerHTML = ico(viewMode === 'grid' ? 'list' : 'grids');
    $('btn-view').title = viewMode === 'grid' ? '切换列表视图' : '切换网格视图';
  }

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */
  function renderStatus() {
    $('stat').textContent = '共 ' + state.stations.length + ' 个电台 · ' +
      state.sources.length + ' 个订阅源';
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
    return n ? '继续收听，' + n.name : '聆听世界，音乐无界';
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
    $('hero-label').textContent = need ? '继续收听' : '随机发现';
    $('hero-sub').textContent = need
      ? '上次听到「' + state.history[0].name + '」，点击接着听'
      : '从 ' + state.stations.length + ' 个电台里随便挑一个开始';
  }

  /** 首页大卡片：有收听记录就续播上一条 */
  function continueLast() {
    var last = state.history[0];
    if (!last) return randomPlay();
    toast('继续收听：' + last.name);
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

  /** 站内图片地址：本地烘焙台标（/logo/...）直接返回，其余走 /img 代理 */
  function imgSrc(url) {
    if (!url) return '';
    if (url.charAt(0) === '/' && url.indexOf('/logo/') === 0) return url;
    return '/img?url=' + enc(url);
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
      img.src = imgSrc(raw);
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function () {
        // 图片挂了：有原生 logo 就保留占位不污染缓存，直接用本地头像顶上
        if (!(st && st.logo)) logoFailed[name] = true;
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
    if (st.country) sub.push(st.country);
    if (st.countryCode && !st.country) sub.push(st.countryCode);
    if (st.sourceName && opts.showSource !== false) sub.push(st.sourceName);
    if (st.bitrate) sub.push((st.codec || '') + ' ' + st.bitrate + 'k');
    var head = document.createElement('div');
    head.className = 'shead';
    head.appendChild(logoNode(st, 'slogo'));
    head.insertAdjacentHTML('beforeend',
      '<div class="stitle"><strong>' + esc(st.name) + '</strong>' +
      (st.poolCount > 1 ? '<em class="srcbadge" title="' + st.poolCount + ' 个播放源可用">🔗' + st.poolCount + '</em>' : '') +
      '<span>' + esc(sub.join(' · ')) + '</span></div>');
    el.appendChild(head);
    el.insertAdjacentHTML('beforeend',
      '<div class="sactions">' +
      (opts.noFav ? '' : '<button data-act="fav" class="icon-btn" title="收藏">' + ico('heart') + '</button>') +
      (opts.canDelete ? '<button data-act="rm" class="icon-btn" title="删除">' + ico('trash') + '</button>' : '') +
      '<button data-act="play" class="play-btn" title="播放">' + ico('play') + '</button>' +
      '</div>');
    if (fav) el.querySelector('[data-act="fav"]').classList.add('on');
    el.querySelector('[data-act="play"]').onclick = function (e) { e.stopPropagation(); play(st); };
    head.onclick = function () { play(st); };
    var fb = el.querySelector('[data-act="fav"]');
    if (fb) fb.onclick = function (e) {
      e.stopPropagation();
      toggleFav(st.id);
      toast(isFav(st.id) ? '已收藏' : '已取消收藏');
      renderAll();
    };
    var rb = el.querySelector('[data-act="rm"]');
    if (rb) rb.onclick = function (e) {
      e.stopPropagation();
      del('/api/stations?id=' + enc(st.id)).then(function (j) {
        state.stations = j.stations; renderAll(); toast('已删除');
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
    var arr = state.stations.filter(function (s) {
      if (cat && (s.group || '未分组') !== cat) return false;
      return matches(s, kw);
    });
    var grid = $('mine-list'), list = $('list-mine');
    grid.innerHTML = ''; list.innerHTML = '';
    arr.forEach(function (st) {
      grid.appendChild(stationCard(st, { canDelete: true }));
      list.appendChild(stationCard(st, { canDelete: true }));
    });
    $('mine-empty').hidden = arr.length > 0 || state.stations.length > 0;
    $('mine-count').textContent = (cat ? '分类「' + cat + '」 ' : '')
      + (kw
        ? '筛选出 ' + arr.length + ' / 共 ' + state.stations.length + ' 个电台'
        : '共 ' + state.stations.length + ' 个电台 · ' + state.sources.length + ' 个订阅源');
    buildCatChips();
  }

  /** 按 group 聚合出分类 chip 栏，点击即筛选「我的电台」 */
  function buildCatChips() {
    var bar = $('cat-chips');
    if (!bar) return;
    var counts = {};
    state.stations.forEach(function (s) {
      var g = s.group || '未分组';
      counts[g] = (counts[g] || 0) + 1;
    });
    var cats = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    bar.innerHTML = '';
    bar.appendChild(catChip('全部', state.stations.length, ''));
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
    $('fav-count').textContent = '共 ' + arr.length + ' 个电台';
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
    $('hist-count').textContent = '共 ' + state.history.length + ' 条记录';
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
      var t = new Date(h.ts);
      var hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      var row = document.createElement('div');
      row.className = 'hist-item';
      row.appendChild(logoNode(h, 'hlogo'));
      row.insertAdjacentHTML('beforeend',
        '<div class="hmeta"><strong>' + esc(h.name) + '</strong>'
        + '<span>' + esc([h.group, h.sourceName].filter(Boolean).join(' · ')) + '</span></div>'
        + '<time>' + hh + '</time>'
        + '<button data-a="play" class="play-btn" title="再听一次">' + ico('play') + '</button>');
      row.querySelector('[data-a="play"]').onclick = function () { play(h); };
      row.querySelector('.hmeta').onclick = function () { play(h); };
      box.appendChild(row);
    });
  }

  function renderSources() {
    var boxes = [$('src-list'), $('src-list-full')].filter(Boolean);
    var countEl = $('src-count');
    if (countEl) countEl.textContent = state.sources.length ? state.sources.length + ' 个' : '';
    var emptyEl = $('src-empty');
    if (emptyEl) emptyEl.hidden = state.sources.length > 0;

    boxes.forEach(function (box) {
      box.innerHTML = '';
      if (!state.sources.length) {
        if (box.id === 'src-list') {
          box.innerHTML = '<div class="empty">还没有订阅源。用下面的输入框加一个 m3u / pls / xspf 列表试试。</div>';
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
    row.innerHTML =
      '<div class="toggle' + (src.enabled === false ? '' : ' on') + '" data-a="en" title="启用/停用"></div>' +
      '<div class="rmeta"><strong>' + esc(src.name) + '</strong>' +
      '<span class="url">' + esc(src.url) + '</span>' +
      '<span class="rmeta-sub">' +
      (src.count ? src.count + ' 个电台' : (src.error ? '<b class="err">' + esc(src.error) + '</b>' : '尚未加载')) +
      (src.lastLoad ? ' · ' + esc(fmtTs(src.lastLoad)) : '') +
      '</span></div>' +
      '<div class="sactions">' +
      '<button data-a="refresh" class="icon-btn" title="重新拉取">' + ico('refresh') + '</button>' +
      '<button data-a="del" class="icon-btn danger" title="删除">' + ico('trash') + '</button>' +
      '</div>';

    var tg = row.querySelector('[data-a="en"]');
    tg.onclick = function () {
      src.enabled = src.enabled === false;
      tg.classList.toggle('on', src.enabled !== false);
      toast(src.enabled === false ? '已停用（仅本地标记）' : '已启用');
    };
    row.querySelector('[data-a="refresh"]').onclick = function () {
      toast('正在拉取…');
      post('/api/sources/refresh', { id: src.id }).then(function (j) {
        state.sources = j.sources; state.stations = j.stations;
        renderAll(); toast('已刷新');
      }).catch(function (e) { toast(String(e.message), true); });
    };
    row.querySelector('[data-a="del"]').onclick = function () {
      del('/api/sources?id=' + enc(src.id)).then(function (j) {
        state.sources = j.sources; state.stations = j.stations;
        renderAll(); toast('已删除');
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
    $('disc-count').textContent = list.length ? '共 ' + list.length + ' 个电台' : '';
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
    $('home-mine-count').textContent = '共 ' + state.stations.length + ' 个电台';
    $('home-empty').hidden = state.stations.length > 0;

    var box = $('home-hist');
    box.innerHTML = '';
    var h = state.history.slice(0, 12);
    $('home-hist-empty').hidden = h.length > 0;
    h.forEach(function (item) {
      var t = new Date(item.ts);
      var hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      var row = document.createElement('div');
      row.className = 'hist-item';
      row.appendChild(logoNode(item, 'hlogo'));
      row.insertAdjacentHTML('beforeend',
        '<div class="hmeta"><strong>' + esc(item.name) + '</strong>'
        + '<span>' + esc([dayKey(item.ts), item.sourceName].filter(Boolean).join(' · ')) + '</span></div>'
        + '<time>' + hh + '</time>'
        + '<button data-a="play" class="play-btn" title="再听一次">' + ico('play') + '</button>');
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
    audio.addEventListener('waiting', function () { setSub('缓冲中…'); });
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
    if (p && current) setSub('正在播放');
  }
  function setSub(t) { $('np-sub').textContent = t; }
  function setSubStatus(t, ok) {
    var el = $('np-sub');
    el.innerHTML = ico(ok ? 'wifi' : 'refresh') + '<span>' + esc(t) + '</span>';
    el.className = 'np-status' + (ok ? ' ok' : '');
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
        var t = data.type;
        if (t === window.Hls.ErrorTypes.NETWORK_ERROR) {
          try { h.startLoad(); } catch (e) { finish(function () { reject(new Error('HLS_NETWORK')); }); }
          return;
        }
        finish(function () { reject(new Error('HLS_' + (t || 'FATAL') + (data.details ? ':' + data.details : ''))); });
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
    $('np-name').textContent = st ? st.name : '未在播放';

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

    var meta = st ? [st.sourceName || st.country, st.group].filter(Boolean).join(' · ') : '';
    $('np-meta').textContent = meta || (st ? '电台' : '选一个电台开始收听');
    var sb = $('btn-src');
    if (sb) {
      var n = (st && st.poolCount) || (st && st.sources ? st.sources.length : 0);
      if (n > 1) { sb.hidden = false; $('np-srcn').textContent = n; }
      else sb.hidden = true;
    }
    if (msg) setSub(msg);
  }

  function play(st, chosenUrl) {
    if (!st || !st.url) return;
    var useUrl = (chosenUrl && st.sources && st.sources.some(function (x) { return x.url === chosenUrl; })) ? chosenUrl : st.url;
    stopAll();
    pushHistory(st);
    setNowPlaying(st, '连接中');
    setPlaying(false);

    var chain = [];
    if (isHls(useUrl)) {
      chain.push({ name: 'HLS 代理', run: function () { return playHls(hlsSrc(useUrl, st.referer)); } });
      chain.push({ name: '原生 HLS', run: function () { return playNative(hlsSrc(useUrl, st.referer)); } });
    }
    chain.push({ name: '直连代理', run: function () { return playNative(proxySrc(useUrl, st.referer)); } });

    var i = 0;
    function next() {
      if (i >= chain.length) {
        setNowPlaying(st);
        setSubStatus('无法播放（试试换个源）', false);
        toast('无法播放：' + st.name, true);
        return;
      }
      var step = chain[i++];
      stopAll();
      setSubStatus('正在连接 · ' + step.name, false);
      step.run().then(function () {
        setNowPlaying(st);
        setSubStatus('正在播放 · ' + step.name, true);
        setPlaying(true);
        refreshCurrentViews();
      }).catch(function (e) {
        console.warn('[jiexiang-radio] ' + step.name + ' 失败：', e && e.message);
        next();
      });
    }
    next();
  }

  function renderSrcMenu(st) {
    var pop = $('src-pop'); if (!pop || !st) return;
    var cur = st.manualUrl || st.url;
    var srcs = (st.sources || []).slice().sort(function (a, b) {
      var oa = (a.ok && !a.dead), ob = (b.ok && !b.dead);
      if (oa !== ob) return oa ? -1 : 1;
      var la = a.latency == null ? 1e9 : a.latency, lb = b.latency == null ? 1e9 : b.latency;
      return la - lb;
    });
    var html = '<div class="srcmenu-h">播放源（按速度排序，绿=可放）</div>';
    srcs.forEach(function (x) {
      var isCur = (x.url === cur);
      var stat = (x.ok === false || x.dead) ? '死链' : (x.ok ? (x.latency != null ? (x.latency + 'ms') : '可放') : '未测');
      html += '<button class="srci' + (isCur ? ' cur' : '') + '" data-u="' + esc(x.url) + '">' +
        '<span class="srci-from">' + esc(x.from || '源') + '</span>' +
        '<span class="srci-stat ' + ((x.ok === false || x.dead) ? 'dead' : (x.ok ? 'ok' : '')) + '">' + stat + '</span></button>';
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
    else if (el.src) { el.play().catch(function (e) { toast('播放被浏览器拦截：' + (e.message || e), true); }); }
    else { play(current); }
  }

  /* ---------------------------------------------------------------- *
   * 事件绑定
   * ---------------------------------------------------------------- */
  function bindTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.addEventListener('click', function () {
        var t = b.dataset.tab;
        if (t === 'search') { openSearch(); return; }
        if (t === 'settings') { go('sources'); return; }
        if (t === 'random') { randomPlay(); return; }
        if (t === 'continue') { continueLast(); return; }
        if (t === 'discover') { go('discover'); if (!discLoaded) doDiscover(); return; }
        go(t);
      });
    });
  }

  function openSearch() {
    go('mine');
    setTimeout(function () { $('q-mine').focus(); }, 30);
  }

  function randomPlay() {
    var pool = state.stations.slice();
    if (!pool.length) return toast('还没有电台，先加个订阅源', true);
    var st = pool[Math.floor(Math.random() * pool.length)];
    toast('随机发现：' + st.name);
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

  /** 语言切换：当前只有中文可用，英文标了「敬请期待」并禁用。
   *  但下拉必须能点开、能选、能关（点外部 / Esc）。这是上一轮用户反馈
   *  「语言也只有中文点击没有反应」的根因——之前那只是个静态 div，没绑定任何事件。 */
  function bindLang() {
    var btn = $('btn-lang');
    var menu = $('lang-menu');
    if (!btn || !menu) return;
    var lang = localStorage.getItem('jxr-lang') || 'zh-CN';

    function labelOf(code) {
      if (code === 'en') return 'English';
      return '简体中文';
    }
    function syncLabel() {
      // 按钮里有「🌐 中文 」文本节点 + 一个 .caret span，只改文本节点
      if (btn.firstChild && btn.firstChild.nodeType === 3) {
        btn.firstChild.textContent = '🌐 ' + labelOf(lang) + ' ';
      }
      qa('[data-lang]', menu).forEach(function (b) {
        b.classList.toggle('on', b.dataset.lang === lang && !b.disabled);
      });
    }
    function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); syncLabel(); }
    function close() { if (!menu.hidden) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } }

    btn.addEventListener('click', function (e) { e.stopPropagation(); if (menu.hidden) open(); else close(); });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    qa('[data-lang]', menu).forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;                 // English：敬请期待，点了不生效
        lang = b.dataset.lang;
        localStorage.setItem('jxr-lang', lang);
        syncLabel();
        close();
        toast('语言已切换为：' + labelOf(lang));
      });
    });

    document.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    syncLabel();
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
      if (!confirm('确定清空收听记录吗？')) return;
      state.history = [];
      localStorage.setItem('jxr-hist', '[]');
      renderHistory(); renderHero();
      toast('已清空记录');
    });

    $('btn-disc').addEventListener('click', doDiscover);
    $('q-disc').addEventListener('keydown', function (e) { if (e.key === 'Enter') doDiscover(); });

    $('btn-play').addEventListener('click', toggle);
    $('vol').addEventListener('input', function () {
      var v = parseInt(this.value, 10) / 100;
      ensureAudio().volume = v;
      localStorage.setItem('jxr-vol', this.value);
    });
    document.addEventListener('keydown', function (e) {
      var t = e.target.tagName;
      if (e.code === 'Space' && t !== 'INPUT' && t !== 'SELECT' && t !== 'TEXTAREA') {
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
    if (!/^https?:\/\//i.test(payload.url)) return toast('地址必须以 http(s):// 开头', true);
    if (!payload.name) payload.name = payload.url.split('/').pop().split('?')[0] || '未命名电台';
    var btn = f.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    post('/api/stations', payload).then(function (j) {
      state.stations = j.stations; renderAll();
      f.reset(); toast('已添加：' + payload.name);
    }).catch(function (err) {
      toast(String(err.message), true);
    }).then(function () { if (btn) btn.disabled = false; });
  }

  /** 新增订阅源 */
  function submitSource(f) {
    var el = f.elements;
    var payload = { name: (el.namedItem('name').value || '').trim(), url: (el.namedItem('url').value || '').trim() };
    if (!/^https?:\/\//i.test(payload.url)) return toast('地址必须以 http(s):// 开头', true);
    var btn = f.querySelector('button[type="submit"]');
    var old = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
    post('/api/sources', payload).then(function (j) {
      state.sources = j.sources; state.stations = j.stations;
      renderAll(); f.reset();
      toast('已添加源');
    }).catch(function (err) {
      toast(String(err.message), true);
    }).then(function () { if (btn) { btn.disabled = false; btn.innerHTML = old; } });
  }

  /** 粘贴 M3U / 纯文本导入 */
  function importPaste(box) {
    if (!box) return toast('找不到粘贴框', true);
    var txt = box.value.trim();
    if (!txt) return toast('先粘贴 M3U 内容', true);
    var re = /#EXTINF[^\n]*,(.*)\r?\n(https?:\/\/[^\s]+)/g;
    var items = [], m;
    while ((m = re.exec(txt)) !== null) items.push({ name: m[1].trim(), url: m[2].trim() });
    if (!items.length) {
      var re2 = /^(https?:\/\/[^\s]+)$/gm;
      while ((m = re2.exec(txt)) !== null) items.push({ name: m[1], url: m[1] });
    }
    if (!items.length) return toast('没解析出有效地址', true);
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
      toast('导入完成：成功 ' + ok + ' 个' + (fail ? '，跳过 ' + fail + ' 个（重复或无效）' : ''));
    });
  }

  /** 导出当前全部电台为 M3U 文件 */
  function exportM3U() {
    var src = state.stations;
    if (!src.length) return toast('没有电台可导出', true);
    var lines = ['#EXTM3U'];
    src.forEach(function (s) {
      var attrs = ' tvg-logo="' + (s.logo || '') + '" group-title="' + (s.group || '') + '"';
      lines.push('#EXTINF:-1' + attrs + ',' + s.name);
      lines.push(s.url);
    });
    var blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jiexiang-radio-' + Date.now() + '.m3u';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('已导出 ' + src.length + ' 个电台');
  }

  /** 清空全部电台（保留订阅源） */
  function clearAllStations() {
    if (!state.stations.length) return toast('本来就是空的');
    if (!confirm('确定清空全部 ' + state.stations.length + ' 个电台吗？订阅源会保留。')) return;
    var chain = Promise.resolve();
    state.stations.slice().forEach(function (s) {
      chain = chain.then(function () {
        return del('/api/stations?id=' + enc(s.id)).then(function (j) { state.stations = j.stations; });
      });
    });
    chain.then(function () { renderAll(); toast('已清空'); });
  }

  function doDiscover() {
    var q = $('q-disc').value.trim();
    var c = $('country').value;
    var ps = new URLSearchParams();
    if (q) ps.set('q', q);
    if (c) ps.set('country', c);
    ps.set('limit', '80');
    $('btn-disc').disabled = true;
    $('disc-empty').textContent = '搜索中…';
    $('disc-empty').hidden = false;
    api('/api/discover?' + ps.toString()).then(function (j) {
      filterText.disc = q;
      renderDisc(j.stations || []);
      discLoaded = true;
      $('disc-empty').textContent = '没有结果，换个关键词试试。';
    }).catch(function (e) {
      toast('搜索失败：' + e.message, true);
      $('disc-empty').textContent = '搜索失败：' + e.message;
      $('disc-empty').hidden = false;
    }).then(function () { $('btn-disc').disabled = false; });
  }

  /* ---------------------------------------------------------------- *
   * 启动
   * ---------------------------------------------------------------- */
  function boot() {
    loadLocal();
    applyTheme();
    applyView();
    bindTabs();
    bindIcons();
    bindLang();
    bindForms();
    $('vol').value = localStorage.getItem('jxr-vol') || '80';
    setNowPlaying(null);
    setSubStatus('选一个电台开始收听', false);
    go('home');

    api('/api/sources').then(function (j) {
      state.sources = j.sources || [];
      state.stations = j.stations || [];
      renderAll();
    }).catch(function (e) {
      $('stat').textContent = '后端连接失败：' + e.message;
    });
  }

  window.jxrPlay = play;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
