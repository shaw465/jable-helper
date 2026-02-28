# jable-helper

Tampermonkey userscript for `jable.tv` and similar sites.

## 一键安装（电脑 / 手机）

<a href="https://www.tampermonkey.net/script_installation.php#url=https%3A%2F%2Fraw.githubusercontent.com%2Fshaw465%2Fjable-helper%2Fmaster%2Fjable-helper.user.js">
  <img alt="一键安装-电脑端" src="https://img.shields.io/badge/%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85-%E7%94%B5%E8%84%91%E7%AB%AF%20Tampermonkey-1677FF?style=for-the-badge&logo=tampermonkey&logoColor=white" />
</a>
<a href="https://www.tampermonkey.net/script_installation.php#url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2Fshaw465%2Fjable-helper%40master%2Fjable-helper.user.js">
  <img alt="一键安装-手机端" src="https://img.shields.io/badge/%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85-%E6%89%8B%E6%9C%BA%E7%AB%AF%20Tampermonkey-13A10E?style=for-the-badge&logo=android&logoColor=white" />
</a>

- 电脑端：Chrome / Edge + Tampermonkey
- 手机端：Kiwi / 狐猴 + Tampermonkey（推荐）
- 安卓 Edge：扩展支持是灰度能力，若按钮无响应，请改用上方“手机端”按钮或手动导入
- 手动导入 URL：`https://raw.githubusercontent.com/shaw465/jable-helper/master/jable-helper.user.js`

## Features

- Force mute all video/audio playback on page load and runtime.
- Show related works by **real series metadata** (from `r18.dev`) on video pages.
- Mobile-friendly floating panel: safe-area spacing + collapse/expand support on small screens.
- Filter out series items that do not exist on current site to avoid dead links.
- Built-in anti-abuse strategy for existence checks: local cache + request budget + random pacing + exponential cooldown + cache-only fallback.
- Prefer sorting related series items by cached heart count (likes), then fallback to release date.
- Series-level ranked cache to reuse ordering results across pages in the same series.

## Supported Sites (v0.9.0)

- `jable.tv` (including subdomains)
- Jable-like domains: `avple.tv` / `hpjav.tv` / `5av.tv` (including subdomains)
- MissAV-like domains: `missav.com` / `missav.ws` (including subdomains)

> 说明：不同站点会有反爬、地区限制或页面结构差异，脚本会自动回退到缓存优先策略，尽量保证可用性。

## Script File

- `jable-helper.user.js`
