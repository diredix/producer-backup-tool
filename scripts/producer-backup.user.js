// ==UserScript==
// @name         Producer.ai Full Backup Exporter
// @namespace    https://github.com/
// @version      1.2.2
// @description  Export all tracks from a Producer.ai project: metadata JSON, prompt summary, CSV, and optional audio files.
// @match        https://producer.ai/*
// @match        https://www.producer.ai/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const API_URL_CANDIDATES = Array.from(
    new Set([
      `${location.origin}/__api/v2/generations`,
      "https://www.producer.ai/__api/v2/generations",
      "https://producer.ai/__api/v2/generations",
    ])
  );
  const PANEL_ID = "producer-backup-exporter-panel";
  const STATUS_ID = "producer-backup-exporter-status";
  const DEFAULT_BATCH_SIZE = 40;
  const DEFAULT_DELAY_MS = 250;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nowIsoCompact() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  function sanitizeFilename(name) {
    return String(name || "untitled")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "untitled";
  }

  function setStatus(text) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = text;
    console.log(`[Producer Backup] ${text}`);
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function guessExtensionFromUrl(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
      return m ? m[1].toLowerCase() : "bin";
    } catch {
      return "bin";
    }
  }

  function guessExtensionFromContentType(contentType, fallbackUrl) {
    const type = String(contentType || "").toLowerCase();
    if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
    if (type.includes("wav")) return "wav";
    if (type.includes("flac")) return "flac";
    if (type.includes("ogg")) return "ogg";
    if (type.includes("aac")) return "aac";
    if (type.includes("mp4") || type.includes("m4a")) return "m4a";
    return guessExtensionFromUrl(fallbackUrl);
  }

  function extractSongIdsFromPage() {
    const anchors = Array.from(document.querySelectorAll("a[href*='/song/'], a[href*='/library/song/']"));
    const ids = new Set();
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/\/song\/([a-f0-9-]{8,})/i) || href.match(/\/library\/song\/([a-f0-9-]{8,})/i);
      if (match) ids.add(match[1]);
    }

    // Common data attribute fallback used by virtualized lists/cards.
    const attrSelectors = [
      "[data-riff-id]",
      "[data-song-id]",
      "[data-generation-id]",
      "[data-id]",
    ];
    for (const sel of attrSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const candidate =
          el.getAttribute("data-riff-id") ||
          el.getAttribute("data-song-id") ||
          el.getAttribute("data-generation-id") ||
          el.getAttribute("data-id") ||
          "";
        if (/^[a-f0-9-]{8,}$/i.test(candidate)) ids.add(candidate);
      }
    }

    // HTML regex fallback for SPA payloads (e.g., __NEXT_DATA__).
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    if (html) {
      const patterns = [
        /\/song\/([a-f0-9-]{8,})/gi,
        /"riff_id"\s*:\s*"([a-f0-9-]{8,})"/gi,
        /"riffId"\s*:\s*"([a-f0-9-]{8,})"/gi,
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) !== null) {
          if (m[1]) ids.add(m[1]);
        }
      }
    }

    return Array.from(ids);
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 80 && rect.height > 80;
  }

  function isScrollable(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const overflowY = style.overflowY || "";
    const range = el.scrollHeight - el.clientHeight;
    return (/(auto|scroll|overlay)/i.test(overflowY) || range > 40) && range > 40;
  }

  function findSongsHeadingElement() {
    const nodes = Array.from(document.querySelectorAll("h1, h2, h3, div, span"));
    return nodes.find((el) => (el.textContent || "").trim().toLowerCase() === "songs") || null;
  }

  function findScrollContainerNearSongs() {
    const heading = findSongsHeadingElement();
    if (!heading) return null;

    let current = heading.parentElement;
    while (current && current !== document.body) {
      if (isElementVisible(current) && isScrollable(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function countRegexMatches(text, regex, maxCount = 40) {
    if (!text) return 0;
    let count = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      count++;
      if (count >= maxCount) break;
    }
    return count;
  }

  function scoreScrollableCandidate(el) {
    if (!el) return -Infinity;
    const rect = el.getBoundingClientRect();
    const range = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
    const widthScore = Math.max(0, el.clientWidth || 0);
    const anchorScore = el.querySelectorAll("a[href*='/song/'], a[href*='/library/song/']").length * 900;
    const text = (el.innerText || "").slice(0, 12000);
    const durationScore = countRegexMatches(text, /\b\d{1,2}:\d{2}\b/g, 40) * 550;

    // Penalize likely sidebars.
    const isLeftNarrow = rect.left < window.innerWidth * 0.22 && rect.width < window.innerWidth * 0.35;
    const sidebarPenalty = isLeftNarrow ? 120000 : 0;

    return range * 6 + widthScore * 2 + anchorScore + durationScore - sidebarPenalty;
  }

  function findBestScrollableContainer() {
    const els = Array.from(document.querySelectorAll("main, section, article, div, ul, aside"));
    const candidates = [];
    for (const el of els) {
      if (!isElementVisible(el) || !isScrollable(el)) continue;
      const score = scoreScrollableCandidate(el);
      candidates.push({ el, score });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  function describeTarget(target) {
    if (!target) return "none";
    if (target === document.scrollingElement || target === document.documentElement) return "document";
    const cls = String(target.className || "").trim().split(/\s+/).slice(0, 2).join(".");
    return `${target.tagName.toLowerCase()}#${target.id || "-"}${cls ? "." + cls : ""}`;
  }

  function resolveScrollTargets() {
    const targets = [];

    const nearSongs = findScrollContainerNearSongs();
    if (nearSongs) targets.push(nearSongs);

    const best = findBestScrollableContainer();
    if (best) targets.push(best);

    const generic = Array.from(document.querySelectorAll("main, section, article, div, ul, aside"))
      .filter((el) => isElementVisible(el) && isScrollable(el))
      .map((el) => ({ el, score: scoreScrollableCandidate(el) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((x) => x.el);
    targets.push(...generic);

    targets.push(document.scrollingElement || document.documentElement);

    const unique = [];
    const seen = new Set();
    for (const t of targets) {
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      unique.push(t);
    }
    return unique;
  }

  function scrollTargetStep(target) {
    if (!target) return false;
    const before = target.scrollTop || 0;
    const maxTop = Math.max(0, (target.scrollHeight || 0) - (target.clientHeight || 0));
    // For infinite lists, jumping near-bottom triggers loaders more reliably than tiny steps.
    const nextTop = maxTop;
    target.scrollTop = nextTop;
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    try {
      target.dispatchEvent(new WheelEvent("wheel", { deltaY: Math.max(600, target.clientHeight || 600), bubbles: true }));
    } catch {
      // ignore
    }
    return (target.scrollTop || 0) !== before;
  }

  async function fetchGenerationsApi(ids) {
    let lastError = "unknown error";
    for (const apiUrl of API_URL_CANDIDATES) {
      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ riff_ids: ids }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${apiUrl}`);
        return await response.json();
      } catch (err) {
        lastError = String(err);
      }
    }
    throw new Error(`All API endpoints failed: ${lastError}`);
  }

  async function autoScrollToLoadSongs(maxRounds = 140, idleThreshold = 10, waitMs = 1300) {
    let targets = resolveScrollTargets();
    if (!targets.length) targets = [document.scrollingElement || document.documentElement];

    const minRoundsBeforeIdleBreak = 20;
    let idleRounds = 0;
    let prevCount = -1;
    let bestCount = 0;

    for (let i = 0; i < maxRounds; i++) {
      if (i % 5 === 0) {
        targets = resolveScrollTargets();
        if (!targets.length) targets = [document.scrollingElement || document.documentElement];
      }

      let movedAny = false;
      for (const t of targets) movedAny = scrollTargetStep(t) || movedAny;
      window.scrollBy(0, Math.max(280, Math.floor(window.innerHeight * 0.75)));

      await sleep(waitMs);

      const c = extractSongIdsFromPage().length;
      if (c > bestCount) bestCount = c;

      if (!movedAny && c === prevCount) {
        idleRounds++;
      } else {
        idleRounds = 0;
      }

      prevCount = c;
      const names = targets.slice(0, 3).map((t) => describeTarget(t)).join(" | ");
      setStatus(`Scanning... loaded ${c} song links [${names}]`);

      if (idleRounds >= idleThreshold && i >= minRoundsBeforeIdleBreak) {
        // One last delayed check for slow lazy-loading responses before exiting.
        setStatus(`Waiting for delayed list load... currently ${c} links`);
        await sleep(3500);
        const afterWait = extractSongIdsFromPage().length;
        if (afterWait > c) {
          idleRounds = 0;
          prevCount = afterWait;
          if (afterWait > bestCount) bestCount = afterWait;
          setStatus(`More songs appeared after wait: ${afterWait} links. Continuing scan...`);
          continue;
        }
        break;
      }
    }
    for (const t of targets) {
      if (t && typeof t.scrollTop === "number") {
        t.scrollTop = 0;
        t.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    }
  }

  async function fetchGenerationsByIds(songIds, batchSize = DEFAULT_BATCH_SIZE, delayMs = DEFAULT_DELAY_MS) {
    const batches = chunk(songIds, batchSize);
    const all = [];
    const errors = [];

    for (let i = 0; i < batches.length; i++) {
      const ids = batches[i];
      setStatus(`Fetching metadata batch ${i + 1}/${batches.length} (${ids.length} ids)`);

      try {
        const data = await fetchGenerationsApi(ids);
        const generations = Array.isArray(data.generations) ? data.generations : [];
        all.push(...generations);
      } catch (err) {
        errors.push({ batch: i + 1, ids, error: String(err) });
      }

      if (i < batches.length - 1) await sleep(delayMs);
    }

    return { generations: all, errors };
  }

  function pickFirstString(obj, paths) {
    for (const path of paths) {
      const parts = path.split(".");
      let cur = obj;
      let ok = true;
      for (const p of parts) {
        if (cur && Object.prototype.hasOwnProperty.call(cur, p)) {
          cur = cur[p];
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (typeof cur === "string" && cur.trim()) return cur.trim();
    }
    return "";
  }

  function escapeCsvField(v) {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function toCsv(rows, headers) {
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((h) => escapeCsvField(row[h])).join(","));
    }
    return lines.join("\n");
  }

  function extractPromptText(generation) {
    return pickFirstString(generation, [
      "prompt",
      "text_prompt",
      "metadata.prompt",
      "metadata.text_prompt",
      "params.prompt",
      "params.text_prompt",
      "input.prompt",
      "input.text_prompt",
      "lyrics",
      "lyric",
      "caption",
      "description",
    ]);
  }

  function findAudioUrlCandidates(generation) {
    const urls = new Set();

    function walk(node, keyHint = "") {
      if (!node) return;

      if (typeof node === "string") {
        const s = node.trim();
        if (!s) return;

        const keyLooksAudio = /audio|mp3|wav|flac|m4a|ogg|riff|track/i.test(keyHint);
        const valueLooksUrl = /^https?:\/\//i.test(s);
        const valueLooksAudioPath = /\.(mp3|wav|flac|m4a|ogg)(\?|$)/i.test(s);

        if (valueLooksUrl && (keyLooksAudio || valueLooksAudioPath)) urls.add(s);
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) walk(item, keyHint);
        return;
      }

      if (typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, k);
      }
    }

    walk(generation);
    return Array.from(urls);
  }

  async function tryDownloadFirstAudioBlob(generation) {
    const candidates = findAudioUrlCandidates(generation);
    for (const url of candidates) {
      try {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) continue;
        const blob = await response.blob();
        const ext = guessExtensionFromContentType(response.headers.get("content-type"), url);
        return { ok: true, blob, ext, url };
      } catch {
        // try next candidate
      }
    }
    return { ok: false, candidates };
  }

  async function buildBackupZip({ includeAudio }) {
    await autoScrollToLoadSongs();
    const songIds = extractSongIdsFromPage();

    if (!songIds.length) {
      throw new Error("No song IDs found on page. Open a project page and ensure songs are visible.");
    }

    setStatus(`Collected ${songIds.length} song IDs. Fetching metadata...`);
    const { generations, errors } = await fetchGenerationsByIds(songIds);

    if (!generations.length) {
      throw new Error("No generation metadata returned. You may need to refresh/login and try again.");
    }

    const zip = new JSZip();
    const metadataFolder = zip.folder("metadata");
    const audioFolder = zip.folder("audio");
    const promptLines = [];
    const summaryRows = [];
    const downloadErrors = [...errors];
    let downloadedAudio = 0;

    for (let i = 0; i < generations.length; i++) {
      const g = generations[i];
      const id = g.id || `unknown-${i + 1}`;
      const title = sanitizeFilename(g.title || id);
      const prompt = extractPromptText(g);
      const createdAt = pickFirstString(g, ["created_at", "createdAt", "timestamp"]);
      const duration = pickFirstString(g, ["duration", "duration_seconds", "metadata.duration"]);

      metadataFolder.file(`${title}__${id}.json`, JSON.stringify(g, null, 2));

      promptLines.push(`### ${title} (${id})`);
      promptLines.push(prompt || "<no prompt text detected>");
      promptLines.push("");

      summaryRows.push({
        id,
        title,
        created_at: createdAt,
        duration_seconds: duration,
        prompt,
      });

      if (includeAudio) {
        setStatus(`Downloading audio ${i + 1}/${generations.length}`);
        const dl = await tryDownloadFirstAudioBlob(g);
        if (dl.ok) {
          audioFolder.file(`${title}__${id}.${dl.ext}`, dl.blob);
          downloadedAudio++;
        } else {
          downloadErrors.push({
            generation_id: id,
            reason: "audio_not_found_or_not_accessible",
            candidates: dl.candidates || [],
          });
        }
      } else {
        setStatus(`Packaging metadata ${i + 1}/${generations.length}`);
      }
    }

    const headers = ["id", "title", "created_at", "duration_seconds", "prompt"];
    zip.file("summary.csv", toCsv(summaryRows, headers));
    zip.file("prompts.txt", promptLines.join("\n"));
    zip.file(
      "_report.json",
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          page_url: location.href,
          total_song_ids_found: songIds.length,
          generations_returned: generations.length,
          audio_requested: includeAudio,
          audio_downloaded: downloadedAudio,
          errors: downloadErrors,
        },
        null,
        2
      )
    );

    setStatus("Building ZIP file...");
    return zip.generateAsync({ type: "blob" });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function createButton(label, bg, onClick) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.margin = "4px 0";
    btn.style.padding = "8px";
    btn.style.width = "100%";
    btn.style.border = "none";
    btn.style.borderRadius = "6px";
    btn.style.cursor = "pointer";
    btn.style.background = bg;
    btn.style.color = "#fff";
    btn.addEventListener("click", onClick);
    return btn;
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.position = "fixed";
    panel.style.top = "12px";
    panel.style.right = "12px";
    panel.style.width = "280px";
    panel.style.zIndex = "2147483647";
    panel.style.background = "rgba(18, 18, 22, 0.95)";
    panel.style.color = "#fff";
    panel.style.padding = "10px";
    panel.style.borderRadius = "10px";
    panel.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    panel.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.35)";
    panel.style.fontSize = "12px";

    const title = document.createElement("div");
    title.textContent = "Producer Backup Exporter";
    title.style.fontWeight = "700";
    title.style.marginBottom = "8px";

    const status = document.createElement("div");
    status.id = STATUS_ID;
    status.textContent = `Ready on ${location.pathname}.`;
    status.style.opacity = "0.9";
    status.style.marginBottom = "8px";
    status.style.minHeight = "32px";

    const metaBtn = createButton("Export ZIP (Metadata + Prompts)", "#3f51b5", async () => {
      metaBtn.disabled = true;
      audioBtn.disabled = true;
      try {
        const blob = await buildBackupZip({ includeAudio: false });
        const filename = `producer-backup-metadata-${nowIsoCompact()}.zip`;
        triggerDownload(blob, filename);
        setStatus(`Done. Downloaded ${filename}`);
      } catch (err) {
        alert(`Export failed: ${err.message || err}`);
        setStatus(`Error: ${err.message || err}`);
      } finally {
        metaBtn.disabled = false;
        audioBtn.disabled = false;
      }
    });

    const audioBtn = createButton("Export ZIP (Metadata + Prompts + Audio)", "#009688", async () => {
      metaBtn.disabled = true;
      audioBtn.disabled = true;
      try {
        const blob = await buildBackupZip({ includeAudio: true });
        const filename = `producer-backup-full-${nowIsoCompact()}.zip`;
        triggerDownload(blob, filename);
        setStatus(`Done. Downloaded ${filename}`);
      } catch (err) {
        alert(`Export failed: ${err.message || err}`);
        setStatus(`Error: ${err.message || err}`);
      } finally {
        metaBtn.disabled = false;
        audioBtn.disabled = false;
      }
    });

    const hint = document.createElement("div");
    hint.textContent =
      "Tip: open your songs page (library/project), keep tab active while export runs.";
    hint.style.opacity = "0.8";
    hint.style.marginTop = "8px";
    hint.style.lineHeight = "1.35";

    panel.appendChild(title);
    panel.appendChild(status);
    panel.appendChild(metaBtn);
    panel.appendChild(audioBtn);
    panel.appendChild(hint);
    document.body.appendChild(panel);
  }

  function shouldShowPanel() {
    // Always show on producer.ai to avoid missing SPA route variants.
    return true;
  }

  function mountIfNeeded() {
    const existing = document.getElementById(PANEL_ID);
    if (shouldShowPanel()) {
      if (!existing) createPanel();
    } else if (existing) {
      existing.remove();
    }
  }

  function start() {
    mountIfNeeded();
    const observer = new MutationObserver(() => mountIfNeeded());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
