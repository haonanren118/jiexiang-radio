#!/usr/bin/env node
/**
 * jiexiang-radio —— 能真正播放的在线电台服务
 *
 * 设计核心：浏览器从头到尾只与本站通信，绝不直连任何外部服务器。
 *   · /hls/...   HLS 重写代理：服务端拉取远端 m3u8，把里面所有 URI
 *                （相对 ts、绝对 CDN 地址、EXT-X-KEY、EXT-X-MAP）
 *                全部改写成本站路径后返回；服务端自行跟随重定向。
 *   · /proxy     通用音频流代理（mp3/aac/ogg 等），支持 Range 与重定向。
 * 因此不存在跨域、证书、混合内容、IP 绑定等浏览器侧问题。
 *
 * 零第三方依赖，仅用 Node 内置模块。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'sources.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT || '15000', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */
const DEFAULT_DB = { sources: [], stations: [], favorites: [] };
let db = Object.assign({}, DEFAULT_DB);

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}

const PRESET_NAME = '国内电台（内置）';
const PRESET_FILE = 'china-radio.m3u';

/* ------------------------------------------------------------------ *
 * hacks.tools FM 收音机源（每日同步 + 离线快照兜底）
 *
 * 数据源真相（探查结论）：
 *   - 用户给的 https://iptv.hacks.tools/content/fm-radio/m3u 是 Next.js 壳，
 *     真实数据在 https://live.hacks.tools/radio/categories/<分类名>.m3u
 *     （中文需 URL 编码）。该端点服务端可直连，返回标准 #EXTM3U，
 *     含 tvg-logo（多为 live.fanmingming.com/radio/，已被 normalizeLogo
 *     改写为可达镜像）与 group-title（=分类名）。
 *   - 全站无单一聚合文件，只有「按分类」的 M3U，所以这里逐分类抓取再合并。
 *   - 没有现成聚合接口，也没有 CORS 需求（服务端抓取），因此用定时器每日同步。
 *   - presets/fm-radio.m3u 是本快照：实时源全挂时仍能保证「内置」可用。
 * ------------------------------------------------------------------ */
const FM_SOURCE_NAME = 'hacks.tools FM 电台（每日同步）';
const FM_BASE = 'https://live.hacks.tools/radio/categories/';
const FM_SNAPSHOT = 'fm-radio.m3u';
/* hacks.tools 的总台/各省电台台标原指向 huangsuming.codeberg.page，但该站点
 * 已整站删除（全部 404）。改用 fanmingming 库按电台纯中文名兜底，走 ghproxy
 * 代理（NAS 国内网络实测唯一能稳定取到的图源）。 */
const FM_FALLBACK_LOGO = 'https://ghproxy.net/https://raw.githubusercontent.com/fanmingming/live/main/radio/';
/* 已知失效的 CNR satellitepull 源（在 NAS 网络逐项实测：上游 404，且先挂起 ~30s
 * 才返回 404 —— 表现为代理 12s 超时「无法播放」）。这些电台在 hacks.tools 里的
 * satellitepull.cnr.cn 链接已失效，统一替换为可用的 蜻蜓FM / 企鹊台(qtfm.cn)
 * 替代源（NAS 实测 HTTP 200 audio/mpeg，可正常播放）。
 * 键为 satellitepull.cnr.cn/live/<id>/ 中的 <id>；每日同步后仍会重新套用本映射。 */
const FM_DEAD_URL_MAP = {
  'wxsccszs':   'https://lhttp.qtfm.cn/live/1111/64k.mp3', // 四川城市之音
  'wxscjjgb':   'https://lhttp.qtfm.cn/live/4927/64k.mp3', // 四川经济广播
  'wxsclyshgb': 'https://lhttp.qtfm.cn/live/4906/64k.mp3', // 四川新闻频率 → 四川新闻广播
  'wxscmjyyt':  'https://lhttp.qtfm.cn/live/1110/64k.mp3'  // 四川岷江音乐 → 四川音乐广播
};
/** 把已失效的 CNR 链接改写为可用的替代源；非匹配 URL 原样返回 */
function fixDeadFmUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const m = /satellitepull\.cnr\.cn\/live\/([^\/]+)\//i.exec(url);
  if (m && FM_DEAD_URL_MAP[m[1]]) return FM_DEAD_URL_MAP[m[1]];
  return url;
}

/* ------------------------------------------------------------------ *
 * 同步后自动连通性检查 + 蜻蜓FM 替代源
 *
 * 设计：每次 FM 同步完成后，逐电台探测其播放 URL 是否还能连通
 * （NAS 实际播放网络，9~12s 内无 2xx 即视为失效）。失效的电台按
 * 电台名去 radio-browser 查 蜻蜓FM / 企鹊台(qtfm.cn) 替代流，并在
 * NAS 侧实测可放后才改写；改写结果按「电台名」持久化到 /data，
 * 每日同步自动保持替换，且重启不丢。
 * ------------------------------------------------------------------ */
const FM_OVERRIDE_FILE = path.join(DATA_DIR, 'fm-overrides.json'); // name -> url | 'NONE'
const FM_HEALTH_FILE = path.join(DATA_DIR, 'fm-health.json');      // url  -> {ok, ts}
const PROBE_TIMEOUT = Math.min(parseInt(process.env.FM_PROBE_TIMEOUT || '12000', 10), 20000);
const FM_REPAIR_CONC = Math.max(parseInt(process.env.FM_REPAIR_CONCURRENCY || '8', 10), 1);
const FM_HEALTH_TTL = parseInt(process.env.FM_HEALTH_TTL || '43200000', 10); // 12h

let fmOverrides = {}; // name -> 替代 url 或 'NONE'（已查无可用）
let fmHealth = {};    // url  -> { ok:boolean, ts:number }

