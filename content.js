(function () {
  "use strict";

  const DATA_ATTR = "data-yt-copy-transcript";
  /** Mark Thanks/Download hosts we hide; restored in removeInjected. */
  const SUPPRESS_ATTR = "data-yt-ct-suppress";
  const STORAGE_DEFAULTS = { format: "plain", includeTimestamps: false };

  let liveSettings = {
    format: "plain",
    includeTimestamps: false,
  };

  let transcriptCache = {
    videoId: "",
    settingsSig: "",
    formattedText: null,
    baseUrl: null,
    error: null,
  };

  let prefetchPromise = null;
  let copiedTimer = null;

  chrome.storage.sync.get(STORAGE_DEFAULTS, (items) => {
    if (!chrome.runtime.lastError) {
      liveSettings = {
        format: items.format === "markdown" ? "markdown" : "plain",
        includeTimestamps: Boolean(items.includeTimestamps),
      };
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.format) {
      liveSettings.format = changes.format.newValue === "markdown" ? "markdown" : "plain";
    }
    if (changes.includeTimestamps) {
      liveSettings.includeTimestamps = Boolean(changes.includeTimestamps.newValue);
    }
    transcriptCache = { videoId: "", settingsSig: "", formattedText: null, baseUrl: null, error: null };
    void prefetchTranscript();
  });

  const ICON_DOC = `
    <svg class="yt-ct-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 4h5l5 5v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>
      <path d="M13 4v5h5"/>
      <path d="M8 13h8M8 17h6"/>
    </svg>`;

  const ICON_FORBIDDEN = `
    <svg class="yt-ct-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M8 8l8 8"/>
    </svg>`;

  const ICON_CHECK = `
    <svg class="yt-ct-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 12l4 4 8-8"/>
    </svg>`;

  function debounce(fn, ms) {
    let t;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function settingsSig(s) {
    return `${s.format}|${s.includeTimestamps ? "1" : "0"}`;
  }

  function extractJsonObjectAfterMarker(scriptText, marker) {
    const idx = scriptText.indexOf(marker);
    if (idx === -1) return null;
    const eq = scriptText.indexOf("=", idx);
    if (eq === -1) return null;
    const start = scriptText.indexOf("{", eq);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < scriptText.length; i++) {
      const ch = scriptText[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(scriptText.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  function getYtInitialPlayerResponseFromScripts() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text.includes("ytInitialPlayerResponse")) continue;
      const parsed = extractJsonObjectAfterMarker(text, "ytInitialPlayerResponse");
      if (parsed) return parsed;
    }
    return null;
  }

  function getYtInitialPlayerResponseFromPageWindow() {
    return new Promise((resolve) => {
      const id = "ytct_" + Math.random().toString(36).slice(2);
      function onMessage(ev) {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.type !== "YT_CT_YTINITIAL" || d.id !== id) return;
        window.removeEventListener("message", onMessage);
        resolve(d.pr != null ? d.pr : null);
      }
      window.addEventListener("message", onMessage);
      const s = document.createElement("script");
      s.textContent = `(function(id){try{var pr=window["ytInitialPlayerResponse"]||null;var slim=null;if(pr){slim={captions:pr.captions,videoDetails:pr.videoDetails};}window.postMessage({type:"YT_CT_YTINITIAL",id:id,pr:slim},"*");}catch(e){window.postMessage({type:"YT_CT_YTINITIAL",id:id,pr:null},"*");}})(${JSON.stringify(
        id
      )});`;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 1500);
    });
  }

  const INNERTUBE_PLAYER_BASE = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
  const INNERTUBE_ANDROID_VER = "20.10.38";

  function extractInnertubeApiKey() {
    const scripts = document.querySelectorAll("script");
    for (let i = 0; i < scripts.length; i++) {
      const t = scripts[i].textContent || "";
      if (!t.includes("INNERTUBE_API_KEY")) continue;
      const m = t.match(/["']INNERTUBE_API_KEY["']\s*:\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
    const h = document.documentElement && document.documentElement.innerHTML;
    if (h) {
      const m2 = h.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (m2) return m2[1];
    }
    return null;
  }

  function extractInnertubeClientVersion() {
    const scripts = document.querySelectorAll("script");
    for (let i = 0; i < scripts.length; i++) {
      const t = scripts[i].textContent || "";
      const m = t.match(/INNERTUBE_CLIENT_VERSION["']\s*:\s*["']([\d.]+)/);
      if (m) return m[1];
    }
    return "2.20241201.01.00";
  }

  function innertubePlayerUrl(apiKey) {
    if (!apiKey) return INNERTUBE_PLAYER_BASE;
    return `${INNERTUBE_PLAYER_BASE}&key=${encodeURIComponent(apiKey)}`;
  }

  async function fetchPlayerResponseInnerTubeAndroid(videoId, apiKey) {
    try {
      const res = await fetch(innertubePlayerUrl(apiKey), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `com.google.android.youtube/${INNERTUBE_ANDROID_VER} (Linux; U; Android 14)`,
        },
        credentials: "include",
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: INNERTUBE_ANDROID_VER,
            },
          },
          videoId,
        }),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async function fetchPlayerResponseWeb(videoId, apiKey, clientVersion) {
    try {
      const res = await fetch(innertubePlayerUrl(apiKey), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: clientVersion || extractInnertubeClientVersion(),
              hl: (navigator.language || "en").split("-")[0],
            },
          },
          videoId,
        }),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async function resolveYtInitialPlayerResponse() {
    const fromScripts = getYtInitialPlayerResponseFromScripts();
    if (fromScripts && getCaptionBaseUrl(fromScripts)) return fromScripts;
    const fromPage = await getYtInitialPlayerResponseFromPageWindow();
    if (fromPage && getCaptionBaseUrl(fromPage)) return fromPage;
    const mergedEarly = fromScripts || fromPage;
    const vid = getVideoId();
    if (vid && !getCaptionBaseUrl(mergedEarly)) {
      const key = extractInnertubeApiKey();
      const inn =
        (await fetchPlayerResponseWeb(vid, key, null)) ||
        (await fetchPlayerResponseInnerTubeAndroid(vid, key));
      if (inn && getCaptionBaseUrl(inn)) return inn;
    }
    return mergedEarly;
  }

  function getOrderedCaptionBaseUrls(playerResponse) {
    try {
      const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(tracks) || tracks.length === 0) return [];
      const langPref = (navigator.language || "en").toLowerCase();
      const langMain = langPref.split(/[-_]/)[0];
      const scored = [];
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (typeof t?.baseUrl !== "string" || !t.baseUrl) continue;
        const code = String(t.languageCode || "").toLowerCase();
        const main = code.split(/[-_]/)[0];
        let score = 0;
        if (t.kind !== "asr") score += 8;
        if (code && (code === langPref || main === langMain)) score += 4;
        if (main === "en") score += 1;
        scored.push({ baseUrl: t.baseUrl, score, i });
      }
      scored.sort((a, b) => b.score - a.score || a.i - b.i);
      const seen = new Set();
      const out = [];
      for (let j = 0; j < scored.length; j++) {
        const u = scored[j].baseUrl;
        if (seen.has(u)) continue;
        seen.add(u);
        out.push(u);
      }
      return out;
    } catch {
      return [];
    }
  }

  function getCaptionBaseUrl(playerResponse) {
    const urls = getOrderedCaptionBaseUrls(playerResponse);
    return urls.length ? urls[0] : null;
  }

  function getVideoLengthSeconds(playerResponse) {
    const n = Number(playerResponse?.videoDetails?.lengthSeconds);
    return Number.isFinite(n) ? n : null;
  }

  function findActionBar() {
    return (
      document.querySelector("ytd-watch-metadata #actions-inner #top-level-buttons-computed") ||
      document.querySelector("#actions-inner #top-level-buttons-computed") ||
      document.querySelector("ytd-watch-metadata #actions #top-level-buttons-computed")
    );
  }

  function ariaLooksLikeDownload(ariaLabel) {
    if (!ariaLabel) return false;
    const t = ariaLabel.toLowerCase();
    return /download|descargar|télécharger|scarica|baixar|скачать|ダウンロード|下载|下載|herunterladen/.test(t);
  }

  function findDownloadHost(container) {
    if (!container) return null;
    const direct = container.querySelector("ytd-download-button-renderer");
    if (direct) return direct;
    const children = container.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (!el.matches || !el.matches("ytd-button-renderer")) continue;
      const b = el.querySelector("button[aria-label], button");
      if (ariaLooksLikeDownload((b && b.getAttribute("aria-label")) || "")) return el;
    }
    return null;
  }

  function textLooksLikeThanks(s) {
    const t = (s || "").toLowerCase();
    return /\bthanks\b|\bsuper thanks\b|\bdanke\b|\bmerci\b|\bgrazie\b|\bgracias\b/.test(t);
  }

  function findThanksHost(container) {
    if (!container) return null;
    const children = container.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (!el.matches) continue;
      if (!el.matches("ytd-button-renderer, ytd-button-view-model")) continue;
      const b = el.querySelector("button[aria-label], button");
      const aria = (b && b.getAttribute("aria-label")) || "";
      const inner = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (textLooksLikeThanks(aria) || textLooksLikeThanks(inner)) return el;
    }
    return null;
  }

  function findTrailingOverflowMenu(container) {
    if (!container) return null;
    const menus = Array.from(container.children).filter((el) => el.matches && el.matches("ytd-menu-renderer"));
    if (menus.length === 0) return null;
    if (menus.length === 1) return menus[0];
    const moreRe = /more actions|more options|^\s*more\s*$|weitere|mehr optionen/i;
    for (let j = menus.length - 1; j >= 0; j--) {
      const trigger = menus[j].querySelector("button#button, button[aria-label]");
      if (moreRe.test(((trigger && trigger.getAttribute("aria-label")) || "").trim())) return menus[j];
    }
    return menus[menus.length - 1];
  }

  function suppressThanksAndDownload(container) {
    if (!container) return;
    const thanks = findThanksHost(container);
    if (thanks && !thanks.hasAttribute(SUPPRESS_ATTR)) {
      thanks.setAttribute(SUPPRESS_ATTR, "1");
      thanks.style.setProperty("display", "none", "important");
    }
    const download = findDownloadHost(container);
    if (download && !download.hasAttribute(SUPPRESS_ATTR)) {
      download.setAttribute(SUPPRESS_ATTR, "1");
      download.style.setProperty("display", "none", "important");
    }
  }

  function restoreSuppressedActionButtons() {
    document.querySelectorAll(`[${SUPPRESS_ATTR}="1"]`).forEach((el) => {
      el.removeAttribute(SUPPRESS_ATTR);
      el.style.removeProperty("display");
    });
  }

  function insertCopyButtonInActionRow(container, wrap) {
    suppressThanksAndDownload(container);
    const downloadEl = findDownloadHost(container);
    const overflowMenu = findTrailingOverflowMenu(container);
    if (downloadEl && downloadEl.parentElement === container) {
      container.insertBefore(wrap, downloadEl);
      return;
    }
    const thanksEl = findThanksHost(container);
    if (thanksEl && thanksEl.parentElement === container) {
      container.insertBefore(wrap, thanksEl);
      return;
    }
    if (overflowMenu && overflowMenu.parentElement) {
      overflowMenu.parentElement.insertBefore(wrap, overflowMenu);
      return;
    }
    container.appendChild(wrap);
  }

  function applyNativeHostLook(container, wrap) {
    /* Do not copy ytd-button-renderer classes onto a div — polymer scopes add margins
       that break flex gap; spacing must come only from #top-level-buttons-computed gap. */
    wrap.className = "yt-ct-wrap";
  }

  function findShareLikeReferenceButton(container) {
    const buttons = container.querySelectorAll("button[aria-label]");
    for (let i = 0; i < buttons.length; i++) {
      const al = (buttons[i].getAttribute("aria-label") || "").trim();
      if (/^share\b|^teilen\b|^partager\b|^compartir\b|^condividi\b|^分享\b|^共有\b/i.test(al)) {
        return buttons[i];
      }
    }
    return null;
  }

  function applyNativeButtonLook(btn) {
    const container = document.querySelector("ytd-watch-metadata") || document;
    const ref =
      findShareLikeReferenceButton(container) ||
      container.querySelector('button.yt-spec-button-shape-next[aria-label="Share"]') ||
      container.querySelector('button[aria-label="Share"]') ||
      container.querySelector('button[aria-label^="Share"]') ||
      container.querySelector("ytd-download-button-renderer button.yt-spec-button-shape-next") ||
      container.querySelector("ytd-button-renderer:not([hidden]) button.yt-spec-button-shape-next") ||
      container.querySelector("ytd-button-renderer button");
    if (!ref || !ref.className) return;
    btn.setAttribute("data-yt-ct", "1");
    btn.className = ref.className + " yt-ct-yt-spec";
    const iconSlot = btn.querySelector(".yt-ct-icon-slot");
    const label = btn.querySelector(".yt-ct-label");
    if (iconSlot) {
      iconSlot.classList.add("yt-spec-button-shape-next__icon");
    }
    if (label) {
      label.classList.add("yt-spec-button-shape-next__button-text-content");
    }
  }

  function getVideoId() {
    try { return new URLSearchParams(location.search).get("v") || ""; } catch { return ""; }
  }

  function removeInjected() {
    document.querySelectorAll(`[${DATA_ATTR}="1"]`).forEach((el) => el.remove());
    restoreSuppressedActionButtons();
  }

  function formatTimestamp(seconds, useHours) {
    const s = Math.floor(Number(seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (useHours) return `[${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}]`;
    return `[${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}]`;
  }

  function shouldUseHours(lengthSeconds, segments) {
    if (lengthSeconds != null && lengthSeconds >= 3600) return true;
    let maxStart = 0;
    for (let i = 0; i < segments.length; i++) {
      const t = Number(segments[i].start);
      if (Number.isFinite(t) && t > maxStart) maxStart = t;
    }
    return maxStart >= 3600;
  }

  /** Classic timedtext XML (<text start="…">). Returns [] if not usable (no throw). */
  function parseTimedTextXml(xmlString) {
    const trimmed = (xmlString || "").trim();
    if (!trimmed) return [];
    const head = trimmed.slice(0, 400).toLowerCase();
    if (head.startsWith("<!doctype html") || /^<\s*html[\s>]/i.test(trimmed.slice(0, 80))) return [];

    const doc = new DOMParser().parseFromString(trimmed, "text/xml");
    if (doc.querySelector("parsererror")) return [];

    const nodes = doc.getElementsByTagName("text");
    const segments = [];
    for (let i = 0; i < nodes.length; i++) {
      const text = String(nodes[i].textContent).replace(/\s+/g, " ").trim();
      if (!text) continue;
      const start = nodes[i].getAttribute("start");
      segments.push({ start: start != null ? Number(start) : 0, text });
    }
    return segments;
  }

  function segmentsFromJson3Caption(json) {
    if (!json || !Array.isArray(json.events)) return [];
    const segments = [];
    for (let i = 0; i < json.events.length; i++) {
      const ev = json.events[i];
      const start = (ev.tStartMs != null ? Number(ev.tStartMs) : 0) / 1000;
      let piece = "";
      const segs = ev.segs;
      if (Array.isArray(segs)) {
        for (let j = 0; j < segs.length; j++) {
          const u = segs[j].utf8;
          if (u) piece += u;
        }
      }
      piece = piece.replace(/\s+/g, " ").trim();
      if (piece && piece !== "\n") segments.push({ start, text: piece });
    }
    return segments;
  }

  function decodeCaptionEntities(s) {
    if (!s) return "";
    return String(s)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  }

  /**
   * Matches youtube-transcript: srv3 &lt;p t dur&gt; with &lt;s&gt; words, then classic &lt;text&gt;.
   */
  function parseTranscriptXmlRobust(raw) {
    const t = (raw || "").trim();
    if (!t) return [];
    if (t.startsWith("{")) {
      try {
        const j = JSON.parse(t);
        const fromJson = segmentsFromJson3Caption(j);
        if (fromJson.length > 0) return fromJson;
      } catch {
        /* fall through */
      }
    }

    const head = t.slice(0, 200).toLowerCase();
    if (head.startsWith("<!doctype html") || /^<\s*html[\s>]/i.test(t.slice(0, 80))) return [];

    const out = [];
    const pRe = /<p\b[^>]*\bt="(\d+)"[^>]*\bd="(\d+)"[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRe.exec(t)) !== null) {
      const startMs = parseInt(m[1], 10);
      const inner = m[3];
      let piece = "";
      const sRe = /<s[^>]*>([^<]*)<\/s>/gi;
      let sm;
      while ((sm = sRe.exec(inner)) !== null) piece += sm[1];
      if (!piece) piece = inner.replace(/<[^>]+>/g, "");
      piece = decodeCaptionEntities(piece.replace(/\s+/g, " ").trim());
      if (piece) out.push({ start: startMs / 1000, text: piece });
    }
    if (out.length > 0) return out;

    const classicRe =
      /<text\s+[^>]*?start=["']([^"']+)["'][^>]*?(?:dur=["']([^"']+)["'])?[^>]*?>([^<]*)<\/text>/gi;
    while ((m = classicRe.exec(t)) !== null) {
      const start = parseFloat(m[1]);
      const txt = decodeCaptionEntities(String(m[3] || "").replace(/\s+/g, " ").trim());
      if (txt && Number.isFinite(start)) out.push({ start, text: txt });
    }
    if (out.length > 0) return out;

    return parseTimedTextXml(t);
  }

  function timedTextUrlWithFmt(baseUrl, fmt) {
    try {
      const u = new URL(baseUrl, location.origin);
      if (fmt == null) u.searchParams.delete("fmt");
      else u.searchParams.set("fmt", fmt);
      return u.toString();
    } catch {
      return baseUrl;
    }
  }

  async function fetchCaptionSegmentsWithVariants(baseUrl) {
    const variants = [
      timedTextUrlWithFmt(baseUrl, "json3"),
      baseUrl,
      timedTextUrlWithFmt(baseUrl, "srv3"),
    ];
    const tried = new Set();
    const fetchOpts = {
      credentials: "include",
      cache: "no-store",
    };
    for (let vi = 0; vi < variants.length; vi++) {
      const url = variants[vi];
      if (tried.has(url)) continue;
      tried.add(url);
      const res = await fetch(url, fetchOpts);
      if (!res.ok) continue;
      const raw = await res.text();
      const segments = parseTranscriptXmlRobust(raw);
      if (segments.length > 0) return segments;
    }
    throw new Error("No caption segments in response");
  }

  function formatOutput(segments, settings, lengthSeconds) {
    const useHours = shouldUseHours(lengthSeconds, segments);
    const includeTs = Boolean(settings.includeTimestamps);
    const md = settings.format === "markdown";
    const lines =[];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const ts = formatTimestamp(seg.start, useHours);
      if (md) lines.push(includeTs ? `- **${ts}** ${seg.text}` : `- ${seg.text}`);
      else lines.push(includeTs ? `${ts} ${seg.text}` : seg.text);
    }
    return lines.join("\n");
  }

  function getStorageSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(STORAGE_DEFAULTS, (items) => {
        if (chrome.runtime.lastError) {
          resolve({ format: liveSettings.format, includeTimestamps: liveSettings.includeTimestamps });
          return;
        }
        liveSettings = {
          format: items.format === "markdown" ? "markdown" : "plain",
          includeTimestamps: Boolean(items.includeTimestamps),
        };
        resolve(liveSettings);
      });
    });
  }

  function setButtonState(btn, state) {
    const label = btn.querySelector(".yt-ct-label");
    const iconSlot = btn.querySelector(".yt-ct-icon-slot");
    btn.classList.remove("yt-ct--disabled", "yt-ct--copied", "yt-ct--busy");
    btn.disabled = false;
    btn.removeAttribute("aria-disabled");
    btn.removeAttribute("data-state");

    if (state === "no-transcript") {
      btn.classList.add("yt-ct--disabled");
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      btn.setAttribute("data-state", "no-transcript");
      btn.title = "No transcript";
      if (label) label.textContent = "Copy transcript";
      if (iconSlot) iconSlot.innerHTML = ICON_FORBIDDEN;
    } else if (state === "loading" || state === "busy") {
      btn.classList.add("yt-ct--busy");
      btn.setAttribute("data-state", state);
      btn.disabled = true;
      btn.title = state === "loading" ? "Loading transcript…" : "Copying…";
      if (label) label.textContent = state === "loading" ? "Loading…" : "Copying…";
      if (iconSlot) iconSlot.innerHTML = ICON_DOC;
    } else if (state === "copied") {
      btn.classList.add("yt-ct--copied");
      btn.setAttribute("data-state", "copied");
      btn.title = "Copied";
      if (label) label.textContent = "Copied!";
      if (iconSlot) iconSlot.innerHTML = ICON_CHECK;
    } else {
      btn.setAttribute("data-state", "ready");
      btn.title = "Copy transcript";
      if (label) label.textContent = "Copy transcript";
      if (iconSlot) iconSlot.innerHTML = ICON_DOC;
    }
  }

  function buildButton() {
    const wrap = document.createElement("div");
    wrap.setAttribute(DATA_ATTR, "1");
    wrap.className = "yt-ct-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-yt-ct", "1");
    btn.className = "yt-ct-btn";
    const iconSlot = document.createElement("span");
    iconSlot.className = "yt-ct-icon-slot";
    iconSlot.innerHTML = ICON_DOC;
    const label = document.createElement("span");
    label.className = "yt-ct-label";
    label.textContent = "Copy transcript";
    btn.appendChild(iconSlot);
    btn.appendChild(label);
    wrap.appendChild(btn);
    return { wrap, btn };
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn("Clipboard API unavailable; using fallback.");
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        const ok = document.execCommand("copy");
        ta.remove();
        if (ok) resolve(true);
        else reject(new Error("Copy failed"));
      } catch (err) {
        ta.remove();
        reject(err);
      }
    });
  }

  function mergeUniqueBaseUrls(playerResponses) {
    const list = [];
    const seen = new Set();
    for (let i = 0; i < playerResponses.length; i++) {
      const pr = playerResponses[i];
      if (!pr) continue;
      const urls = getOrderedCaptionBaseUrls(pr);
      for (let j = 0; j < urls.length; j++) {
        const u = urls[j];
        if (seen.has(u)) continue;
        seen.add(u);
        list.push(u);
      }
    }
    return list;
  }

  async function prefetchTranscript() {
    await getStorageSettings();
    const vid = getVideoId();
    if (!vid || !location.pathname.startsWith("/watch")) return;
    const sig = settingsSig(liveSettings);
    const key = extractInnertubeApiKey();
    const clientVer = extractInnertubeClientVersion();

    const prPage = await resolveYtInitialPlayerResponse();
    const innWeb = await fetchPlayerResponseWeb(vid, key, clientVer);
    const innAndroid = await fetchPlayerResponseInnerTubeAndroid(vid, key);

    const prForLength = prPage || innWeb || innAndroid;
    const baseUrls = mergeUniqueBaseUrls([prPage, innWeb, innAndroid]);

    if (baseUrls.length === 0) {
      transcriptCache = {
        videoId: vid,
        settingsSig: sig,
        formattedText: null,
        baseUrl: null,
        error: "no-caption",
      };
      return;
    }

    let lastErr = null;
    for (let ti = 0; ti < baseUrls.length; ti++) {
      const baseUrl = baseUrls[ti];
      try {
        const segments = await fetchCaptionSegmentsWithVariants(baseUrl);
        transcriptCache = {
          videoId: vid,
          settingsSig: sig,
          formattedText: formatOutput(
            segments,
            liveSettings,
            prForLength ? getVideoLengthSeconds(prForLength) : null
          ),
          baseUrl,
          error: null,
        };
        return;
      } catch (e) {
        lastErr = e;
      }
    }

    transcriptCache = {
      videoId: vid,
      settingsSig: sig,
      formattedText: null,
      baseUrl: baseUrls[0],
      error: String(lastErr && lastErr.message ? lastErr.message : lastErr || "load failed"),
    };
  }

  function ensurePrefetch() {
    if (!prefetchPromise) prefetchPromise = prefetchTranscript().finally(() => { prefetchPromise = null; });
    return prefetchPromise;
  }

  function cacheReadyForClick(vid) {
    return transcriptCache.videoId === vid && transcriptCache.settingsSig === settingsSig(liveSettings) &&
           typeof transcriptCache.formattedText === "string" && transcriptCache.formattedText.length > 0;
  }

  function showCopiedFeedback(btn) {
    if (copiedTimer) clearTimeout(copiedTimer);
    setButtonState(btn, "copied");
    copiedTimer = setTimeout(() => { setButtonState(btn, "ready"); copiedTimer = null; }, 2000);
  }

  async function handleCopyClick(btn) {
    if (btn.disabled && btn.getAttribute("data-state") !== "ready") return;

    const vid = getVideoId();
    if (!cacheReadyForClick(vid)) {
      setButtonState(btn, "busy");
      await prefetchTranscript();
    }

    if (!cacheReadyForClick(vid)) {
      setButtonState(btn, transcriptCache.error === "no-caption" ? "no-transcript" : "ready");
      if (transcriptCache.error && transcriptCache.error !== "no-caption") {
        btn.title = "Could not load transcript";
        setTimeout(() => { if (btn.getAttribute("data-state") === "ready") btn.title = "Copy transcript"; }, 2500);
      }
      return;
    }

    setButtonState(btn, "busy");
    try {
      await copyToClipboard(transcriptCache.formattedText);
      showCopiedFeedback(btn);
    } catch (err) {
      console.error("Failed to copy transcript:", err);
      setButtonState(btn, "ready");
      btn.title = "Failed to copy transcript";
      setTimeout(() => { if (btn.getAttribute("data-state") === "ready") btn.title = "Copy transcript"; }, 2500);
    }
  }

  async function syncButtonAvailability(btn) {
    const state = btn.getAttribute("data-state");
    if (state === "busy" || state === "copied" || state === "loading") return;

    const vid = getVideoId();

    if (transcriptCache.videoId === vid) {
      if (cacheReadyForClick(vid)) {
        if (state !== "ready") setButtonState(btn, "ready");
      } else if (transcriptCache.error === "no-caption") {
        if (state !== "no-transcript") setButtonState(btn, "no-transcript");
      } else {
        if (state !== "ready") setButtonState(btn, "ready");
      }
      return;
    }
    
    setButtonState(btn, "loading");
    await ensurePrefetch();

    if (cacheReadyForClick(vid)) {
      setButtonState(btn, "ready");
    } else if (transcriptCache.error === "no-caption") {
      setButtonState(btn, "no-transcript");
    } else {
      setButtonState(btn, "ready");
      btn.title = "Could not load transcript";
    }
  }

  function tryInjectOrSync() {
    if (!location.pathname.startsWith("/watch")) { removeInjected(); return; }
    const vid = getVideoId();
    const container = findActionBar();
    const existing = document.querySelector(`[${DATA_ATTR}="1"]`);

    if (existing && existing.dataset.videoId === vid && existing.isConnected && container && container.contains(existing)) {
      const btn = existing.querySelector("button[data-yt-ct]");
      if (btn) {
        suppressThanksAndDownload(container);
        applyNativeHostLook(container, existing);
        applyNativeButtonLook(btn);
        void syncButtonAvailability(btn);
      }
      return;
    }

    removeInjected();
    if (!container || container.querySelector(`[${DATA_ATTR}="1"]`)) return;

    transcriptCache = { videoId: "", settingsSig: "", formattedText: null, baseUrl: null, error: null };
    const { wrap, btn } = buildButton();
    wrap.dataset.videoId = vid;
    void syncButtonAvailability(btn);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleCopyClick(btn);
    });

    applyNativeHostLook(container, wrap);
    applyNativeButtonLook(btn);
    insertCopyButtonInActionRow(container, wrap);
    window.requestAnimationFrame(() => {
      const bar = findActionBar();
      if (bar && bar.contains(wrap)) {
        applyNativeHostLook(bar, wrap);
        applyNativeButtonLook(btn);
      }
    });
  }

  document.addEventListener("yt-navigate-finish", () => {
    removeInjected();
    transcriptCache = { videoId: "", settingsSig: "", formattedText: null, baseUrl: null, error: null };
    window.requestAnimationFrame(tryInjectOrSync);
  });

  const mo = new MutationObserver(debounce(tryInjectOrSync, 150));
  mo.observe(document.documentElement, { childList: true, subtree: true });

  tryInjectOrSync();
})();