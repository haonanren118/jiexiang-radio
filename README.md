# 📻 jiexiang-radio 杰翔电台

> **网络电台 · 在线电台 · 网络收音机 · Internet Radio · Online Radio · Web Radio**

一个**能真正播放**的在线电台 Web 播放器（Docker 一键部署），单个容器搞定。

内置 [RadioDroid](https://github.com/segler-alex/RadioDroid)（数据源为 [radio-browser](https://www.radio-browser.info/) 全球电台库，global-radio 使用的同一个数据源），
同时支持添加任意自定义订阅源，**多种播放列表格式全支持**，并且内置服务端代理，**不存在跨域 / 证书 / 混合内容 / IP 绑定导致的播不出声**。

---

## 为什么它能播，而很多同类项目播不出

浏览器比 PotPlayer 之类本地播放器严格得多，常见的坑有三个：

| 问题 | 表现 | 本项目做法 |
| --- | --- | --- |
| 原生 `<audio>` 不支持 HLS | `.m3u8` 点了没反应 / 一直转圈 | 内置 vendored [hls.js](https://github.com/video-dev/hls.js)，自动识别走 HLS 分支 |
| 跨域（CORS） | 控制台一片 `Access-Control-Allow-Origin` 报错 | 服务端代理，所有请求同源，浏览器从不直连外部源 |
| master m3u8 跳 CDN + token | 四川 / CNR 这类源播到一半断 | 服务端**重写整个 m3u8**：子列表、ts 分片、`EXT-X-KEY`、`EXT-X-MAP` 全部改写成 `/hls/...`，服务端自行跟随 301/302 重定向 |

一句话：**浏览器只跟 `jiexiang-radio` 说话，其它事服务端做完。**

---

## 功能

- 🌍 **发现标签页**：直接搜索 radio-browser 全球电台（多个官方镜像自动容灾切换，命中哪个就用哪个）
- 🛰️ **RadioDroid 全球电台（内置备用源）**：直接内置 [RadioDroid](https://github.com/segler-alex/RadioDroid) 的上万条全球电台目录（数据源 radio-browser.info）。这些台**不打主动测通断**（避免一次性对上万条流地址探测把 NAS 打崩），而是作为**备用源**并入其它台的源池——当你常用的源都连不上时，点播会自动顺延到 RadioDroid 备用源兜底。可在 🛰 RadioDroid 标签页按国家/搜索浏览。
- 📺 **多种订阅源格式**：`M3U / M3U8 / PLS / ASX / XSPF / JSON / 每行一条纯文本`，拖进来自动识别
- 🎧 **手动添加单个电台**
- 🔗 **防盗链支持**：自动识别 `#EXTVLCOPT:http-referrer` / `#KODIPROP`，代理时带上 Referer
- ⭐ 收藏、🔍 本地搜索、⌨️ 空格播放/暂停、🔊 音量记忆
- 🌙 深色模式跟随系统
- 💾 数据持久化到 `/data/sources.json`，容器重建不丢
- 📻 **内置 hacks.tools FM 电台（每日同步）**：自动按分类抓取并合并约 600 个国内电台，**每日同步更新**
- 🐝 **内置 蜻蜓FM 电台源**：一份在 NAS 播放网络实测可放的 蜻蜓FM / 企鹊台(qtfm.cn) 直链精选集（`presets/qingting-radio.m3u`，开箱即听，可自己往里加台）
- 🛠️ **同步后自动体检**：每次同步完逐电台探测连通性，**失效的自动换成可用的 蜻蜓FM / 企鹊台(qtfm.cn) 替代源**，按电台名持久化，重启不丢
- 🌐 **简体中文 / English 双语界面**：所有页面文案随语言切换即时本地化，右上角 🌐 一键切换并记忆

---

## 🌐 多语言支持 / Bilingual UI

界面完整支持 **简体中文** 与 **English** 双语，所有页面（导航、首页、我的电台、RadioDroid、收藏、足迹、发现、订阅源、播放器）文案均随语言切换即时本地化。

- **自动识别**：首次打开按浏览器 `navigator.language` 自动选择（中文环境默认中文，其它默认 English）。
- **手动切换**：右上角 🌐 按钮打开语言菜单，点选「简体中文 / English」即时生效，选择记忆在浏览器本地（`localStorage`）。
- **强制指定**：URL 加 `?lang=zh-CN` 或 `?lang=en` 可强制语言，优先级最高（适合分享固定语言链接）。

> 说明：已入库的**电台数据本身不会被翻译**（内置源名、国别标签等仍以原语言存储，仅做显示层映射），切换语言不会改变你的收藏与历史记录。

---

## 快速部署（飞牛 NAS / 任意 Docker 主机）

### docker compose

```yaml
services:
  jiexiang-radio:
    image: ghcr.io/haonanren118/jiexiang-radio:latest   # 或本地 docker build
    container_name: jiexiang-radio
    restart: unless-stopped
    ports:
      - "8081:8080"
    volumes:
      - ./data:/data
    environment:
      - TZ=Asia/Shanghai
      - UPSTREAM_TIMEOUT=15000
```

```bash
docker compose up -d
# 浏览器打开 http://<NAS-IP>:8081
```

### 本地构建

```bash
git clone https://github.com/haonanren118/jiexiang-radio.git
cd jiexiang-radio
docker build -t jiexiang-radio:latest .
docker run -d --name jiexiang-radio --restart=unless-stopped \
  -p 8081:8080 -v $(pwd)/data:/data jiexiang-radio:latest
```

> **零第三方 npm 依赖**，`hls.js` 已内置在 `public/vendor/`，构建不需要联网 `npm install`，几十秒完成。

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内监听端口 |
| `DATA_DIR` | `/data` | 持久化目录，放 `sources.json` |
| `UPSTREAM_TIMEOUT` | `15000` | 单个上游请求超时（毫秒） |
| `TZ` | - | 建议 `Asia/Shanghai` |
| `FM_SYNC_HOURS` | `24` | 内置 FM 源自动同步间隔（小时） |
| `FM_PROBE_TIMEOUT` | `12000` | 同步后连通性探测超时（毫秒），超出即视为失效 |
| `FM_REPAIR_CONCURRENCY` | `8` | 连通性探测并发数 |
| `FM_HEALTH_TTL` | `43200000` | 健康结果缓存时长（毫秒，默认 12h），期内复用不再重复探测 |

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 / 当前使用的 radio-browser 镜像 |
| GET | `/api/sources` | 列出订阅源 + 电台列表 |
| POST | `/api/sources` | `{name, url}` 添加订阅源并立即拉取 |
| DELETE | `/api/sources?id=xxx` | 删除订阅源及其电台 |
| POST | `/api/sources/refresh` | `{id?}` 刷新（不传则全刷） |
| POST | `/api/stations` | `{name, url}` 手动添加电台 |
| DELETE | `/api/stations?id=xxx` | 删除电台 |
| POST | `/api/favorites` | `{id}` 收藏/取消收藏（toggle） |
| GET | `/api/discover?q=&country=&limit=` | radio-browser 搜索 |
| GET | `/hls/<percent-encoded url>` | HLS 重写代理 |
| GET | `/proxy?url=<url>&ref=<referer>` | 通用音频流代理（支持 Range） |

---

## 内置电台

开箱自带一份国内电台列表 `presets/china-radio.m3u`（约 100 个），首次启动自动导入为「国内电台（内置）」订阅源，可随时刷新或删除。

已实测：全部能对 Toolbox 之外的浏览器环境正常输出音频数据（含带 CDN 跳转 + token 的 CNR 系源）。

---

## 目录结构

```
jiexiang-radio/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js                  # 零依赖 Node 后端：代理 + 解析 + API
├── presets/china-radio.m3u    # 内置国内电台
└── public/
    ├── index.html
    ├── style.css
    ├── app.js                 # 播放逻辑：hls.js → 原生 → 通用代理，三级降级
    ├── i18n.js                # 双语词表与 i18n 引擎（简体中文 / English）
    └── vendor/hls.min.js      # vendored，构建无需联网
```

---

## 播放失败自动降级链路

前端对每个电台依次尝试，任一步真正出数据（hls.js `FRAG_BUFFERED` / audio `playing`）才算成功：

1. `hls.js` 播 `/hls/<url>` ← 绝大多数 HLS 源走这条
2. 原生 `<audio>` 播 `/hls/<url>`（Safari）
3. `<audio>` 播 `/proxy?url=<url>` ← MP3/AAC/OGG 等直连流

---

## 鸣谢 / Acknowledgements

本项目在内置电台数据与服务搭建过程中，复用了以下开源项目与公开数据源，特此致谢：

- **🌟 RadioDroid**：[segler-alex/RadioDroid](https://github.com/segler-alex/RadioDroid) —— 本项目内置的「RadioDroid 全球电台」源即取自其背后的 [radio-browser.info](https://www.radio-browser.info/) 开放电台目录（含上万条全球电台）。为致敬与致谢，本项目以 RadioDroid 命名该内置源，并将其作为不主动测通断的**备用源**并入源池（其它源不可用时自动兜底）。**RadioDroid 是 AGPL-3.0 协议的开源 Android 电台客户端，感谢作者 segler-alex 与 radio-browser 社区的贡献。**
- **全球电台索引 / 发现数据源**：[radio-browser](https://www.radio-browser.info/)——「发现」标签页的数据源，本项目在自动替换失效源时也会向它查询 蜻蜓FM / 企鹊台(qtfm.cn) 替代流。其数据由全球社区共同维护。
- **FM 电台数据**：[hacks.tools / iptv.hacks.tools](https://iptv.hacks.tools) 每日更新的分类 M3U 源——本项目将其内置为「hacks.tools FM 电台（每日同步）」，并每日自动同步。
- **电台台标（Logo）**：[fanmingming/live](https://github.com/fanmingming/live) 开源台标库——经 ghproxy 代理在 NAS 取用，修复了原 `huangsuming.codeberg.page` 整站删除导致的台标缺失。
- **全球电台索引**：[radio-browser](https://www.radio-browser.info/)——「发现」标签页的数据源，本项目在自动替换失效源时也会向它查询 蜻蜓FM / 企鹊台(qtfm.cn) 替代流。
- **蜻蜓FM / 企鹊台(qtfm.cn) 直链**：本项目内置的「蜻蜓FM 电台（内置）」订阅源即采用其 `lhttp.qtfm.cn/live/<id>/64k.mp3` 直链（已在 NAS 播放网络实测可放）。
- **HLS 播放**：[hls.js](https://github.com/video-dev/hls.js)（已内置 `public/vendor/`，构建无需联网）。
- **电台版权**：各电台的节目版权归原广播机构所有（央广 CNR/CMG、各省电台等），本项目仅作播放聚合，不存储、不转售任何节目内容。

---

## 交流社区

欢迎进群一起交流、反馈问题、共建功能 🎉

- **QQ 交流群：708144970**
  - 在 QQ 中搜索群号 `708144970` 即可加入；
  - 或点击网页加群链接：<https://shang.qq.com/wpa/qunwpa?id=708144970>

---

## License

MIT