function loadFmAux() {
  try { fmOverrides = JSON.parse(fs.readFileSync(FM_OVERRIDE_FILE, 'utf8')); } catch (e) { fmOverrides = {}; }
  if (!fmOverrides || typeof fmOverrides !== 'object') fmOverrides = {};
  try { fmHealth = JSON.parse(fs.readFileSync(FM_HEALTH_FILE, 'utf8')); } catch (e) { fmHealth = {}; }
  if (!fmHealth || typeof fmHealth !== 'object') fmHealth = {};
}
function saveFmAux() {
  try { fs.writeFileSync(FM_OVERRIDE_FILE, JSON.stringify(fmOverrides)); } catch (e) { /* ignore */ }
  try { fs.writeFileSync(FM_HEALTH_FILE, JSON.stringify(fmHealth)); } catch (e) { /* ignore */ }
}

/** 解析最终播放 URL：先套用已知死链映射，再套用按电台名缓存的替代源 */
function resolveFmUrl(name, url) {
  let u = fixDeadFmUrl(url);
  if (fmOverrides[name] && fmOverrides[name] !== 'NONE') u = fmOverrides[name];
  return u;
}

/** 探测一个流是否连通（NAS 播放网络）。2xx 即视为可用；支持 3xx 重定向跟随 */
function probeStream(url, depth) {
  depth = depth || 0;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(false); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve(false);
    const mod = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity', 'Range': 'bytes=0-4095' },
      rejectUnauthorized: false,
      timeout: PROBE_TIMEOUT
    }, (res) => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && depth < 3) {
        res.resume();
        let nu; try { nu = new URL(res.headers.location, u).href; } catch (e) { return finish(false); }
        return probeStream(nu, depth + 1).then(finish);
      }
      res.destroy();
      finish(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } finish(false); });
    req.on('error', () => finish(false));
    req.end();
  });
}

/** 按电台名去 radio-browser 找可用的 蜻蜓FM/qtfm 替代流；找到且在 NAS 实测可放才返回 */
async function findQtfmReplacement(name) {
  const q = encodeURIComponent(name);
  // NAS 网络实测仅 de1 镜像可达，其余均 ENOTFOUND；只查 de1 避免无谓重试
  for (const base of [RB_MIRRORS[0]]) {
    try {
      const api = base + '/json/stations/search?name=' + q + '&order=votes&reverse=true&limit=12';
      const res = await requestUpstream(api, { Accept: 'application/json' }, 'rblookup');
      if (res.statusCode !== 200) { res.resume(); continue; }
      const buf = await readAll(res);
      const arr = JSON.parse(buf.toString('utf8'));
      const cands = arr
        .map((s) => s.url_resolved || s.url || '')
        .filter((u) => /qtfm\.cn/i.test(u) || /qingting\.fm/i.test(u));
      for (const cu of cands) {
        if (await probeStream(cu)) return cu;
      }
    } catch (e) { /* try next mirror */ }
  }
  return null;
}

/** 把已通过 fixDeadFmUrl 落到 qtfm 的 4 个四川台，按电台名固化进 override 缓存 */
function seedFmOverridesFromStations() {
  const sid = fmSrcId();
  for (const st of db.stations) {
    if (st.sourceId !== sid) continue;
    if (fmOverrides[st.name]) continue;
    if (/qtfm\.cn/i.test(st.url) || /qingting\.fm/i.test(st.url)) fmOverrides[st.name] = st.url;
  }
}

/**
 * 同步完成后全量体检：探测每个 FM 电台连通性，失效的自动换 蜻蜓FM 源。
 * 后台执行，不阻塞同步返回；健康缓存 12h 内复用，避免每日重复探测。
 */
async function repairFmStreams() {
  const sid = fmSrcId();
  const list = db.stations.filter((s) => s.sourceId === sid);
  if (!list.length) return;
  let checked = 0, dead = 0, fixed = 0;
  for (let i = 0; i < list.length; i += FM_REPAIR_CONC) {
    const chunk = list.slice(i, i + FM_REPAIR_CONC);
    await Promise.all(chunk.map(async (st) => {
      const url = st.url;
      // 跳过无 URL 或元数据伪电台（hacks.tools 里混入了 "updateTime: ..." 之类的行）
      if (!url || !/^https?:/i.test(url)) return;
      if (/^updateTime/i.test(st.name || '')) return;
      const h = fmHealth[url];
      if (h && h.ok && (Date.now() - (h.ts || 0)) < FM_HEALTH_TTL) return; // 近期已验证可用
      checked++;
      const ok = await probeStream(url);
      fmHealth[url] = { ok, ts: Date.now() };
      if (ok) return;
      dead++;
      // 1) 已有按名缓存的替代源：实测仍可用就直接换
      const cached = fmOverrides[st.name];
      if (cached && cached !== 'NONE' && cached !== url) {
        if (await probeStream(cached)) {
          st.url = cached; fixed++;
          fmHealth[cached] = { ok: true, ts: Date.now() };
          return;
        }
      }
      // 2) 未查过：去 radio-browser 找 蜻蜓FM 替代
      if (!cached) {
        const rep = await findQtfmReplacement(st.name);
        fmOverrides[st.name] = rep || 'NONE';
        if (rep && rep !== url) {
          st.url = rep; fixed++;
          fmHealth[rep] = { ok: true, ts: Date.now() };
        }
      }
    }));
  }
  if (fixed) saveDB();
  saveFmAux();
  log('fm repair done: checked=%d dead=%d fixed=%d', checked, dead, fixed);
}
/* 本地烘焙台标：沙箱把台标图下载到 presets/logos/，manifest 记录
 * canonical 运行期 URL -> 本地文件名。命中即改写为站内 /logo/ 路径，
 * NAS 运行时不依赖任何外网图床（彻底根治台标加载不出）。播放链路不动。 */
