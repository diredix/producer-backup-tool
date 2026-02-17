// ==UserScript==
// @name         Producer.ai Full Backup Exporter
// @namespace    https://github.com/
// @version      1.0.1
// @description  Export all tracks from a Producer.ai project: metadata JSON, prompt summary, CSV, and optional audio files.
// @match        https://producer.ai/project/*
// @match        https://www.producer.ai/project/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

(function () {
  "use strict";

  const API_URL = "https://www.producer.ai/__api/v2/generations";
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
    const anchors = Array.from(document.querySelectorAll("a[href*='/song/']"));
    const ids = new Set();
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/\/song\/([a-f0-9-]{8,})/i);
      if (match) ids.add(match[1]);
    }
    return Array.from(ids);
  }

  async function autoScrollToLoadSongs(maxRounds = 80, idleThreshold = 5, waitMs = 1200) {
    let idleRounds = 0;
    let prevHeight = -1;
    let prevCount = -1;

    for (let i = 0; i < maxRounds; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(waitMs);

      const h = document.body.scrollHeight;
      const c = extractSongIdsFromPage().length;

      if (h === prevHeight && c === prevCount) {
        idleRounds++;
      } else {
        idleRounds = 0;
      }

      prevHeight = h;
      prevCount = c;
      setStatus(`Scanning page... loaded ${c} song links`);

      if (idleRounds >= idleThreshold) break;
    }
    window.scrollTo(0, 0);
  }

  async function fetchGenerationsByIds(songIds, batchSize = DEFAULT_BATCH_SIZE, delayMs = DEFAULT_DELAY_MS) {
    const batches = chunk(songIds, batchSize);
    const all = [];
    const errors = [];

    for (let i = 0; i < batches.length; i++) {
      const ids = batches[i];
      setStatus(`Fetching metadata batch ${i + 1}/${batches.length} (${ids.length} ids)`);

      try {
        const response = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ riff_ids: ids }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
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
    panel.style.zIndex = "999999";
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
    status.textContent = "Ready. Open a project page and run export.";
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
      "Tip: stay on the project page until export finishes. Large libraries may need multiple runs.";
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
    return /\/project\//.test(location.pathname);
  }

  function mountIfNeeded() {
    const existing = document.getElementById(PANEL_ID);
    if (shouldShowPanel()) {
      if (!existing) createPanel();
    } else if (existing) {
      existing.remove();
    }
  }

  const observer = new MutationObserver(() => mountIfNeeded());
  observer.observe(document.body, { childList: true, subtree: true });
  mountIfNeeded();
})();
