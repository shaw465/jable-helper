// ==UserScript==
// @name         Jable Helper
// @namespace    https://tampermonkey.net/
// @version      0.3.0
// @description  jable.tv 视频页增强：自动静音 + 按真实系列展示相关作品
// @author       you
// @match        https://jable.tv/*
// @match        https://*.jable.tv/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'jh-series-panel';
  const STYLE_ID = 'jh-series-style';
  const ITEM_LIMIT = 24;
  const REQUEST_TIMEOUT_MS = 12000;
  const R18_BASE = 'https://r18.dev';
  let isPlayPatched = false;

  function muteMedia(media) {
    if (!(media instanceof HTMLMediaElement)) {
      return;
    }
    if (!media.muted) {
      media.muted = true;
    }
    if (media.volume !== 0) {
      media.volume = 0;
    }
    media.defaultMuted = true;
    if (!media.hasAttribute('muted')) {
      media.setAttribute('muted', '');
    }
  }

  function installMuteGuard() {
    if (!isPlayPatched) {
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        muteMedia(this);
        return originalPlay.apply(this, args);
      };
      isPlayPatched = true;
    }

    document.addEventListener(
      'play',
      (event) => {
        muteMedia(event.target);
      },
      true
    );

    document.addEventListener(
      'volumechange',
      (event) => {
        const target = event.target;
        if (target instanceof HTMLMediaElement && (!target.muted || target.volume !== 0)) {
          muteMedia(target);
        }
      },
      true
    );

    const muteAll = () => {
      document.querySelectorAll('video, audio').forEach(muteMedia);
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }
          if (node.matches('video, audio')) {
            muteMedia(node);
          }
          node.querySelectorAll?.('video, audio').forEach(muteMedia);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', muteAll, { once: true });
    } else {
      muteAll();
    }
  }

  function isVideoPage() {
    return /\/videos\/[^/]+\/?/i.test(location.pathname);
  }

  function getCurrentSlug() {
    const match = location.pathname.match(/\/videos\/([^/]+)\/?/i);
    return match ? match[1].toLowerCase() : '';
  }

  function canonicalizeCode(raw) {
    if (!raw) {
      return '';
    }
    const text = String(raw).trim().toUpperCase().replace(/_/g, '-');
    const match = text.match(/^([A-Z]{2,10})-?(\d{2,6})([A-Z]{0,5})$/);
    if (!match) {
      return '';
    }
    return `${match[1]}-${match[2]}${match[3]}`;
  }

  function codeToSlug(code) {
    return code.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function inferCodeFromPage(slug) {
    const fromSlug = canonicalizeCode(slug);
    if (fromSlug) {
      return fromSlug;
    }

    const titleText = document.querySelector('.video-info h4')?.textContent || document.title;
    const fromTitle = titleText.match(/\b([A-Z]{2,10}-\d{2,6}[A-Z]{0,5})\b/i);
    return fromTitle ? canonicalizeCode(fromTitle[1]) : '';
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        mode: 'cors',
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function parseSeriesId(seriesUrl) {
    if (!seriesUrl) {
      return null;
    }
    try {
      const url = new URL(seriesUrl, R18_BASE);
      const id = url.searchParams.get('id');
      const type = url.searchParams.get('type');
      if (!id || type !== 'series') {
        return null;
      }
      return id;
    } catch {
      return null;
    }
  }

  async function loadSeriesContextByCode(code) {
    const detailUrl = `${R18_BASE}/videos/vod/movies/detail/-/dvd_id=${encodeURIComponent(code)}/json`;
    const detail = await fetchJson(detailUrl);
    const series = detail?.series || null;
    if (!series || !series.series_url) {
      return null;
    }

    const seriesId = parseSeriesId(series.series_url);
    if (!seriesId) {
      return null;
    }

    return {
      seriesId,
      seriesName: series.name || '未命名系列'
    };
  }

  async function loadSeriesItems(seriesId, currentCode) {
    const items = new Map();
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && items.size < ITEM_LIMIT) {
      const listUrl = `${R18_BASE}/videos/vod/movies/list2/json?id=${encodeURIComponent(seriesId)}&type=series&page=${page}`;
      const listData = await fetchJson(listUrl);
      const results = Array.isArray(listData?.results) ? listData.results : [];
      const totalResults = Number(listData?.total_results || 0);
      totalPages = Math.max(1, Math.ceil(totalResults / 100));

      results.forEach((row) => {
        const code = canonicalizeCode(row?.dvd_id || row?.content_id || '');
        if (!code || code === currentCode || items.has(code)) {
          return;
        }

        const title = [row?.title_zh, row?.title_en, row?.title_ja, code]
          .find((v) => typeof v === 'string' && v.trim())
          .trim();

        items.set(code, {
          code,
          title,
          url: `https://jable.tv/videos/${codeToSlug(code)}/`,
          releaseDate: row?.release_date || ''
        });
      });

      page += 1;
    }

    return Array.from(items.values()).slice(0, ITEM_LIMIT);
  }

  function ensurePanelStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 84px;
        right: 16px;
        width: 340px;
        max-height: 76vh;
        z-index: 99999;
        background: rgba(12, 18, 28, 0.95);
        color: #e5e7eb;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 12px;
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(8px);
        overflow: hidden;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      }
      #${PANEL_ID} .jh-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.25);
        font-weight: 700;
      }
      #${PANEL_ID} .jh-sub {
        color: #9ca3af;
        font-weight: 500;
        font-size: 12px;
      }
      #${PANEL_ID} .jh-body {
        max-height: calc(76vh - 46px);
        overflow: auto;
      }
      #${PANEL_ID} .jh-item {
        border-bottom: 1px solid rgba(148, 163, 184, 0.12);
      }
      #${PANEL_ID} .jh-item:last-child {
        border-bottom: none;
      }
      #${PANEL_ID} .jh-link {
        display: block;
        padding: 10px 12px;
        color: #e5e7eb;
        text-decoration: none;
      }
      #${PANEL_ID} .jh-link:hover {
        background: rgba(30, 41, 59, 0.45);
      }
      #${PANEL_ID} .jh-code {
        display: inline-block;
        margin-bottom: 4px;
        color: #7dd3fc;
        font-weight: 700;
      }
      #${PANEL_ID} .jh-title {
        color: #cbd5e1;
        display: block;
      }
      #${PANEL_ID} .jh-meta {
        color: #94a3b8;
        font-size: 12px;
        display: block;
        margin-top: 3px;
      }
      #${PANEL_ID} .jh-empty {
        padding: 12px;
        color: #94a3b8;
      }
      @media (max-width: 960px) {
        #${PANEL_ID} {
          top: auto;
          right: 12px;
          left: 12px;
          bottom: 12px;
          width: auto;
          max-height: 42vh;
        }
        #${PANEL_ID} .jh-body {
          max-height: calc(42vh - 46px);
        }
      }
    `;
    document.head.appendChild(style);
  }

  function ensurePanelSkeleton(title) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('aside');
      panel.id = PANEL_ID;
      panel.innerHTML = `
        <div class="jh-header">
          <span id="jh-series-title">${title}</span>
          <span class="jh-sub" id="jh-series-count">加载中...</span>
        </div>
        <div class="jh-body" id="jh-series-body"></div>
      `;
      document.body.appendChild(panel);
    }
    return panel;
  }

  function renderPanel(title, items, emptyMessage) {
    const panel = ensurePanelSkeleton(title);
    const titleNode = panel.querySelector('#jh-series-title');
    const countNode = panel.querySelector('#jh-series-count');
    const bodyNode = panel.querySelector('#jh-series-body');
    if (!titleNode || !countNode || !bodyNode) {
      return;
    }

    titleNode.textContent = title;

    if (!items || items.length === 0) {
      countNode.textContent = '0 条';
      bodyNode.innerHTML = `<div class="jh-empty">${emptyMessage}</div>`;
      return;
    }

    countNode.textContent = `${items.length} 条`;
    bodyNode.innerHTML = '';

    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'jh-item';

      const link = document.createElement('a');
      link.className = 'jh-link';
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      const code = document.createElement('span');
      code.className = 'jh-code';
      code.textContent = item.code;

      const titleNode = document.createElement('span');
      titleNode.className = 'jh-title';
      titleNode.textContent = item.title;

      link.appendChild(code);
      link.appendChild(titleNode);

      if (item.releaseDate) {
        const meta = document.createElement('span');
        meta.className = 'jh-meta';
        meta.textContent = `发行：${item.releaseDate}`;
        link.appendChild(meta);
      }

      row.appendChild(link);
      fragment.appendChild(row);
    });

    bodyNode.appendChild(fragment);
  }

  async function initSeriesPanel() {
    if (!isVideoPage()) {
      return;
    }

    const currentSlug = getCurrentSlug();
    const currentCode = inferCodeFromPage(currentSlug);
    if (!currentCode) {
      return;
    }

    ensurePanelStyle();
    ensurePanelSkeleton('相关系列作品');

    try {
      const seriesContext = await loadSeriesContextByCode(currentCode);
      if (!seriesContext) {
        renderPanel('相关系列作品', [], '当前作品没有可识别的系列信息');
        return;
      }

      const title = `相关系列作品（${seriesContext.seriesName}）`;
      const items = await loadSeriesItems(seriesContext.seriesId, currentCode);
      renderPanel(title, items, '系列存在，但未找到可展示条目');
    } catch (error) {
      console.warn('[Jable Helper] 系列加载失败:', error);
      renderPanel('相关系列作品', [], '系列数据加载失败，请稍后重试');
    }
  }

  installMuteGuard();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSeriesPanel, { once: true });
  } else {
    initSeriesPanel();
  }
})();
