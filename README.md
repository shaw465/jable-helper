# jable-helper

Tampermonkey userscript for `jable.tv` and similar sites.

## 一键安装（电脑 / 手机）

[![Install Script](https://img.shields.io/badge/Tampermonkey-一键安装脚本-2ea44f?style=for-the-badge)](https://raw.githubusercontent.com/shaw465/jable-helper/master/jable-helper.user.js)
[![Install Script CDN](https://img.shields.io/badge/Tampermonkey-CDN备用安装-1677FF?style=for-the-badge)](https://cdn.jsdelivr.net/gh/shaw465/jable-helper@master/jable-helper.user.js)

- 电脑端：Chrome / Edge + Tampermonkey
- 手机端：Kiwi / 狐猴 + Tampermonkey（推荐）
- 安卓 Edge：扩展支持不稳定，若按钮无响应，请复制下方 URL 到地址栏直接打开
- 手动导入 URL：`https://raw.githubusercontent.com/shaw465/jable-helper/master/jable-helper.user.js`

## Features

- Show related works by **real series metadata** (from `r18.dev`) on video pages.
- Mobile-friendly floating panel: safe-area spacing + collapse/expand support on small screens.
- Filter out series items that do not exist on current site to avoid dead links.
- Built-in anti-abuse strategy for existence checks: local cache + request budget + random pacing + exponential cooldown + cache-only fallback.
- Related series supports **最热(红心优先)** / **最新(发行日优先)** switch.
- Series-level ranked cache to reuse ordering results across pages in the same series.
- Mobile gestures on player: left swipe for volume, right swipe for brightness, double tap play/pause, pinch to fullscreen landscape.

## Supported Sites (v0.9.1)

- `jable.tv` (including subdomains)
- Jable-like domains: `avple.tv` / `hpjav.tv` / `5av.tv` (including subdomains)
- MissAV-like domains: `missav.com` / `missav.ws` (including subdomains)

> 说明：不同站点会有反爬、地区限制或页面结构差异，脚本会自动回退到缓存优先策略，尽量保证可用性。

## Script File

- `jable-helper.user.js`

## TODO（后续待办）

- [ ] MissAV (`missav.ws`)：在 Tampermonkey 运行态加载最新脚本后，复测 `ABP-901` 等样例，确认“相关系列”不再长期 `0 条`。
- [ ] MissAV (`missav.com`)：针对首页重定向场景增加降级提示，避免用户误判脚本失效。
- [ ] 主流站点联调清单：固定 `jable.tv` / `missav.ws` 冒烟样例，发版前执行一次最小回归。