const FM_LOGO_DIR = path.join(__dirname, 'presets', 'logos');
let LOGO_LOCAL = {};
try {
  LOGO_LOCAL = JSON.parse(fs.readFileSync(path.join(FM_LOGO_DIR, 'manifest.json'), 'utf8'));
} catch (e) { LOGO_LOCAL = {}; }
const FM_CATEGORIES = [
  '上海', '云南', '体育频道', '儿童频道', '其他频道', '内蒙古', '北京', '卫视频道',
  '台湾频道', '吉林', '四川', '地方频道', '境外广播', '央视频道', '宁夏', '安徽', '山东', '山西',
  '广东', '广西', '思奥', '总台', '戏曲频道', '数字频道', '新疆', '春晚频道', '江苏', '江西',
  '河北', '河南', '浙江', '海南', '游戏频道', '湖北', '湖南', '澳门频道', '甘肃', '电影频道',
  '直播中国', '福建', '纪录频道', '综合广播', '综艺频道', '网络广播', '西藏', '解说频道', '贵州',
  '辽宁', '重庆', '陕西', '青海', '音乐广播', '音乐频道', '香港频道', '黑龙江'
];

function fmSrcId() {
  return idOf('src', 'fm-hacks-tools');
}

/** 首次启动时把内置的国内电台列表作为默认订阅源放进去 */
function seedDefault() {
  const file = path.join(__dirname, 'presets', PRESET_FILE);
  if (!fs.existsSync(file)) return;
  const src = {
    id: idOf('src', 'preset:' + PRESET_FILE),
    name: PRESET_NAME,
    url: 'file://presets/' + PRESET_FILE,
    local: PRESET_FILE,
    builtin: true,
    enabled: true,
    count: 0,
    lastLoad: '',
    error: ''
  };
  db.sources.push(src);
  loadSource(src).then(() => { saveDB(); log('preset seeded: %d stations', src.count); });
}

function loadDB() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = Object.assign({}, DEFAULT_DB, parsed);
    log('loaded %d sources, %d stations', db.sources.length, db.stations.length);
    migrateLogos();
  } catch (e) {
    db = Object.assign({}, DEFAULT_DB);
    log('no existing data file, starting fresh');
    seedDefault();
  }
}

/**
 * 一次性数据迁移：把历史数据里指向 live.fanmingming.com 的台标
 * 改写到可达镜像。老版本写进 sources.json 的地址不会因为改代码
 * 而自动更新，必须在这里补一刀（否则用户要重新拉一次订阅源才生效）。
 */
function migrateLogos() {
  let n = 0;
  for (const st of db.stations) {
    const fixed = normalizeLogo(st.logo || '');
    if (fixed !== (st.logo || '')) { st.logo = fixed; n++; }
  }
  if (n) {
    log('migrated %d station logos to reachable mirror', n);
    saveDB();
  }
}

let saveTimer = null;
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
      log('save failed: %s', e.message);
    }
  }, 200);
}

function idOf(prefix, s) {
  return prefix + crypto.createHash('md5').update(s).digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * 台标地址归一化
 *
 * 内置列表里的 tvg-logo 全部指向 live.fanmingming.com，但该域名在
 * 中国大陆的多数宽带（含本 NAS 所在网络）上完全不可达 —— TCP 能连上
 * 却一直不返回数据，最终 15s 超时。结果是浏览器 <img> 全部失败，
 * 页面看起来「台标全没了」。
 *
 * 同一批图片在 GitHub 仓库 fanmingming/live 里是公开的，国内的
 * jsdelivr 镜像可达且更快，因此统一改写到镜像地址。原域名保留在
 * 末尾作为兜底（万一镜像哪天挂了）。
 * ------------------------------------------------------------------ */
/* NAS（国内网络）实测：live.fanmingming.com / jsdelivr / raw.githubusercontent
 * 均不可达或超时；仅 ghproxy.net 与 gh-proxy.com 这两个 GitHub 代理能稳定取到
 * fanmingming 台标（1~4s）。统一改写到主代理，handleImg 内再带备用代理兜底。 */
const LOGO_PRIMARY = 'https://ghproxy.net/https://raw.githubusercontent.com/fanmingming/live/main/radio/';
const LOGO_ALT = 'https://gh-proxy.com/https://raw.githubusercontent.com/fanmingming/live/main/radio/';

/** 把已知不可达的图床地址改写为可达镜像；其它地址原样保留 */
function normalizeLogo(url) {
  if (!url || typeof url !== 'string') return '';
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return u;
  const m = /^https?:\/\/live\.fanmingming\.com\/radio\/(.+)$/i.exec(u);
  if (m) return LOGO_PRIMARY + m[1];
  // 源里直接写成 jsdelivr 镜像的 fanmingming 台标（NAS 同样不可达）→ 也改 ghproxy
  const j = /^https?:\/\/(?:fastly|cdn)\.jsdelivr\.net\/gh\/fanmingming\/live@[^/]+\/radio\/(.+)$/i.exec(u);
  if (j) return LOGO_PRIMARY + j[1];
  return u;
}

/** fanmingming 台标在两个 GitHub 代理间互换（handleImg 兜底用） */
function fanmingmingAlt(url) {
  if (!url) return url;
  if (url.indexOf('ghproxy.net') >= 0) return url.replace('ghproxy.net', 'gh-proxy.com');
  if (url.indexOf('gh-proxy.com') >= 0) return url.replace('gh-proxy.com', 'ghproxy.net');
  return url;
}

/** 剥掉 codeberg 台标里的拉丁前缀（CNR-/CMG-/CRI- 等），用纯中文名去
 *  fanmingming 匹配。仅当剩余部分含中文时才剥，避免误伤 HITFM 这类全拉丁名。 */
function cleanRadioName(n) {
  if (!n) return n;
  const m = /^([A-Za-z][A-Za-z0-9]*)[-\s]+(.+)$/.exec(n.trim());
  if (m && /[一-鿿]/.test(m[2])) return m[2].trim();
  return n;
}

/** 台标图片也走服务端代理：浏览器不直连任何外部站点，302 由服务端跟随 */
function proxyLogo(url) {
  if (!url) return '';
  return '/img?url=' + encodeURIComponent(url);
}

function log() {
  const msg = require('util').format.apply(null, arguments);
  process.stdout.write(new Date().toISOString() + ' ' + msg + '\n');
}

const LOG_REQUESTS = process.env.LOG_REQUESTS !== '0';

function describeTarget(targetUrl) {
  try { return decodeURIComponent(targetUrl).slice(0, 160); }
  catch (e) { return String(targetUrl).slice(0, 160); }
}

/** 记录每个请求的结果、耗时、走到第几次尝试 —— 排查「播不出声」必备 */
function accessLog(scope, targetUrl, result) {
  if (!LOG_REQUESTS) return;
  log('[%s] %d %sms tries=%d %s',
    scope, result.status, result.ms, result.tries || 1, describeTarget(targetUrl));
}

/** 连接超时（对端不响应时多久放弃）。见 requestOnce 的注释。 */
const CONNECT_TIMEOUT = Math.min(parseInt(process.env.CONNECT_TIMEOUT || '12000', 10), 60000);

/**
 * 一次上游请求。
 *
 * 注意：这里**不再自己钉 IP**。曾试过用 opts.lookup 把连接固定到
 * dns.lookup(all:true) 返回的某个地址，结果 TLS 会静默挂到超时
 * （命令行 curl 同一地址 0.05s 就返回 404，走这段代码却要等满 6s）。
 * 交回给 Node 自己解析 —— 和 curl 行为一致。
 *
 * 重试只针对「连不上」，不针对「服务器明确答复」。
 */
async function requestOnce(targetUrl, extraHeaders, redirects) {
  redirects = redirects || 0;
  let u;
  try {
    u = new URL(targetUrl);
  } catch (e) {
    throw new Error('invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('unsupported protocol');
  }

  const mod = u.protocol === 'https:' ? https : http;
  // 注意：不要加 'Connection: close'。
  // 实测该头会让部分源（如 satellitepull.cnr.cn 直连返回 404 时的路径）
  // 的连接请求被服务端静默挂住直到超时；去掉后同一地址 75ms 即返回。
  const headers = Object.assign({
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Encoding': 'identity'
  }, extraHeaders || {});

  const res = await new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: 'GET',
      headers,
      // 不少电台 CDN 的证书是自签名或已过期，严格要求会让它们全部播不了
      rejectUnauthorized: false,
      timeout: CONNECT_TIMEOUT
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('timeout ' + CONNECT_TIMEOUT + 'ms')));
    req.on('error', reject);
    req.end();
  });

  const loc = res.headers.location;
  if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && loc && redirects < 5) {
    res.resume();
    let next;
    try {
      next = new URL(loc, u).href;
    } catch (e) {
      throw new Error('bad redirect');
    }
    log('redirect -> %s', next);
    return await requestOnce(next, extraHeaders, redirects + 1);
  }

  // 4xx 是服务器的明确答复（如 404 频道已下线），重试毫无意义，直接交给上层
  if (res.statusCode >= 400 && res.statusCode < 500) {
    res.resume();
    const err = new Error('HTTP ' + res.statusCode);
    err.statusCode = res.statusCode;
    throw err;
  }

  return res;
}

