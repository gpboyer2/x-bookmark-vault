// ==UserScript==
// @name         [X收藏] 帖子快照收藏 · 增删改查 · 导出
// @namespace    http://tampermonkey.net/
// @version      2026-10-30.1
// @description  一键收藏 X/Twitter 帖子：正文（含长文章全文）、图片链接、引用、评论快照，支持分组、增删改查与 JSON 导出；顺带过滤首页推广广告
// @author       You
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ==================================================================
  // 0. 运行环境守卫
  // ------------------------------------------------------------------
  // 只服务于 x.com / twitter.com 的普通网页。其它协议（file://、插件页、
  // 浏览器内置页）一律视为"脚本不存在"，不产生任何 DOM 痕迹。
  // ==================================================================
  const ALLOWED_HOSTS = ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.x.com', 'mobile.twitter.com'];

  function isSupportedPage() {
    try {
      if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
        return false;
      }
      return ALLOWED_HOSTS.indexOf(window.location.hostname) !== -1;
    } catch (error) {
      return false;
    }
  }

  if (!isSupportedPage()) {
    return;
  }

  // ==================================================================
  // 1. 全局配置
  // ==================================================================
  const CONFIG = {
    VERSION: '2026-10-30.1',
    DEBUG: false,

    // 选择器（集中管理，X 改版时只改这里）
    SEL: {
      article: 'article[data-testid="tweet"]',
      text: '[data-testid="tweetText"]',
      userName: '[data-testid="User-Name"]',
      avatar: '[data-testid^="UserAvatar-Container"] img',
      photo: '[data-testid="tweetPhoto"] img',
      video: '[data-testid="videoPlayer"], [data-testid="videoComponent"]',
      group: 'div[role="group"][aria-label]',
      time: 'time[datetime]',
      promo: '[data-testid="placementTracking"]',
      quoteLink: '[role="link"][tabindex="0"]',
      // 长文章（X Articles）：详情页与时间线卡片的 DOM 标记
      articleView: '[data-testid="twitterArticleReadView"]',
      articleTitle: '[data-testid="twitter-article-title"]',
      articleRich: '[data-testid="twitterArticleRichTextView"]',
      articleCover: '[data-testid="article-cover-image"]',
      // 广告：时间线单元格 / 右侧趋势条目 / 右栏容器
      cell: '[data-testid="cellInnerDiv"]',
      trend: '[data-testid="trend"]',
      sidebar: '[data-testid="sidebarColumn"]'
    },

    // UI 元素守护周期（X 会整块重渲染，必须定期自愈）
    SWEEP_INTERVAL: 1500,
    // 滚动 / DOM 变动后的补偿延迟
    SWEEP_DEBOUNCE: 300,
    // 单帖最多抓多少条评论
    MAX_REPLIES: 60,
    // 面板宽度上限
    PANEL_MAX_WIDTH: 1080
  };

  const UI_STYLE_ID = 'xb-style';
  const FLOAT_ID = 'xb-float';
  const PANEL_ID = 'xb-panel-root';
  const HOST_ID = 'xb-host';

  // ==================================================================
  // 2. 基础工具
  // ==================================================================

  const Logger = {
    log() {
      if (CONFIG.DEBUG) {
        console.log('[X收藏]', ...arguments);
      }
    },
    warn() {
      if (CONFIG.DEBUG) {
        console.warn('[X收藏]', ...arguments);
      }
    },
    error() {
      console.error('[X收藏]', ...arguments);
    }
  };

  const Text = {
    escape(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[ch]));
    },
    nl2br(value) {
      return Text.escape(value).replace(/\n/g, '<br>');
    },
    cut(value, len) {
      const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
      return s.length > len ? s.slice(0, len) + '…' : s;
    },
    num(value) {
      if (value == null || value === '') {
        return '';
      }
      const n = Number(value);
      if (!isFinite(n)) {
        return String(value);
      }
      if (n >= 1000000) {
        return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
      }
      if (n >= 1000) {
        return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
      }
      return String(n);
    }
  };

  const DOM = {
    create(tag, options) {
      const opts = options || {};
      const el = document.createElement(tag);
      if (opts.id) {
        el.id = opts.id;
      }
      if (opts.className) {
        el.className = opts.className;
      }
      if (opts.text != null) {
        el.textContent = String(opts.text);
      }
      if (opts.html != null) {
        el.innerHTML = String(opts.html);
      }
      if (opts.attrs) {
        Object.keys(opts.attrs).forEach(k => el.setAttribute(k, opts.attrs[k]));
      }
      if (opts.style) {
        Object.keys(opts.style).forEach(k => {
          try {
            el.style[k] = opts.style[k];
          } catch (error) {
            /* 忽略非法样式 */
          }
        });
      }
      return el;
    },
    on(el, type, handler, options) {
      if (el) {
        el.addEventListener(type, handler, options || false);
      }
    }
  };

  const DateUtil = {
    pad(n) {
      return String(n).padStart(2, '0');
    },
    fmt(ms) {
      if (!ms) {
        return '';
      }
      const d = new Date(ms);
      if (isNaN(d.getTime())) {
        return '';
      }
      return d.getFullYear() + '-' + this.pad(d.getMonth() + 1) + '-' + this.pad(d.getDate()) +
        ' ' + this.pad(d.getHours()) + ':' + this.pad(d.getMinutes());
    },
    fmtShort(ms) {
      if (!ms) {
        return '';
      }
      const d = new Date(ms);
      if (isNaN(d.getTime())) {
        return '';
      }
      return this.pad(d.getMonth() + 1) + '-' + this.pad(d.getDate()) + ' ' +
        this.pad(d.getHours()) + ':' + this.pad(d.getMinutes());
    },
    toISO(value) {
      if (!value) {
        return '';
      }
      const d = new Date(value);
      return isNaN(d.getTime()) ? '' : d.toISOString();
    },
    stamp() {
      const d = new Date();
      return d.getFullYear() + this.pad(d.getMonth() + 1) + this.pad(d.getDate()) +
        '-' + this.pad(d.getHours()) + this.pad(d.getMinutes());
    }
  };

  const Download = {
    save(filename, content, mime) {
      try {
        const blob = new Blob([content], { type: mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(url);
        }, 2000);
      } catch (error) {
        Logger.error('导出失败:', error);
        Toast.show('导出失败，请查看控制台');
      }
    }
  };

  /** GM 存储的薄封装：没有 GM API 时退回 localStorage */
  const GM = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key, null);
          return v == null ? fallback : v;
        }
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (error) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(key, value);
          return;
        }
        localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        Logger.warn('写入设置失败:', error);
      }
    }
  };

  // ==================================================================
  // 3. 存储层
  // ------------------------------------------------------------------
  // IndexedDB 为主（能存图片二进制），不可用时降级为内存 Map——
  // 宁可本次会话能用，也不要因为隐私模式直接崩掉。
  // 三张表：
  //   posts  { id, url, author, text, createdAt, savedAt, updatedAt,
  //            tags[], note, stats, media[], quote, replies[], source }
  //   media  { url, blob, mime, size, fetchedAt }
  //   meta   { k, v }
  // ==================================================================
  const DB = {
    NAME: 'xbook_db',
    VERSION: 1,
    _p: null,
    _mem: null,

    hasIDB() {
      try {
        return typeof indexedDB !== 'undefined' && !!indexedDB.open;
      } catch (error) {
        return false;
      }
    },

    open() {
      if (this._p) {
        return this._p;
      }
      this._p = new Promise(resolve => {
        if (!this.hasIDB()) {
          resolve(null);
          return;
        }
        let req;
        try {
          req = indexedDB.open(this.NAME, this.VERSION);
        } catch (error) {
          resolve(null);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          try {
            if (!db.objectStoreNames.contains('posts')) {
              const s = db.createObjectStore('posts', { keyPath: 'id' });
              s.createIndex('savedAt', 'savedAt');
              s.createIndex('handle', 'author.handle');
            }
            if (!db.objectStoreNames.contains('meta')) {
              db.createObjectStore('meta', { keyPath: 'k' });
            }
          } catch (error) {
            Logger.error('建表失败:', error);
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // 旧版本缓存过图片二进制；现在只存链接，顺手把历史 blob 清掉释放空间
          try {
            if (db.objectStoreNames.contains('media')) {
              const tx = db.transaction('media', 'readwrite');
              tx.objectStore('media').clear();
            }
          } catch (error) {
            /* 忽略 */
          }
          resolve(db);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
      return this._p;
    },

    mem() {
      if (!this._mem) {
        this._mem = { posts: new Map(), media: new Map(), meta: new Map() };
      }
      return this._mem;
    },

    keyOf(store, value) {
      if (store === 'meta') {
        return value && value.k;
      }
      if (store === 'media') {
        return value && value.url;
      }
      return value && value.id;
    },

    async put(store, value) {
      const db = await this.open();
      if (!db) {
        this.mem()[store].set(this.keyOf(store, value), value);
        return value;
      }
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(value);
          tx.oncomplete = () => resolve(value);
          tx.onerror = () => reject(tx.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    async get(store, key) {
      const db = await this.open();
      if (!db) {
        return this.mem()[store].get(key) || null;
      }
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(store, 'readonly');
          const req = tx.objectStore(store).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    async all(store) {
      const db = await this.open();
      if (!db) {
        return Array.from(this.mem()[store].values());
      }
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(store, 'readonly');
          const req = tx.objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    async del(store, key) {
      const db = await this.open();
      if (!db) {
        this.mem()[store].delete(key);
        return;
      }
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    async clear(store) {
      const db = await this.open();
      if (!db) {
        this.mem()[store].clear();
        return;
      }
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        } catch (error) {
          reject(error);
        }
      });
    }
  };

  const Posts = {
    async all() {
      const list = await DB.all('posts');
      return list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    },
    get(id) {
      return DB.get('posts', id);
    },
    put(post) {
      return DB.put('posts', post);
    },
    remove(id) {
      return DB.del('posts', id);
    },
    async update(id, patch) {
      const post = await DB.get('posts', id);
      if (!post) {
        return null;
      }
      Object.assign(post, patch, { updatedAt: Date.now() });
      await DB.put('posts', post);
      return post;
    },
    async count() {
      return (await DB.all('posts')).length;
    },
    async clearAll() {
      await DB.clear('posts');
    }
  };

  /** 设置（体积小，走 GM 存储） */
  const Settings = {
    KEY: 'xbook_settings',
    defaults() {
      return {
        captureReplies: true,
        maxReplies: CONFIG.MAX_REPLIES,
        // 首页推广广告过滤（时间线推广帖 + 右栏推广趋势）
        hideAds: true
      };
    },
    load() {
      const saved = GM.get(this.KEY, null);
      const cfg = this.defaults();
      if (saved && typeof saved === 'object') {
        Object.keys(cfg).forEach(k => {
          if (saved[k] !== undefined) {
            cfg[k] = saved[k];
          }
        });
      }
      return cfg;
    },
    save(patch) {
      const cfg = Object.assign(this.load(), patch || {});
      GM.set(this.KEY, cfg);
      return cfg;
    }
  };

  // ==================================================================
  // 4. X 数据补全（GraphQL）
  // ------------------------------------------------------------------
  // DOM 能拿到"用户看到的东西"，但长帖会被截断、视频没有直链、
  // 互动数可能只显示缩写。用页面自带的 GraphQL 接口再取一份结构化
  // 数据做补全；失败（接口改版 / 未登录 / 限流）时静默退回 DOM 结果。
  // 端点与特征参数沿用同目录 twitter.js 的验证结果。
  // ==================================================================
  const TweetAPI = {
    BEARER: 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    // 第一项是当前实测可用的 queryId；X 会不定期换，运行时还会从页面 JS 包里自动发现
    QUERY_IDS: ['U8lc5aomF5krJzZ9vJ9wxg', '2ICDjqPd81tulZcYrtpTuQ'],
    // 带上 withArticleRichContentState 才会返回「文章」全文，否则只有预览
    FIELD_TOGGLES: {
      withArticleRichContentState: true,
      withArticlePlainText: false,
      withArticleSummaryText: true,
      withArticleVoiceOver: true,
      withPayments: false
    },
    FEATURES: {
      articles_preview_enabled: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      communities_web_enable_tweet_community_results_fetch: false,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      longform_notetweets_consumption_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      premium_content_api_read_enabled: false,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_edit_tweet_api_enabled: false,
      responsive_web_enhance_cards_enabled: false,
      responsive_web_graphql_exclude_directive_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: false,
      responsive_web_grok_analysis_button_from_backend: false,
      responsive_web_grok_analyze_button_fetch_trends_enabled: false,
      responsive_web_grok_analyze_post_followups_enabled: false,
      responsive_web_grok_image_annotation_enabled: false,
      responsive_web_grok_share_attachment_enabled: false,
      responsive_web_grok_show_grok_translated_post: false,
      responsive_web_jetfuel_frame: false,
      responsive_web_media_download_video_enabled: false,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      rweb_video_screen_enabled: false,
      standardized_nudges_misinfo: true,
      tweet_awards_web_tipping_enabled: false,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      tweetypie_unmention_optimization_enabled: false,
      verified_phone_label_enabled: false,
      view_counts_everywhere_api_enabled: true
    },
    _failUntil: 0,
    _qidCache: null,
    _qidAt: 0,

    /**
     * 自动发现 TweetResultByRestId 的当前 queryId。
     * X 把接口元数据（queryId + operationName）写进 client-web 的 JS 包里，
     * 扫一遍比写死更耐改版；失败时退回 QUERY_IDS 里记录的实测值。
     */
    async resolveQueryIds() {
      if (this._qidCache && Date.now() - this._qidAt < 30 * 60 * 1000) {
        return this._qidCache;
      }
      const found = [];
      const scripts = Array.from(document.querySelectorAll('script[src]'))
        .map(s => s.src)
        .filter(u => /\/responsive-web\/client-web\/.*\.js(\?|$)/.test(u));
      for (let i = 0; i < scripts.length && found.length === 0; i++) {
        try {
          const text = await (await fetch(scripts[i])).text();
          const m = text.match(/queryId:"([^"]+)",operationName:"TweetResultByRestId"/);
          if (m) {
            found.push(m[1]);
          }
        } catch (error) {
          /* 单个包失败不影响其它包 */
        }
      }
      this.QUERY_IDS.forEach(id => {
        if (found.indexOf(id) === -1) {
          found.push(id);
        }
      });
      this._qidCache = found;
      this._qidAt = Date.now();
      Logger.log('TweetResultByRestId queryId:', found.join(', '));
      return found;
    },

    cookie(name) {
      try {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
      } catch (error) {
        return '';
      }
    },

    async fetch(id) {
      if (!id || Date.now() < this._failUntil) {
        return null;
      }
      const ct0 = this.cookie('ct0');
      if (!ct0) {
        Logger.log('没有 ct0（未登录），跳过 GraphQL 补全');
        return null;
      }
      const variables = {
        tweetId: id,
        with_rux_injections: false,
        includePromotedContent: true,
        withCommunity: true,
        withVoice: true,
        withBirdwatchNotes: true,
        withV2Timeline: true
      };
      const ids = await this.resolveQueryIds();
      for (let i = 0; i < ids.length; i++) {
        const qid = ids[i];
        try {
          const url = 'https://' + location.hostname + '/i/api/graphql/' + qid + '/TweetResultByRestId' +
            '?variables=' + encodeURIComponent(JSON.stringify(variables)) +
            '&features=' + encodeURIComponent(JSON.stringify(this.FEATURES)) +
            '&fieldToggles=' + encodeURIComponent(JSON.stringify(this.FIELD_TOGGLES));
          const res = await fetch(url, {
            credentials: 'include',
            headers: {
              authorization: 'Bearer ' + this.BEARER,
              'x-csrf-token': ct0,
              'x-twitter-active-user': 'yes',
              'x-twitter-client-language': 'en'
            }
          });
          if (!res || !res.ok) {
            continue;
          }
          const json = await res.json();
          const result = json && json.data && json.data.tweetResult && json.data.tweetResult.result;
          if (!result) {
            continue;
          }
          // 命中的 queryId 下次优先用
          if (i > 0 && this._qidCache) {
            this._qidCache.splice(i, 1);
            this._qidCache.unshift(qid);
          }
          return result.tweet || result;
        } catch (error) {
          Logger.warn('GraphQL 请求失败:', error);
        }
      }
      // 失败后 5 分钟内不再重试，避免每条帖子都撞一次墙
      this._failUntil = Date.now() + 5 * 60 * 1000;
      Logger.log('GraphQL 补全不可用，已退回 DOM 解析');
      return null;
    },

    origUrl(url) {
      return String(url || '').replace(/([?&])name=[^&]*/g, (m, p1) => p1 + 'name=orig');
    },

    cleanText(text) {
      return String(text || '')
        .replace(/https:\/\/t\.co\/\w+\s*$/g, '')
        .replace(/\u00a0/g, ' ')
        .trim();
    },

    mapMedia(list) {
      const out = [];
      (list || []).forEach(m => {
        if (!m || !m.media_url_https) {
          return;
        }
        const rawType = m.type || 'photo';
        const type = rawType === 'animated_gif' ? 'gif' : (rawType === 'video' ? 'video' : 'photo');
        let best = '';
        if (type !== 'photo' && m.video_info && m.video_info.variants) {
          const mp4 = m.video_info.variants
            .filter(v => v && v.content_type === 'video/mp4' && v.url)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          best = mp4.length ? mp4[0].url : '';
        }
        out.push({
          type: type,
          url: type === 'photo' ? this.origUrl(m.media_url_https) : best,
          thumb: m.media_url_https,
          poster: m.media_url_https,
          alt: (m.extended_alt_text || '')
        });
      });
      return out;
    },

    /** 文章（长文）结果：新接口放在 article.article_results.result，旧接口只有 article.article 预览 */
    articleOf(result) {
      const box = result && result.article;
      if (!box) {
        return null;
      }
      return (box.article_results && box.article_results.result) || box.article || null;
    },

    /** 文章富文本 content_state.blocks → 纯文本（段落 / 小标题 / 列表 / 内嵌链接） */
    articleText(article) {
      const state = article && article.content_state;
      if (!state || !Array.isArray(state.blocks)) {
        return '';
      }
      const map = state.entityMap || {};
      const lines = [];
      state.blocks.forEach(block => {
        const type = block.type || 'unstyled';
        if (type === 'atomic') {
          const range = (block.entityRanges || [])[0];
          const entity = range ? map[range.key] : null;
          const data = entity && entity.value && entity.value.data;
          const hasMedia = data && data.mediaItems && data.mediaItems.length;
          if (!hasMedia && data && data.url) {
            lines.push(String(data.url)); // 内嵌的推文/外链，保留链接
          }
          return; // 图片走 articleMedia，正文里不重复占位
        }
        const text = String(block.text || '').replace(/\u00a0/g, ' ').trim();
        if (!text) {
          lines.push('');
          return;
        }
        if (type === 'unordered-list-item') {
          lines.push('• ' + text);
        } else if (type === 'ordered-list-item') {
          lines.push('1. ' + text);
        } else if (type === 'blockquote') {
          lines.push('> ' + text);
        } else {
          lines.push(text);
        }
      });
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    },

    /** 文章配图：封面 + 正文内嵌图片/视频 */
    articleMedia(article) {
      const out = [];
      const seen = new Set();
      const push = info => {
        if (!info) {
          return;
        }
        const src = info.original_img_url || info.media_url_https || '';
        if (!src || seen.has(src)) {
          return;
        }
        seen.add(src);
        const isVideo = info.__typename === 'ApiVideo' || info.type === 'video';
        let url = this.origUrl(src);
        let poster = src;
        if (isVideo) {
          poster = (info.preview_image && info.preview_image.media_url_https) || src;
          const mp4 = (info.variants || [])
            .filter(v => v && v.content_type === 'video/mp4' && v.url)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          url = mp4.length ? mp4[0].url : '';
        }
        out.push({
          type: isVideo ? 'video' : 'photo',
          url: url,
          thumb: poster,
          poster: poster,
          alt: ''
        });
      };
      push(article.cover_media && article.cover_media.media_info);
      const entities = article.media_entities || {};
      Object.keys(entities).forEach(key => {
        push(entities[key] && entities[key].media_info);
      });
      return out;
    },

    /** 文章元信息：标题 + 打开链接（收藏库详情里单独展示） */
    articleMeta(article) {
      const title = String((article && article.title) || '').trim();
      const restId = String((article && article.rest_id) || '');
      if (!title && !restId) {
        return null;
      }
      return {
        id: restId,
        title: title,
        url: restId ? ('https://x.com/i/article/' + restId) : ''
      };
    },

    quoted(result, depth) {
      if (depth >= 1) {
        return null;
      }
      const q = result.quoted_status_result && result.quoted_status_result.result;
      if (!q) {
        return null;
      }
      const post = this.toPost(q.tweet || q, depth + 1);
      if (!post) {
        return null;
      }
      return {
        id: post.id,
        url: post.url,
        author: post.author,
        text: post.text,
        createdAt: post.createdAt,
        media: post.media
      };
    },

    toPost(result, depth) {
      if (!result) {
        return null;
      }
      const d = depth || 0;
      const legacy = result.legacy || {};
      const core = result.core && result.core.user_results && result.core.user_results.result;
      const userLegacy = (core && core.legacy) || {};
      const noteResult = result.note_tweet && result.note_tweet.note_tweet_results && result.note_tweet.note_tweet_results.result;
      const noteText = noteResult && noteResult.text ? noteResult.text : '';
      const id = result.rest_id || legacy.id_str || '';
      if (!id) {
        return null;
      }
      const handle = userLegacy.screen_name || '';
      const views = result.views && result.views.count != null ? parseInt(result.views.count, 10) : null;
      // 「文章」类帖子：普通 full_text 只是 t.co 链接，正文在 article 结构里
      const article = this.articleOf(result);
      let text = this.cleanText(noteText || legacy.full_text || '');
      let media = this.mapMedia((legacy.extended_entities && legacy.extended_entities.media) ||
        (legacy.entities && legacy.entities.media) || []);
      let articleInfo = null;
      if (article) {
        const title = String(article.title || '').trim();
        const body = this.articleText(article) || String(article.preview_text || '').trim();
        const full = [title, body].filter(Boolean).join('\n\n');
        if (full) {
          text = full;
        }
        const articleMedia = this.articleMedia(article);
        if (articleMedia.length) {
          media = articleMedia;
        }
        articleInfo = this.articleMeta(article);
      }
      return {
        id: id,
        url: 'https://x.com/' + (handle || 'i') + '/status/' + id,
        author: {
          name: userLegacy.name || '',
          handle: handle,
          avatar: String(userLegacy.profile_image_url_https || '').replace('_normal', '_400x400'),
          verified: !!userLegacy.verified
        },
        text: text,
        createdAt: DateUtil.toISO(legacy.created_at || ''),
        stats: {
          replies: legacy.reply_count != null ? legacy.reply_count : null,
          reposts: legacy.retweet_count != null ? legacy.retweet_count : null,
          likes: legacy.favorite_count != null ? legacy.favorite_count : null,
          bookmarks: legacy.bookmark_count != null ? legacy.bookmark_count : null,
          views: isNaN(views) ? null : views
        },
        media: media,
        article: articleInfo,
        quote: this.quoted(result, d),
        replies: [],
        source: article ? 'article' : 'graphql'
      };
    }
  };

  // ==================================================================
  // 5. DOM 解析
  // ------------------------------------------------------------------
  // 只用 data-testid / role / 语义结构，不依赖 X 混淆后的 class 名。
  // 每条选择器都留了兜底路径，单点失效不会导致整条帖子解析失败。
  // ==================================================================
  /**
   * 页面类型判定：只有"帖子详情页"才显示收藏按钮。
   *
   * X 同一个帖子有多种 URL 写法，全部以 pathname 里的 /status(es)/<纯数字> 为准：
   *   /<handle>/status/<id>                     普通详情
   *   /i/status/<id>、/i/web/status/<id>        站内跳转写法
   *   /<handle>/status/<id>/photo/1             图片详情
   *   /<handle>/status/<id>/video/1             视频详情
   *   /<handle>/status/<id>/analytics           帖子分析
   *   /<handle>/status/<id>/retweets            转发列表
   *   /<handle>/status/<id>/retweets/with_comments
   *   /<handle>/status/<id>/likes               点赞列表
   *   /<handle>/statuses/<id>                   旧写法
   *   ?s=20&t=xxx 之类的查询串一律忽略
   * 首页 /home、探索、个人主页、搜索、通知等都不匹配 → 不显示按钮。
   */
  const PageKind = {
    detailId() {
      const path = String((typeof location !== 'undefined' && location.pathname) || '');
      // 帖子详情：/status/、/statuses/（旧）、/i/status/、/i/web/status/
      // 长文章：/article/、/articles/、/i/article/
      const m = path.match(/\/(?:status(?:es)?|articles?)\/(\d+)/);
      return m ? m[1] : '';
    },
    isDetail() {
      return !!this.detailId();
    },
    isArticle() {
      return /\/articles?\//.test(String((typeof location !== 'undefined' && location.pathname) || ''));
    }
  };

  const TweetParser = {
    idFromUrl(url) {
      const m = String(url || '').match(/\/status\/(\d+)/);
      return m ? m[1] : '';
    },

    /** 引用帖里随便一个 /status/ 链接（引用块常常没有时间链接） */
    findAnyStatusLink(scope) {
      const a = scope.querySelector('a[href*="/status/"]');
      return a && a.href ? a.href : '';
    },

    findPermalink(scope) {
      const times = Array.from(scope.querySelectorAll(CONFIG.SEL.time));
      // 文章正文里可能内嵌别的帖子（带自己的时间链接），必须跳过，
      // 否则整篇文章会被认成那条内嵌帖
      const timeEl = times.find(t => !t.closest(CONFIG.SEL.articleView)) || times[0];
      if (timeEl) {
        const a = timeEl.closest('a[href*="/status/"]');
        if (a && a.href) {
          return a.href;
        }
      }
      const any = scope.querySelector('a[href*="/status/"]');
      return any && any.href ? any.href : '';
    },

    /** 引用帖的容器：role=link 且内部有作者名 + 文本/媒体，且不是整条帖子的链接 */
    findQuoteRoot(article) {
      const inArticleBody = el => !!(el.closest && el.closest(CONFIG.SEL.articleView));
      const candidates = Array.from(article.querySelectorAll(CONFIG.SEL.quoteLink));
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (el.querySelector('article') || inArticleBody(el)) {
          continue;
        }
        if (!el.querySelector(CONFIG.SEL.userName)) {
          continue;
        }
        if (el.querySelector(CONFIG.SEL.text + ', ' + CONFIG.SEL.photo + ', ' + CONFIG.SEL.video)) {
          return el;
        }
      }
      // 兜底：出现第二个作者名块时，向上找它的内容容器（文章正文里的内嵌帖不算引用）
      const names = Array.from(article.querySelectorAll(CONFIG.SEL.userName)).filter(n => !inArticleBody(n));
      if (names.length > 1) {
        let node = names[1].parentElement;
        for (let i = 0; i < 5 && node && node !== article; i++) {
          if (node.querySelector(CONFIG.SEL.text)) {
            return node;
          }
          node = node.parentElement;
        }
      }
      return null;
    },

    parseAuthor(scope) {
      const box = scope.querySelector(CONFIG.SEL.userName) || scope;
      const spans = Array.from(box.querySelectorAll('span'))
        .map(s => (s.textContent || '').trim())
        .filter(Boolean);
      let handle = '';
      const handleSpan = spans.find(t => t.charAt(0) === '@');
      if (handleSpan) {
        handle = handleSpan.slice(1);
      }
      if (!handle) {
        const links = Array.from(box.querySelectorAll('a[role="link"]'))
          .map(a => a.getAttribute('href') || '');
        const hit = links.find(href => /^\/[A-Za-z0-9_]{1,20}$/.test(href));
        if (hit) {
          handle = hit.slice(1);
        }
      }
      let name = '';
      for (let i = 0; i < spans.length; i++) {
        const t = spans[i];
        if (t.charAt(0) === '@' || t === '·') {
          continue;
        }
        if (/^\d{1,2}月\d{1,2}日$/.test(t) || /^[A-Z][a-z]{2} \d{1,2}$/.test(t)) {
          continue;
        }
        name = t.replace(/^·\s*/, '').trim();
        break;
      }
      const avatarEl = scope.querySelector(CONFIG.SEL.avatar);
      const verified = !!scope.querySelector('[data-testid="icon-verified"], svg[data-testid="icon-verified"]');
      return {
        name: name,
        handle: handle,
        avatar: avatarEl ? (avatarEl.getAttribute('src') || '') : '',
        verified: verified
      };
    },

    /** 文本节点转纯文本，保留换行 */
    textOf(el) {
      if (!el) {
        return '';
      }
      let clone;
      try {
        clone = el.cloneNode(true);
      } catch (error) {
        return (el.textContent || '').trim();
      }
      const doc = clone.ownerDocument || document;
      Array.from(clone.querySelectorAll('br')).forEach(br => {
        br.replaceWith(doc.createTextNode('\n'));
      });
      Array.from(clone.querySelectorAll('div,p,li')).forEach(node => {
        node.appendChild(doc.createTextNode('\n'));
      });
      return (clone.textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s*(显示更多|Show more)\s*$/i, '')
        .trim();
    },

    /** 文本 + 语言标记（X 翻译后 lang 会变成译文语言） */
    textInfo(scope, excludeRoot) {
      const nodes = Array.from(scope.querySelectorAll(CONFIG.SEL.text));
      const target = nodes.find(n => !excludeRoot || !excludeRoot.contains(n));
      if (!target) {
        return { text: '', lang: '' };
      }
      return {
        text: this.textOf(target),
        lang: target.getAttribute('lang') || ''
      };
    },

    parseText(scope, excludeRoot) {
      return this.textInfo(scope, excludeRoot).text;
    },

    /** DOM 文本是否是截断版（X 长帖会带"显示更多"） */
    looksTruncated(text) {
      const t = String(text || '');
      return /(…|\.\.\.)$/.test(t) || /(显示更多|Show more)$/i.test(t);
    },

    /** 页面是否开着"翻译"（会显示「显示原文」入口） */
    isTranslated(scope) {
      try {
        const nodes = scope.querySelectorAll('span, div, button');
        const limit = Math.min(nodes.length, 400);
        for (let i = 0; i < limit; i++) {
          const t = (nodes[i].textContent || '').trim();
          if (t === '显示原文' || t === 'Show original') {
            return true;
          }
        }
      } catch (error) {
        /* 忽略 */
      }
      return false;
    },

    origUrl(url) {
      return TweetAPI.origUrl(url);
    },

    /** 长文章卡片：标题 + 正文/预览（时间线卡片只有预览，详情页有全文） */
    parseArticleBlock(scope) {
      const view = scope.querySelector(CONFIG.SEL.articleView);
      const cover = scope.querySelector(CONFIG.SEL.articleCover);
      if (!view && !cover) {
        return null;
      }
      const titleEl = scope.querySelector(CONFIG.SEL.articleTitle);
      let title = titleEl ? String(titleEl.textContent || '').trim() : '';
      let body = '';
      const rich = scope.querySelector(CONFIG.SEL.articleRich);
      if (rich) {
        body = this.textOf(rich);
      }
      if (!title || !body) {
        // 时间线卡片结构是「文章」标签 + 标题 + 预览，按卡片文字兜底
        const card = (cover && cover.parentElement) || (view && view.parentElement);
        if (card) {
          const raw = String(card.innerText || '').replace(/^\s*文章\s*/i, '').trim();
          const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
          if (!title && lines.length) {
            title = lines[0];
            body = body || lines.slice(1).join('\n');
          } else if (!body && lines.length) {
            body = lines.filter(line => line !== title).join('\n');
          }
        }
      }
      if (!title && !body) {
        return null;
      }
      return { title: title, body: body };
    },

    parseMedia(scope, excludeRoot) {
      const out = [];
      const seen = new Set();
      const inExcluded = el => !!(excludeRoot && excludeRoot.contains(el));

      Array.from(scope.querySelectorAll(CONFIG.SEL.photo)).forEach(img => {
        if (inExcluded(img)) {
          return;
        }
        const src = img.getAttribute('src') || '';
        if (!src || seen.has(src)) {
          return;
        }
        seen.add(src);
        out.push({
          type: 'photo',
          url: this.origUrl(src),
          thumb: src,
          poster: src,
          alt: img.getAttribute('alt') || ''
        });
      });

      // 文章卡片的封面是 CSS 背景图，不是 <img>
      Array.from(scope.querySelectorAll(CONFIG.SEL.articleCover)).forEach(el => {
        if (inExcluded(el)) {
          return;
        }
        let src = '';
        try {
          const bg = window.getComputedStyle(el).backgroundImage || '';
          const m = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          if (m) {
            src = m[1];
          }
        } catch (error) {
          src = '';
        }
        if (!src) {
          const img = el.querySelector('img');
          src = img ? (img.getAttribute('src') || '') : '';
        }
        if (!src || seen.has(src)) {
          return;
        }
        seen.add(src);
        out.push({
          type: 'photo',
          url: this.origUrl(src),
          thumb: src,
          poster: src,
          alt: ''
        });
      });

      Array.from(scope.querySelectorAll(CONFIG.SEL.video)).forEach(vp => {
        if (inExcluded(vp)) {
          return;
        }
        const video = vp.querySelector('video');
        const poster = video ? (video.getAttribute('poster') || '') : '';
        const key = poster || 'video:' + out.length;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        out.push({ type: 'video', url: '', thumb: poster, poster: poster, alt: '' });
      });

      return out;
    },

    parseStats(scope) {
      const group = scope.querySelector(CONFIG.SEL.group);
      const label = group ? (group.getAttribute('aria-label') || '') : '';
      // 中文 aria-label 形如「6 条回复、32 次转帖、641 喜欢、28万 次观看」
      const toNum = raw => {
        const s = String(raw || '').replace(/[,，\s]/g, '');
        const m = s.match(/^([\d.]+)(万|千|[kKmM])?$/);
        if (!m) {
          return null;
        }
        let n = parseFloat(m[1]);
        const unit = (m[2] || '').toLowerCase();
        if (unit === '万') {
          n *= 10000;
        } else if (unit === '千' || unit === 'k') {
          n *= 1000;
        } else if (unit === 'm') {
          n *= 1000000;
        }
        return isNaN(n) ? null : Math.round(n);
      };
      const pick = re => {
        const m = label.match(re);
        return m ? toNum(m[1]) : null;
      };
      return {
        replies: pick(/([\d.,]+\s*[万kKmM千]?)\s*(?:条|次|个)?\s*(?:repl(?:y|ies)|回复)/),
        reposts: pick(/([\d.,]+\s*[万kKmM千]?)\s*(?:条|次|个)?\s*(?:repost|retweet|转发|转帖)/),
        likes: pick(/([\d.,]+\s*[万kKmM千]?)\s*(?:条|次|个)?\s*(?:like|喜欢|赞)/),
        views: pick(/([\d.,]+\s*[万kKmM千]?)\s*(?:条|次|个)?\s*(?:view|查看|观看)/),
        bookmarks: pick(/([\d.,]+\s*[万kKmM千]?)\s*(?:条|次|个)?\s*(?:bookmark|书签)/)
      };
    },

    parseArticle(article, fallbackId) {
      if (!article || !article.querySelector) {
        return null;
      }
      const permalink = this.findPermalink(article);
      const id = this.idFromUrl(permalink) || String(fallbackId || '');
      if (!id) {
        return null;
      }
      const quoteRoot = this.findQuoteRoot(article);
      const timeEl = article.querySelector(CONFIG.SEL.time);
      let quote = null;
      if (quoteRoot) {
        const quoteLink = this.findPermalink(quoteRoot) || this.findAnyStatusLink(quoteRoot);
        const quoteTime = quoteRoot.querySelector(CONFIG.SEL.time);
        quote = {
          id: this.idFromUrl(quoteLink),
          url: quoteLink,
          author: this.parseAuthor(quoteRoot),
          text: this.parseText(quoteRoot, null),
          createdAt: quoteTime ? (quoteTime.getAttribute('datetime') || '') : '',
          media: this.parseMedia(quoteRoot, null)
        };
      }
      const mainText = this.textInfo(article, quoteRoot);
      // 文章帖没有 tweetText：用「文章」卡片的标题 + 正文兜底；
      // 正文里若内嵌了普通帖子，textInfo 会先抓到内嵌帖文本，这里用更长的文章正文覆盖
      const articleBlock = this.parseArticleBlock(article);
      let text = mainText.text;
      if (articleBlock) {
        const articleText = [articleBlock.title, articleBlock.body].filter(Boolean).join('\n\n');
        if (!text || articleText.length > text.length) {
          text = articleText;
        }
      }
      return {
        id: id,
        url: permalink || ('https://x.com/i/status/' + id),
        author: this.parseAuthor(article),
        text: text,
        textLang: mainText.lang,
        translated: this.isTranslated(article),
        createdAt: timeEl ? (timeEl.getAttribute('datetime') || '') : '',
        stats: this.parseStats(article),
        media: this.parseMedia(article, quoteRoot),
        quote: quote,
        replies: [],
        source: 'dom'
      };
    },

    /** 原帖页：主帖 + 已加载出来的评论 */
    parseConversation(limit) {
      const articles = this.visibleArticles();
      const parsed = [];
      articles.forEach(a => {
        const p = this.parseArticle(a);
        if (p && !parsed.some(x => x.id === p.id)) {
          parsed.push(p);
        }
      });
      const focalId = PageKind.detailId();
      const focal = parsed.find(p => p.id === focalId) || parsed[0] || null;
      const replies = parsed
        .filter(p => !focal || p.id !== focal.id)
        .slice(0, limit || CONFIG.MAX_REPLIES)
        .map(p => ({
          id: p.id,
          url: p.url,
          author: p.author,
          text: p.text,
          createdAt: p.createdAt,
          media: p.media
        }));
      return { focal: focal, replies: replies };
    },

    /** 当前页可见的帖子元素（文章正文里内嵌的帖子不算，避免给它单独加星标） */
    visibleArticles() {
      return Array.from(document.querySelectorAll(CONFIG.SEL.article))
        .filter(article => !article.closest(CONFIG.SEL.articleView));
    }
  };

  // ==================================================================
  // 5.1 长文章页兜底抓取
  // ------------------------------------------------------------------
  // X 的「文章」（长文）不是 status 结构，DOM 里没有 tweetText。
  // 这里做尽力而为的抓取：标题 + 正文 + 图片；抓不到有效正文就不给按钮，
  // 避免存进一堆导航栏文字。
  // ==================================================================
  const ArticleCapture = {
    textOf(root) {
      let clone;
      try {
        clone = root.cloneNode(true);
      } catch (error) {
        return (root.textContent || '').trim();
      }
      Array.from(clone.querySelectorAll('script,style,nav,button,svg,aside')).forEach(n => n.remove());
      return (clone.textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    capture() {
      const id = PageKind.detailId();
      if (!id || !PageKind.isArticle()) {
        return null;
      }
      const view = document.querySelector(CONFIG.SEL.articleView);
      const root = (view && view.closest('article')) || document.querySelector('article') || document.querySelector('main');
      if (!root) {
        return null;
      }
      const titleEl = document.querySelector(CONFIG.SEL.articleTitle);
      const richEl = document.querySelector(CONFIG.SEL.articleRich);
      const title = titleEl ? String(titleEl.textContent || '').trim() : '';
      let body = richEl ? TweetParser.textOf(richEl) : '';
      if (!body) {
        body = this.textOf(root);
        if (title && body.indexOf(title) === 0) {
          body = body.slice(title.length).trim();
        }
      }
      if ((title + body).length < 120) {
        return null; // 还没渲染出来或不是正文
      }
      // 作者：文章页 URL 是 /<handle>/article/<id>，handle 从路径取最稳；
      // 正文里可能内嵌别人的帖子，DOM 里的第一个 User-Name 未必是作者
      const pathParts = String(location.pathname || '').split('/').filter(Boolean);
      let handle = '';
      if (pathParts.length > 1 && /^[A-Za-z0-9_]{1,20}$/.test(pathParts[0])) {
        handle = pathParts[0];
      }
      let name = '';
      let avatar = '';
      if (handle) {
        const needle = '@' + handle.toLowerCase();
        const leaf = Array.from(document.querySelectorAll('span, div')).find(el =>
          el.children.length === 0 && String(el.textContent || '').trim().toLowerCase() === needle);
        if (leaf) {
          let node = leaf.parentElement;
          for (let i = 0; i < 6 && node; i++) {
            const text = String(node.innerText || '');
            if (text.length < 200 && text.toLowerCase().indexOf(needle) !== -1) {
              const before = text.split(new RegExp('@' + handle, 'i'))[0].replace(/[\n·]/g, ' ').replace(/\s+/g, ' ').trim();
              const img = node.querySelector('img[src*="profile_images"]');
              if (img && !avatar) {
                avatar = img.getAttribute('src') || '';
              }
              if (before) {
                name = before;
                break;
              }
            }
            node = node.parentElement;
          }
        }
      }
      if (!name) {
        name = title;
      }
      if (!avatar && handle) {
        const avatarImg = document.querySelector('[data-testid="UserAvatar-Container-' + handle + '"] img');
        if (avatarImg) {
          avatar = avatarImg.getAttribute('src') || '';
        }
      }
      const timeEl = document.querySelector(CONFIG.SEL.time);
      const media = [];
      const seen = new Set();
      Array.from(root.querySelectorAll('img[src*="pbs.twimg.com"]')).slice(0, 20).forEach(img => {
        const src = img.getAttribute('src') || '';
        if (!src || seen.has(src)) {
          return;
        }
        // 头像不算正文配图
        if (img.closest('[data-testid^="UserAvatar-Container"], [data-testid="User-Name"]')) {
          return;
        }
        seen.add(src);
        media.push({
          type: 'photo',
          url: TweetAPI.origUrl(src),
          thumb: src,
          poster: src,
          alt: img.getAttribute('alt') || ''
        });
      });
      const url = String(location.origin || 'https://x.com') + String(location.pathname || '');
      return {
        id: id,
        url: url,
        author: {
          name: name,
          handle: handle,
          avatar: avatar,
          verified: !!document.querySelector('[data-testid="icon-verified"]')
        },
        text: [title, body].filter(Boolean).join('\n\n').slice(0, 40000),
        createdAt: timeEl ? (timeEl.getAttribute('datetime') || '') : '',
        stats: TweetParser.parseStats(document.querySelector('main') || root),
        media: media,
        article: { id: '', title: title, url: url },
        quote: null,
        replies: [],
        source: 'article'
      };
    }
  };

  // ==================================================================
  // 7. 收藏业务（增删改查 + 导出导入）
  // ==================================================================
  const Bookmark = {
    /** 引用帖的打开链接：没有就直接用 id + 作者拼出来 */
    quoteUrl(quote) {
      if (!quote) {
        return '';
      }
      if (quote.url) {
        return quote.url;
      }
      if (quote.id && quote.author && quote.author.handle) {
        return 'https://x.com/' + quote.author.handle + '/status/' + quote.id;
      }
      if (quote.id) {
        return 'https://x.com/i/status/' + quote.id;
      }
      return '';
    },

    /** 老收藏里引用块可能没存链接：打开详情时补一次（每个帖子每次会话只试一次） */
    async backfillQuote(post) {
      if (!post || !post.quote || this.quoteUrl(post.quote)) {
        return false;
      }
      if (this._backfilled.has(post.id)) {
        return false;
      }
      this._backfilled.add(post.id);
      try {
        const raw = await TweetAPI.fetch(post.id);
        if (!raw) {
          return false;
        }
        const api = TweetAPI.toPost(raw, 0);
        if (!api || !api.quote) {
          return false;
        }
        post.quote.id = post.quote.id || api.quote.id;
        post.quote.url = post.quote.url || api.quote.url;
        if (!post.quote.author || !post.quote.author.handle) {
          post.quote.author = api.quote.author;
        }
        if (!post.quote.text && api.quote.text) {
          post.quote.text = api.quote.text;
        }
        await Posts.put(post);
        return true;
      } catch (error) {
        Logger.warn('补全引用链接失败:', error);
        return false;
      }
    },

    _backfilled: new Set(),

    /**
     * 健壮性辅助：每次收藏，额外把帖子链接备份进 localStorage。
     * 用途：万一将来 IndexedDB 收藏库再次整库丢失可从 localStorage 读出这份纯链接 list（key: xbook_links_backup），
     * 该逻辑完全独立于主收藏流程：localStorage 不可用或写入失败时静默忽略，绝不抛错影响主流程。
     */
    _backupLink(post) {
      if (!post) return;
      let url = post.url;
      if (!url && post.id) {
        const handle = post.author && post.author.handle;
        url = 'https://x.com/' + (handle ? handle + '/status/' : 'i/status/') + post.id;
      }
      if (!url) return;
      try {
        const KEY = 'xbook_links_backup';
        let list = [];
        try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { list = []; }
        if (!Array.isArray(list)) list = [];
        if (list.indexOf(url) === -1) {
          list.push(url);
          localStorage.setItem(KEY, JSON.stringify(list));
        }
      } catch (e) {
        /* localStorage 不可用时静默忽略，不影响主收藏 */
      }
    },

    isStatusPageOf(id) {
      return !!id && PageKind.detailId() === String(id);
    },

    /** DOM 结果 + GraphQL 补全 */
    async enrich(domPost) {
      const post = JSON.parse(JSON.stringify(domPost));
      try {
        const raw = await TweetAPI.fetch(post.id);
        if (!raw) {
          return post;
        }
        const api = TweetAPI.toPost(raw, 0);
        if (!api) {
          return post;
        }
        // 关键：DOM 里可能是"译文"，接口返回的是原文。原文往往更长，
        // 不能简单用长度覆盖，否则译文会被英文原文冲掉。
        const domText = post.text || '';
        const apiText = api.text || '';
        if (api.article && apiText) {
          // 文章帖：DOM 只有预览（还带省略号），接口给的是全文，正文以接口为准
          post.text = apiText;
          post.article = api.article;
          if (domText && domText !== apiText && !TweetParser.looksTruncated(domText)) {
            post.textOriginal = domText;
          }
        } else if (!domText) {
          post.text = apiText;
        } else if (apiText && apiText !== domText && apiText.length > domText.length && TweetParser.looksTruncated(domText)) {
          post.text = apiText; // DOM 只是被截断，用接口全文
        } else if (apiText && apiText !== domText) {
          post.textOriginal = apiText; // 两份都留：显示译文，保留原文
        }
        if (!post.author.name && api.author.name) {
          post.author.name = api.author.name;
        }
        if (!post.author.handle && api.author.handle) {
          post.author.handle = api.author.handle;
        }
        if (!post.author.avatar && api.author.avatar) {
          post.author.avatar = api.author.avatar;
        }
        if (api.media && api.media.length && api.media.length >= (post.media || []).length) {
          post.media = api.media;
        }
        if (!post.quote && api.quote) {
          post.quote = api.quote;
        } else if (post.quote && api.quote) {
          // DOM 里引用块常常没有链接，用接口给的 id / 作者把链接补全
          if (!post.quote.id && api.quote.id) {
            post.quote.id = api.quote.id;
          }
          if (!post.quote.url && api.quote.url) {
            post.quote.url = api.quote.url;
          }
          if (!post.quote.author || !post.quote.author.handle) {
            post.quote.author = api.quote.author;
          }
          if (!post.quote.text && api.quote.text) {
            post.quote.text = api.quote.text;
          } else if (post.quote.text && api.quote.text && post.quote.text !== api.quote.text) {
            post.quote.textOriginal = api.quote.text;
          }
          if ((!post.quote.media || !post.quote.media.length) && api.quote.media) {
            post.quote.media = api.quote.media;
          }
        }
        if (api.stats) {
          // 接口偶尔把某些计数给 0（文章帖的回复数就是），DOM 有值时以 DOM 为准
          const merged = post.stats || {};
          Object.keys(api.stats).forEach(key => {
            const value = api.stats[key];
            if (value == null) {
              return;
            }
            if (value !== 0 || !merged[key]) {
              merged[key] = value;
            }
          });
          post.stats = merged;
        }
        if (!post.createdAt && api.createdAt) {
          post.createdAt = api.createdAt;
        }
        post.source = 'merged';
      } catch (error) {
        Logger.warn('补全失败:', error);
      }
      return post;
    },

    /** 增：收藏一条帖子 */
    async save(domPost, options) {
      const opts = options || {};
      const post = await this.enrich(domPost);
      const cfg = Settings.load();
      if ((opts.withReplies !== false) && cfg.captureReplies && this.isStatusPageOf(post.id)) {
        const conv = TweetParser.parseConversation(cfg.maxReplies);
        post.replies = conv.replies || [];
      }
      const now = Date.now();
      post.savedAt = now;
      post.updatedAt = now;
      await Posts.put(post);
      // 健壮性辅助：把链接额外备份到 localStorage，便于将来整库丢失后批量还原
      this._backupLink(post);
      // 同步内存状态，按钮立即变成 ✓
      SavedState.mark(post.id, true);
      return post;
    },

    /** 删 */
    async remove(id) {
      await Posts.remove(id);
      SavedState.mark(id, false);
      Library.refreshIfOpen();
    },

    /** 改（分组） */
    async update(id, patch) {
      const post = await Posts.update(id, patch);
      Library.refreshIfOpen();
      return post;
    },

    /** 查 */
    async list() {
      return Posts.all();
    },

    async get(id) {
      return Posts.get(id);
    },

    /** 分组名列表（不含未分组） */
    async groups() {
      const all = await Posts.all();
      const set = new Set();
      all.forEach(post => {
        if (post.group) {
          set.add(post.group);
        }
      });
      return Array.from(set).sort();
    },

    /** 查：一个输入框做全字段模糊匹配 + 分组过滤 */
    async search(query, group) {
      const all = await Posts.all();
      const q = String(query || '').trim().toLowerCase();
      const g = group || '__all__';
      return all.filter(post => {
        if (g === '__none__') {
          if (post.group) {
            return false;
          }
        } else if (g !== '__all__' && (post.group || '') !== g) {
          return false;
        }
        if (!q) {
          return true;
        }
        const hay = [
          post.text,
          post.group,
          post.author && post.author.name,
          post.author && post.author.handle,
          post.quote && post.quote.text,
          (post.replies || []).map(r => r.text).join(' ')
        ].join(' ').toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    },

    /** 单条收藏（用于帖子按钮 / 悬浮按钮） */
    /** 是否详情页的第一条帖子（X 的详情页主帖永远是第一条） */
    isFocalArticle(article) {
      try {
        const first = document.querySelector(CONFIG.SEL.article);
        return !!first && first === article;
      } catch (error) {
        return false;
      }
    },

    /** 直接按解析结果收藏（文章页等没有 article 元素的场景用） */
    async togglePost(domPost) {
      if (!domPost || !domPost.id) {
        return;
      }
      const existing = await Posts.get(domPost.id);
      if (existing) {
        await this.remove(domPost.id);
        Toast.show('已取消收藏');
        return;
      }
      const post = await this.save(domPost);
      Toast.show('已收藏' + (post.replies && post.replies.length ? '（含 ' + post.replies.length + ' 条评论）' : ''));
    },

    async toggle(article) {
      let domPost = TweetParser.parseArticle(article);
      if (!domPost && PageKind.isDetail() && this.isFocalArticle(article)) {
        // 详情页主帖偶尔没有时间链接，用 URL 里的帖子 ID 兜底
        domPost = TweetParser.parseArticle(article, PageKind.detailId());
      }
      if (!domPost) {
        Toast.show('没能识别这条帖子（可能还在加载）');
        return;
      }
      await this.togglePost(domPost);
      FloatButton.refreshState();
      StarButton.refreshAllStates();
    },

    /** 当前页焦点帖（键盘快捷方式用） */
    activeArticle() {
      try {
        const active = document.activeElement;
        if (active) {
          const a = active.closest ? active.closest(CONFIG.SEL.article) : null;
          if (a) {
            return a;
          }
        }
      } catch (error) {
        /* 忽略 */
      }
      return FloatButton.currentArticle();
    }
  };

  const Exporter = {
    toJSON(posts) {
      return JSON.stringify({
        format: 'x-bookmark',
        version: 2,
        exportedAt: new Date().toISOString(),
        count: posts.length,
        posts: posts
      }, null, 2);
    },

    toMarkdown(posts) {
      const lines = ['# X 帖子收藏', '', '导出时间：' + DateUtil.fmt(Date.now()) + '　共 ' + posts.length + ' 条', ''];
      posts.forEach((post, idx) => {
        lines.push('---', '');
        lines.push('## ' + (idx + 1) + '. ' + (post.author && post.author.name ? post.author.name : '') +
          ' (@' + (post.author && post.author.handle ? post.author.handle : '') + ')');
        lines.push('');
        lines.push('原帖：' + (post.url || ''));
        lines.push('发布时间：' + (post.createdAt || '') + '　收藏时间：' + DateUtil.fmt(post.savedAt));
        lines.push('');
        String(post.text || '').split('\n').forEach(line => lines.push('> ' + line));
        if (post.textOriginal) {
          lines.push('', '原文：', '');
          String(post.textOriginal).split('\n').forEach(line => lines.push('> ' + line));
        }
        if (post.media && post.media.length) {
          lines.push('');
          post.media.forEach(m => {
            lines.push('![' + (m.alt || m.type || 'media') + '](' + (m.url || m.thumb || '') + ')');
          });
        }
        if (post.quote) {
          lines.push('', '**引用 @' + (post.quote.author && post.quote.author.handle ? post.quote.author.handle : '') + '：**', '');
          String(post.quote.text || '').split('\n').forEach(line => lines.push('>> ' + line));
        }
        if (post.replies && post.replies.length) {
          lines.push('', '**评论（' + post.replies.length + ' 条）：**', '');
          post.replies.forEach(r => {
            lines.push('- @' + (r.author && r.author.handle ? r.author.handle : '') + '：' + String(r.text || '').replace(/\n/g, ' '));
          });
        }
        lines.push('');
      });
      return lines.join('\n');
    },

    toHTML(posts) {
      const cards = [];
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        const imgs = [];
        for (let j = 0; j < (post.media || []).length; j++) {
          const m = post.media[j];
          const src = m.thumb || m.url || '';
          if (src) {
            imgs.push('<img loading="lazy" src="' + Text.escape(src) + '" alt="' + Text.escape(m.alt || '') + '">');
          }
        }
        let quoteHtml = '';
        if (post.quote) {
          const q = post.quote;
          const qImgs = [];
          for (let j = 0; j < (q.media || []).length; j++) {
            const m = q.media[j];
            const src = m.thumb || m.url || '';
            if (src) {
              qImgs.push('<img loading="lazy" src="' + Text.escape(src) + '">');
            }
          }
          const qLink = Bookmark.quoteUrl(q);
          quoteHtml = '<div class="quote"><div class="qa">@' + Text.escape(q.author && q.author.handle ? q.author.handle : '') +
            '</div><div class="qt">' + Text.nl2br(q.text || '') + '</div>' + (qImgs.length ? '<div class="media">' + qImgs.join('') + '</div>' : '') +
            (qLink ? '<div class="qa"><a href="' + Text.escape(qLink) + '" target="_blank" rel="noreferrer">打开引用帖 ↗</a></div>' : '') + '</div>';
        }
        let replyHtml = '';
        if (post.replies && post.replies.length) {
          replyHtml = '<details class="replies"><summary>评论 ' + post.replies.length + ' 条</summary>' +
            post.replies.map(r => '<div class="reply"><b>@' + Text.escape(r.author && r.author.handle ? r.author.handle : '') +
              '</b> ' + Text.nl2br(r.text || '') + '</div>').join('') + '</details>';
        }
        cards.push('<article class="card" data-search="' +
          Text.escape((post.text + ' ' + (post.author && post.author.handle) + ' ' + (post.group || '')).toLowerCase()) + '">' +
          '<header><img class="av" src="' + Text.escape(post.author && post.author.avatar ? post.author.avatar : '') + '" alt="">' +
          '<div><div class="nm">' + Text.escape(post.author && post.author.name ? post.author.name : '') + '</div>' +
          '<div class="hd">@' + Text.escape(post.author && post.author.handle ? post.author.handle : '') +
          '　' + Text.escape(post.createdAt || '') + '</div></div>' +
          '<a class="src" href="' + Text.escape(post.url || '') + '" target="_blank" rel="noreferrer">原帖 ↗</a></header>' +
          '<div class="tx">' + Text.nl2br(post.text || '') + '</div>' +
          (post.textOriginal ? '<details class="orig"><summary>原文</summary><div class="qt">' + Text.nl2br(post.textOriginal) + '</div></details>' : '') +
          (imgs.length ? '<div class="media">' + imgs.join('') + '</div>' : '') +
          quoteHtml + replyHtml +
          '</article>');
      }
      const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>X 帖子收藏（' + posts.length + ' 条）</title><style>' +
        'body{margin:0;background:#0f1419;color:#e7e9ea;font:15px/1.6 -apple-system,"PingFang SC",sans-serif}' +
        '.wrap{max-width:760px;margin:0 auto;padding:24px 16px 80px}' +
        'h1{font-size:20px;margin:0 0 4px}.meta{color:#71767b;font-size:13px;margin-bottom:16px}' +
        '#q{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2f3336;background:#16181c;color:#e7e9ea;margin-bottom:18px;font-size:15px}' +
        '.card{border:1px solid #2f3336;border-radius:14px;padding:14px;margin-bottom:16px;background:#16181c}' +
        '.card header{display:flex;align-items:center;gap:10px}.av{width:38px;height:38px;border-radius:50%;object-fit:cover;background:#333}' +
        '.nm{font-weight:600}.hd{color:#71767b;font-size:13px}.src{margin-left:auto;color:#1d9bf0;text-decoration:none;font-size:13px}' +
        '.tx{margin:10px 0;white-space:pre-wrap;word-break:break-word}' +
        '.media{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin:10px 0}' +
        '.media img{width:100%;border-radius:10px;display:block}' +
        '.quote{border:1px solid #2f3336;border-radius:12px;padding:10px;margin:10px 0;background:#0f1419}' +
        '.qa{color:#71767b;font-size:13px;margin-bottom:4px}.qt{white-space:pre-wrap}' +
        '.replies{margin-top:10px;border-top:1px solid #2f3336;padding-top:8px}' +
        '.replies summary{cursor:pointer;color:#1d9bf0;font-size:13px}' +
        '.reply{padding:6px 0;border-bottom:1px dashed #2f3336;font-size:14px;white-space:pre-wrap}' +
        '.orig{margin:8px 0}.orig summary{cursor:pointer;color:#71767b;font-size:13px}.orig .qt{color:#9aa0a6;font-size:14px}' +
        '.note{margin-top:10px;padding:8px 10px;border-left:3px solid #f5c518;background:#1c1f23;font-size:14px}' +
        '.tags{margin-top:8px}.tags span{display:inline-block;background:#1d9bf0;color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;margin-right:6px}' +
        '.empty{color:#71767b;text-align:center;padding:40px 0}' +
        '</style></head><body><div class="wrap"><h1>X 帖子收藏</h1>' +
        '<div class="meta">导出时间 ' + Text.escape(DateUtil.fmt(Date.now())) + '　共 ' + posts.length + ' 条　图片已内嵌，可离线查看</div>' +
        '<input id="q" placeholder="搜索正文 / 作者 / 标签 / 备注…">' +
        cards.join('') +
        '<div class="empty" id="empty" style="display:none">没有匹配的收藏</div>' +
        '</div><script>(function(){var q=document.getElementById("q");var cards=[].slice.call(document.querySelectorAll(".card"));' +
        'var empty=document.getElementById("empty");q.addEventListener("input",function(){var v=q.value.trim().toLowerCase();var n=0;' +
        'cards.forEach(function(c){var hit=!v||(c.getAttribute("data-search")||"").indexOf(v)!==-1;c.style.display=hit?"":"none";if(hit)n++;});' +
        'empty.style.display=n?"none":"block";});})();<\/script></body></html>';
      return html;
    },

    /** 导入：按 id 合并，updatedAt 更新的覆盖旧的 */
    async importJSON(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error('不是合法的 JSON 文件');
      }
      const list = Array.isArray(data) ? data : (data && data.posts);
      if (!Array.isArray(list)) {
        throw new Error('文件里没有 posts 数组');
      }
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (let i = 0; i < list.length; i++) {
        const incoming = list[i];
        if (!incoming || !incoming.id) {
          skipped++;
          continue;
        }
        const existing = await Posts.get(incoming.id);
        if (!existing) {
          await Posts.put(incoming);
          added++;
          continue;
        }
        if ((incoming.updatedAt || 0) > (existing.updatedAt || 0)) {
          await Posts.put(incoming);
          updated++;
        } else {
          skipped++;
        }
      }
      return { added: added, updated: updated, skipped: skipped };
    }
  };

  // ==================================================================
  // 8. UI 基础：样式 / 轻提示 / 容器守护
  // ==================================================================
  const UI_CSS = `
    #${HOST_ID}{position:static}
    .xb-ad{display:none!important}
    #${FLOAT_ID}{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:8px;
      user-select:none;-webkit-user-select:none;touch-action:none}
    .xb-float-btn{width:44px;height:44px;border-radius:50%;background:rgba(15,20,25,.92);
      color:#e7e9ea;border:1px solid #2f3336;display:flex;align-items:center;justify-content:center;
      font-size:22px;line-height:1;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45);
      transition:transform .15s ease,box-shadow .15s ease,background .15s ease,color .15s ease}
    .xb-float-btn:hover{transform:scale(1.08)}
    .xb-float-btn.xb-lib{color:#f5c518;border-color:rgba(245,197,24,.55)}
    .xb-float-btn.xb-lib:hover{box-shadow:0 8px 26px rgba(245,197,24,.35)}
    .xb-float-btn.xb-mark{font-size:24px}
    .xb-float-btn.xb-mark:hover{border-color:#536471;background:#1c1f23}
    .xb-float-btn.xb-mark.on{background:#f5c518;color:#0f1419;border-color:#f5c518;
      box-shadow:0 8px 26px rgba(245,197,24,.45)}
    .xb-star{position:absolute;top:6px;right:86px;z-index:6;width:26px;height:26px;border-radius:50%;
      border:1px solid rgba(245,197,24,.5);background:rgba(15,20,25,.8);color:#f5c518;font-size:16px;
      line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:.5;
      padding:0;transition:opacity .15s ease,transform .12s ease,background .15s ease}
    .xb-star:hover{opacity:1;background:rgba(245,197,24,.22);transform:scale(1.1)}
    .xb-star.on{opacity:1;background:#f5c518;color:#0f1419;border-color:#f5c518}
    .xb-toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483600;
      background:rgba(15,20,25,.95);color:#e7e9ea;border:1px solid rgba(245,197,24,.45);
      padding:10px 18px;border-radius:999px;font-size:14px;opacity:0;transition:opacity .2s ease;
      box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:80vw;text-align:center}
    #${PANEL_ID}{position:fixed;inset:0;z-index:2147483400;display:none;align-items:center;justify-content:center;
      font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#e7e9ea}
    #${PANEL_ID} .xb-mask{position:absolute;inset:0;background:rgba(0,0,0,.62)}
    #${PANEL_ID} .xb-panel{position:relative;width:min(94vw,${CONFIG.PANEL_MAX_WIDTH}px);height:min(88vh,900px);
      background:#16181c;border:1px solid #2f3336;border-radius:16px;display:flex;flex-direction:column;overflow:hidden;
      box-shadow:0 24px 60px rgba(0,0,0,.6)}
    #${PANEL_ID} .xb-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #2f3336}
    #${PANEL_ID} .xb-title{font-size:16px;font-weight:600;color:#f5c518}
    #${PANEL_ID} .xb-count{color:#71767b;font-weight:400;font-size:13px}
    #${PANEL_ID} .xb-head-actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
    #${PANEL_ID} button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid #2f3336;background:#1c1f23;
      color:#e7e9ea;padding:6px 10px;line-height:1;display:inline-flex;align-items:center;justify-content:center;
      transition:background .15s ease,border-color .15s ease}
    #${PANEL_ID} button:hover{background:#22262b;border-color:#3d4145}
    #${PANEL_ID} button.on{background:#f5c518;color:#0f1419;border-color:#f5c518;font-weight:600}
    #${PANEL_ID} button.danger{color:#f4212e;border-color:rgba(244,33,46,.4)}
    #${PANEL_ID} button.primary{background:#1d9bf0;border-color:#1d9bf0;color:#fff}
    #${PANEL_ID} .xb-body{flex:1;display:flex;min-height:0}
    #${PANEL_ID} .xb-groups{width:172px;flex:none;border-right:1px solid #2f3336;overflow-y:auto;padding:8px 0}
    #${PANEL_ID} .xb-groups-head{display:flex;align-items:center;justify-content:space-between;padding:2px 12px 8px;
      color:#71767b;font-size:12px;letter-spacing:.5px}
    #${PANEL_ID} .xb-groups-add{width:22px;height:22px;padding:0;font-size:14px;line-height:1;border-radius:6px;
      display:inline-flex;align-items:center;justify-content:center}
    #${PANEL_ID} .xb-group-item{display:flex;align-items:center;gap:6px;padding:9px 12px;cursor:pointer;font-size:13px;line-height:1;
      border-left:3px solid transparent;transition:background .12s ease,border-color .12s ease}
    #${PANEL_ID} .xb-group-item:hover{background:#1c1f23}
    #${PANEL_ID} .xb-group-item.active{background:#1f2429;border-left-color:#f5c518;color:#f5c518}
    #${PANEL_ID} .xb-group-item.drop{background:rgba(245,197,24,.18);border-left-color:#f5c518}
    #${PANEL_ID} .xb-g-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${PANEL_ID} .xb-g-count{color:#71767b;font-size:12px}
    #${PANEL_ID} .xb-g-del{opacity:0;width:18px;height:18px;padding:0;font-size:11px;border-radius:4px;line-height:1;
      display:inline-flex;align-items:center;justify-content:center}
    #${PANEL_ID} .xb-group-item:hover .xb-g-del{opacity:1}
    #${PANEL_ID} .xb-mid{width:38%;min-width:300px;display:flex;flex-direction:column;min-height:0;border-right:1px solid #2f3336}
    #${PANEL_ID} .xb-toolbar{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid #2f3336}
    #${PANEL_ID} .xb-search{flex:1;min-width:0;padding:8px 12px;border-radius:999px;border:1px solid #2f3336;
      background:#0f1419;color:#e7e9ea;font:inherit;outline:none}
    #${PANEL_ID} .xb-search:focus{border-color:#1d9bf0}
    #${PANEL_ID} .xb-selbar{display:flex;gap:8px;align-items:center;padding:7px 12px;border-bottom:1px solid #22262b;
      font-size:12px;color:#71767b;flex-wrap:wrap;min-height:38px;box-sizing:border-box}
    #${PANEL_ID} .xb-selbar .xb-selall{display:inline-flex;align-items:center;gap:5px;height:24px;cursor:pointer;color:#e7e9ea}
    #${PANEL_ID} .xb-selbar input[type="checkbox"]{width:14px;height:14px;margin:0;accent-color:#f5c518;cursor:pointer}
    #${PANEL_ID} .xb-selbar button{height:24px;padding:0 9px;font-size:12px;border-radius:6px;
      display:inline-flex;align-items:center;justify-content:center;line-height:1}
    #${PANEL_ID} .xb-selbar .xb-selcount{min-width:46px;text-align:center;color:#e7e9ea;line-height:1}
    #${PANEL_ID} .xb-selbar .xb-move-target{height:24px;padding:0 6px;font-size:12px;border-radius:6px;border:1px solid #2f3336;
      background:#0f1419;color:#e7e9ea;max-width:110px;line-height:1}
    #${PANEL_ID} .xb-selbar:not(.has-selection) .xb-move-target,
    #${PANEL_ID} .xb-selbar:not(.has-selection) [data-act="move-selected"],
    #${PANEL_ID} .xb-selbar:not(.has-selection) [data-act="delete-selected"]{opacity:.4;pointer-events:none}
    #${PANEL_ID} .xb-list{flex:1;overflow-y:auto;scrollbar-width:thin}
    #${PANEL_ID} .xb-detail{flex:1;overflow-y:auto;padding:16px 18px;scrollbar-width:thin}
    #${PANEL_ID} .xb-detail > .xb-empty,#${PANEL_ID} .xb-list > .xb-empty{display:flex;align-items:center;justify-content:center;
      min-height:60%;padding:24px}
    #${PANEL_ID} .xb-scroll{overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#4a5158 transparent}
    #${PANEL_ID} .xb-scroll::-webkit-scrollbar{width:10px;height:10px}
    #${PANEL_ID} .xb-scroll::-webkit-scrollbar-track{background:rgba(255,255,255,.03);border-radius:999px}
    #${PANEL_ID} .xb-scroll::-webkit-scrollbar-button{display:none;width:0;height:0}
    #${PANEL_ID} .xb-scroll::-webkit-scrollbar-thumb{background:#464d54;border-radius:999px;
      border:3px solid transparent;background-clip:content-box;min-height:40px}
    #${PANEL_ID} .xb-scroll::-webkit-scrollbar-thumb:hover{background:#5c646c;background-clip:content-box}
    #${PANEL_ID} .xb-item{display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid #22262b;cursor:pointer;align-items:flex-start}
    #${PANEL_ID} .xb-item:hover{background:#1c1f23}
    #${PANEL_ID} .xb-item.checked{background:#1a1d21}
    #${PANEL_ID} .xb-item.dragging{opacity:.45}
    #${PANEL_ID} .xb-check{width:14px;height:14px;margin:10px 0 0;flex:none;accent-color:#f5c518;cursor:pointer}
    #${PANEL_ID} .xb-item.active{background:#1f2429;box-shadow:inset 3px 0 0 #f5c518}
    #${PANEL_ID} .xb-av{width:34px;height:34px;border-radius:50%;object-fit:cover;background:#333;flex:none}
    #${PANEL_ID} .xb-it-body{min-width:0;flex:1}
    #${PANEL_ID} .xb-it-head{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
    #${PANEL_ID} .xb-it-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
    #${PANEL_ID} .xb-it-handle{color:#71767b;font-size:12px}
    #${PANEL_ID} .xb-it-time{margin-left:auto;color:#71767b;font-size:12px;white-space:nowrap}
    #${PANEL_ID} .xb-it-text{color:#c9cdd1;font-size:13px;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    #${PANEL_ID} .xb-it-badges{margin-top:4px;display:flex;gap:8px;color:#71767b;font-size:12px}
    #${PANEL_ID} .xb-empty{color:#71767b;text-align:center;padding:48px 16px;font-size:14px}
    #${PANEL_ID} .xb-d-author{display:flex;gap:10px;align-items:center}
    #${PANEL_ID} .xb-d-name{font-weight:600}
    #${PANEL_ID} .xb-d-sub{color:#71767b;font-size:13px}
    #${PANEL_ID} .xb-open{margin-left:auto;color:#1d9bf0;text-decoration:none;font-size:13px}
    #${PANEL_ID} .xb-d-text{margin:14px 0;white-space:pre-wrap;word-break:break-word;font-size:15px}
    #${PANEL_ID} .xb-d-media{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:12px 0}
    #${PANEL_ID} .xb-d-media img{width:100%;border-radius:10px;display:block;cursor:zoom-in;background:#22262b;min-height:60px}
    #${PANEL_ID} .xb-d-quote{border:1px solid #2f3336;border-radius:12px;padding:10px;margin:12px 0;background:#0f1419}
    #${PANEL_ID} .xb-d-orig{margin:6px 0 12px;border-left:3px solid #2f3336;padding-left:10px}
    #${PANEL_ID} .xb-d-orig summary{cursor:pointer;color:#71767b;font-size:13px;margin-bottom:4px}
    #${PANEL_ID} .xb-d-stats{display:flex;gap:16px;color:#71767b;font-size:13px;margin:10px 0;flex-wrap:wrap}
    #${PANEL_ID} .xb-d-sub-title{margin:16px 0 8px;font-weight:600;color:#f5c518;font-size:14px}
    #${PANEL_ID} .xb-reply{padding:8px 0;border-bottom:1px dashed #2f3336;font-size:14px;white-space:pre-wrap}
    #${PANEL_ID} .xb-reply b{color:#1d9bf0;font-weight:600;margin-right:4px}
    #${PANEL_ID} .xb-edit{margin-top:20px;border-top:1px solid #2f3336;padding-top:14px}
    #${PANEL_ID} .xb-field{margin-bottom:10px}
    #${PANEL_ID} .xb-field label{display:block;color:#71767b;font-size:12px;margin-bottom:4px}
    #${PANEL_ID} .xb-field input,#${PANEL_ID} .xb-field textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;
      border:1px solid #2f3336;background:#0f1419;color:#e7e9ea;font:inherit;outline:none;resize:vertical}
    #${PANEL_ID} .xb-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    #${PANEL_ID} .xb-settings{padding:16px 18px;overflow-y:auto;border-top:1px solid #2f3336;background:#121417}
    #${PANEL_ID} .xb-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #22262b}
    #${PANEL_ID} .xb-row span{flex:1}
    #${PANEL_ID} .xb-hint{color:#71767b;font-size:12px;line-height:1.7;margin-top:10px}
    @media (max-width:900px){
      #${PANEL_ID} .xb-groups{width:120px}
      #${PANEL_ID} .xb-mid{width:45%;min-width:220px}
    }
    @media (max-width:760px){
      #${PANEL_ID} .xb-body{flex-direction:column}
      #${PANEL_ID} .xb-groups{width:100%;max-height:120px;border-right:0;border-bottom:1px solid #2f3336}
      #${PANEL_ID} .xb-mid{width:100%;min-width:0;max-height:42%;border-right:0;border-bottom:1px solid #2f3336}
      #${PANEL_ID} .xb-panel{width:100vw;height:100vh;border-radius:0}
    }
  `;

  const StyleSheet = {
    ensure(id, css) {
      let el = document.getElementById(id);
      if (el) {
        return el;
      }
      el = document.createElement('style');
      el.id = id;
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
      return el;
    }
  };

  const Toast = {
    show(text, duration) {
      try {
        const el = DOM.create('div', { className: 'xb-toast', text: text });
        UIHost.mount(el, { persistent: false });
        requestAnimationFrame(() => {
          el.style.opacity = '1';
        });
        setTimeout(() => {
          el.style.opacity = '0';
          setTimeout(() => el.remove(), 220);
        }, duration || 2200);
      } catch (error) {
        Logger.warn('提示显示失败:', error);
      }
    }
  };

  /** 容器与守护：X 是重渲染型 SPA，注入的节点随时可能被整块替换 */
  const UIHost = {
    _keep: [],
    _started: false,

    container() {
      let c = document.getElementById(HOST_ID);
      if (!c) {
        c = DOM.create('div', { id: HOST_ID });
        (document.body || document.documentElement).appendChild(c);
      }
      return c;
    },

    mount(node, options) {
      const opts = options || {};
      try {
        this.container().appendChild(node);
      } catch (error) {
        Logger.warn('挂载失败:', error);
      }
      if (opts.persistent) {
        this._keep.push(node);
      }
      return node;
    },

    /** 守护：被页面移除的常驻节点重新挂回 */
    reensure() {
      const c = this.container();
      this._keep = this._keep.filter(node => !!node);
      this._keep.forEach(node => {
        if (!node.isConnected) {
          try {
            c.appendChild(node);
          } catch (error) {
            /* 忽略 */
          }
        }
      });
    },

    start() {
      if (this._started) {
        return;
      }
      this._started = true;
      let timer = null;
      const schedule = () => {
        if (timer) {
          return;
        }
        timer = setTimeout(() => {
          timer = null;
          this.reensure();
          SavedState.ensureFresh();
          StarButton.sweep();
          StarButton.refreshAllStates();
          FloatButton.refreshState();
          AdFilter.apply();
        }, CONFIG.SWEEP_DEBOUNCE);
      };
      try {
        const observer = new MutationObserver(schedule);
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      } catch (error) {
        Logger.warn('观察器启动失败:', error);
      }
      setInterval(() => {
        this.reensure();
        SavedState.ensureFresh();
        StarButton.sweep();
        StarButton.refreshAllStates();
        FloatButton.refreshState();
        AdFilter.apply();
      }, CONFIG.SWEEP_INTERVAL);
    }
  };

  // ==================================================================
  // 9. 每帖收藏按钮
  // ==================================================================
  /** 已收藏状态的缓存：悬浮按钮、列表都读它 */
  const SavedState = {
    _saved: new Set(),
    _idsAt: 0,
    _refreshing: null,

    async refresh() {
      try {
        const all = await Posts.all();
        this._saved = new Set(all.map(p => p.id));
      } catch (error) {
        Logger.warn('读取收藏状态失败:', error);
      }
      FloatButton.refreshState();
      StarButton.refreshAllStates();
    },

    /** 节流刷新：10 秒一次，收藏/删除后立即刷新 */
    ensureFresh(force) {
      if (!force && Date.now() - this._idsAt < 10000) {
        return Promise.resolve();
      }
      this._idsAt = Date.now();
      if (this._refreshing) {
        return this._refreshing;
      }
      this._refreshing = this.refresh().then(() => {
        this._refreshing = null;
      }).catch(() => {
        this._refreshing = null;
      });
      return this._refreshing;
    },

    has(id) {
      return !!id && this._saved.has(id);
    },

    mark(id, saved) {
      if (saved) {
        this._saved.add(id);
      } else {
        this._saved.delete(id);
      }
      FloatButton.refreshState();
      StarButton.refreshAllStates();
    }
  };

  // ==================================================================
  // 9.1 每条帖子右上角的星标
  // ------------------------------------------------------------------
  // 绝对定位在帖子右上角、避开 X 自己的「⋯」按钮，不参与操作栏的
  // 弹性布局，因此不会被其它脚本动态插入的按钮（如下载图标）挤动。
  // 首页时间线、详情页、文章页都能用。
  // ==================================================================
  const StarButton = {
    STAR: '✓',
    HOLLOW: '＋',

    create(article) {
      if (!article || !article.querySelector) {
        return;
      }
      if (article.querySelector('.xb-star')) {
        return;
      }
      try {
        const pos = window.getComputedStyle ? window.getComputedStyle(article).position : '';
        if (!pos || pos === 'static') {
          article.style.position = 'relative';
        }
      } catch (error) {
        article.style.position = 'relative';
      }
      const btn = DOM.create('button', {
        className: 'xb-star',
        attrs: { type: 'button', title: '添加为书签' }
      });
      btn.textContent = this.HOLLOW;
      const stop = e => {
        e.preventDefault();
        e.stopPropagation();
      };
      DOM.on(btn, 'mousedown', stop);
      DOM.on(btn, 'mouseup', stop);
      DOM.on(btn, 'click', e => {
        stop(e);
        Bookmark.toggle(article).catch(error => {
          Logger.error('收藏失败:', error);
          Toast.show('收藏失败，请查看控制台');
        });
      });
      article.appendChild(btn);
      const id = TweetParser.idFromUrl(TweetParser.findPermalink(article));
      if (id) {
        this.setState(article, SavedState.has(id));
      }
    },

    setState(article, saved) {
      const btn = article ? article.querySelector('.xb-star') : null;
      if (!btn) {
        return;
      }
      btn.textContent = saved ? this.STAR : this.HOLLOW;
      btn.classList.toggle('on', !!saved);
      btn.title = saved ? '已加入书签（点击取消）' : '添加为书签';
    },

    sweep() {
      const articles = TweetParser.visibleArticles();
      for (let i = 0; i < articles.length; i++) {
        this.create(articles[i]);
      }
    },

    refreshAllStates() {
      TweetParser.visibleArticles().forEach(article => {
        const id = TweetParser.idFromUrl(TweetParser.findPermalink(article));
        if (id) {
          this.setState(article, SavedState.has(id));
        }
      });
    }
  };

  // ==================================================================
  // 9.2 首页广告过滤
  // ------------------------------------------------------------------
  // X 的推广内容没有稳定的 class，但有两类可靠特征：
  //   1) 时间线推广帖：卡片头部有一个独立的「Promoted / 推广」标签；
  //   2) 右栏「有什么新鲜事」的推广趋势：trend 条目里带「Promoted by …」。
  // 只认"正文以外"的标签文字，避免把正文里提到"广告"的正常帖子误杀。
  // ==================================================================
  const AdFilter = {
    CLASS: 'xb-ad',
    // 推广标签的精确文字（多语言）
    LABELS: /^(Promoted|Promoted by .+|推广|赞助|广告|Ad|Publicité|Gesponsert|Anzeige|プロモーション|프로モーション)$/i,
    _lastAt: 0,

    enabled() {
      return Settings.load().hideAds !== false;
    },

    /** 正文以外的标签文字才算广告标记 */
    hasAdLabel(scope, excludeSelector) {
      const excluded = excludeSelector ? Array.from(scope.querySelectorAll(excludeSelector)) : [];
      const isExcluded = el => excluded.some(root => root.contains(el));
      const nodes = scope.querySelectorAll('span, div[dir="ltr"]');
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.children.length) {
          continue; // 只看叶子节点，避免父容器整段文字误匹配
        }
        if (isExcluded(node)) {
          continue;
        }
        const text = String(node.textContent || '').trim();
        if (text && this.LABELS.test(text)) {
          return true;
        }
      }
      return false;
    },

    isPromotedTweet(article) {
      return this.hasAdLabel(article, CONFIG.SEL.text);
    },

    isPromotedTrend(trend) {
      return this.hasAdLabel(trend, null);
    },

    /** 推广帖连外层 cell 一起收掉，避免时间线里留一条空白 */
    hide(el) {
      if (!el || el.classList.contains(this.CLASS)) {
        return;
      }
      const target = el.matches && el.matches(CONFIG.SEL.article)
        ? (el.closest(CONFIG.SEL.cell) || el)
        : el;
      target.classList.add(this.CLASS);
    },

    showAll() {
      Array.from(document.querySelectorAll('.' + this.CLASS)).forEach(el => el.classList.remove(this.CLASS));
    },

    apply(force) {
      if (!force && Date.now() - this._lastAt < 700) {
        return;
      }
      this._lastAt = Date.now();
      if (!this.enabled()) {
        this.showAll();
        return;
      }
      TweetParser.visibleArticles().forEach(article => {
        if (article.closest('.' + this.CLASS)) {
          return;
        }
        if (this.isPromotedTweet(article)) {
          this.hide(article);
        }
      });
      Array.from(document.querySelectorAll(CONFIG.SEL.trend)).forEach(trend => {
        if (trend.classList.contains(this.CLASS)) {
          return;
        }
        if (this.isPromotedTrend(trend)) {
          this.hide(trend);
        }
      });
    }
  };

  // ==================================================================
  // 10. 浮动主按钮
  // ==================================================================
  const FloatButton = {
    wrap: null,
    libBtn: null,
    markBtn: null,

    create() {
      if (this.wrap && this.wrap.isConnected) {
        return this.wrap;
      }
      const wrap = DOM.create('div', { id: FLOAT_ID });
      const lib = DOM.create('div', { className: 'xb-float-btn xb-lib', text: '★' });
      lib.title = '帖子收藏库';
      const mark = DOM.create('div', { className: 'xb-float-btn xb-mark', text: '＋' });
      mark.title = '收藏当前帖';
      wrap.appendChild(lib);
      wrap.appendChild(mark);

      const pos = GM.get('xbook_float_pos', null);
      wrap.style.top = (pos && pos.top != null ? pos.top : 96) + 'px';
      wrap.style.left = (pos && pos.left != null ? pos.left : 18) + 'px';

      this.bindDrag(wrap);
      DOM.on(lib, 'click', () => {
        if (!wrap.dataset.dragged) {
          Library.toggle();
        }
        wrap.dataset.dragged = '';
      });
      DOM.on(mark, 'click', () => {
        if (!wrap.dataset.dragged) {
          this.onMark();
        }
        wrap.dataset.dragged = '';
      });

      UIHost.mount(wrap, { persistent: true });
      this.wrap = wrap;
      this.libBtn = lib;
      this.markBtn = mark;
      this.refreshState();
      return wrap;
    },

    /** 当前帖：只在详情页有值；按 URL 里的帖子 ID 找对应的那条帖子 */
    currentArticle() {
      const id = PageKind.detailId();
      if (!id) {
        return null; // 首页 / 探索 / 个人主页等：没有"当前帖"
      }
      const articles = TweetParser.visibleArticles();
      const hit = articles.find(a => {
        const link = TweetParser.findPermalink(a);
        return link && link.indexOf('/status/' + id) !== -1;
      });
      if (hit) {
        return hit;
      }
      // 详情页主帖有时没有时间链接，按"第一条帖子就是主帖"兜底
      const first = articles[0];
      if (first && first.querySelector(CONFIG.SEL.text)) {
        return first;
      }
      return null;
    },

    /** 详情页才显示 ＋/✓；首页一律隐藏，只留收藏库 ★ */
    refreshState() {
      if (!this.markBtn) {
        return;
      }
      const detail = PageKind.isDetail();
      this.markBtn.style.display = detail ? '' : 'none';
      if (!detail) {
        this.markBtn.textContent = '＋';
        this.markBtn.classList.remove('on');
        return;
      }
      const article = this.currentArticle();
      const id = article
        ? TweetParser.idFromUrl(TweetParser.findPermalink(article))
        : PageKind.detailId();
      const saved = SavedState.has(id);
      this.markBtn.textContent = saved ? '✓' : '＋';
      this.markBtn.classList.toggle('on', saved);
      this.markBtn.title = saved ? '已收藏（点击取消）' : '收藏这条帖子';
    },

    async onMark() {
      if (!PageKind.isDetail()) {
        Toast.show('请先点开一条帖子（详情页）再收藏');
        return;
      }
      const article = this.currentArticle();
      try {
        if (article) {
          await Bookmark.toggle(article);
        } else {
          // 长文章页：没有 article[data-testid="tweet"]，走兜底抓取
          const post = ArticleCapture.capture();
          if (!post) {
            Toast.show('帖子还没加载出来，稍等一下再点');
            return;
          }
          await Bookmark.togglePost(post);
        }
      } catch (error) {
        Logger.error('收藏失败:', error);
        Toast.show('收藏失败，请查看控制台');
      }
      this.refreshState();
    },

    bindDrag(wrap) {
      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let startTop = 0;
      let startLeft = 0;

      DOM.on(wrap, 'mousedown', e => {
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        startTop = parseInt(wrap.style.top, 10) || 0;
        startLeft = parseInt(wrap.style.left, 10) || 0;
        e.preventDefault();
      });

      DOM.on(document, 'mousemove', e => {
        if (!dragging) {
          return;
        }
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          moved = true;
        }
        const maxLeft = Math.max(0, window.innerWidth - 56);
        const maxTop = Math.max(0, window.innerHeight - 104);
        wrap.style.left = Math.min(maxLeft, Math.max(0, startLeft + dx)) + 'px';
        wrap.style.top = Math.min(maxTop, Math.max(0, startTop + dy)) + 'px';
      });

      DOM.on(document, 'mouseup', () => {
        if (!dragging) {
          return;
        }
        dragging = false;
        if (moved) {
          wrap.dataset.dragged = '1';
          GM.set('xbook_float_pos', {
            top: parseInt(wrap.style.top, 10) || 0,
            left: parseInt(wrap.style.left, 10) || 0
          });
          setTimeout(() => {
            wrap.dataset.dragged = '';
          }, 120);
        }
      });
    }
  };

  /** 分组名持久化（允许空分组存在；帖子上的 group 字段才是归属） */
  const Groups = {
    KEY: 'xbook_groups',

    load() {
      const v = GM.get(this.KEY, []);
      return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
    },

    save(list) {
      GM.set(this.KEY, list);
    },

    async names() {
      const set = new Set(this.load());
      const all = await Posts.all();
      all.forEach(p => {
        if (p.group) {
          set.add(p.group);
        }
      });
      return Array.from(set).sort();
    },

    add(name) {
      const n = String(name || '').trim();
      if (!n) {
        return;
      }
      const list = this.load();
      if (list.indexOf(n) === -1) {
        list.push(n);
        this.save(list);
      }
    },

    remove(name) {
      this.save(this.load().filter(g => g !== name));
    }
  };

  // ==================================================================
  // 11. 收藏库面板
  // ==================================================================
  const Library = {
    root: null,
    posts: [],
    currentId: '',
    query: '',
    groupView: '__none__',
    selected: new Set(),
    settingsOpen: false,

    async toggle() {
      if (this.root && this.root.style.display !== 'none') {
        this.hide();
      } else {
        await this.show();
      }
    },

    async show() {
      this.build();
      this.root.style.display = 'flex';
      await SavedState.refresh();
      await this.reload();
    },

    hide() {
      if (this.root) {
        this.root.style.display = 'none';
      }
    },

    refreshIfOpen() {
      if (this.root && this.root.style.display !== 'none') {
        this.reload().catch(error => Logger.warn('刷新失败:', error));
      }
    },

    build() {
      if (this.root) {
        return this.root;
      }
      StyleSheet.ensure(UI_STYLE_ID, UI_CSS);
      const root = DOM.create('div', { id: PANEL_ID });
      root.innerHTML = [
        '<div class="xb-mask"></div>',
        '<div class="xb-panel">',
        '  <div class="xb-head">',
        '    <div class="xb-title">★ 帖子收藏库 <span class="xb-count">0</span></div>',
        '    <div class="xb-head-actions">',
        '      <button type="button" data-act="settings">设置</button>',
        '      <button type="button" data-act="export">导出</button>',
        '      <button type="button" data-act="import">导入</button>',
        '      <button type="button" data-act="close">✕</button>',
        '    </div>',
        '  </div>',
        '  <div class="xb-body">',
        '    <div class="xb-groups xb-scroll">',
        '      <div class="xb-groups-head"><span>分组</span><button type="button" class="xb-groups-add" data-act="new-group" title="新建分组">＋</button></div>',
        '      <div class="xb-groups-list"></div>',
        '    </div>',
        '    <div class="xb-mid">',
        '      <div class="xb-toolbar">',
        '        <input class="xb-search" type="search" placeholder="搜索正文 / 作者…">',
        '      </div>',
        '      <div class="xb-selbar">',
        '        <label class="xb-selall"><input type="checkbox" class="xb-check-all">全选</label>',
        '        <button type="button" data-act="invert">反选</button>',
        '        <span class="xb-selcount">已选 0</span>',
        '        <select class="xb-move-target" title="移动到分组"></select>',
        '        <button type="button" data-act="move-selected">移动</button>',
        '        <button type="button" class="danger" data-act="delete-selected">删除</button>',
        '      </div>',
        '      <div class="xb-list xb-scroll"></div>',
        '    </div>',
        '    <div class="xb-detail xb-scroll"><div class="xb-empty">从左侧选择一条收藏</div></div>',
        '  </div>',
        '  <div class="xb-settings" hidden></div>',
        '  <input type="file" accept=".json,application/json" hidden>',
        '</div>'
      ].join('');
      UIHost.mount(root, { persistent: true });
      this.root = root;
      this.bind();
      return root;
    },

    bind() {
      const root = this.root;

      DOM.on(root.querySelector('.xb-mask'), 'click', () => this.hide());
      DOM.on(root.querySelector('[data-act="close"]'), 'click', () => this.hide());

      DOM.on(document, 'keydown', e => {
        if (e.key === 'Escape' && this.root && this.root.style.display !== 'none') {
          e.stopPropagation();
          this.hide();
        }
      }, true);

      const search = root.querySelector('.xb-search');
      let timer = null;
      DOM.on(search, 'input', () => {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          this.query = search.value;
          this.reload().catch(error => Logger.warn(error));
        }, 160);
      });

      // 面板内滚动不穿透到下层时间线
      DOM.on(root, 'wheel', e => e.stopPropagation(), { passive: true });
      DOM.on(root.querySelector('.xb-mask'), 'wheel', e => e.stopPropagation(), { passive: true });

      // 左栏：切换分组 / 删除分组
      DOM.on(root.querySelector('.xb-groups'), 'click', async e => {
        const del = e.target.closest ? e.target.closest('[data-del-group]') : null;
        if (del) {
          e.stopPropagation();
          const name = del.getAttribute('data-del-group');
          if (del.dataset.confirm !== '1') {
            del.dataset.confirm = '1';
            del.textContent = '?';
            del.title = '再点一次删除分组（帖子会移到未分组）';
            setTimeout(() => {
              if (del.isConnected) {
                del.dataset.confirm = '';
                del.textContent = '✕';
              }
            }, 3000);
            return;
          }
          await this.deleteGroup(name);
          return;
        }
        const item = e.target.closest ? e.target.closest('.xb-group-item') : null;
        if (item) {
          this.groupView = item.getAttribute('data-group') || '__none__';
          await this.reload();
        }
      });

      DOM.on(root.querySelector('[data-act="new-group"]'), 'click', async () => {
        const name = window.prompt('新建分组名称');
        if (name && String(name).trim()) {
          Groups.add(String(name).trim());
          Toast.show('已新建分组：' + String(name).trim());
          await this.reload();
        }
      });

      // 选择：全选 / 反选 / 批量移动 / 批量删除
      DOM.on(root.querySelector('.xb-check-all'), 'change', e => {
        if (e.target.checked) {
          this.selectAll();
        } else {
          this.selected.clear();
          this.renderList();
          this.renderSelectionBar();
        }
      });
      DOM.on(root.querySelector('[data-act="invert"]'), 'click', () => this.invertSelection());
      DOM.on(root.querySelector('[data-act="move-selected"]'), 'click', () => {
        const sel = root.querySelector('.xb-move-target');
        this.moveSelected(sel ? sel.value : '');
      });
      DOM.on(root.querySelector('[data-act="delete-selected"]'), 'click', e => this.deleteSelected(e.currentTarget));

      // 拖拽：把帖子（或已选中的一批）拖到左侧分组
      const listEl = root.querySelector('.xb-list');
      DOM.on(listEl, 'dragstart', e => {
        const item = e.target.closest ? e.target.closest('.xb-item') : null;
        if (!item) {
          return;
        }
        const id = item.getAttribute('data-id');
        const ids = this.selected.has(id) ? Array.from(this.selected) : [id];
        try {
          e.dataTransfer.setData('text/plain', JSON.stringify(ids));
          e.dataTransfer.effectAllowed = 'move';
        } catch (error) {
          /* 忽略 */
        }
        item.classList.add('dragging');
      });
      DOM.on(listEl, 'dragend', e => {
        const item = e.target.closest ? e.target.closest('.xb-item') : null;
        if (item) {
          item.classList.remove('dragging');
        }
        Array.from(root.querySelectorAll('.xb-group-item.drop')).forEach(el => el.classList.remove('drop'));
      });
      const groupsEl = root.querySelector('.xb-groups');
      DOM.on(groupsEl, 'dragover', e => {
        const g = e.target.closest ? e.target.closest('.xb-group-item') : null;
        if (!g) {
          return;
        }
        e.preventDefault();
        try {
          e.dataTransfer.dropEffect = 'move';
        } catch (error) {
          /* 忽略 */
        }
        Array.from(root.querySelectorAll('.xb-group-item.drop')).forEach(el => {
          if (el !== g) {
            el.classList.remove('drop');
          }
        });
        g.classList.add('drop');
      });
      DOM.on(groupsEl, 'dragleave', e => {
        const g = e.target.closest ? e.target.closest('.xb-group-item') : null;
        if (g) {
          g.classList.remove('drop');
        }
      });
      DOM.on(groupsEl, 'drop', e => {
        const g = e.target.closest ? e.target.closest('.xb-group-item') : null;
        if (!g) {
          return;
        }
        e.preventDefault();
        g.classList.remove('drop');
        let ids = [];
        try {
          ids = JSON.parse(e.dataTransfer.getData('text/plain') || '[]');
        } catch (error) {
          ids = [];
        }
        this.moveTo(ids, g.getAttribute('data-group'));
      });

      DOM.on(root.querySelector('[data-act="settings"]'), 'click', () => {
        this.settingsOpen = !this.settingsOpen;
        this.renderSettings();
      });

      // 唯一的导出格式：JSON
      DOM.on(root.querySelector('[data-act="export"]'), 'click', () => this.exportJSON());
      DOM.on(root.querySelector('[data-act="import"]'), 'click', () => {
        const input = root.querySelector('input[type="file"]');
        if (input) {
          input.value = '';
          input.click();
        }
      });
      DOM.on(root.querySelector('input[type="file"]'), 'change', e => {
        const file = e.target.files && e.target.files[0];
        if (!file) {
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          Exporter.importJSON(String(reader.result || ''))
            .then(res => {
              Toast.show('导入完成：新增 ' + res.added + '，更新 ' + res.updated + '，跳过 ' + res.skipped);
              this.reload();
            })
            .catch(error => {
              Logger.error('导入失败:', error);
              Toast.show('导入失败：' + error.message);
            });
        };
        reader.readAsText(file);
      });

      DOM.on(root.querySelector('.xb-list'), 'click', e => {
        const box = e.target.closest ? e.target.closest('[data-check]') : null;
        if (box) {
          this.toggleSelect(box.getAttribute('data-check'), box.checked);
          return;
        }
        const item = e.target.closest ? e.target.closest('.xb-item') : null;
        if (item) {
          this.select(item.getAttribute('data-id'));
        }
      });

      // 详情里只保留"点图片看大图"（分组靠左栏拖拽，删除靠列表复选框批量删）
      DOM.on(root.querySelector('.xb-detail'), 'click', e => {
        const img = e.target.closest ? e.target.closest('.xb-d-media img') : null;
        if (img && img.getAttribute('data-full')) {
          window.open(img.getAttribute('data-full'), '_blank');
        }
      });
    },

    async reload() {
      await this.renderGroups();
      this.posts = await Bookmark.search(this.query, this.groupView);

      // 选中项只保留当前列表里还存在的
      const alive = new Set(this.posts.map(p => p.id));
      Array.from(this.selected).forEach(id => {
        if (!alive.has(id)) {
          this.selected.delete(id);
        }
      });

      const countEl = this.root.querySelector('.xb-count');
      const total = await Posts.count();
      if (countEl) {
        countEl.textContent = this.query || this.groupView !== '__all__'
          ? this.posts.length + ' / ' + total
          : String(total);
      }
      this.renderList();
      this.renderSelectionBar();
      if (this.currentId) {
        const still = this.posts.some(p => p.id === this.currentId);
        if (still) {
          this.renderDetail(this.currentId);
        } else {
          this.currentId = '';
          this.renderDetail('');
        }
      }
      if (this.settingsOpen) {
        this.renderSettings();
      }
    },

    /** 左栏：全部 / 未分组 / 各分组（带数量，可作拖拽目标） */
    async renderGroups() {
      const box = this.root.querySelector('.xb-groups-list');
      if (!box) {
        return;
      }
      const all = await Posts.all();
      const counts = { total: all.length, none: 0, groups: {} };
      all.forEach(post => {
        const g = post.group || '';
        if (!g) {
          counts.none += 1;
        } else {
          counts.groups[g] = (counts.groups[g] || 0) + 1;
        }
      });
      const names = await Groups.names();
      const view = this.groupView;
      const row = (key, label, count, extra) => '<div class="xb-group-item' + (view === key ? ' active' : '') +
        '" data-group="' + Text.escape(key) + '">' +
        '<span class="xb-g-name">' + Text.escape(label) + '</span>' +
        '<span class="xb-g-count">' + count + '</span>' +
        (extra || '') + '</div>';
      box.innerHTML =
        row('__all__', '全部', counts.total) +
        row('__none__', '未分组', counts.none) +
        names.map(name => row(name, name, counts.groups[name] || 0,
          '<button type="button" class="xb-g-del" data-del-group="' + Text.escape(name) + '" title="删除分组">✕</button>'
        )).join('');
    },

    /** 选择条：全选状态、已选数量、移动目标 */
    renderSelectionBar() {
      const bar = this.root.querySelector('.xb-selbar');
      if (!bar) {
        return;
      }
      const n = this.selected.size;
      const countEl = bar.querySelector('.xb-selcount');
      if (countEl) {
        countEl.textContent = '已选 ' + n;
      }
      bar.classList.toggle('has-selection', n > 0);
      const allBox = bar.querySelector('.xb-check-all');
      if (allBox) {
        allBox.checked = n > 0 && n === this.posts.length;
        allBox.indeterminate = n > 0 && n < this.posts.length;
      }
      const sel = bar.querySelector('.xb-move-target');
      if (sel) {
        const current = sel.value;
        Groups.names().then(names => {
          sel.innerHTML = '<option value="">移动到…</option>' +
            names.map(g => '<option value="' + Text.escape(g) + '">' + Text.escape(g) + '</option>').join('') +
            '<option value="__none__">未分组</option>';
          if (current) {
            sel.value = current;
          }
        }).catch(() => {});
      }
    },

    toggleSelect(id, on) {
      if (!id) {
        return;
      }
      if (on === undefined) {
        on = !this.selected.has(id);
      }
      if (on) {
        this.selected.add(id);
      } else {
        this.selected.delete(id);
      }
      const item = this.root.querySelector('.xb-item[data-id="' + id + '"]');
      if (item) {
        item.classList.toggle('checked', on);
        const box = item.querySelector('.xb-check');
        if (box) {
          box.checked = on;
        }
      }
      this.renderSelectionBar();
    },

    selectAll() {
      this.posts.forEach(p => this.selected.add(p.id));
      this.renderList();
      this.renderSelectionBar();
    },

    invertSelection() {
      const next = new Set();
      this.posts.forEach(p => {
        if (!this.selected.has(p.id)) {
          next.add(p.id);
        }
      });
      this.selected = next;
      this.renderList();
      this.renderSelectionBar();
    },

    /** 批量移动到分组（'' / '__none__' = 未分组） */
    async moveTo(ids, groupKey) {
      const list = (ids || []).filter(Boolean);
      if (!list.length) {
        return;
      }
      if (groupKey === '__all__') {
        Toast.show('请拖到具体分组上');
        return;
      }
      const group = (groupKey === '__none__' || !groupKey) ? '' : String(groupKey);
      for (let i = 0; i < list.length; i++) {
        await Posts.update(list[i], { group: group });
      }
      if (group) {
        Groups.add(group);
      }
      Toast.show('已移动 ' + list.length + ' 条到「' + (group || '未分组') + '」');
      await this.reload();
    },

    moveSelected(groupKey) {
      if (!this.selected.size) {
        Toast.show('还没有选中条目');
        return;
      }
      if (!groupKey) {
        Toast.show('请先选择目标分组');
        return;
      }
      return this.moveTo(Array.from(this.selected), groupKey);
    },

    async deleteSelected(btn) {
      const ids = Array.from(this.selected);
      if (!ids.length) {
        Toast.show('还没有选中条目');
        return;
      }
      if (btn && btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = '确认删除 ' + ids.length + ' 条';
        setTimeout(() => {
          if (btn.isConnected) {
            btn.dataset.confirm = '';
            btn.textContent = '删除';
          }
        }, 4000);
        return;
      }
      for (let i = 0; i < ids.length; i++) {
        await Posts.remove(ids[i]);
      }
      this.selected.clear();
      if (ids.indexOf(this.currentId) !== -1) {
        this.currentId = '';
        this.renderDetail('');
      }
      Toast.show('已删除 ' + ids.length + ' 条');
      await this.reload();
    },

    async deleteGroup(name) {
      const all = await Posts.all();
      const hit = all.filter(p => p.group === name);
      for (let i = 0; i < hit.length; i++) {
        await Posts.update(hit[i].id, { group: '' });
      }
      Groups.remove(name);
      if (this.groupView === name) {
        this.groupView = '__none__';
      }
      Toast.show('已删除分组「' + name + '」，' + hit.length + ' 条移到未分组');
      await this.reload();
    },

    renderList() {
      const box = this.root.querySelector('.xb-list');
      if (!this.posts.length) {
        const emptyText = this.query
          ? '没有匹配的收藏'
          : (this.groupView === '__all__' ? '还没有收藏。在帖子右上角点 ＋ 即可收藏。' : '这个分组里还没有收藏。');
        box.innerHTML = '<div class="xb-empty">' + emptyText + '</div>';
        return;
      }
      box.innerHTML = this.posts.map(post => {
        const badges = [];
        if (post.article) {
          badges.push('📄 文章');
        }
        if (post.media && post.media.length) {
          badges.push('🖼 ' + post.media.length);
        }
        if (post.quote) {
          badges.push('❝ 引用');
        }
        if (post.replies && post.replies.length) {
          badges.push('💬 ' + post.replies.length);
        }
        if (post.group) {
          badges.push('📁 ' + post.group);
        }
        const checked = this.selected.has(post.id);
        return '<div class="xb-item' + (post.id === this.currentId ? ' active' : '') + (checked ? ' checked' : '') +
          '" data-id="' + Text.escape(post.id) + '" draggable="true">' +
          '<input type="checkbox" class="xb-check"' + (checked ? ' checked' : '') + ' data-check="' + Text.escape(post.id) + '">' +
          '<img class="xb-av" src="' + Text.escape(post.author && post.author.avatar ? post.author.avatar : '') + '" alt="">' +
          '<div class="xb-it-body">' +
          '<div class="xb-it-head"><span class="xb-it-name">' + Text.escape(post.author && post.author.name ? post.author.name : '(未知作者)') + '</span>' +
          '<span class="xb-it-handle">@' + Text.escape(post.author && post.author.handle ? post.author.handle : '') + '</span>' +
          '<span class="xb-it-time">' + Text.escape(DateUtil.fmtShort(post.savedAt)) + '</span></div>' +
          '<div class="xb-it-text">' + Text.escape(Text.cut(post.text || '(无正文)', 120)) + '</div>' +
          (badges.length ? '<div class="xb-it-badges">' + badges.map(b => '<span>' + Text.escape(b) + '</span>').join('') + '</div>' : '') +
          '</div></div>';
      }).join('');
    },

    select(id) {
      this.currentId = id;
      Array.from(this.root.querySelectorAll('.xb-item')).forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-id') === id);
      });
      this.renderDetail(id);
    },

    async renderDetail(id) {
      const box = this.root.querySelector('.xb-detail');
      if (!id) {
        box.innerHTML = '<div class="xb-empty">从左侧选择一条收藏</div>';
        return;
      }
      const post = await Posts.get(id);
      if (this.currentId !== id) {
        return; // 期间用户已切换到别的条目，丢弃过期渲染
      }
      if (!post) {
        box.innerHTML = '<div class="xb-empty">这条收藏不存在了</div>';
        return;
      }
      const mediaHtml = [];
      for (let i = 0; i < (post.media || []).length; i++) {
        const m = post.media[i];
        const src = m.thumb || m.url || '';
        if (!src) {
          continue;
        }
        mediaHtml.push('<img src="' + Text.escape(src) + '" data-full="' + Text.escape(m.url || m.thumb || '') +
          '" alt="' + Text.escape(m.alt || '') + '" title="点击查看大图">');
      }

      let quoteHtml = '';
      if (post.quote) {
        const q = post.quote;
        const qMedia = [];
        for (let i = 0; i < (q.media || []).length; i++) {
          const m = q.media[i];
          const src = m.thumb || m.url || '';
          if (src) {
            qMedia.push('<img src="' + Text.escape(src) + '" alt="">');
          }
        }
        quoteHtml = '<div class="xb-d-quote">' +
          '<div class="xb-d-sub">引用 @' + Text.escape(q.author && q.author.handle ? q.author.handle : '') + '</div>' +
          '<div class="xb-d-text" style="margin:8px 0;font-size:14px">' + Text.nl2br(q.text || '(引用内容已不可见)') + '</div>' +
          (q.textOriginal
            ? '<details class="xb-d-orig"><summary>原文</summary><div class="xb-d-text" style="font-size:13px;color:#c9cdd1">' +
              Text.nl2br(q.textOriginal) + '</div></details>'
            : '') +
          (qMedia.length ? '<div class="xb-d-media">' + qMedia.join('') + '</div>' : '') +
          (Bookmark.quoteUrl(q) ? '<a class="xb-open" href="' + Text.escape(Bookmark.quoteUrl(q)) + '" target="_blank" rel="noreferrer">打开引用帖 ↗</a>' : '') +
          '</div>';
      }

      let repliesHtml = '';
      if (post.replies && post.replies.length) {
        repliesHtml = '<div class="xb-d-sub-title">评论（' + post.replies.length + ' 条，收藏时已加载的部分）</div>' +
          post.replies.map(r => '<div class="xb-reply"><b>@' + Text.escape(r.author && r.author.handle ? r.author.handle : '') + '</b>' +
            Text.nl2br(r.text || '') + '</div>').join('');
      }

      const stats = post.stats || {};
      const statBits = [];
      if (stats.replies != null) {
        statBits.push('💬 ' + Text.num(stats.replies));
      }
      if (stats.reposts != null) {
        statBits.push('🔁 ' + Text.num(stats.reposts));
      }
      if (stats.likes != null) {
        statBits.push('❤️ ' + Text.num(stats.likes));
      }
      if (stats.views != null) {
        statBits.push('👁 ' + Text.num(stats.views));
      }
      if (stats.bookmarks != null) {
        statBits.push('🔖 ' + Text.num(stats.bookmarks));
      }

      box.innerHTML = '<div class="xb-d-author">' +
        '<img class="xb-av" style="width:40px;height:40px" src="' + Text.escape(post.author && post.author.avatar ? post.author.avatar : '') + '" alt="">' +
        '<div><div class="xb-d-name">' + Text.escape(post.author && post.author.name ? post.author.name : '(未知作者)') + '</div>' +
        '<div class="xb-d-sub">@' + Text.escape(post.author && post.author.handle ? post.author.handle : '') +
        (post.createdAt ? '　发布于 ' + Text.escape(String(post.createdAt).replace('T', ' ').slice(0, 16)) : '') + '</div></div>' +
        '<a class="xb-open" href="' + Text.escape(post.url || '') + '" target="_blank" rel="noreferrer">打开原帖 ↗</a>' +
        '</div>' +
        '<div class="xb-d-text">' + Text.nl2br(post.text || '(无正文)') + '</div>' +
        (post.textOriginal
          ? '<details class="xb-d-orig"><summary>原文</summary><div class="xb-d-text" style="font-size:14px;color:#c9cdd1">' +
            Text.nl2br(post.textOriginal) + '</div></details>'
          : '') +
        (mediaHtml.length ? '<div class="xb-d-media">' + mediaHtml.join('') + '</div>' : '') +
        quoteHtml +
        (statBits.length ? '<div class="xb-d-stats">' + statBits.map(s => '<span>' + Text.escape(s) + '</span>').join('') + '</div>' : '') +
        '<div class="xb-d-sub">收藏于 ' + Text.escape(DateUtil.fmt(post.savedAt)) +
        (post.updatedAt && post.updatedAt !== post.savedAt ? '　更新于 ' + Text.escape(DateUtil.fmt(post.updatedAt)) : '') +
        '　来源 ' + Text.escape(post.source || 'dom') + '</div>' +
        repliesHtml +
        '';

      // 引用链接缺失（老收藏 / DOM 没渲染链接）：后台补一次再重画
      if (post.quote && !Bookmark.quoteUrl(post.quote)) {
        Bookmark.backfillQuote(post).then(ok => {
          if (ok && this.currentId === id) {
            this.renderDetail(id);
          }
        });
      }
    },

    async renderSettings() {
      const box = this.root.querySelector('.xb-settings');
      if (!this.settingsOpen) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }
      const cfg = Settings.load();
      const postCount = await Posts.count();
      box.hidden = false;
      box.innerHTML = '<div class="xb-d-sub-title" style="margin-top:0">设置</div>' +
        '<div class="xb-row"><span>在原帖页收藏时抓取已加载的评论</span>' +
        '<button type="button" class="' + (cfg.captureReplies ? 'on' : '') + '" data-toggle="captureReplies">' + (cfg.captureReplies ? '开' : '关') + '</button></div>' +
        '<div class="xb-row"><span>过滤首页推广广告（推广帖 / 推广趋势）</span>' +
        '<button type="button" class="' + (cfg.hideAds ? 'on' : '') + '" data-toggle="hideAds">' + (cfg.hideAds ? '开' : '关') + '</button></div>' +
        '<div class="xb-row"><span>单帖最多抓取评论数</span><span style="flex:none;color:#71767b">' + cfg.maxReplies + '</span></div>' +
        '<div class="xb-hint">已收藏 ' + postCount + ' 条。图片只存链接，显示时直接加载推特图床。<br>' +
        '数据存在浏览器本地（IndexedDB）。换设备请用「JSON」导出再导入。<br>' +
        '版本 ' + CONFIG.VERSION + '</div>' +
        '<div class="xb-actions"><button type="button" class="danger" data-act="clear-all">清空全部收藏</button></div>';

      Array.from(box.querySelectorAll('[data-toggle]')).forEach(btn => {
        DOM.on(btn, 'click', () => {
          const key = btn.getAttribute('data-toggle');
          const patch = {};
          patch[key] = !Settings.load()[key];
          Settings.save(patch);
          if (key === 'hideAds') {
            AdFilter.apply(true);
          }
          this.renderSettings();
        });
      });
      DOM.on(box.querySelector('[data-act="clear-all"]'), 'click', async e => {
        const btn = e.currentTarget;
        if (btn.dataset.confirm !== '1') {
          btn.dataset.confirm = '1';
          btn.textContent = '再点一次确认清空全部';
          return;
        }
        await Posts.clearAll();
        await SavedState.refresh();
        Toast.show('全部收藏已清空');
        this.currentId = '';
        this.reload();
        this.renderSettings();
      });
    },

    /** 导出＝备份：永远导出全部收藏（不受搜索/分组筛选影响） */
    async exportJSON() {
      const posts = await Posts.all();
      if (!posts.length) {
        Toast.show('还没有收藏，没有可导出的内容');
        return;
      }
      Toast.show('正在导出 ' + posts.length + ' 条…');
      const json = Exporter.toJSON(posts);
      Download.save('x-bookmarks-' + DateUtil.stamp() + '.json', json, 'application/json;charset=utf-8');
      setTimeout(() => Toast.show('已导出 ' + posts.length + ' 条'), 600);
    },

    async exportHTML() {
      if (!this.posts.length) {
        Toast.show('没有可导出的收藏');
        return;
      }
      Toast.show('正在生成离线 HTML（含图片）…');
      const html = await Exporter.toHTML(this.posts);
      Download.save('x-bookmarks-' + DateUtil.stamp() + '.html', html, 'text/html;charset=utf-8');
    },

    exportMarkdown() {
      if (!this.posts.length) {
        Toast.show('没有可导出的收藏');
        return;
      }
      const md = Exporter.toMarkdown(this.posts);
      Download.save('x-bookmarks-' + DateUtil.stamp() + '.md', md, 'text/markdown;charset=utf-8');
    }
  };

  // ==================================================================
  // 12. 菜单
  // ==================================================================
  function registerMenu() {
    if (window.__xbMenuReady) {
      return;
    }
    window.__xbMenuReady = true;
    try {
      if (typeof GM_registerMenuCommand !== 'function') {
        return;
      }
      GM_registerMenuCommand('打开收藏库', () => {
        Library.toggle();
      });
      GM_registerMenuCommand('收藏当前页这条帖子', () => {
        const article = Bookmark.activeArticle();
        if (!article) {
          Toast.show('当前页没有识别到帖子');
          return;
        }
        Bookmark.toggle(article).catch(error => {
          Logger.error(error);
          Toast.show('收藏失败，请查看控制台');
        });
      });
      GM_registerMenuCommand('导出收藏（JSON）', () => {
        Library.show().then(() => Library.exportJSON());
      });
    } catch (error) {
      Logger.warn('注册菜单失败:', error);
    }
  }

  // ==================================================================
  // 13. 调试入口
  // ==================================================================
  // 油猴沙箱里 window 不是页面的 window，必须挂到 unsafeWindow 才能在控制台用
  const PAGE_GLOBAL = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  PAGE_GLOBAL.xbDebug = {
    enableDebug() {
      CONFIG.DEBUG = true;
      console.log('[X收藏] 调试已开启');
    },
    disableDebug() {
      CONFIG.DEBUG = false;
    },
    version() {
      console.log('[X收藏] 版本', CONFIG.VERSION);
    },
    pageInfo() {
      console.log('=== [X收藏] 页面信息 ===');
      console.log('URL:', location.href);
      console.log('页面类型:', PageKind.isDetail() ? '帖子详情页（ID ' + PageKind.detailId() + '）' : '非详情页（不显示收藏按钮）');
      console.log('帖子数:', document.querySelectorAll(CONFIG.SEL.article).length);
      const markBtn = document.querySelector('.xb-float-btn.xb-mark');
      console.log('收藏按钮状态:', markBtn ? markBtn.textContent + (markBtn.classList.contains('on') ? '（已收藏）' : '（未收藏）') : '未注入');
      const cur = FloatButton.currentArticle();
      const curId = cur ? TweetParser.idFromUrl(TweetParser.findPermalink(cur)) : '';
      console.log('当前帖:', curId || '未识别');
      console.log('浮动按钮存在:', !!document.getElementById(FLOAT_ID));
      console.log('面板存在:', !!document.getElementById(PANEL_ID));
    },
    /** 解析当前页第一条帖子并打印（排查选择器失效用） */
    parseCurrent() {
      const article = Bookmark.activeArticle();
      if (!article) {
        console.log('没有识别到帖子');
        return null;
      }
      const parsed = TweetParser.parseArticle(article);
      console.log('=== [X收藏] 解析结果 ===');
      console.log(parsed);
      return parsed;
    },
    inspect() {
      const article = Bookmark.activeArticle();
      if (!article) {
        console.log('没有识别到帖子');
        return;
      }
      const counts = {
        'article': document.querySelectorAll(CONFIG.SEL.article).length,
        'tweetText': article.querySelectorAll(CONFIG.SEL.text).length,
        'User-Name': article.querySelectorAll(CONFIG.SEL.userName).length,
        'avatar': article.querySelectorAll(CONFIG.SEL.avatar).length,
        'photo': article.querySelectorAll(CONFIG.SEL.photo).length,
        'video': article.querySelectorAll(CONFIG.SEL.video).length,
        'role=group[aria-label]': article.querySelectorAll(CONFIG.SEL.group).length,
        'time[datetime]': article.querySelectorAll(CONFIG.SEL.time).length,
        'quoteRoot': TweetParser.findQuoteRoot(article) ? 1 : 0
      };
      console.table(counts);
      return counts;
    },
    ads() {
      console.log('=== [X收藏] 广告过滤 ===');
      console.log('开关:', Settings.load().hideAds ? '开' : '关');
      console.log('已隐藏元素:', document.querySelectorAll('.xb-ad').length);
      const arts = TweetParser.visibleArticles();
      console.log('疑似推广帖:', arts.filter(a => AdFilter.isPromotedTweet(a)).length);
      const trends = Array.from(document.querySelectorAll(CONFIG.SEL.trend));
      console.log('推广趋势:', trends.filter(t => AdFilter.isPromotedTrend(t)).length);
      return { hidden: document.querySelectorAll('.xb-ad').length, tweets: arts.length, trends: trends.length };
    },
    async dbInfo() {
      const posts = await Posts.all();
      console.log('=== [X收藏] 存储 ===');
      console.log('收藏数:', posts.length);
      console.log('IDB 可用:', DB.hasIDB());
      console.log(posts);
    },
    async exportHTML() {
      const posts = await Posts.all();
      if (!posts.length) {
        console.log('没有可导出的收藏');
        return;
      }
      const html = Exporter.toHTML(posts);
      Download.save('x-bookmarks-' + DateUtil.stamp() + '.html', html, 'text/html;charset=utf-8');
      console.log('已导出离线 HTML（含内嵌图片）');
    },
    async exportMarkdown() {
      const posts = await Posts.all();
      if (!posts.length) {
        console.log('没有可导出的收藏');
        return;
      }
      Download.save('x-bookmarks-' + DateUtil.stamp() + '.md', Exporter.toMarkdown(posts), 'text/markdown;charset=utf-8');
      console.log('已导出 Markdown');
    },
    async clearAll() {
      await Posts.clearAll();
      await SavedState.refresh();
      console.log('已清空');
    },
    internals: {
      DB: DB,
      Posts: Posts,
      Settings: Settings,
      TweetParser: TweetParser,
      TweetAPI: TweetAPI,
      Bookmark: Bookmark,
      Exporter: Exporter,
      Library: Library,
      PageKind: PageKind,
      ArticleCapture: ArticleCapture,
      Groups: Groups,
      StarButton: StarButton,
      SavedState: SavedState,
      FloatButton: FloatButton,
      AdFilter: AdFilter,
      CONFIG: CONFIG
    }
  };

  // ==================================================================
  // 14. 启动
  // ==================================================================
  function initScript() {
    try {
      StyleSheet.ensure(UI_STYLE_ID, UI_CSS);
      FloatButton.create();
      registerMenu();
      UIHost.start();
      SavedState.refresh();
      StarButton.sweep();
      AdFilter.apply(true);
      Logger.log('初始化完成，版本', CONFIG.VERSION);
    } catch (error) {
      Logger.error('初始化失败:', error);
    }
  }

  function boot() {
    if (window.__xbBooted) {
      return;
    }
    window.__xbBooted = true;
    initScript();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // SPA 路由变化：X 切页不刷新，需要重新巡检注入点
  let lastUrl = location.href;

  function handleRouteChange() {
    if (location.href === lastUrl) {
      return;
    }
    lastUrl = location.href;
    Logger.log('路由变化:', lastUrl);
    setTimeout(() => {
      FloatButton.refreshState();
      UIHost.reensure();
      AdFilter.apply(true);
    }, 600);
  }

  window.addEventListener('popstate', handleRouteChange);
  window.addEventListener('hashchange', handleRouteChange);
  setInterval(handleRouteChange, 1000);
})();
