// ==UserScript==
// @name         Jable Helper
// @namespace    https://tampermonkey.net/
// @version      0.8.1
// @description  jable.tv 视频页增强：自动静音 + 按真实系列展示相关作品
// @author       you
// @match        https://jable.tv/*
// @match        https://*.jable.tv/*
// @downloadURL  https://raw.githubusercontent.com/shaw465/jable-helper/master/jable-helper.user.js
// @updateURL    https://raw.githubusercontent.com/shaw465/jable-helper/master/jable-helper.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'jh-series-panel';
  const STYLE_ID = 'jh-series-style';
  const TOGGLE_ID = 'jh-series-toggle';
  const PANEL_COLLAPSED_CLASS = 'jh-collapsed';
  const PANEL_COLLAPSED_STORAGE_KEY = 'jh-series-panel-collapsed';
  const VIDEO_EXISTENCE_CACHE_KEY = 'jh-video-existence-cache-v1';
  const VIDEO_LIKE_CACHE_KEY = 'jh-video-like-cache-v1';
  const SERIES_ITEMS_CACHE_KEY = 'jh-series-items-cache-v1';
  const VERIFY_RUNTIME_STATE_KEY = 'jh-verify-runtime-state-v1';
  const VIDEO_EXISTENCE_CACHE_MAX = 1200;
  const VIDEO_LIKE_CACHE_MAX = 1600;
  const SERIES_ITEMS_CACHE_MAX = 260;
  const VIDEO_EXISTS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const VIDEO_MISSING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  const VIDEO_LIKE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const SERIES_ITEMS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const SERIES_ITEMS_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const ITEM_LIMIT = 24;
  const CANDIDATE_LIMIT = ITEM_LIMIT * 2;
  const MAX_VERIFY_REQUESTS_PER_PAGE = 12;
  const MAX_DETAIL_REQUESTS_PER_PAGE = 5;
  const VERIFY_REQUEST_INTERVAL_MS = 240;
  const VERIFY_REQUEST_JITTER_MIN_MS = 90;
  const VERIFY_REQUEST_JITTER_MAX_MS = 280;
  const VERIFY_COOLDOWN_BASE_MS = 15 * 60 * 1000;
  const VERIFY_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000;
  const VERIFY_BACKOFF_MAX_LEVEL = 5;
  const VERIFY_FAIL_CACHE_ONLY_THRESHOLD = 5;
  const VERIFY_CACHE_ONLY_MS = 20 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 12000;
  const R18_BASE = 'https://r18.dev';
  let isPlayPatched = false;
  const videoExistenceCache = new Map(); // url -> { exists, expireAt, checkedAt }
  const videoLikeCache = new Map(); // url -> { likeCount, expireAt, checkedAt }
  const seriesItemsCache = new Map(); // seriesId -> { items, expireAt, checkedAt }
  let verifyRequestsUsed = 0;
  let nextVerifyRequestAt = 0;
  let verifyCooldownUntil = 0;
  let verifyCacheOnlyUntil = 0;
  let verifyBackoffLevel = 0;
  let verifyConsecutiveFailures = 0;
  let detailRequestsUsed = 0;

  function nowMs() {
    return Date.now();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clampInteger(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, Math.trunc(number)));
  }

  function randomBetween(min, max) {
    const minValue = Math.min(min, max);
    const maxValue = Math.max(min, max);
    return minValue + Math.floor(Math.random() * (maxValue - minValue + 1));
  }

  function isVerifyNetworkRestricted() {
    const now = nowMs();
    return now < verifyCooldownUntil || now < verifyCacheOnlyUntil;
  }

  function persistVerifyRuntimeState() {
    try {
      localStorage.setItem(
        VERIFY_RUNTIME_STATE_KEY,
        JSON.stringify({
          cooldownUntil: verifyCooldownUntil,
          cacheOnlyUntil: verifyCacheOnlyUntil,
          backoffLevel: verifyBackoffLevel,
          consecutiveFailures: verifyConsecutiveFailures
        })
      );
    } catch {}
  }

  function loadVerifyRuntimeState() {
    try {
      const raw = localStorage.getItem(VERIFY_RUNTIME_STATE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return;
      }

      const now = nowMs();
      verifyCooldownUntil = Math.max(0, Number(parsed.cooldownUntil || 0));
      verifyCacheOnlyUntil = Math.max(0, Number(parsed.cacheOnlyUntil || 0));
      verifyBackoffLevel = clampInteger(parsed.backoffLevel, 0, VERIFY_BACKOFF_MAX_LEVEL);
      verifyConsecutiveFailures = clampInteger(parsed.consecutiveFailures, 0, 999);

      if (verifyCooldownUntil <= now) {
        verifyCooldownUntil = 0;
      }
      if (verifyCacheOnlyUntil <= now) {
        verifyCacheOnlyUntil = 0;
      }
    } catch {}
  }

  function markVerifySuccess() {
    if (verifyBackoffLevel === 0 && verifyConsecutiveFailures === 0 && verifyCooldownUntil === 0) {
      return;
    }
    verifyBackoffLevel = 0;
    verifyConsecutiveFailures = 0;
    verifyCooldownUntil = 0;
    persistVerifyRuntimeState();
  }

  function markVerifyFailure() {
    verifyConsecutiveFailures += 1;
    if (verifyConsecutiveFailures >= VERIFY_FAIL_CACHE_ONLY_THRESHOLD) {
      verifyCacheOnlyUntil = Math.max(verifyCacheOnlyUntil, nowMs() + VERIFY_CACHE_ONLY_MS);
    }
    persistVerifyRuntimeState();
  }

  function markVerifyThrottled() {
    const now = nowMs();
    verifyBackoffLevel = Math.min(VERIFY_BACKOFF_MAX_LEVEL, verifyBackoffLevel + 1);
    const baseCooldown = VERIFY_COOLDOWN_BASE_MS * 2 ** Math.max(0, verifyBackoffLevel - 1);
    const cooldownMs = Math.min(VERIFY_COOLDOWN_MAX_MS, baseCooldown);
    const jitterMs = randomBetween(VERIFY_REQUEST_JITTER_MIN_MS, VERIFY_REQUEST_JITTER_MAX_MS);
    verifyCooldownUntil = Math.max(verifyCooldownUntil, now + cooldownMs + jitterMs);
    verifyConsecutiveFailures += 1;
    if (verifyConsecutiveFailures >= VERIFY_FAIL_CACHE_ONLY_THRESHOLD) {
      verifyCacheOnlyUntil = Math.max(verifyCacheOnlyUntil, now + VERIFY_CACHE_ONLY_MS);
    }
    persistVerifyRuntimeState();
  }

  function normalizeVideoUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.origin);
      const match = url.pathname.match(/^\/(?:s\d+\/)?videos\/([^/]+)\/?/i);
      if (!match) {
        return '';
      }
      return `https://jable.tv/videos/${match[1].toLowerCase()}/`;
    } catch {
      return '';
    }
  }

  function parseNumberText(rawText) {
    if (!rawText) {
      return null;
    }
    const normalized = String(rawText).replace(/[^\d]/g, '');
    if (!normalized) {
      return null;
    }
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) {
      return '';
    }
    return new Intl.NumberFormat('en-US').format(value);
  }

  function loadVideoExistenceCache() {
    try {
      const raw = localStorage.getItem(VIDEO_EXISTENCE_CACHE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const now = nowMs();
      parsed.forEach((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return;
        }
        const [url, value] = entry;
        const normalizedUrl = normalizeVideoUrl(url);
        if (!normalizedUrl || !value || typeof value !== 'object') {
          return;
        }
        const exists = Boolean(value.exists);
        const expireAt = Number(value.expireAt || 0);
        const checkedAt = Number(value.checkedAt || 0);
        if (!expireAt || expireAt <= now) {
          return;
        }
        videoExistenceCache.set(normalizedUrl, { exists, expireAt, checkedAt });
      });
    } catch {}
  }

  function persistVideoExistenceCache() {
    try {
      const entries = Array.from(videoExistenceCache.entries())
        .sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0))
        .slice(0, VIDEO_EXISTENCE_CACHE_MAX);
      localStorage.setItem(VIDEO_EXISTENCE_CACHE_KEY, JSON.stringify(entries));
    } catch {}
  }

  function pruneVideoExistenceCache() {
    const now = nowMs();
    for (const [url, record] of videoExistenceCache.entries()) {
      if (!record || record.expireAt <= now) {
        videoExistenceCache.delete(url);
      }
    }
    if (videoExistenceCache.size <= VIDEO_EXISTENCE_CACHE_MAX) {
      return;
    }
    const sortedUrls = Array.from(videoExistenceCache.entries())
      .sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0))
      .map((entry) => entry[0]);
    const keepSet = new Set(sortedUrls.slice(0, VIDEO_EXISTENCE_CACHE_MAX));
    for (const url of videoExistenceCache.keys()) {
      if (!keepSet.has(url)) {
        videoExistenceCache.delete(url);
      }
    }
  }

  function getVideoExistenceFromCache(url) {
    const normalizedUrl = normalizeVideoUrl(url);
    if (!normalizedUrl) {
      return null;
    }
    const record = videoExistenceCache.get(normalizedUrl);
    if (!record) {
      return null;
    }
    if (record.expireAt <= nowMs()) {
      videoExistenceCache.delete(normalizedUrl);
      return null;
    }
    return record.exists;
  }

  function setVideoExistenceCache(url, exists) {
    const normalizedUrl = normalizeVideoUrl(url);
    if (!normalizedUrl) {
      return;
    }
    const checkedAt = nowMs();
    const ttl = exists ? VIDEO_EXISTS_TTL_MS : VIDEO_MISSING_TTL_MS;
    videoExistenceCache.set(normalizedUrl, {
      exists,
      checkedAt,
      expireAt: checkedAt + ttl
    });
    pruneVideoExistenceCache();
    persistVideoExistenceCache();
  }

  function loadVideoLikeCache() {
    try {
      const raw = localStorage.getItem(VIDEO_LIKE_CACHE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const now = nowMs();
      parsed.forEach((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return;
        }
        const [url, value] = entry;
        const normalizedUrl = normalizeVideoUrl(url);
        if (!normalizedUrl || !value || typeof value !== 'object') {
          return;
        }
        const likeCount = Number(value.likeCount);
        const expireAt = Number(value.expireAt || 0);
        const checkedAt = Number(value.checkedAt || 0);
        if (!Number.isFinite(likeCount) || likeCount < 0 || !expireAt || expireAt <= now) {
          return;
        }
        videoLikeCache.set(normalizedUrl, { likeCount, expireAt, checkedAt });
      });
    } catch {}
  }

  function persistVideoLikeCache() {
    try {
      const entries = Array.from(videoLikeCache.entries())
        .sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0))
        .slice(0, VIDEO_LIKE_CACHE_MAX);
      localStorage.setItem(VIDEO_LIKE_CACHE_KEY, JSON.stringify(entries));
    } catch {}
  }

  function pruneVideoLikeCache() {
    const now = nowMs();
    for (const [url, record] of videoLikeCache.entries()) {
      if (!record || record.expireAt <= now) {
        videoLikeCache.delete(url);
      }
    }
    if (videoLikeCache.size <= VIDEO_LIKE_CACHE_MAX) {
      return;
    }
    const sortedUrls = Array.from(videoLikeCache.entries())
      .sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0))
      .map((entry) => entry[0]);
    const keepSet = new Set(sortedUrls.slice(0, VIDEO_LIKE_CACHE_MAX));
    for (const url of videoLikeCache.keys()) {
      if (!keepSet.has(url)) {
        videoLikeCache.delete(url);
      }
    }
  }

  function getLikeCountFromCache(url) {
    const normalizedUrl = normalizeVideoUrl(url);
    if (!normalizedUrl) {
      return null;
    }
    const record = videoLikeCache.get(normalizedUrl);
    if (!record) {
      return null;
    }
    if (record.expireAt <= nowMs()) {
      videoLikeCache.delete(normalizedUrl);
      return null;
    }
    return record.likeCount;
  }

  function setLikeCountCache(url, likeCount) {
    const normalizedUrl = normalizeVideoUrl(url);
    if (!normalizedUrl || !Number.isFinite(likeCount) || likeCount < 0) {
      return;
    }
    const checkedAt = nowMs();
    videoLikeCache.set(normalizedUrl, {
      likeCount,
      checkedAt,
      expireAt: checkedAt + VIDEO_LIKE_TTL_MS
    });
    pruneVideoLikeCache();
    persistVideoLikeCache();
  }

  function normalizeSeriesItem(item) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const code = canonicalizeCode(item.code || '');
    if (!code) {
      return null;
    }
    const url = normalizeVideoUrl(item.url || `https://jable.tv/videos/${codeToSlug(code)}/`);
    if (!url) {
      return null;
    }
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : code;
    const releaseDate = typeof item.releaseDate === 'string' ? item.releaseDate : '';
    const likeValue = Number(item.likeCount);
    const likeCount = Number.isFinite(likeValue) && likeValue >= 0 ? likeValue : null;
    return {
      code,
      title,
      url,
      releaseDate,
      likeCount
    };
  }

  function loadSeriesItemsCache() {
    try {
      const raw = localStorage.getItem(SERIES_ITEMS_CACHE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const now = nowMs();
      parsed.forEach((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return;
        }
        const [seriesId, value] = entry;
        if (typeof seriesId !== 'string' || !value || typeof value !== 'object') {
          return;
        }
        const checkedAt = Number(value.checkedAt || 0);
        const expireAt = Number(value.expireAt || 0);
        const items = Array.isArray(value.items) ? value.items.map(normalizeSeriesItem).filter(Boolean) : [];
        if (!checkedAt || items.length === 0) {
          return;
        }
        if (expireAt <= now && now - checkedAt > SERIES_ITEMS_STALE_TTL_MS) {
          return;
        }
        seriesItemsCache.set(seriesId, {
          checkedAt,
          expireAt,
          items
        });
      });
    } catch {}
  }

  function persistSeriesItemsCache() {
    try {
      const entries = Array.from(seriesItemsCache.entries())
        .sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0))
        .slice(0, SERIES_ITEMS_CACHE_MAX);
      localStorage.setItem(SERIES_ITEMS_CACHE_KEY, JSON.stringify(entries));
    } catch {}
  }

  function pruneSeriesItemsCache() {
    const now = nowMs();
    for (const [seriesId, record] of seriesItemsCache.entries()) {
      if (!record || !Array.isArray(record.items) || record.items.length === 0) {
        seriesItemsCache.delete(seriesId);
        continue;
      }
      if (record.expireAt <= now && now - (record.checkedAt || 0) > SERIES_ITEMS_STALE_TTL_MS) {
        seriesItemsCache.delete(seriesId);
      }
    }
    if (seriesItemsCache.size <= SERIES_ITEMS_CACHE_MAX) {
      return;
    }
    const sortedSeriesIds = Array.from(seriesItemsCache.entries())
      .sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0))
      .map((entry) => entry[0]);
    const keepSet = new Set(sortedSeriesIds.slice(0, SERIES_ITEMS_CACHE_MAX));
    for (const seriesId of seriesItemsCache.keys()) {
      if (!keepSet.has(seriesId)) {
        seriesItemsCache.delete(seriesId);
      }
    }
  }

  function getSeriesItemsFromCache(seriesId, options = {}) {
    const key = String(seriesId || '');
    const record = seriesItemsCache.get(key);
    if (!record || !Array.isArray(record.items) || record.items.length === 0) {
      return null;
    }
    const now = nowMs();
    const allowStale = Boolean(options.allowStale);
    const isFresh = record.expireAt > now;
    const isStaleButAllowed = allowStale && now - (record.checkedAt || 0) <= SERIES_ITEMS_STALE_TTL_MS;
    if (!isFresh && !isStaleButAllowed) {
      seriesItemsCache.delete(key);
      return null;
    }
    const hydratedItems = record.items.map((item) => {
      const nextItem = { ...item };
      const cachedLike = getLikeCountFromCache(nextItem.url);
      if (cachedLike !== null) {
        nextItem.likeCount = cachedLike;
      }
      return nextItem;
    });
    return sortSeriesItemsByLikeCount(hydratedItems);
  }

  function setSeriesItemsCache(seriesId, items) {
    const key = String(seriesId || '');
    if (!key || !Array.isArray(items) || items.length === 0) {
      return;
    }
    const normalizedItems = items
      .map(normalizeSeriesItem)
      .filter(Boolean)
      .slice(0, CANDIDATE_LIMIT);
    if (normalizedItems.length === 0) {
      return;
    }
    const checkedAt = nowMs();
    seriesItemsCache.set(key, {
      checkedAt,
      expireAt: checkedAt + SERIES_ITEMS_CACHE_TTL_MS,
      items: normalizedItems
    });
    pruneSeriesItemsCache();
    persistSeriesItemsCache();
  }

  async function reserveVerifyRequestSlot() {
    if (isVerifyNetworkRestricted()) {
      return false;
    }
    if (verifyRequestsUsed >= MAX_VERIFY_REQUESTS_PER_PAGE) {
      return false;
    }
    verifyRequestsUsed += 1;
    const waitMs = nextVerifyRequestAt - nowMs();
    if (waitMs > 0) {
      await delay(waitMs);
    }
    nextVerifyRequestAt =
      nowMs() + VERIFY_REQUEST_INTERVAL_MS + randomBetween(VERIFY_REQUEST_JITTER_MIN_MS, VERIFY_REQUEST_JITTER_MAX_MS);
    return true;
  }

  function isMobileViewport() {
    return window.matchMedia('(max-width: 960px)').matches;
  }

  function readCollapsedPreference() {
    try {
      return localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function writeCollapsedPreference(collapsed) {
    try {
      localStorage.setItem(PANEL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
    } catch {}
  }

  function applyCollapsedState(panel, collapsed) {
    panel.classList.toggle(PANEL_COLLAPSED_CLASS, collapsed);
    const toggle = panel.querySelector(`#${TOGGLE_ID}`);
    if (toggle) {
      toggle.textContent = collapsed ? '展开' : '收起';
      toggle.setAttribute('aria-expanded', String(!collapsed));
    }
  }

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
    return /\/(?:s\d+\/)?videos\/[^/]+\/?/i.test(location.pathname);
  }

  function getCurrentSlug() {
    const match = location.pathname.match(/\/(?:s\d+\/)?videos\/([^/]+)\/?/i);
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
    const shouldUseStaleCache = isVerifyNetworkRestricted();
    const cachedItems = getSeriesItemsFromCache(seriesId, { allowStale: shouldUseStaleCache });
    if (cachedItems && cachedItems.length > 0) {
      return cachedItems.filter((item) => item.code !== currentCode).slice(0, ITEM_LIMIT);
    }
    if (shouldUseStaleCache) {
      return [];
    }

    const items = new Map();
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && items.size < CANDIDATE_LIMIT) {
      const listUrl = `${R18_BASE}/videos/vod/movies/list2/json?id=${encodeURIComponent(seriesId)}&type=series&page=${page}`;
      const listData = await fetchJson(listUrl);
      const results = Array.isArray(listData?.results) ? listData.results : [];
      const totalResults = Number(listData?.total_results || 0);
      totalPages = Math.max(1, Math.ceil(totalResults / 100));

      results.forEach((row) => {
        const code = canonicalizeCode(row?.dvd_id || row?.content_id || '');
        if (!code || items.has(code)) {
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

    const candidates = Array.from(items.values()).slice(0, CANDIDATE_LIMIT);
    const rankedItems = await filterItemsExistingOnJable(candidates);
    setSeriesItemsCache(seriesId, rankedItems);
    return rankedItems.filter((item) => item.code !== currentCode).slice(0, ITEM_LIMIT);
  }

  function isVideoPath(pathname) {
    return /^\/(?:s\d+\/)?videos\/[^/]+\/?$/i.test(pathname);
  }

  function extractLikeCountFromHtml(htmlText) {
    if (!htmlText) {
      return null;
    }
    try {
      const doc = new DOMParser().parseFromString(htmlText, 'text/html');
      const countText = doc.querySelector('button.btn.btn-action.fav .count')?.textContent || '';
      return parseNumberText(countText);
    } catch {
      return null;
    }
  }

  function sortSeriesItemsByLikeCount(items) {
    return items
      .slice()
      .sort((a, b) => {
        const aLike = Number.isFinite(a.likeCount) ? a.likeCount : null;
        const bLike = Number.isFinite(b.likeCount) ? b.likeCount : null;
        if (aLike !== null && bLike !== null && aLike !== bLike) {
          return bLike - aLike;
        }
        if (aLike !== null && bLike === null) {
          return -1;
        }
        if (aLike === null && bLike !== null) {
          return 1;
        }
        return String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''));
      });
  }

  async function checkVideoMetaOnJable(url, options = {}) {
    const canonicalUrl = normalizeVideoUrl(url);
    if (!canonicalUrl) {
      return { exists: false, likeCount: null, usedDetailRequest: false };
    }

    const withLikeCount = Boolean(options.withLikeCount);
    const cachedExists = getVideoExistenceFromCache(canonicalUrl);
    const cachedLike = getLikeCountFromCache(canonicalUrl);
    if (cachedExists === false) {
      return { exists: false, likeCount: cachedLike, usedDetailRequest: false };
    }
    if (cachedExists === true && (!withLikeCount || cachedLike !== null)) {
      return { exists: true, likeCount: cachedLike, usedDetailRequest: false };
    }

    const canVerify = await reserveVerifyRequestSlot();
    if (!canVerify) {
      return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest: false };
    }

    const requestWithTimeout = async (method) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await fetch(canonicalUrl, {
          method,
          credentials: 'same-origin',
          redirect: 'follow',
          signal: controller.signal,
          cache: 'no-store'
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    try {
      let usedDetailRequest = false;
      let method = withLikeCount ? 'GET' : 'HEAD';
      let response = await requestWithTimeout(method);
      if (method === 'HEAD' && (response.status === 405 || response.status === 501)) {
        method = 'GET';
        usedDetailRequest = true;
        response = await requestWithTimeout(method);
      }
      if (response.status === 429 || response.status === 403) {
        markVerifyThrottled();
        return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest };
      }

      const finalUrl = response.url || canonicalUrl;
      const normalizedFinalUrl = normalizeVideoUrl(finalUrl);
      const finalPath = new URL(finalUrl, location.origin).pathname;
      const isVideoRoute = Boolean(normalizedFinalUrl) && isVideoPath(finalPath);
      if (!isVideoRoute) {
        markVerifyFailure();
        return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest };
      }

      if (response.status === 404) {
        setVideoExistenceCache(canonicalUrl, false);
        markVerifySuccess();
        return { exists: false, likeCount: null, usedDetailRequest };
      }
      if (!response.ok) {
        markVerifyFailure();
        return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest };
      }

      setVideoExistenceCache(canonicalUrl, true);

      let likeCount = cachedLike;
      if (method === 'GET') {
        usedDetailRequest = true;
        const htmlText = await response.text();
        const parsedLike = extractLikeCountFromHtml(htmlText);
        if (parsedLike !== null) {
          likeCount = parsedLike;
          setLikeCountCache(canonicalUrl, parsedLike);
        }
      }

      markVerifySuccess();
      return { exists: true, likeCount, usedDetailRequest };
    } catch {
      markVerifyFailure();
      return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest: false };
    }
  }

  async function filterItemsExistingOnJable(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const verified = [];
    detailRequestsUsed = 0;
    for (const item of items) {
      if (verified.length >= ITEM_LIMIT) {
        break;
      }

      const normalizedUrl = normalizeVideoUrl(item.url);
      if (!normalizedUrl) {
        continue;
      }
      item.url = normalizedUrl;

      const cachedLike = getLikeCountFromCache(item.url);
      if (cachedLike !== null) {
        item.likeCount = cachedLike;
      }

      const shouldProbeLike = item.likeCount == null && detailRequestsUsed < MAX_DETAIL_REQUESTS_PER_PAGE;
      const meta = await checkVideoMetaOnJable(item.url, { withLikeCount: shouldProbeLike });
      if (meta.usedDetailRequest) {
        detailRequestsUsed += 1;
      }
      if (!meta.exists) {
        continue;
      }
      if (meta.likeCount !== null) {
        item.likeCount = meta.likeCount;
      }
      verified.push(item);
    }
    return sortSeriesItemsByLikeCount(verified);
  }

  function harvestLikeCountsFromPage() {
    const currentVideoUrl = normalizeVideoUrl(location.href);
    const currentLikeText = document.querySelector('button.btn.btn-action.fav .count')?.textContent || '';
    const currentLike = parseNumberText(currentLikeText);
    if (currentVideoUrl) {
      setVideoExistenceCache(currentVideoUrl, true);
      if (currentLike !== null) {
        setLikeCountCache(currentVideoUrl, currentLike);
      }
    }

    document.querySelectorAll('.video-img-box .detail').forEach((detailNode) => {
      const href = detailNode.querySelector('h6.title a[href*="/videos/"]')?.getAttribute('href') || '';
      const itemUrl = normalizeVideoUrl(href);
      if (!itemUrl) {
        return;
      }
      setVideoExistenceCache(itemUrl, true);

      const subtitleText = detailNode.querySelector('.sub-title')?.textContent || '';
      const numberMatches = subtitleText.match(/\d[\d,]*(?:\s\d{3})*/g) || [];
      const numbers = numberMatches
        .map((match) => parseNumberText(match))
        .filter((value) => value !== null);
      if (numbers.length >= 2) {
        const likeCount = numbers[numbers.length - 1];
        setLikeCountCache(itemUrl, likeCount);
      }
    });
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
      #${PANEL_ID} .jh-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #${PANEL_ID} .jh-toggle {
        display: none;
        border: 1px solid rgba(148, 163, 184, 0.45);
        border-radius: 8px;
        padding: 2px 8px;
        font-size: 12px;
        line-height: 1.4;
        color: #e5e7eb;
        background: rgba(30, 41, 59, 0.55);
      }
      #${PANEL_ID} .jh-body {
        max-height: calc(76vh - 46px);
        overflow: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
      }
      #${PANEL_ID}.${PANEL_COLLAPSED_CLASS} {
        max-height: 52px;
      }
      #${PANEL_ID}.${PANEL_COLLAPSED_CLASS} .jh-body {
        display: none;
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
          right: calc(12px + env(safe-area-inset-right));
          left: calc(12px + env(safe-area-inset-left));
          bottom: calc(12px + env(safe-area-inset-bottom));
          width: auto;
          max-height: 42vh;
        }
        #${PANEL_ID} .jh-toggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
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
          <div class="jh-actions">
            <span class="jh-sub" id="jh-series-count">加载中...</span>
            <button type="button" class="jh-toggle" id="${TOGGLE_ID}" aria-expanded="true">收起</button>
          </div>
        </div>
        <div class="jh-body" id="jh-series-body"></div>
      `;
      document.body.appendChild(panel);
    }

    const toggle = panel.querySelector(`#${TOGGLE_ID}`);
    if (toggle && toggle.dataset.bound !== '1') {
      toggle.dataset.bound = '1';
      toggle.addEventListener('click', () => {
        const collapsed = !panel.classList.contains(PANEL_COLLAPSED_CLASS);
        applyCollapsedState(panel, collapsed);
        writeCollapsedPreference(collapsed);
      });
    }

    const shouldCollapse = isMobileViewport() && readCollapsedPreference();
    applyCollapsedState(panel, shouldCollapse);

    if (panel.dataset.responsiveBound !== '1') {
      panel.dataset.responsiveBound = '1';
      const mediaQuery = window.matchMedia('(max-width: 960px)');
      const syncPanelMode = () => {
        const nextCollapsed = mediaQuery.matches ? readCollapsedPreference() : false;
        applyCollapsedState(panel, nextCollapsed);
      };
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', syncPanelMode);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(syncPanelMode);
      }
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

      const metaParts = [];
      if (Number.isFinite(item.likeCount)) {
        metaParts.push(`红心：${formatNumber(item.likeCount)}`);
      }
      if (item.releaseDate) {
        metaParts.push(`发行：${item.releaseDate}`);
      }

      if (metaParts.length > 0) {
        const meta = document.createElement('span');
        meta.className = 'jh-meta';
        meta.textContent = metaParts.join(' · ');
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

    harvestLikeCountsFromPage();
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
  loadVideoExistenceCache();
  loadVideoLikeCache();
  loadSeriesItemsCache();
  loadVerifyRuntimeState();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSeriesPanel, { once: true });
  } else {
    initSeriesPanel();
  }
})();