/* ------------------------------------------------------------------ *
 * 上游请求：多 IP 重试 + 跟随重定向 + 容忍证书问题，并记录访问日志
 * ------------------------------------------------------------------ */
async function requestUpstream(targetUrl, extraHeaders, scope) {
  const t0 = Date.now();
  try {
    const res = await requestOnce(targetUrl, extraHeaders, 0);
    accessLog(scope || 'up', targetUrl, {
      status: res.statusCode, ms: Date.now() - t0, tries: res.__tries || 1
    });
    return res;
  } catch (e) {
    const st = e.statusCode || -1;
    accessLog(scope || 'up', targetUrl, { status: st, ms: Date.now() - t0, tries: 1 });
    log('  └─ 失败原因: %s%s',
      e.message,
      st === 404 ? '（该频道上游已下线，重试无用）' : '');
    throw e;
  }
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

function decompress(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch (e) { /* 解压失败就当原文 */ }
  return buf;
}

/* ------------------------------------------------------------------ *
 * 播放列表解析：M3U / PLS / ASX / XSPF / JSON / 纯文本
 * ------------------------------------------------------------------ */
function resolveUrl(maybe, baseUrl) {
  try {
    return new URL(maybe, baseUrl).href;
  } catch (e) {
    return null;
  }
}

function attr(attrs, key) {
  const re = new RegExp(key + '\\s*=\\s*"([^"]*)"', 'i');
  const m = re.exec(attrs);
  return m ? m[1] : '';
}

function parseM3U(text, baseUrl) {
  const out = [];
  let cur = null;
  let referer = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // #EXTVLCOPT:http-referrer=https://xxx   —— 很多国内电台列表用它防盗链
    let m = /^#EXTVLCOPT\s*:\s*(?:http-referrer|http-referer)\s*=\s*(.+)$/i.exec(line);
    if (m) { referer = m[1].trim(); continue; }
    m = /^#KODIPROP\s*:\s*(.+)$/i.exec(line);
    if (m) {
      const rm = /(?:referrer|referer)\s*=\s*(.+)/i.exec(m[1]);
      if (rm) referer = rm[1].trim();
      continue;
    }

    if (line.toUpperCase().indexOf('#EXTINF') === 0) {
      const comma = line.indexOf(',');
      const name = comma >= 0 ? line.slice(comma + 1).trim() : '';
      const attrs = comma >= 0 ? line.slice(0, comma) : line;
      let logo = normalizeLogo(attr(attrs, 'tvg-logo') || '');
      // codeberg 死链 → fanmingming 按电台纯中文名兜底（ghproxy 代理，国内可达）
      if (logo && /huangsuming\.codeberg\.page/i.test(logo) && name) {
        logo = FM_FALLBACK_LOGO + encodeURIComponent(cleanRadioName(name)) + '.png';
      }
      // 命中本地烘焙台标则改写为站内路径，运行时不再依赖外网图床
      if (LOGO_LOCAL[logo]) logo = '/logo/' + LOGO_LOCAL[logo];
      cur = {
        name,
        group: attr(attrs, 'group-title') || '',
        logo,
        referer
      };
      continue;
    }
    if (line.charAt(0) === '#') continue;
    const abs = resolveUrl(line, baseUrl);
    if (abs) {
      out.push({
        name: (cur && cur.name) || line,
        url: abs,
        group: cur ? cur.group : '',
        logo: cur ? cur.logo : '',
        referer: cur ? cur.referer : referer
      });
      cur = null;
      referer = '';
    }
  }
  return out;
}

