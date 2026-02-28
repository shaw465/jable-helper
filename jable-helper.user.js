// ==UserScript==
// @name         Jable Helper
// @namespace    https://tampermonkey.net/
// @version      0.9.4
// @description  多站视频页增强：系列筛选 + 红心排序 + 移动端看片手势优化
// @author       you
// @match        https://jable.tv/*
// @match        https://*.jable.tv/*
// @match        https://avple.tv/*
// @match        https://*.avple.tv/*
// @match        https://hpjav.tv/*
// @match        https://*.hpjav.tv/*
// @match        https://5av.tv/*
// @match        https://*.5av.tv/*
// @match        https://missav.com/*
// @match        https://*.missav.com/*
// @match        https://missav.ws/*
// @match        https://*.missav.ws/*
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
  const SORT_MODE_STORAGE_KEY = 'jh-series-sort-mode-v1';
  const SORT_MODE_HOT = 'hot';
  const SORT_MODE_NEWEST = 'newest';
  const PANEL_COLLAPSED_CLASS = 'jh-collapsed';
  const PANEL_COLLAPSED_STORAGE_KEY = 'jh-series-panel-collapsed';
  const GESTURE_STYLE_ID = 'jh-player-gesture-style';
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
  const GESTURE_MIN_MOVE_PX = 8;
  const GESTURE_VERTICAL_RATIO = 1.2;
  const GESTURE_DOUBLE_TAP_MS = 300;
  const GESTURE_DOUBLE_TAP_MAX_DISTANCE_PX = 24;
  const GESTURE_VOLUME_STEP_PX = 220;
  const GESTURE_BRIGHTNESS_STEP_PX = 260;
  const GESTURE_BRIGHTNESS_MIN = 0.3;
  const GESTURE_BRIGHTNESS_MAX = 1;
  const GESTURE_PINCH_SCALE_TRIGGER = 1.12;
  const GESTURE_SUPPRESS_CLICK_MS = 480;
  const R18_BASE = 'https://r18.dev';
  const JABLE_LIKE_HOST_RE = /(?:^|\.)(?:jable|avple|hpjav|5av)\.tv$/i;
  const MISSAV_LIKE_HOST_RE = /(?:^|\.)missav\.(?:com|ws)$/i;
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
  let fullscreenOrientationBound = false;
  let gestureObserverInstalled = false;

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

  function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, number));
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

  function isJableLikeHost(hostname = location.hostname) {
    return JABLE_LIKE_HOST_RE.test(hostname || '');
  }

  function isMissavLikeHost(hostname = location.hostname) {
    return MISSAV_LIKE_HOST_RE.test(hostname || '');
  }

  function extractJableLikeSlug(pathname) {
    const match = String(pathname || '').match(/^\/(?:s\d+\/)?videos\/([^/]+)\/?/i);
    return match ? match[1].toLowerCase() : '';
  }

  function extractMissavLikeParts(pathname) {
    const segments = String(pathname || '')
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return { slug: '', prefix: '/', locale: '', dm: '' };
    }

    let index = 0;
    let dm = '';
    if (/^dm\d+$/i.test(segments[index])) {
      dm = segments[index].toLowerCase();
      index += 1;
    }

    let locale = '';
    if (index < segments.length && /^[a-z]{2}$/i.test(segments[index])) {
      locale = segments[index].toLowerCase();
      index += 1;
    }

    const normalizedPrefix = locale ? `/${locale}/` : '/';
    if (index !== segments.length - 1) {
      return { slug: '', prefix: normalizedPrefix, locale, dm };
    }

    const slug = segments[index].toLowerCase();
    if (!canonicalizeCode(slug)) {
      return { slug: '', prefix: normalizedPrefix, locale, dm };
    }

    return { slug, prefix: normalizedPrefix, locale, dm };
  }

  function getMissavLikeDefaultPrefix() {
    const parts = extractMissavLikeParts(location.pathname);
    if (parts.locale) {
      return `/${parts.locale}/`;
    }
    const locale = document.documentElement?.lang;
    if (locale && /^[a-z]{2}$/i.test(locale)) {
      return `/${locale.toLowerCase()}/`;
    }
    return '/';
  }

  function buildVideoUrlForCurrentSite(code) {
    const slug = codeToSlug(code);
    if (!slug) {
      return '';
    }
    if (isMissavLikeHost()) {
      const prefix = getMissavLikeDefaultPrefix();
      return new URL(`${prefix}${slug}/`, location.origin).toString();
    }
    return new URL(`/videos/${slug}/`, location.origin).toString();
  }

  function normalizeVideoUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.origin);
      if (isJableLikeHost(url.hostname)) {
        const slug = extractJableLikeSlug(url.pathname);
        if (!slug) {
          return '';
        }
        return new URL(`/videos/${slug}/`, url.origin).toString();
      }
      if (isMissavLikeHost(url.hostname)) {
        const { slug, prefix } = extractMissavLikeParts(url.pathname);
        if (!slug) {
          return '';
        }
        return new URL(`${prefix}${slug}/`, url.origin).toString();
      }
      const fallbackSlug = extractJableLikeSlug(url.pathname);
      if (!fallbackSlug) {
        return '';
      }
      return new URL(`/videos/${fallbackSlug}/`, url.origin).toString();
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

  function normalizePerformerName(rawName) {
    if (!rawName) {
      return '';
    }
    const cleaned = String(rawName).replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length < 2 || cleaned.length > 36) {
      return '';
    }
    if (/^[\d\W_]+$/u.test(cleaned)) {
      return '';
    }
    if (/^(?:n\/a|unknown|null|undefined|匿名|不明)$/i.test(cleaned)) {
      return '';
    }
    return cleaned;
  }

  function collectPerformerNames(source, bucket) {
    if (!source) {
      return;
    }

    if (Array.isArray(source)) {
      source.forEach((item) => collectPerformerNames(item, bucket));
      return;
    }

    if (typeof source === 'string') {
      source
        .split(/[、,\/|]|&| and /gi)
        .map((segment) => normalizePerformerName(segment))
        .filter(Boolean)
        .forEach((name) => bucket.add(name));
      return;
    }

    if (typeof source === 'object') {
      const fields = [
        source.name,
        source.name_ja,
        source.name_en,
        source.display_name,
        source.actress_name,
        source.text
      ];
      fields.forEach((value) => collectPerformerNames(value, bucket));
    }
  }

  function extractPerformersFromApiRow(row) {
    if (!row || typeof row !== 'object') {
      return [];
    }
    const bucket = new Set();
    const fields = [
      row.actress,
      row.actresses,
      row.actress_name,
      row.actress_names,
      row.actress_name_ja,
      row.actress_name_en,
      row.models,
      row.performers,
      row.stars
    ];
    fields.forEach((value) => collectPerformerNames(value, bucket));
    if (bucket.size === 0) {
      [row.title_zh, row.title_en, row.title_ja, row.title].forEach((title) => {
        inferPerformersFromTitle(title).forEach((name) => bucket.add(name));
      });
    }
    return Array.from(bucket).slice(0, 3);
  }

  function inferPerformersFromTitle(title) {
    if (!title) {
      return [];
    }
    const text = String(title).replace(/\s+/g, ' ').trim();
    if (!text) {
      return [];
    }

    const stripped = text
      .replace(/[!！?？。．…~～]+$/g, '')
      .replace(/\s*[（(【\[].{1,16}[】\])）]\s*$/g, '')
      .trim();
    if (!stripped) {
      return [];
    }

    const bucket = new Set();
    const cjkTail = stripped.match(/([一-龥々〆ヵヶぁ-ゔァ-ヴー]{2,14})$/u);
    if (cjkTail) {
      collectPerformerNames(cjkTail[1], bucket);
    }
    const latinTail = stripped.match(/([A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,2})$/);
    if (latinTail) {
      collectPerformerNames(latinTail[1], bucket);
    }
    return Array.from(bucket).slice(0, 3);
  }

  function extractPerformersFromPageDocument(doc = document) {
    if (!doc) {
      return [];
    }
    const bucket = new Set();
    const selectors = [
      '.video-info .models a',
      '.video-info a[href*="/models/"]',
      '.video-info a[href*="/star/"]',
      '.video-info a[href*="/actress/"]',
      '[class*="model"] a',
      '[class*="actor"] a',
      '[class*="performer"] a'
    ];
    selectors.forEach((selector) => {
      doc.querySelectorAll(selector).forEach((node) => {
        const candidateTexts = [
          node.getAttribute('title'),
          node.getAttribute('data-original-title'),
          node.getAttribute('aria-label'),
          node.querySelector('.placeholder')?.getAttribute('title'),
          node.querySelector('[data-toggle="tooltip"]')?.getAttribute('title'),
          node.textContent || ''
        ];
        candidateTexts.forEach((value) => collectPerformerNames(value, bucket));
      });
    });
    return Array.from(bucket).slice(0, 3);
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
    let performers = Array.isArray(item.performers)
      ? item.performers.map((name) => normalizePerformerName(name)).filter(Boolean).slice(0, 3)
      : [];
    if (performers.length === 0) {
      performers = inferPerformersFromTitle(title);
    }
    const isCurrent = item.isCurrent === true;
    return {
      code,
      title,
      url,
      releaseDate,
      likeCount,
      performers,
      isCurrent
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
      if (!Array.isArray(nextItem.performers) || nextItem.performers.length === 0) {
        nextItem.performers = inferPerformersFromTitle(nextItem.title);
      }
      return nextItem;
    });
    return hydratedItems;
  }

  function buildMissavVerifyUrlCandidates(canonicalUrl) {
    try {
      const url = new URL(canonicalUrl, location.origin);
      if (!isMissavLikeHost(url.hostname)) {
        return [url.toString()];
      }

      const target = extractMissavLikeParts(url.pathname);
      if (!target.slug) {
        return [url.toString()];
      }

      const current = extractMissavLikeParts(location.pathname);
      const locale = target.locale || current.locale || '';
      const currentDm = current.dm || '';
      const dmFallbacks = ['dm18', 'dm21'];
      const candidates = [];
      const seen = new Set();

      const pushPath = (path) => {
        try {
          const resolved = new URL(path, url.origin).toString();
          if (seen.has(resolved)) {
            return;
          }
          seen.add(resolved);
          candidates.push(resolved);
        } catch {}
      };

      const localeSegment = locale ? `${locale}/` : '';
      if (currentDm) {
        pushPath(`/${currentDm}/${localeSegment}${target.slug}/`);
      }
      if (locale) {
        pushPath(`/${locale}/${target.slug}/`);
      }
      pushPath(`/${target.slug}/`);
      dmFallbacks.forEach((dm) => {
        pushPath(`/${dm}/${localeSegment}${target.slug}/`);
      });
      pushPath(url.pathname);

      return candidates.length > 0 ? candidates : [url.toString()];
    } catch {
      return [canonicalUrl];
    }
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

  function normalizeSortMode(mode) {
    return mode === SORT_MODE_NEWEST ? SORT_MODE_NEWEST : SORT_MODE_HOT;
  }

  function readSortModePreference() {
    try {
      return normalizeSortMode(localStorage.getItem(SORT_MODE_STORAGE_KEY));
    } catch {
      return SORT_MODE_HOT;
    }
  }

  function writeSortModePreference(mode) {
    const normalizedMode = normalizeSortMode(mode);
    try {
      localStorage.setItem(SORT_MODE_STORAGE_KEY, normalizedMode);
    } catch {}
    return normalizedMode;
  }

  function getPanelSortMode(panel) {
    return normalizeSortMode(panel?.dataset?.sortMode || readSortModePreference());
  }

  function applySortModeState(panel, mode) {
    if (!panel) {
      return;
    }
    const normalizedMode = normalizeSortMode(mode);
    panel.dataset.sortMode = normalizedMode;
    panel.querySelectorAll('.jh-sort-btn').forEach((button) => {
      const isActive = button.dataset.sortMode === normalizedMode;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
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

  function hasTouchCapability() {
    return Boolean('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }

  function ensureGestureStyle() {
    if (document.getElementById(GESTURE_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = GESTURE_STYLE_ID;
    style.textContent = `
      .jh-gesture-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 3;
      }
      .jh-gesture-dim {
        position: absolute;
        inset: 0;
        background: #000;
        opacity: 0;
        transition: opacity 0.12s linear;
      }
      .jh-gesture-hint {
        position: absolute;
        top: 12%;
        left: 50%;
        transform: translateX(-50%);
        max-width: 75%;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.8);
        color: #f8fafc;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.3;
        opacity: 0;
        transition: opacity 0.16s ease;
        text-align: center;
      }
      .jh-gesture-hint.is-visible {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  function getGestureContainer(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return null;
    }
    return (
      video.closest('.plyr__video-wrapper') ||
      video.closest('.plyr') ||
      video.closest('[class*="player"]') ||
      video.parentElement ||
      video
    );
  }

  function ensureGestureLayer(container) {
    if (!(container instanceof Element)) {
      return null;
    }
    const existingLayer = container.querySelector(':scope > .jh-gesture-layer');
    if (existingLayer) {
      const dimNode = existingLayer.querySelector('.jh-gesture-dim');
      const hintNode = existingLayer.querySelector('.jh-gesture-hint');
      if (dimNode && hintNode) {
        return { layer: existingLayer, dimNode, hintNode };
      }
    }

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const layer = document.createElement('div');
    layer.className = 'jh-gesture-layer';

    const dimNode = document.createElement('div');
    dimNode.className = 'jh-gesture-dim';

    const hintNode = document.createElement('div');
    hintNode.className = 'jh-gesture-hint';

    layer.appendChild(dimNode);
    layer.appendChild(hintNode);
    container.appendChild(layer);
    return { layer, dimNode, hintNode };
  }

  function calcTouchDistance(touchA, touchB) {
    if (!touchA || !touchB) {
      return 0;
    }
    const dx = touchA.clientX - touchB.clientX;
    const dy = touchA.clientY - touchB.clientY;
    return Math.hypot(dx, dy);
  }

  function isTouchOnControl(target) {
    return target instanceof Element && Boolean(target.closest('.plyr__controls, button, a, input, select, textarea'));
  }

  function formatPercent(value) {
    return `${Math.round(clampNumber(value, 0, 1) * 100)}%`;
  }

  function lockLandscapeOrientation() {
    try {
      if (screen.orientation && typeof screen.orientation.lock === 'function') {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } catch {}
  }

  function unlockOrientation() {
    try {
      if (screen.orientation && typeof screen.orientation.unlock === 'function') {
        screen.orientation.unlock();
      }
    } catch {}
  }

  function bindFullscreenOrientationLifecycle() {
    if (fullscreenOrientationBound) {
      return;
    }
    fullscreenOrientationBound = true;

    const onFullscreenChange = () => {
      const activeFullscreenElement =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement;
      if (activeFullscreenElement) {
        lockLandscapeOrientation();
      } else {
        unlockOrientation();
      }
    };

    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach((eventName) => {
      document.addEventListener(eventName, onFullscreenChange, true);
    });
  }

  async function requestFullscreen(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const request =
      element.requestFullscreen ||
      element.webkitRequestFullscreen ||
      element.mozRequestFullScreen ||
      element.msRequestFullscreen;
    if (typeof request !== 'function') {
      return false;
    }
    try {
      const result = request.call(element);
      if (result && typeof result.then === 'function') {
        await result.catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  function installVideoGestureHandlers(video) {
    if (!(video instanceof HTMLVideoElement) || video.dataset.jhGestureBound === '1') {
      return;
    }
    const container = getGestureContainer(video);
    if (!(container instanceof Element)) {
      return;
    }
    const layerContext = ensureGestureLayer(container);
    if (!layerContext) {
      return;
    }

    video.dataset.jhGestureBound = '1';
    bindFullscreenOrientationLifecycle();

    const state = {
      brightness: 1,
      activeSide: '',
      startX: 0,
      startY: 0,
      startVolume: 0,
      startBrightness: 1,
      moved: false,
      pinchStartDistance: 0,
      pinchTriggered: false,
      hintTimer: 0,
      lastTapAt: 0,
      lastTapX: 0,
      lastTapY: 0,
      suppressClickUntil: 0
    };

    const showHint = (text) => {
      if (!text) {
        return;
      }
      layerContext.hintNode.textContent = text;
      layerContext.hintNode.classList.add('is-visible');
      if (state.hintTimer) {
        clearTimeout(state.hintTimer);
      }
      state.hintTimer = window.setTimeout(() => {
        layerContext.hintNode.classList.remove('is-visible');
      }, 900);
    };

    const updateBrightness = (nextBrightness) => {
      state.brightness = clampNumber(nextBrightness, GESTURE_BRIGHTNESS_MIN, GESTURE_BRIGHTNESS_MAX);
      layerContext.dimNode.style.opacity = String(clampNumber(1 - state.brightness, 0, 0.7));
      showHint(`亮度 ${formatPercent(state.brightness)}`);
    };

    const updateVolume = (nextVolume) => {
      const volume = clampNumber(nextVolume, 0, 1);
      video.volume = volume;
      video.muted = volume <= 0.001;
      showHint(`音量 ${formatPercent(volume)}`);
    };

    const togglePlayback = () => {
      if (video.paused || video.ended) {
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
        showHint('播放');
      } else {
        video.pause();
        showHint('暂停');
      }
    };

    const onTouchStart = (event) => {
      if (isTouchOnControl(event.target)) {
        return;
      }

      if (event.touches.length === 2) {
        state.pinchStartDistance = calcTouchDistance(event.touches[0], event.touches[1]);
        state.pinchTriggered = false;
        state.moved = false;
        return;
      }

      if (event.touches.length !== 1) {
        return;
      }

      const touch = event.touches[0];
      const rect = video.getBoundingClientRect();
      if (touch.clientX < rect.left || touch.clientX > rect.right || touch.clientY < rect.top || touch.clientY > rect.bottom) {
        return;
      }

      state.startX = touch.clientX;
      state.startY = touch.clientY;
      state.activeSide = touch.clientX <= rect.left + rect.width / 2 ? 'left' : 'right';
      state.startVolume = clampNumber(video.muted ? 0 : video.volume, 0, 1);
      state.startBrightness = state.brightness;
      state.moved = false;
      state.pinchStartDistance = 0;
      state.pinchTriggered = false;
    };

    const onTouchMove = (event) => {
      if (event.touches.length === 2 && state.pinchStartDistance > 0) {
        const distance = calcTouchDistance(event.touches[0], event.touches[1]);
        const scale = state.pinchStartDistance > 0 ? distance / state.pinchStartDistance : 1;
        if (!state.pinchTriggered && scale >= GESTURE_PINCH_SCALE_TRIGGER) {
          state.pinchTriggered = true;
          requestFullscreen(container).then((entered) => {
            if (entered) {
              lockLandscapeOrientation();
              showHint('已全屏横屏');
            }
          });
        }
        if (scale > 1.02) {
          event.preventDefault();
        }
        return;
      }

      if (event.touches.length !== 1 || !state.activeSide) {
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (!state.moved) {
        if (absDy < GESTURE_MIN_MOVE_PX) {
          return;
        }
        if (absDy <= absDx * GESTURE_VERTICAL_RATIO) {
          return;
        }
      }

      state.moved = true;
      event.preventDefault();

      if (state.activeSide === 'right') {
        const nextVolume = state.startVolume - dy / GESTURE_VOLUME_STEP_PX;
        updateVolume(nextVolume);
      } else if (state.activeSide === 'left') {
        const nextBrightness = state.startBrightness - dy / GESTURE_BRIGHTNESS_STEP_PX;
        updateBrightness(nextBrightness);
      }
    };

    const onTouchEnd = (event) => {
      if (!state.activeSide && !state.moved) {
        return;
      }

      if (!state.moved && state.activeSide) {
        const currentTime = nowMs();
        const deltaTime = currentTime - state.lastTapAt;
        const tapDistance = Math.hypot(state.startX - state.lastTapX, state.startY - state.lastTapY);
        if (state.lastTapAt > 0 && deltaTime <= GESTURE_DOUBLE_TAP_MS && tapDistance <= GESTURE_DOUBLE_TAP_MAX_DISTANCE_PX) {
          togglePlayback();
          state.lastTapAt = 0;
          state.suppressClickUntil = currentTime + GESTURE_SUPPRESS_CLICK_MS;
          event.preventDefault();
          event.stopPropagation();
        } else {
          state.lastTapAt = currentTime;
          state.lastTapX = state.startX;
          state.lastTapY = state.startY;
        }
      }

      state.activeSide = '';
      state.moved = false;
      state.pinchStartDistance = 0;
      state.pinchTriggered = false;
    };

    const onClickCapture = (event) => {
      if (nowMs() > state.suppressClickUntil) {
        return;
      }
      if (isTouchOnControl(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const onDoubleClickCapture = (event) => {
      if (isTouchOnControl(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: false });
    container.addEventListener('touchcancel', onTouchEnd, { passive: false });
    container.addEventListener('click', onClickCapture, true);
    container.addEventListener('dblclick', onDoubleClickCapture, true);
  }

  function installMobileVideoGestures() {
    if (gestureObserverInstalled || !hasTouchCapability() || !isVideoPage()) {
      return;
    }
    gestureObserverInstalled = true;
    ensureGestureStyle();

    const bindExistingVideos = (root = document) => {
      root.querySelectorAll?.('video').forEach(installVideoGestureHandlers);
      if (root instanceof HTMLVideoElement) {
        installVideoGestureHandlers(root);
      }
    };

    bindExistingVideos(document);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }
          bindExistingVideos(node);
        });
      });
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true
    });
  }

  function isVideoPage() {
    return Boolean(getCurrentSlug());
  }

  function getCurrentSlug() {
    if (isMissavLikeHost()) {
      return extractMissavLikeParts(location.pathname).slug;
    }
    return extractJableLikeSlug(location.pathname);
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

    const titleSelectors = [
      '.video-info h4',
      '.mt-4 h1',
      'h1',
      'meta[property="og:title"]'
    ];
    let titleText = '';
    for (const selector of titleSelectors) {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }
      if (selector.startsWith('meta')) {
        titleText = node.getAttribute('content') || '';
      } else {
        titleText = node.textContent || '';
      }
      if (titleText.trim()) {
        break;
      }
    }
    if (!titleText.trim()) {
      titleText = document.title;
    }
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

  async function loadSeriesItems(seriesId) {
    const shouldUseStaleCache = isVerifyNetworkRestricted();
    const cachedItems = getSeriesItemsFromCache(seriesId, { allowStale: shouldUseStaleCache });
    if (cachedItems && cachedItems.length > 0) {
      return cachedItems.slice(0, CANDIDATE_LIMIT);
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
          url: buildVideoUrlForCurrentSite(code),
          releaseDate: row?.release_date || '',
          performers: extractPerformersFromApiRow(row)
        });
      });

      page += 1;
    }

    const candidates = Array.from(items.values()).slice(0, CANDIDATE_LIMIT);
    const verifiedItems = await filterItemsExistingOnJable(candidates);
    setSeriesItemsCache(seriesId, verifiedItems);
    return verifiedItems.slice(0, CANDIDATE_LIMIT);
  }

  function isVideoPath(pathname, hostname = location.hostname) {
    if (isMissavLikeHost(hostname)) {
      return Boolean(extractMissavLikeParts(pathname).slug);
    }
    if (isJableLikeHost(hostname)) {
      return /^\/(?:s\d+\/)?videos\/[^/]+\/?$/i.test(pathname);
    }
    return /^\/(?:s\d+\/)?videos\/[^/]+\/?$/i.test(pathname);
  }

  function extractLikeCountFromDocument(doc) {
    if (!doc) {
      return null;
    }
    try {
      const selectorCandidates = [
        'button.btn.btn-action.fav .count',
        '.btn-action.fav .count',
        '[class*="fav"] .count',
        '[class*="like"] .count',
        '.fa-heart + span',
        '.mdi-heart + span'
      ];
      for (const selector of selectorCandidates) {
        const countText = doc.querySelector(selector)?.textContent || '';
        const parsed = parseNumberText(countText);
        if (parsed !== null) {
          return parsed;
        }
      }

      const bodyText = doc.body?.textContent || '';
      const fallbackMatch = bodyText.match(/(?:❤|♥|heart|喜欢|點讚|点赞)\D{0,12}([\d,\s]{1,12})/i);
      return fallbackMatch ? parseNumberText(fallbackMatch[1]) : null;
    } catch {
      return null;
    }
  }

  function extractLikeCountFromHtml(htmlText) {
    if (!htmlText) {
      return null;
    }
    try {
      const doc = new DOMParser().parseFromString(htmlText, 'text/html');
      return extractLikeCountFromDocument(doc);
    } catch {
      return null;
    }
  }

  function sortSeriesItems(items, mode = SORT_MODE_HOT) {
    const normalizedMode = normalizeSortMode(mode);
    return items
      .slice()
      .sort((a, b) => {
        const aLike = Number.isFinite(a.likeCount) ? a.likeCount : null;
        const bLike = Number.isFinite(b.likeCount) ? b.likeCount : null;
        const aDate = String(a.releaseDate || '');
        const bDate = String(b.releaseDate || '');

        if (normalizedMode === SORT_MODE_NEWEST && aDate !== bDate) {
          return bDate.localeCompare(aDate);
        }
        if (aLike !== null && bLike !== null && aLike !== bLike) {
          return bLike - aLike;
        }
        if (aLike !== null && bLike === null) {
          return -1;
        }
        if (aLike === null && bLike !== null) {
          return 1;
        }
        if (aDate !== bDate) {
          return bDate.localeCompare(aDate);
        }
        return String(a.code || '').localeCompare(String(b.code || ''));
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

    const requestWithTimeout = async (targetUrl, method) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await fetch(targetUrl, {
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
      const canonicalUrlObject = new URL(canonicalUrl, location.origin);
      const isMissavTarget = isMissavLikeHost(canonicalUrlObject.hostname);
      const requestUrls = isMissavTarget ? buildMissavVerifyUrlCandidates(canonicalUrl) : [canonicalUrl];
      const baseMethod = withLikeCount ? 'GET' : 'HEAD';
      let sawNotFound = false;
      let sawForbidden = false;

      for (const requestUrl of requestUrls) {
        let method = baseMethod;
        let response = await requestWithTimeout(requestUrl, method);
        if (method === 'HEAD' && (response.status === 405 || response.status === 501)) {
          method = 'GET';
          usedDetailRequest = true;
          response = await requestWithTimeout(requestUrl, method);
        }

        if (response.status === 429) {
          markVerifyThrottled();
          return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest };
        }
        if (response.status === 403) {
          if (isMissavTarget) {
            sawForbidden = true;
            continue;
          }
          markVerifyThrottled();
          return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest };
        }
        if (response.status === 404) {
          if (isMissavTarget) {
            sawNotFound = true;
            continue;
          }
          setVideoExistenceCache(canonicalUrl, false);
          markVerifySuccess();
          return { exists: false, likeCount: null, usedDetailRequest };
        }

        const finalUrl = response.url || requestUrl;
        const normalizedFinalUrl = normalizeVideoUrl(finalUrl);
        const finalUrlObject = new URL(finalUrl, location.origin);
        const finalPath = finalUrlObject.pathname;
        const isVideoRoute = Boolean(normalizedFinalUrl) && isVideoPath(finalPath, finalUrlObject.hostname);
        if (!isVideoRoute) {
          if (isMissavTarget) {
            continue;
          }
          markVerifyFailure();
          return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest };
        }

        if (!response.ok) {
          if (isMissavTarget) {
            continue;
          }
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
      }

      if (isMissavTarget && sawNotFound && !sawForbidden) {
        setVideoExistenceCache(canonicalUrl, false);
        markVerifySuccess();
        return { exists: false, likeCount: null, usedDetailRequest };
      }

      markVerifyFailure();
      return { exists: cachedExists === true, likeCount: cachedLike, usedDetailRequest };
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
      if (verified.length >= CANDIDATE_LIMIT) {
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
    return verified;
  }

  function harvestLikeCountsFromPage() {
    const currentVideoUrl = normalizeVideoUrl(location.href);
    const currentLike = extractLikeCountFromDocument(document);
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

    const fallbackAnchors = document.querySelectorAll('a[href]');
    let scanned = 0;
    fallbackAnchors.forEach((anchor) => {
      if (scanned >= 220) {
        return;
      }
      scanned += 1;

      const href = anchor.getAttribute('href') || '';
      const itemUrl = normalizeVideoUrl(href);
      if (!itemUrl) {
        return;
      }
      setVideoExistenceCache(itemUrl, true);

      const blockText =
        anchor.closest('article,li,div,section')?.textContent ||
        anchor.parentElement?.textContent ||
        '';
      if (!blockText) {
        return;
      }
      const nearNumbers = blockText.match(/\d[\d,\s]{0,10}/g) || [];
      if (nearNumbers.length === 0) {
        return;
      }
      const likeCount = parseNumberText(nearNumbers[nearNumbers.length - 1]);
      if (likeCount !== null) {
        setLikeCountCache(itemUrl, likeCount);
      }
    });
  }

  function inferReleaseDateFromPage() {
    const selectorCandidates = [
      'meta[itemprop="datePublished"]',
      'meta[property="video:release_date"]',
      '.video-info .meta',
      '.video-info',
      'body'
    ];
    for (const selector of selectorCandidates) {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }
      const text = selector.startsWith('meta')
        ? node.getAttribute('content') || ''
        : node.textContent || '';
      const matched = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
      if (matched) {
        return matched[1];
      }
    }
    return '';
  }

  function inferCurrentTitleFromPage() {
    const titleSelectors = ['.video-info h4', '.mt-4 h1', 'h1', 'meta[property="og:title"]'];
    for (const selector of titleSelectors) {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }
      const text = selector.startsWith('meta') ? node.getAttribute('content') || '' : node.textContent || '';
      if (text.trim()) {
        return text.trim();
      }
    }
    return document.title || '';
  }

  function buildCurrentSeriesItem(currentCode) {
    if (!currentCode) {
      return null;
    }
    const currentUrl = normalizeVideoUrl(location.href) || buildVideoUrlForCurrentSite(currentCode);
    if (!currentUrl) {
      return null;
    }
    const currentLike = extractLikeCountFromDocument(document);
    if (currentLike !== null) {
      setLikeCountCache(currentUrl, currentLike);
    }
    setVideoExistenceCache(currentUrl, true);
    const currentTitle = inferCurrentTitleFromPage();
    const performerSet = new Set();
    extractPerformersFromPageDocument(document).forEach((name) => performerSet.add(name));
    inferPerformersFromTitle(currentTitle).forEach((name) => performerSet.add(name));
    return normalizeSeriesItem({
      code: currentCode,
      title: currentTitle,
      url: currentUrl,
      releaseDate: inferReleaseDateFromPage(),
      likeCount: currentLike,
      performers: Array.from(performerSet).slice(0, 3)
    });
  }

  function mergeCurrentItemIntoSeries(items, currentItem, currentCode) {
    const sourceItems = Array.isArray(items) ? items : [];
    const merged = sourceItems.map((item) => ({ ...item }));
    const codeKey = String(currentCode || '').toUpperCase();
    if (!codeKey) {
      return merged;
    }

    let found = false;
    for (const item of merged) {
      if (String(item.code || '').toUpperCase() !== codeKey) {
        continue;
      }
      found = true;
      item.isCurrent = true;
      if (currentItem) {
        item.url = currentItem.url || item.url;
        item.title = currentItem.title || item.title;
        item.releaseDate = currentItem.releaseDate || item.releaseDate;
        item.likeCount = Number.isFinite(currentItem.likeCount) ? currentItem.likeCount : item.likeCount;
        item.performers = Array.isArray(currentItem.performers) && currentItem.performers.length > 0
          ? currentItem.performers
          : item.performers;
      }
      break;
    }

    if (!found && currentItem) {
      merged.push({ ...currentItem, isCurrent: true });
    }
    return merged;
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
      #${PANEL_ID} .jh-sort {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px;
        border-radius: 8px;
        background: rgba(30, 41, 59, 0.48);
      }
      #${PANEL_ID} .jh-sort-btn {
        border: none;
        border-radius: 6px;
        padding: 2px 8px;
        font-size: 12px;
        line-height: 1.4;
        color: #cbd5e1;
        background: transparent;
      }
      #${PANEL_ID} .jh-sort-btn.is-active {
        color: #0f172a;
        font-weight: 700;
        background: #7dd3fc;
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
        padding-bottom: 8px;
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
      #${PANEL_ID} .jh-badge {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.4;
        color: #052e16;
        background: #86efac;
        font-weight: 700;
        vertical-align: middle;
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
          bottom: calc(58px + env(safe-area-inset-bottom));
          width: auto;
          max-height: 42vh;
        }
        #${PANEL_ID} .jh-toggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        #${PANEL_ID} .jh-sort-btn {
          padding: 2px 7px;
        }
        #${PANEL_ID} .jh-body {
          max-height: calc(42vh - 46px);
          padding-bottom: calc(14px + env(safe-area-inset-bottom));
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
            <div class="jh-sort" role="group" aria-label="排序方式">
              <button type="button" class="jh-sort-btn" data-sort-mode="${SORT_MODE_HOT}" aria-pressed="true">最热</button>
              <button type="button" class="jh-sort-btn" data-sort-mode="${SORT_MODE_NEWEST}" aria-pressed="false">最新</button>
            </div>
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

    if (panel.dataset.sortBound !== '1') {
      panel.dataset.sortBound = '1';
      panel.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('.jh-sort-btn') : null;
        if (!button) {
          return;
        }
        const nextMode = writeSortModePreference(button.dataset.sortMode);
        applySortModeState(panel, nextMode);
        const renderState = panel.__jhRenderState;
        if (renderState) {
          renderPanel(renderState.title, renderState.items, renderState.emptyMessage);
        }
      });
    }

    const shouldCollapse = isMobileViewport() && readCollapsedPreference();
    applyCollapsedState(panel, shouldCollapse);
    applySortModeState(panel, readSortModePreference());

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
    panel.__jhRenderState = {
      title,
      items: Array.isArray(items) ? items.slice() : [],
      emptyMessage
    };

    const normalizedItems = Array.isArray(items) ? items : [];
    if (normalizedItems.length === 0) {
      countNode.textContent = '0 条';
      bodyNode.innerHTML = `<div class="jh-empty">${emptyMessage}</div>`;
      return;
    }

    const sortedItems = sortSeriesItems(normalizedItems, getPanelSortMode(panel));
    const visibleItems = sortedItems.slice(0, ITEM_LIMIT);
    countNode.textContent =
      sortedItems.length > visibleItems.length ? `${visibleItems.length}/${sortedItems.length} 条` : `${visibleItems.length} 条`;
    bodyNode.innerHTML = '';

    const fragment = document.createDocumentFragment();
    visibleItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'jh-item';

      const link = document.createElement('a');
      link.className = 'jh-link';
      link.href = item.url;

      const code = document.createElement('span');
      code.className = 'jh-code';
      code.textContent = item.code;

      const titleNode = document.createElement('span');
      titleNode.className = 'jh-title';
      titleNode.textContent = item.title;

      link.appendChild(code);
      if (item.isCurrent) {
        const badge = document.createElement('span');
        badge.className = 'jh-badge';
        badge.textContent = '当前';
        link.appendChild(badge);
      }
      link.appendChild(titleNode);

      const metaParts = [];
      if (Number.isFinite(item.likeCount)) {
        metaParts.push(`红心：${formatNumber(item.likeCount)}`);
      }
      const performerText = Array.isArray(item.performers) && item.performers.length > 0
        ? item.performers.join(' / ')
        : '未知';
      metaParts.push(`主演：${performerText}`);
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
    installMobileVideoGestures();

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
      const items = await loadSeriesItems(seriesContext.seriesId);
      const currentItem = buildCurrentSeriesItem(currentCode);
      const mergedItems = mergeCurrentItemIntoSeries(items, currentItem, currentCode);
      renderPanel(title, mergedItems, '系列存在，但未找到可展示条目');
    } catch (error) {
      console.warn('[Jable Helper] 系列加载失败:', error);
      renderPanel('相关系列作品', [], '系列数据加载失败，请稍后重试');
    }
  }

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
