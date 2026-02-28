# jable-helper

Tampermonkey userscript for `jable.tv`.

## 一键安装（电脑 / 手机）

<a href="https://raw.githubusercontent.com/shaw465/jable-helper/master/jable-helper.user.js">
  <img alt="一键安装-电脑端" src="https://img.shields.io/badge/%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85-%E7%94%B5%E8%84%91%E7%AB%AF%20Tampermonkey-1677FF?style=for-the-badge&logo=tampermonkey&logoColor=white" />
</a>
<a href="https://raw.githubusercontent.com/shaw465/jable-helper/master/jable-helper.user.js">
  <img alt="一键安装-手机端" src="https://img.shields.io/badge/%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85-%E6%89%8B%E6%9C%BA%E7%AB%AF%20Tampermonkey-13A10E?style=for-the-badge&logo=android&logoColor=white" />
</a>

- 电脑端：Chrome / Edge + Tampermonkey
- 手机端：Kiwi / 狐猴 / Edge(安卓) + Tampermonkey
- 备用安装链接：`https://cdn.jsdelivr.net/gh/shaw465/jable-helper@master/jable-helper.user.js`

## Features

- Force mute all video/audio playback on page load and runtime.
- Show related works by **real series metadata** (from `r18.dev`) on video pages.
- Mobile-friendly floating panel: safe-area spacing + collapse/expand support on small screens.
- Filter out series items that do not exist on `jable.tv` to avoid dead links.
- Built-in anti-abuse strategy for existence checks: local cache + request budget + random pacing + exponential cooldown + cache-only fallback.
- Prefer sorting related series items by cached heart count (likes), then fallback to release date.
- Series-level ranked cache to reuse ordering results across pages in the same series.

## Script File

- `jable-helper.user.js`