function parsePLS(text, baseUrl) {
  const out = [];
  const re = /^File(\d+)\s*=\s*(.+)$/i;
  const files = {};
  const titles = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = re.exec(line);
    if (m) { files[m[1]] = m[2].trim(); continue; }
    m = /^Title(\d+)\s*=\s*(.+)$/i.exec(line);
    if (m) titles[m[1]] = m[2].trim();
  }
  for (const k of Object.keys(files)) {
    const abs = resolveUrl(files[k], baseUrl);
    if (abs) out.push({ name: titles[k] || files[k], url: abs, group: '', logo: '' });
  }
  return out;
}

function parseASX(text, baseUrl) {
  const out = [];
  const re = /<entry\b[\s\S]*?<\/entry>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[0];
    const href = /<ref[^>]+href\s*=\s*["']([^"']+)["']/i.exec(block);
    if (!href) continue;
    const abs = resolveUrl(href[1], baseUrl);
    if (!abs) continue;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    out.push({ name: title ? title[1].trim() : href[1], url: abs, group: '', logo: '' });
  }
  if (!out.length) {
    const refs = text.match(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi) || [];
    for (const r of refs) {
      const u = /["'](https?:\/\/[^"']+)["']/i.exec(r);
      if (u) out.push({ name: u[1], url: u[1], group: '', logo: '' });
    }
  }
  return out;
}

function parseXSPF(text, baseUrl) {
  const out = [];
  const re = /<track\b[\s\S]*?<\/track>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[0];
    const loc = /<location[^>]*>([\s\S]*?)<\/location>/i.exec(block);
    if (!loc) continue;
    const abs = resolveUrl(loc[1].trim(), baseUrl);
    if (!abs) continue;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    out.push({ name: title ? title[1].trim() : abs, url: abs, group: '', logo: '' });
  }
  return out;
}

function parseJSON(text, baseUrl) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : (Array.isArray(data.stations) ? data.stations : null);
  if (!arr) return [];
  const out = [];
  for (const it of arr) {
    if (!it || !it.url) continue;
    const abs = resolveUrl(it.url, baseUrl);
    if (!abs) continue;
    out.push({
      name: it.name || abs,
      url: abs,
      group: it.group || '',
      logo: it.logo || it.favicon || ''
    });
  }
  return out;
}

function parseTextLines(text, baseUrl) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') continue;
    let name = null;
    let url = line;
    if (line.indexOf(',') > 0 && /^[^,]{1,80},https?:\/\//i.test(line)) {
      const i = line.indexOf(',');
      name = line.slice(0, i).trim();
      url = line.slice(i + 1).trim();
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const abs = resolveUrl(url, baseUrl);
    if (abs) out.push({ name: name || abs, url: abs, group: '', logo: '' });
  }
  return out;
}

/** 按内容自动识别格式并解析 */
function parsePlaylist(text, baseUrl) {
  const head = text.slice(0, 2000).trim();
  if (head.indexOf('[playlist]') === 0) return parsePLS(text, baseUrl);
  if (/^<\?xml/i.test(head) || /<playlist[^>]*version\s*=\s*"1"/i.test(head) || head.indexOf('<asx') === 0) {
    if (/<asx/i.test(head)) return parseASX(text, baseUrl);
    return parseXSPF(text, baseUrl);
  }
  if (head.charAt(0) === '{') return parseJSON(text, baseUrl);
  if (/#EXTM3U|#EXTINF/i.test(head)) return parseM3U(text, baseUrl);
  return parseTextLines(text, baseUrl);
}

/* ------------------------------------------------------------------ *
 * HLS 重写
 * ------------------------------------------------------------------ */
/** 绝对 URL -> /hls/<百分号编码的完整 URL>（与前端 hlsSrc() 必须完全一致） */
function toHlsPath(absUrl) {
  return '/hls/' + encodeURIComponent(absUrl);
}

/** 给代理路径带上防盗链 Referer，保证下层 URI 也能被正确拉取 */
function withRef(hlsPath, referer) {
  if (!referer) return hlsPath;
  return hlsPath + (hlsPath.indexOf('?') >= 0 ? '&' : '?') + 'ref=' + encodeURIComponent(referer);
}

/** 重写一个 m3u8 文本里的所有 URI 为本站路径 */
function rewriteM3U(text, baseUrl, referer) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }

    if (t.charAt(0) === '#') {
      // #EXT-X-KEY:METHOD=AES-128,URI="..."
      // #EXT-X-MAP:URI="..."
      if (/URI\s*=\s*"/i.test(t)) {
        out.push(t.replace(/URI\s*=\s*"([^"]+)"/i, (whole, u) => {
          const abs = resolveUrl(u, baseUrl);
          return abs ? 'URI="' + withRef(toHlsPath(abs), referer) + '"' : whole;
        }));
      } else {
        out.push(line);
      }
      continue;
    }

    // 媒体条目（ts / 子 playlist）
    const abs = resolveUrl(t, baseUrl);
    out.push(abs ? withRef(toHlsPath(abs), referer) : line);
  }
  return out.join('\n');
}

function isPlaylistByUrl(u) {
  return /\.m3u8(\?|$)/i.test(u);
}

/* ------------------------------------------------------------------ *
 * HTTP 响应工具
 * ------------------------------------------------------------------ */
function sendJSON(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, code, msg) {
  sendJSON(res, { error: msg }, code);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * 订阅源
 * ------------------------------------------------------------------ */
async function loadSource(src) {
  if (src.fm) return await loadFmRadio(src);
  try {
    src.error = '';
    let text;
    if (src.local) {
      // 内置预置列表直接读本地文件
      text = fs.readFileSync(path.join(__dirname, 'presets', src.local), 'utf8');
    } else {
      const res = await requestUpstream(src.url, { Accept: '*/*' }, 'source');
      if (res.statusCode !== 200) {
        src.error = 'HTTP ' + res.statusCode;
        return 0;
      }
      const buf = await readAll(res);
      text = decompress(buf, (res.headers['content-encoding'] || '').toLowerCase())
        .toString('utf8');
    }
    const items = parsePlaylist(text, src.url);

    db.stations = db.stations.filter((s) => s.sourceId !== src.id);
    let n = 0;
    for (const it of items) {
      const id = idOf('st', it.url);
      if (db.stations.some((s) => s.id === id)) {
        // 同 URL 已存在则补上来源标记，不重复添加
        const exist = db.stations.find((s) => s.id === id);
        if (!exist.sourceId) exist.sourceId = src.id;
        continue;
      }
      db.stations.push({
        id,
        name: it.name,
        url: it.url,
        logo: normalizeLogo(it.logo || ''),
        group: it.group || '',
        sourceId: src.id,
        sourceName: src.name,
        referer: it.referer || '',
        addedAt: new Date().toISOString()
      });
      n++;
    }
    src.count = n;
    src.lastLoad = new Date().toISOString();
    if (!n) src.error = '解析出 0 个电台（文件可能为空或格式不支持）';
    log('source %s -> %d stations', src.name, n);
    return n;
  } catch (e) {
    src.error = e.message || String(e);
    log('source %s failed: %s', src.name, src.error);
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * hacks.tools FM 收音机源：逐分类抓取 + 合并 + 去重，失败回退离线快照
 * ------------------------------------------------------------------ */
function ensureFmSource() {
  const id = fmSrcId();
  if (!db.sources.some((s) => s.id === id)) {
    db.sources.push({
      id,
      name: FM_SOURCE_NAME,
      url: 'fm://hacks-tools',
      builtin: true,
      fm: true,
      remote: true,
      enabled: true,
      count: 0,
      lastLoad: '',
      error: ''
    });
  }
  return db.sources.find((s) => s.id === id);
}

/**
 * 逐分类抓取 hacks.tools FM 源。
 * 任一分类失败（404 / 超时）不影响其它分类；全部失败则用 presets/fm-radio.m3u 兜底。
 */
async function loadFmRadio(src) {
  try {
    src.error = '';
    const items = [];
    const seen = new Set();
    let okCats = 0;
    let failCats = 0;

    for (const cat of FM_CATEGORIES) {
      const url = FM_BASE + encodeURIComponent(cat) + '.m3u';
      try {
        const res = await requestUpstream(url, { Accept: '*/*' }, 'fmsrc');
        if (res.statusCode !== 200) {
          res.resume();
          failCats++;
          continue;
        }
        const buf = await readAll(res);
        const text = decompress(buf, (res.headers['content-encoding'] || '').toLowerCase())
          .toString('utf8');
        const parsed = parseM3U(text, url);
        for (const it of parsed) {
          const key = idOf('st', it.url);
          if (seen.has(key)) continue;
          seen.add(key);
        items.push({
          url: resolveFmUrl(it.name, it.url),
          name: it.name,
          group: it.group || cat,
            logo: it.logo,
            referer: it.referer || ''
          });
        }
        okCats++;
      } catch (e) {
        failCats++;
        log('fm category %s failed: %s', cat, e.message);
      }
    }

    if (items.length) {
      db.stations = db.stations.filter((s) => s.sourceId !== src.id);
      for (const it of items) {
        db.stations.push({
          id: idOf('st', it.url),
          name: it.name,
          url: resolveFmUrl(it.name, it.url),
          logo: normalizeLogo(it.logo || ''),
          group: it.group || '',
          sourceId: src.id,
          sourceName: src.name,
          referer: it.referer || '',
          addedAt: new Date().toISOString()
        });
      }
      src.count = items.length;
      src.lastLoad = new Date().toISOString();
      src.error = okCats + '/' + FM_CATEGORIES.length + ' 分类已同步'
        + (failCats ? ('，' + failCats + ' 个暂无数据') : '');
      log('fm radio -> %d stations (%d cats ok, %d fail)', items.length, okCats, failCats);
      return items.length;
    }

    /* 实时源全挂：用离线快照兜底，保证「内置」始终有数据 */
    const snap = path.join(__dirname, 'presets', FM_SNAPSHOT);
    if (fs.existsSync(snap)) {
      const text = fs.readFileSync(snap, 'utf8');
      const parsed = parseM3U(text, 'file://presets/' + FM_SNAPSHOT);
      db.stations = db.stations.filter((s) => s.sourceId !== src.id);
      let n = 0;
      for (const it of parsed) {
        const id = idOf('st', it.url);
        if (db.stations.some((s) => s.id === id)) {
          const ex = db.stations.find((s) => s.id === id);
          if (!ex.sourceId) ex.sourceId = src.id;
          continue;
        }
        db.stations.push({
          id,
          name: it.name,
          url: resolveFmUrl(it.name, it.url),
          logo: normalizeLogo(it.logo || ''),
          group: it.group || '',
          sourceId: src.id,
          sourceName: src.name,
          referer: it.referer || '',
          addedAt: new Date().toISOString()
        });
        n++;
      }
      src.count = n;
      src.lastLoad = new Date().toISOString();
      src.error = '实时源暂不可达，已用离线快照（' + n + ' 个）';
      log('fm radio fallback snapshot -> %d', n);
      return n;
    }

    src.error = '实时源与离线快照均无数据';
    return 0;
  } catch (e) {
    src.error = e.message || String(e);
    log('fm radio failed: %s', src.error);
    return 0;
  }
}

/** 每日自动同步一次 hacks.tools FM 源（可用 FM_SYNC_HOURS 覆盖间隔，默认 24） */
function scheduleFmSync() {
  const hours = Math.max(parseInt(process.env.FM_SYNC_HOURS || '24', 10), 1);
  const ms = hours * 3600 * 1000;
  setInterval(() => {
    const s = db.sources.find((x) => x.id === fmSrcId());
    if (s) loadFmRadio(s).then(() => { seedFmOverridesFromStations(); saveDB(); repairFmStreams(); });
  }, ms);
  log('fm sync scheduled every %d h', hours);
}

/* ------------------------------------------------------------------ *
 * radio-browser（global-radio 使用的数据源）
 * ------------------------------------------------------------------ */
const RB_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://us1.api.radio-browser.info',
  'https://fr1.api.radio-browser.info',
  'https://all.api.radio-browser.info'
];
let goodMirror = RB_MIRRORS[0];

async function discover(params) {
  const q = new URLSearchParams();
  q.set('hidebroken', 'true');
  q.set('limit', String(params.limit || 60));
  q.set('order', 'votes');
  q.set('reverse', 'true');
  if (params.country) q.set('countrycode', params.country);
  if (params.q) { q.set('name', params.q); q.delete('countrycode'); }
  else if (params.countryFree) q.set('country', params.countryFree);

  // 先用上次成功的镜像，失败再逐个尝试
  const order = [goodMirror].concat(RB_MIRRORS.filter((m) => m !== goodMirror));
  const pathOnly = '/json/stations/search?' + q.toString();

  for (const base of order) {
    try {
      const res = await requestUpstream(base + pathOnly, { Accept: 'application/json' }, 'rb');
      if (res.statusCode !== 200) { res.resume(); continue; }
      const buf = await readAll(res);
      const text = decompress(buf, (res.headers['content-encoding'] || '').toLowerCase()).toString('utf8');
      const arr = JSON.parse(text);
      goodMirror = base;
      return arr.map((s) => ({
        id: idOf('rb', s.stationuuid || s.url),
        name: (s.name || '').trim() || s.url,
        url: s.url_resolved || s.url,
        logo: s.favicon ? normalizeLogo(s.favicon) : '',
        group: s.tags || '',
        country: s.country || '',
        codec: s.codec || '',
        bitrate: s.bitrate || 0,
        kind: 'radio-browser'
      }));
    } catch (e) {
      continue;
    }
  }
  throw new Error('所有 radio-browser 镜像均不可用');
}

/* ------------------------------------------------------------------ *
 * 静态资源
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  fs.readFile(full, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return res.writeHead(404).end('not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * 代理：HLS 重写 / 通用流
 * ------------------------------------------------------------------ */
async function handleHls(req, res, pathname, search) {
  let target;
  try {
    const rest = decodeURIComponent(pathname.slice('/hls/'.length));
    target = rest + (search || '');
  } catch (e) {
    return sendError(res, 400, 'bad path');
  }
  if (!/^https?:\/\//i.test(target)) return sendError(res, 400, 'bad scheme');

  const referer = new URLSearchParams(search || '').get('ref');
  const extra = { Accept: '*/*' };
  if (referer) extra.Referer = referer;
  if (req.headers.range) extra.Range = req.headers.range;

  let upstream;
  try {
    upstream = await requestUpstream(target, extra, 'hls');
  } catch (e) {
    return sendError(res, 502, 'upstream: ' + e.message);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');

  const ctype = (upstream.headers['content-type'] || '').toLowerCase();
  const wantsRewrite = isPlaylistByUrl(target) || /mpegurl|m3u/i.test(ctype);

  if (!wantsRewrite) {
    // ts / key / 二进制：原样流式转发
    const pass = {};
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (upstream.headers[k]) pass[k] = upstream.headers[k];
    }
    res.writeHead(upstream.statusCode, pass);
    upstream.pipe(res);
    return;
  }

  const buf = await readAll(upstream);
  const text = decompress(buf, (upstream.headers['content-encoding'] || '').toLowerCase()).toString('utf8');
  const rewritten = rewriteM3U(text, target, referer);
  const body = Buffer.from(rewritten, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * 台标图片代理
 *
 * 与 /proxy 的区别：这里专门处理图片，会跟随 301/302（jsdelivr 会对
 * /gh/ 路径返回 301），并且失败时返回一个内置的 SVG 占位图而不是 502，
 * 这样前端 <img> 永远不会出现「破图」图标。
 * ------------------------------------------------------------------ */
const PLACEHOLDER_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
  '<rect width="96" height="96" rx="22" fill="#2a3140"/>' +
  '<text x="48" y="62" font-size="46" text-anchor="middle">\u{1F4FB}</text></svg>', 'utf8');

async function handleImg(req, res, search) {
  const params = new URLSearchParams(search || '');
  let target = params.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return sendError(res, 400, 'missing or invalid url');
  }
  target = normalizeLogo(target);

  let upstream;
  try {
    upstream = await requestUpstream(target, { Accept: 'image/*,*/*' }, 'img');
  } catch (e) {
    // 兜底：fanmingming 台标换备用 GitHub 代理再试一次
    const alt = fanmingmingAlt(target);
    if (alt && alt !== target) {
      try { upstream = await requestUpstream(alt, { Accept: 'image/*,*/*' }, 'img'); }
      catch (e2) { upstream = null; }
    }
    if (!upstream) {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=120',
        'X-Logo-Fallback': e.message || 'error'
      });
      return res.end(PLACEHOLDER_SVG);
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  const pass = { 'Cache-Control': 'public, max-age=86400' };
  for (const k of ['content-type', 'content-length', 'etag', 'last-modified']) {
    if (upstream.headers[k]) pass[k] = upstream.headers[k];
  }
  if (!pass['content-type'] || /text\/|json/.test(pass['content-type'])) {
    // 上游给了错误页而不是图片 → 用占位图，避免前端出现破图
    upstream.resume();
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=120',
      'X-Logo-Fallback': 'not-an-image'
    });
    return res.end(PLACEHOLDER_SVG);
  }
  res.writeHead(upstream.statusCode, pass);
  upstream.pipe(res);
}

async function handleProxy(req, res, search) {
  const params = new URLSearchParams(search || '');
  const target = params.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return sendError(res, 400, 'missing or invalid url');
  }
  const referer = params.get('ref');
  const extra = { Accept: '*/*' };
  if (referer) extra.Referer = referer;
  if (req.headers.range) extra.Range = req.headers.range;

  let upstream;
  try {
    upstream = await requestUpstream(target, extra, 'proxy');
  } catch (e) {
    return sendError(res, 502, 'upstream: ' + e.message);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');

  const pass = {};
  for (const k of ['content-type', 'content-length', 'content-range']) {
    if (upstream.headers[k]) pass[k] = upstream.headers[k];
  }
  if (upstream.statusCode === 206) {
    res.writeHead(206, pass);
  } else if (upstream.statusCode === 200 && req.headers.range) {
    // 源站不支持 Range 却收到 Range 请求时，至少不要返回误导性的 206
    res.writeHead(200, pass);
  } else {
    res.writeHead(upstream.statusCode, pass);
  }
  upstream.pipe(res);
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    /* ---------- 本地烘焙台标（静态，不走外网） ---------- */
    if (p.indexOf('/logo/') === 0) {
      const f = path.basename(p.slice(6));
      const fp = path.join(FM_LOGO_DIR, f);
      if (f && fp.indexOf(FM_LOGO_DIR + path.sep) === 0 && fs.existsSync(fp)) {
        const ext = path.extname(f).toLowerCase();
        const ct = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
        return fs.createReadStream(fp).pipe(res);
      }
      res.writeHead(404); return res.end('not found');
    }

    /* ---------- 代理 ---------- */
    if (p.indexOf('/hls/') === 0) return await handleHls(req, res, p, u.search);
    if (p === '/img') return await handleImg(req, res, u.search);
    if (p === '/proxy') return await handleProxy(req, res, u.search);

    /* ---------- 健康检查 ---------- */
    if (p === '/api/health') {
      return sendJSON(res, {
        ok: true,
        sources: db.sources.length,
        stations: db.stations.length,
        mirror: goodMirror,
        dataFile: DATA_FILE
      });
    }

    /* ---------- 订阅源 ---------- */
    if (p === '/api/sources') {
      if (req.method === 'GET') return sendJSON(res, { sources: db.sources, stations: db.stations });
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!body.url || !/^https?:\/\//i.test(body.url)) return sendError(res, 400, 'url 无效');
        const id = idOf('src', body.url);
        if (db.sources.some((s) => s.id === id)) return sendError(res, 409, '该源已存在');
        const src = {
          id,
          name: (body.name || '').trim() || body.url,
          url: body.url,
          enabled: true,
          count: 0,
          lastLoad: '',
          error: ''
        };
        db.sources.push(src);
        await loadSource(src);
        saveDB();
        return sendJSON(res, { source: src, stations: db.stations });
      }
      if (req.method === 'DELETE') {
        const id = u.searchParams.get('id');
        db.sources = db.sources.filter((s) => s.id !== id);
        db.stations = db.stations.filter((s) => s.sourceId !== id);
        saveDB();
        return sendJSON(res, { ok: true, sources: db.sources, stations: db.stations });
      }
    }

    if (p === '/api/sources/refresh' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const targets = body.id
        ? db.sources.filter((s) => s.id === body.id)
        : db.sources.slice();
      for (const s of targets) await loadSource(s);
      saveDB();
      return sendJSON(res, { sources: db.sources, stations: db.stations });
    }

    /* ---------- 单个电台 ---------- */
    if (p === '/api/stations') {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!body.url || !/^https?:\/\//i.test(body.url)) return sendError(res, 400, 'url 无效');
        const id = idOf('st', body.url);
        if (db.stations.some((s) => s.id === id)) return sendError(res, 409, '该电台已存在');
        db.stations.unshift({
          id,
          name: (body.name || '').trim() || body.url,
          url: body.url,
          logo: normalizeLogo(body.logo || ''),
          group: body.group || '',
          // 由调用方指明来源，便于区分「手动添加」与「粘贴导入」
          sourceName: (body.sourceName || '').trim() || '手动添加',
          addedAt: new Date().toISOString()
        });
        saveDB();
        return sendJSON(res, { stations: db.stations });
      }
      if (req.method === 'DELETE') {
        const id = u.searchParams.get('id');
        db.stations = db.stations.filter((s) => s.id !== id);
        saveDB();
        return sendJSON(res, { stations: db.stations });
      }
    }

    /* ---------- 收藏 ---------- */
    if (p === '/api/favorites' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const list = new Set(db.favorites);
      if (list.has(body.id)) list.delete(body.id); else list.add(body.id);
      db.favorites = Array.from(list);
      saveDB();
      return sendJSON(res, { favorites: db.favorites });
    }

    /* ---------- radio-browser ---------- */
    if (p === '/api/discover') {
      let list;
      try {
        list = await discover({
          q: u.searchParams.get('q') || '',
          country: u.searchParams.get('country') || '',
          countryFree: u.searchParams.get('countryName') || '',
          limit: parseInt(u.searchParams.get('limit') || '60', 10)
        });
      } catch (e) {
        return sendError(res, 502, e.message);
      }
      return sendJSON(res, { stations: list });
    }

    /* ---------- 尝试在本地收藏中匹配，便于播放 ---------- */
    if (p === '/api/resolve') {
      return sendJSON(res, {
        stations: db.stations.filter((s) => {
          const k = (u.searchParams.get('q') || '').toLowerCase();
          if (!k) return true;
          return (s.name || '').toLowerCase().indexOf(k) >= 0;
        })
      });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    log('handler error: %s', e.stack || e.message);
    if (!res.headersSent) sendError(res, 500, e.message || 'internal error');
  }
});

loadDB();
/* 内置 hacks.tools FM 源：启动即拉取一次（后台，不阻塞监听），并每日自动同步 */
loadFmAux(); // 载入按名缓存的替代源与健康状态
const fmSrc = ensureFmSource();
loadFmRadio(fmSrc).then(() => { seedFmOverridesFromStations(); saveDB(); repairFmStreams(); log('fm radio seeded'); });
scheduleFmSync();

server.listen(PORT, '0.0.0.0', () => {
  log('jiexiang-radio listening on %d, data=%s', PORT, DATA_FILE);
});
