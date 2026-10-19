const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  desktopCapturer,
  clipboard,
  shell,
  screen,
  session,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const WebSocket = require("ws");

let mainWindow = null;
let tray = null;
let isMiniMode = false;
let savedBounds = { width: 1380, height: 880 };

// ============================================================================
// ULTRA-FAST RAM-INDEXED + DISK-SYNCED TIMESTAMPED MEMORY ENGINE (<0.1ms lookup)
// ============================================================================
const MEMORY_DIR = path.join(__dirname, "..", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "jarvis_memory.json");
const PROJECTS_DIR = path.join(__dirname, "..", "projects");

let memoryState = {
  turns: [],
  addresses: {},
};

function formatFullTimestamp(date = new Date()) {
  return date.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function loadMemoryFromDisk() {
  try {
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
      if (Array.isArray(raw.turns)) memoryState.turns = raw.turns;
      if (raw.addresses && typeof raw.addresses === "object") memoryState.addresses = raw.addresses;
    }
  } catch {
    // start fresh if corrupted
  }
}

function saveMemoryToDiskAsync() {
  try {
    const serialized = JSON.stringify(memoryState, null, 2);
    fs.writeFile(MEMORY_FILE, serialized, "utf8", () => {});
  } catch {
    // ignore write error
  }
}

function recordMemoryTurn(entry = {}) {
  const now = new Date();
  const isoTimestamp = now.toISOString();
  const humanTimestamp = formatFullTimestamp(now);

  const actions = Array.isArray(entry.actions) ? entry.actions : [];
  for (const act of actions) {
    const addr = act.address || act.result?.address || act.result?.url || act.result?.projectDir;
    if (addr) {
      const key = act.projectName || act.toolName + ":" + String(addr).slice(-40);
      memoryState.addresses[key] = {
        key,
        toolName: act.toolName,
        address: addr,
        summary: act.summary || act.result?.message || act.toolName,
        agent: act.agent || act.args?.agent || "jarvis",
        timestamp: humanTimestamp,
        isoTimestamp,
      };
    }
  }

  const record = {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    isoTimestamp,
    humanTimestamp,
    userText: String(entry.userText || ""),
    assistantReply: String(entry.assistantReply || ""),
    languageCode: entry.languageCode || "en-IN",
    actions: actions.map((a) => ({
      toolName: a.toolName,
      args: a.args,
      address: a.address || a.result?.address || a.result?.url || a.result?.projectDir || null,
      summary: a.summary || a.result?.message || "",
      timestamp: a.timestamp || humanTimestamp,
    })),
  };

  memoryState.turns.push(record);
  if (memoryState.turns.length > 2000) {
    memoryState.turns = memoryState.turns.slice(-2000);
  }
  saveMemoryToDiskAsync();
  return record;
}

function queryMemoryFast(queryText = "") {
  const tokens = String(queryText || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u0DFF]+/)
    .filter((t) => t.length >= 2);

  const scored = [];
  for (let i = 0; i < memoryState.turns.length; i++) {
    const t = memoryState.turns[i];
    const hay = `${t.humanTimestamp} ${t.userText} ${t.assistantReply} ${JSON.stringify(t.actions)}`.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 3;
    }
    if (score > 0) {
      // Boost more recent matches slightly
      score += (i / Math.max(1, memoryState.turns.length)) * 1.5;
      scored.push({ turn: t, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const topMatches = scored.slice(0, 6).map((s) => s.turn);
  const recentTurns = memoryState.turns.slice(-12);
  const addressList = Object.values(memoryState.addresses).slice(-20);

  const lines = [];

  if (activeNewsCache && activeNewsCache.expiresAt && Date.now() < activeNewsCache.expiresAt) {
    lines.push(
      `=== ACTIVE TEMP CRAWLED NEWS CACHE (Topic: "${activeNewsCache.topic}" — Crawled from ${(activeNewsCache.websites || []).length} websites via Firecrawl) ===`
    );
    lines.push(
      `IMPORTANT: If the user asks any follow-up question about "${activeNewsCache.topic}" or this news event, answer in a vivid, natural "What Happened" story format using the crawled article facts below. NEVER read URLs or links aloud!`
    );
    lines.push(`Synthesized Story: ${activeNewsCache.storyBriefing}`);
    for (let i = 0; i < (activeNewsCache.websites || []).length; i++) {
      const w = activeNewsCache.websites[i];
      lines.push(
        `\n[Crawled Website ${i + 1}: ${w.title} (${w.source})]\n${String(w.content || "").slice(0, 2000)}`
      );
    }
  }

  if (addressList.length > 0) {
    lines.push("=== SAVED PROJECTS & ADDRESSES (INTERNAL REFERENCE ONLY — DO NOT READ PATHS OR TIMESTAMPS ALOUD) ===");
    for (const item of addressList) {
      lines.push(`- ${item.key}: address="${item.address}" (${item.summary})`);
    }
  }

  if (topMatches.length > 0) {
    lines.push("\n=== REMEMBERED FACTS & PAST CONVERSATIONS ===");
    for (const m of topMatches) {
      const actStr =
        m.actions && m.actions.length > 0
          ? ` [Action: ${m.actions.map((a) => a.toolName).join(", ")}]`
          : "";
      lines.push(`- User said: "${m.userText}"${actStr} -> You replied: "${m.assistantReply}"`);
    }
  }

  if (recentTurns.length > 0) {
    lines.push("\n=== RECENT CONVERSATION CONTEXT ===");
    for (const r of recentTurns) {
      lines.push(`- User: "${r.userText}" -> You: "${r.assistantReply}"`);
    }
  }

  return {
    formattedContext: lines.join("\n"),
    recentTurns,
    matchedTurns: topMatches,
    addresses: addressList,
    totalMemories: memoryState.turns.length,
  };
}

loadMemoryFromDisk();

// Persistent Python Wake Word Co-Processor for hey_jarvis_v0.1.tflite
let wakeProc = null;
let wakeStatus = {
  ready: false,
  modelPath: path.join(__dirname, "..", "hey_jarvis_v0.1.tflite"),
  modelBytes: 1278912,
  architecture: "TFL3 2-Stage Cascade (1536->128->128->1 + 1536->64->64->1)",
  lastScore: 0,
  stage1Score: 0,
  stage2Verified: false,
  framesProcessed: 0,
  error: null,
};
let reqCounter = 1;
const pendingWakeCallbacks = new Map();

function startWakeWordWorker() {
  const scriptPath = path.join(__dirname, "wakeword_worker.py");
  if (!fs.existsSync(scriptPath)) {
    wakeStatus.error = "wakeword_worker.py not found";
    return;
  }

  try {
    wakeProc = spawn("python", [scriptPath], {
      cwd: path.join(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBuffer = "";
    wakeProc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(String.fromCharCode(10));
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.type === "ready") {
            wakeStatus.ready = true;
            wakeStatus.modelPath = msg.modelPath;
            wakeStatus.modelBytes = msg.modelBytes;
            wakeStatus.architecture = msg.architecture;
            wakeStatus.error = null;
          } else if (msg.type === "score" || msg.type === "test_result" || msg.type === "reset_ok") {
            if (typeof msg.score === "number") {
              wakeStatus.lastScore = msg.score;
              wakeStatus.stage1Score = msg.stage1Score ?? msg.score;
              wakeStatus.stage2Verified = Boolean(msg.stage2Verified);
              wakeStatus.framesProcessed = msg.framesProcessed ?? wakeStatus.framesProcessed;
            }
            if (msg.id && pendingWakeCallbacks.has(msg.id)) {
              const resolve = pendingWakeCallbacks.get(msg.id);
              pendingWakeCallbacks.delete(msg.id);
              resolve(msg);
            }
          } else if (msg.type === "error") {
            wakeStatus.error = msg.error;
            if (msg.id && pendingWakeCallbacks.has(msg.id)) {
              const resolve = pendingWakeCallbacks.get(msg.id);
              pendingWakeCallbacks.delete(msg.id);
              resolve(msg);
            }
          }
        } catch {
          // ignore malformed line
        }
      }
    });

    wakeProc.on("exit", () => {
      wakeStatus.ready = false;
    });
  } catch (err) {
    wakeStatus.error = err.message;
  }
}

function sendWakeCommand(payload, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!wakeProc || !wakeStatus.ready) {
      resolve({ type: "error", error: "Wake word worker not ready", score: 0 });
      return;
    }
    const id = reqCounter++;
    const timer = setTimeout(() => {
      pendingWakeCallbacks.delete(id);
      resolve({ type: "timeout", score: wakeStatus.lastScore });
    }, timeoutMs);

    pendingWakeCallbacks.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });

    try {
      wakeProc.stdin.write(JSON.stringify({ ...payload, id }) + String.fromCharCode(10));
    } catch (err) {
      clearTimeout(timer);
      pendingWakeCallbacks.delete(id);
      resolve({ type: "error", error: err.message, score: 0 });
    }
    });
    }

    function runPowerShell(command, timeoutMs = 12000) {
    return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: (stdout || "").trim(),
          stderr: (stderr || "").trim(),
          error: error ? error.message : null,
        });
      }
    );
    });
    }

    // Cache Vertex AI token & GCP YouTube Data API v3 key
    let cachedVertexAuth = { token: null, project: null, expiresAt: 0 };
    let cachedYouTubeApiKey = process.env.YOUTUBE_API_KEY || null;

    async function getYouTubeApiKey() {
      if (cachedYouTubeApiKey) return cachedYouTubeApiKey;
      const userEnvRes = await runPowerShell(
        '[Environment]::GetEnvironmentVariable("YOUTUBE_API_KEY", "User")',
        4000
      );
      if (userEnvRes.ok && userEnvRes.stdout && userEnvRes.stdout.startsWith("AIza")) {
        cachedYouTubeApiKey = userEnvRes.stdout.trim();
        return cachedYouTubeApiKey;
      }
      const gcloudRes = await runPowerShell(
        '$k = (gcloud services api-keys list --filter="displayName=\'Jarvis YouTube API\'" --format="value(name)" | Select-Object -First 1); if ($k) { gcloud services api-keys get-key-string $k --format="value(keyString)" }',
        7000
      );
      if (gcloudRes.ok && gcloudRes.stdout && gcloudRes.stdout.includes("AIza")) {
        cachedYouTubeApiKey = gcloudRes.stdout.split(String.fromCharCode(10)).pop().trim();
        return cachedYouTubeApiKey;
      }
      return null;
    }

    function cleanYouTubeSongTitle(rawTitle = "", channelTitle = "") {
      const decoded = rawTitle
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

      // Strip common YouTube video noise tags
      const stripped = decoded
        .replace(
          /\([^)]*(?:official|lyric|video|audio|4k|8k|hd|full\s*song|visualizer|remaster|title|jukebox|best|slowed|reverb|\d{4})[^)]*\)/gi,
          " "
        )
        .replace(
          /\[[^\]]*(?:official|lyric|video|audio|4k|8k|hd|full\s*song|visualizer|remaster|title|jukebox|best|slowed|reverb|\d{4})[^\]]*\]/gi,
          " "
        )
        .replace(
          /\b(?:official\s*(?:music\s*)?video|lyric(?:s)?\s*video|full\s*video\s*song|full\s*song|video\s*song|audio\s*song|4k\s*ultra\s*hd|8k|4k|hd|hq|jukebox|non\s*stop|back\s*to\s*back|superhit\s*hindi\s*song|songs|song|title\s*track|video)\b/gi,
          " "
        );

      const parts = stripped
        .split(/[|\-–—:]/)
        .map((p) =>
          p
            .replace(/[^a-zA-Z0-9\s']/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        )
        .filter((p) => p.length >= 2);

      // Take primary song title + movie/singer segment from YouTube's official metadata
      const cleanedQuery = parts.slice(0, 2).join(" ") || stripped.replace(/\s+/g, " ").trim();
      const primaryTitle = parts[0] || cleanedQuery;
      const secondaryContext = parts[1] || channelTitle.replace(/VEVO|Official|Music|Records|Series|India|Films/gi, "").trim();

      return {
        cleanedQuery,
        primaryTitle,
        secondaryContext,
      };
    }

    /**
     * Resolves hummed/sung lyrics, Hindi/Devanagari phrases, movie names, or partial song descriptions
     * into the official Romanized song title and artist using GCP YouTube Data API v3 (regionCode=IN).
     */
    async function resolveSongViaYouTubeAPI(lyricsOrQuery) {
      const ytKey = await getYouTubeApiKey();
      const searchQuery = /song|music|track/i.test(lyricsOrQuery)
        ? lyricsOrQuery
        : `${lyricsOrQuery} song`;

      let videoId = null;
      let ytTitle = "";
      let ytChannel = "";

      if (ytKey) {
        try {
          const ytUrl = `https://youtube.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&regionCode=IN&maxResults=3&q=${encodeURIComponent(
            searchQuery
          )}&key=${encodeURIComponent(ytKey)}`;
          const resp = await fetch(ytUrl);
          if (resp.ok) {
            const data = await resp.json();
            const top = data?.items?.[0];
            if (top) {
              videoId = top.id?.videoId || null;
              ytTitle = top.snippet?.title || "";
              ytChannel = top.snippet?.channelTitle || "";
            }
          }
        } catch {
          // fall through to HTML fallback
        }
      }

      // Fallback to YouTube HTML search if API quota or network failed
      if (!videoId) {
        try {
          const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
          const resp = await fetch(searchUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            },
          });
          const html = await resp.text();
          const idMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
          const titleMatch = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"\}/);
          if (idMatch) videoId = idMatch[1];
          if (titleMatch) ytTitle = titleMatch[1];
        } catch {
          // ignore
        }
      }

      const { cleanedQuery, primaryTitle, secondaryContext } = cleanYouTubeSongTitle(
        ytTitle || lyricsOrQuery,
        ytChannel
      );

      return {
        videoId,
        youtubeTitle: ytTitle || primaryTitle,
        officialSongName: primaryTitle || lyricsOrQuery,
        officialArtist: secondaryContext || "",
        spotifySearchQuery: cleanedQuery || lyricsOrQuery,
      };
    }

    // ============================================================================
    // SPOTIFY DEVELOPER API & PREMIUM OAUTH 2.0 CONTROLLER
    // ============================================================================
    const SPOTIFY_CONFIG_FILE = path.join(MEMORY_DIR, "spotify_config.json");
    const SPOTIFY_TOKEN_FILE = path.join(MEMORY_DIR, "spotify_tokens.json");
    let spotifyCallbackServer = null;

    function getSpotifyCredentials() {
      let fileCfg = {};
      try {
        if (fs.existsSync(SPOTIFY_CONFIG_FILE)) {
          fileCfg = JSON.parse(fs.readFileSync(SPOTIFY_CONFIG_FILE, "utf8"));
        }
      } catch {
        // ignore
      }
      return {
        clientId: process.env.SPOTIFY_CLIENT_ID || fileCfg.clientId || "",
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET || fileCfg.clientSecret || "",
        redirectUri: "http://127.0.0.1:8888/callback",
      };
    }

    async function getSpotifyAccessToken() {
      const { clientId, clientSecret } = getSpotifyCredentials();
      if (!clientId || !clientSecret) return { token: null, isUserToken: false };

      // 1. Check saved user OAuth token (for Spotify Premium /v1/me/player/play)
      try {
        if (fs.existsSync(SPOTIFY_TOKEN_FILE)) {
          const saved = JSON.parse(fs.readFileSync(SPOTIFY_TOKEN_FILE, "utf8"));
          if (saved.access_token && saved.expires_at && Date.now() < saved.expires_at - 30000) {
            return { token: saved.access_token, isUserToken: true };
          }
          if (saved.refresh_token) {
            const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
            const resp = await fetch("https://accounts.spotify.com/api/token", {
              method: "POST",
              headers: {
                Authorization: `Basic ${basic}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: saved.refresh_token,
              }),
            });
            if (resp.ok) {
              const data = await resp.json();
              const updated = {
                ...saved,
                access_token: data.access_token,
                refresh_token: data.refresh_token || saved.refresh_token,
                expires_at: Date.now() + (data.expires_in || 3600) * 1000,
              };
              fs.writeFileSync(SPOTIFY_TOKEN_FILE, JSON.stringify(updated, null, 2), "utf8");
              return { token: updated.access_token, isUserToken: true };
            }
          }
        }
      } catch {
        // fall through to client_credentials
      }

      // 2. Client Credentials token (for /v1/search exact Track ID resolution)
      try {
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        const resp = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ grant_type: "client_credentials" }),
        });
        if (resp.ok) {
          const data = await resp.json();
          return { token: data.access_token, isUserToken: false };
        }
      } catch {
        // ignore
      }
      return { token: null, isUserToken: false };
    }

    function startSpotifyOAuthServer() {
      const { clientId, clientSecret, redirectUri } = getSpotifyCredentials();
      if (!clientId || !clientSecret) {
        return {
          ok: false,
          message:
            "Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your environment or memory/spotify_config.json first.",
        };
      }

      if (!spotifyCallbackServer) {
        const http = require("node:http");
        spotifyCallbackServer = http.createServer(async (req, res) => {
          const reqUrl = new URL(req.url, "http://127.0.0.1:8888");
          if (reqUrl.pathname === "/callback") {
            const code = reqUrl.searchParams.get("code");
            if (code) {
              try {
                const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
                const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
                  method: "POST",
                  headers: {
                    Authorization: `Basic ${basic}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: redirectUri,
                  }),
                });
                const tokenData = await tokenResp.json();
                if (tokenData.access_token) {
                  fs.writeFileSync(
                    SPOTIFY_TOKEN_FILE,
                    JSON.stringify(
                      {
                        ...tokenData,
                        expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
                      },
                      null,
                      2
                    ),
                    "utf8"
                  );
                  res.writeHead(200, { "Content-Type": "text/html" });
                  res.end(
                    "<body style='background:#09090b;color:#22d3ee;font-family:sans-serif;text-align:center;padding-top:20%'><h1>J.A.R.V.I.S. // Spotify Premium Connected</h1><p>You can close this tab now, sir.</p></body>"
                  );
                  return;
                }
              } catch {
                // ignore
              }
            }
            res.writeHead(400);
            res.end("Spotify authorization failed.");
          }
        });
        spotifyCallbackServer.listen(8888, "127.0.0.1");
      }

      const scopes =
        "user-modify-playback-state user-read-playback-state user-read-currently-playing streaming";
      const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${encodeURIComponent(
        clientId
      )}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

      const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
      if (fs.existsSync(chromePath)) {
        spawn(chromePath, [authUrl], { detached: true, stdio: "ignore" }).unref();
      } else {
        shell.openExternal(authUrl);
      }
      return { ok: true, message: "Opened Spotify Premium authorization in Chrome." };
    }

    // ============================================================================
// AZURE GLOBE NEWS API (gdelt-timeline-proxy-rk2026) & PROACTIVE TOPIC SENTINEL
// ============================================================================
const GLOBE_NEWS_BASE_URL = "https://gdelt-timeline-proxy-rk2026.azurewebsites.net/api";
const NEWS_WATCHES_FILE = path.join(MEMORY_DIR, "news_watches.json");
const FIRECRAWL_CONFIG_FILE = path.join(MEMORY_DIR, "firecrawl_config.json");
const NEWS_TEMP_CACHE_FILE = path.join(MEMORY_DIR, "news_temp_cache.json");
let cachedGlobeTimeline = { slotKey: "", items: [], fetchedAt: 0 };
let newsWatches = [];
let activeNewsCache = null;

function loadActiveNewsCache() {
  try {
    if (fs.existsSync(NEWS_TEMP_CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(NEWS_TEMP_CACHE_FILE, "utf8"));
      if (parsed && parsed.expiresAt && Date.now() < parsed.expiresAt) {
        activeNewsCache = parsed;
      }
    }
  } catch {
    activeNewsCache = null;
  }
}
loadActiveNewsCache();

function getFirecrawlApiKey() {
  if (process.env.FIRECRAWL_API_KEY) return process.env.FIRECRAWL_API_KEY;
  try {
    if (fs.existsSync(FIRECRAWL_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(FIRECRAWL_CONFIG_FILE, "utf8"));
      return cfg.apiKey || "";
    }
  } catch {
    // ignore
  }
  return "";
}

function cleanFirecrawlMarkdown(rawMd = "") {
  const noImgs = String(rawMd || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ");

  const lines = [];
  for (const rawLine of noImgs.split(/\r?\n/)) {
    const s = rawLine.replace(/\s+/g, " ").trim();
    if (
      s.length >= 50 &&
      !/^(?:edition\b|advertisement\b|skip to\b|follow us\b|sign in\b|subscribe\b|copyright\b|all rights reserved|arrow-down)/i.test(
        s
      ) &&
      !s.startsWith("|")
    ) {
      lines.push(s);
    }
    if (lines.length >= 22) break;
  }
  return lines.join("\n").slice(0, 3200);
}

/**
 * Crawls 2-3 news websites on the given topic in parallel using Firecrawl (/v1/search with markdown scrape)
 * + Azure Globe News, stores the full article bodies in the Temporary News Cache (memory/news_temp_cache.json),
 * and synthesizes a natural "What Happened" story briefing without reading any links/URLs out loud.
 */
async function crawlAndSynthesizeNewsStory(rawTopic = "", languageCode = "en-IN") {
  const { cleanPhrase } = extractSignificantTopicWords(rawTopic);
  const searchTopic = cleanPhrase || "India and World";
  const fcKey = getFirecrawlApiKey();

  const crawledWebsites = [];

  // 1. Crawl top 3 news websites in parallel via Firecrawl API (/v1/search with markdown extraction)
  if (fcKey) {
    try {
      const fcResp = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fcKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `${searchTopic} latest news -site:youtube.com`,
          limit: 3,
          scrapeOptions: {
            formats: ["markdown"],
            onlyMainContent: true,
          },
        }),
      });
      if (fcResp.ok) {
        const fcData = await fcResp.json();
        const items = Array.isArray(fcData?.data) ? fcData.data : [];
        for (const item of items.slice(0, 3)) {
          const cleanBody = cleanFirecrawlMarkdown(item.markdown || item.description || "");
          if (cleanBody || item.title) {
            let domain = "News Source";
            try {
              domain = new URL(item.url).hostname.replace(/^www\./, "");
            } catch {
              // ignore
            }
            crawledWebsites.push({
              title: item.title || searchTopic,
              source: domain,
              url: item.url || "",
              content: cleanBody || item.description || item.title || "",
            });
          }
        }
      }
    } catch {
      // fall through to searchGlobeNews backup
    }
  }

  // 2. Also include Azure Globe News / RSS matches if Firecrawl returned fewer than 2 sites
  if (crawledWebsites.length < 2) {
    const globeHits = await searchGlobeNews(searchTopic);
    for (const h of globeHits.slice(0, 3 - crawledWebsites.length)) {
      crawledWebsites.push({
        title: h.headline,
        source: h.source,
        url: h.url,
        content: `${h.headline} (${h.place}, reported by ${h.source})`,
      });
    }
  }

  if (crawledWebsites.length === 0) {
    return {
      ok: true,
      topic: searchTopic,
      storyBriefing: `Sir, I checked Globe News and crawled live news sources, but there are no breaking stories on "${searchTopic}" right now.`,
      websites: [],
    };
  }

  // 3. Synthesize a vivid 3-4 sentence "What Happened" story across the 2-3 crawled websites!
  const isHindi = languageCode === "hi-IN" || languageCode === "mr-IN";
  const multiSourceContext = crawledWebsites
    .map(
      (w, idx) =>
        `--- WEBSITE ${idx + 1}: ${w.title} (${w.source}) ---\n${w.content.slice(0, 2200)}`
    )
    .join("\n\n");

  const synthesisPrompt = `You are J.A.R.V.I.S., Rakesh's personal AI intelligence officer.
You have just crawled ${crawledWebsites.length} news websites about "${searchTopic}".
Synthesize the facts across all ${crawledWebsites.length} websites into a clear, engaging 3-to-4 sentence "What Happened" story briefing:
1. Explain clearly WHAT happened, WHERE and WHEN it happened, WHO is involved, and the latest update/outcome.
2. Tell it like a natural story ("Sir, here is what happened..." or in Hinglish "Sir, ${searchTopic} को लेकर बड़ी खबर यह है कि...").
3. Language: ${
    isHindi
      ? "Speak in natural conversational Hinglish (Hindi in Devanagari mixed with English words like sir, police, hospital, security, update)."
      : "Speak in crisp, natural English."
  }
4. STRICT RULE: NEVER read any URLs, web links, domain names, or markdown formatting out loud! Plain spoken sentences only.`;

  let storyBriefing = "";

  // Try Vertex AI gemini-2.5-flash (thinkingBudget: 0) first for ultra-fast multi-article synthesis
  try {
    const auth = await getVertexCredentials();
    if (auth.token && auth.project) {
      const endpoint = `https://aiplatform.googleapis.com/v1beta1/projects/${auth.project}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`;
      const vResp = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
          "x-goog-user-project": auth.project,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: synthesisPrompt }] },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Crawled News Websites on "${searchTopic}":\n\n${multiSourceContext}\n\nGive me the 3-4 sentence "What Happened" story briefing now:`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.35,
            maxOutputTokens: 320,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });
      if (vResp.ok) {
        const vData = await vResp.json();
        storyBriefing = (
          vData?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || ""
        )
          .replace(/\[LANG:[a-z]{2}-[A-Z]{2}\]/gi, "")
          .replace(/[*#_`~]+/g, "")
          .trim();
      }
    }
  } catch {
    // fallback to Sarvam sarvam-105b
  }

  if (!storyBriefing) {
    try {
      const sKey = getSarvamKey();
      const sResp = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "api-subscription-key": sKey,
          Authorization: `Bearer ${sKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "sarvam-105b",
          messages: [
            { role: "system", content: synthesisPrompt },
            {
              role: "user",
              content: `Crawled News Websites on "${searchTopic}":\n\n${multiSourceContext}\n\nGive me the 3-4 sentence "What Happened" story briefing now:`,
            },
          ],
          temperature: 0.35,
          max_tokens: 320,
        }),
      });
      if (sResp.ok) {
        const sData = await sResp.json();
        storyBriefing = (sData?.choices?.[0]?.message?.content || "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/[*#_`~]+/g, "")
          .trim();
      }
    } catch {
      // fallback to top article summary
    }
  }

  if (!storyBriefing) {
    const first = crawledWebsites[0];
    storyBriefing = `Sir, here is what happened regarding ${searchTopic}: ${first.title}. ${first.content
      .split("\n")
      .slice(0, 2)
      .join(" ")}`;
  }

  // 4. Save crawled websites + synthesized story in the Temporary News Cache (valid for 30 minutes for follow-up Q&A!)
  activeNewsCache = {
    topic: searchTopic,
    fetchedAt: formatFullTimestamp(new Date()),
    expiresAt: Date.now() + 30 * 60 * 1000,
    storyBriefing,
    websites: crawledWebsites,
  };
  try {
    fs.writeFileSync(NEWS_TEMP_CACHE_FILE, JSON.stringify(activeNewsCache, null, 2), "utf8");
  } catch {
    // ignore
  }

  // Also record primary article URL silently in memory ledger in case user asks "open that article in Chrome"
  if (crawledWebsites[0]?.url) {
    memoryState.addresses[`news:${searchTopic}`] = {
      key: `news:${searchTopic}`,
      toolName: "get_globe_news",
      address: crawledWebsites[0].url,
      summary: storyBriefing,
      agent: "firecrawl-globe-news",
      timestamp: formatFullTimestamp(new Date()),
      isoTimestamp: new Date().toISOString(),
    };
    saveMemoryToDiskAsync();
  }

  return {
    ok: true,
    topic: searchTopic,
    storyBriefing,
    websitesCount: crawledWebsites.length,
    websites: crawledWebsites.map((w) => ({ title: w.title, source: w.source, url: w.url })),
    address: crawledWebsites[0]?.url || "",
    message: storyBriefing,
  };
}

function loadNewsWatches() {
  try {
    if (fs.existsSync(NEWS_WATCHES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(NEWS_WATCHES_FILE, "utf8"));
      if (Array.isArray(raw)) newsWatches = raw;
    }
  } catch {
    newsWatches = [];
  }
}

function saveNewsWatches() {
  try {
    fs.writeFileSync(NEWS_WATCHES_FILE, JSON.stringify(newsWatches, null, 2), "utf8");
  } catch {
    // ignore
  }
}

loadNewsWatches();

function getLatestGdeltSlot(offsetMinutes = 15) {
  const dt = new Date(Date.now() - offsetMinutes * 60 * 1000);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const slotMin = String(Math.floor(dt.getUTCMinutes() / 15) * 15).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${slotMin}` };
}

async function fetchGlobeTimelineSlot() {
  const now = Date.now();
  const slot1 = getLatestGdeltSlot(15);
  const slotKey = `${slot1.date}_${slot1.time}`;
  if (
    cachedGlobeTimeline.slotKey === slotKey &&
    cachedGlobeTimeline.items.length > 0 &&
    now - cachedGlobeTimeline.fetchedAt < 60 * 1000
  ) {
    return cachedGlobeTimeline.items;
  }

  for (const offset of [15, 30, 45]) {
    const s = getLatestGdeltSlot(offset);
    try {
      const url = `${GLOBE_NEWS_BASE_URL}/timeline-news?date=${s.date}&time=${s.time}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const items = await resp.json();
        if (Array.isArray(items) && items.length > 0) {
          cachedGlobeTimeline = {
            slotKey: `${s.date}_${s.time}`,
            items,
            fetchedAt: now,
          };
          return items;
        }
      }
    } catch {
      // try previous 15-min slot
    }
  }
  return cachedGlobeTimeline.items || [];
}

const NEWS_STOPWORDS = new Set([
  "is", "there", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "shall", "should", "may", "might", "must", "can", "could",
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when", "whenever", "where", "why", "how",
  "what", "whats", "which", "who", "whom", "whose", "this", "that", "these", "those",
  "any", "some", "all", "no", "not", "only", "own", "same", "so", "than", "too", "very",
  "in", "on", "at", "by", "for", "with", "about", "against", "between", "into", "through",
  "during", "before", "after", "above", "below", "to", "from", "up", "down", "of", "off", "over", "under",
  "related", "relating", "regarding", "concerning", "connected", "associated", "pertaining",
  "news", "latest", "breaking", "recent", "new", "current", "today", "todays", "update", "updates",
  "headline", "headlines", "story", "stories", "report", "reports", "globe", "tell", "me", "give", "show",
  "inform", "notify", "alert", "watch", "monitor", "comes", "come", "coming", "happening", "going",
  "please", "sir", "jarvis", "hey", "hi", "ok", "okay",
  "क्या", "कोई", "है", "हैं", "में", "पर", "पे", "की", "का", "के", "को", "से", "तो", "अगर", "जब", "भी",
  "खबर", "खबरें", "न्यूज़", "समाचार", "ताज़ा", "आज", "मुझे", "बताना", "बताओ", "सुनाओ",
]);

function extractSignificantTopicWords(rawText = "") {
  const cleaned = String(rawText || "")
    .replace(/['’]s\b/gi, "")
    .replace(/[?!.,;:"'()[\]{}|/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !NEWS_STOPWORDS.has(w.toLowerCase()));

  return {
    cleanPhrase: words.join(" ").trim(),
    keywords: words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3),
  };
}

function escapeRegExpStr(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function searchGlobeNews(topic = "") {
  const { cleanPhrase, keywords } = extractSignificantTopicWords(topic);
  const timelineItems = await fetchGlobeTimelineSlot();

  // If user asked for general global/world news without a specific topic
  if (
    !cleanPhrase ||
    keywords.length === 0 ||
    /^(?:world|global|international|all)$/i.test(cleanPhrase)
  ) {
    return timelineItems.slice(0, 6).map((item) => ({
      id: item.id || item.url,
      headline: item.headline,
      place: item.place || item.country || "Global",
      source: item.source || "Globe News",
      url: item.url,
      origin: "Azure Globe News (GDELT)",
    }));
  }

  // 1. Search Azure Globe News GDELT 15-minute slot using WHOLE-WORD matching (ALL keywords must match)
  const wordRegexes = keywords.map((kw) => new RegExp(`\\b${escapeRegExpStr(kw)}\\b`, "i"));
  const matched = [];

  for (const item of timelineItems) {
    const hay = `${item.headline || ""} ${item.place || ""}`;
    // Require ALL topic keywords to appear as whole words in the headline or place
    if (wordRegexes.every((rx) => rx.test(hay))) {
      matched.push({
        id: item.id || item.url,
        headline: item.headline,
        place: item.place || item.country || cleanPhrase,
        source: item.source || "Globe News",
        url: item.url,
        origin: "Azure Globe News (GDELT)",
      });
    }
  }

  // 2. Query real-time topic news stream for exact phrase / person / subject if GDELT 15-min window didn't have it
  if (matched.length < 3) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
        cleanPhrase
      )}&hl=en-IN&gl=IN&ceid=IN:en`;
      const rssResp = await fetch(rssUrl);
      if (rssResp.ok) {
        const xml = await rssResp.text();
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = itemRegex.exec(xml)) !== null && matched.length < 6) {
          const block = m[1];
          const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
          const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
          const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          if (titleMatch) {
            const rawTitle = titleMatch[1]
              .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
              .replace(/&amp;/g, "&")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+-\s+[^-]+$/, "")
              .trim();
            const link = linkMatch ? linkMatch[1].trim() : "";
            const src = sourceMatch ? sourceMatch[1].trim() : "Globe News Feed";
            // Verify at least one significant topic keyword appears in the headline
            if (wordRegexes.some((rx) => rx.test(rawTitle)) || matched.length === 0) {
              matched.push({
                id: link || rawTitle,
                headline: rawTitle,
                place: cleanPhrase,
                source: src,
                url: link,
                origin: "Globe News Live Topic Stream",
              });
            }
          }
        }
      }
    } catch {
      // ignore fallback error
    }
  }

  return matched.slice(0, 6);
}

async function checkNewsWatchesAndNotify(specificWatchId = null) {
  if (!mainWindow || newsWatches.length === 0) return;

  for (const watch of newsWatches) {
    if (specificWatchId && watch.id !== specificWatchId) continue;
    try {
      const articles = await searchGlobeNews(watch.topic);
      if (!articles || articles.length === 0) continue;

      const unseen = articles.find((a) => !watch.seenIds.includes(a.id));
      if (unseen) {
        watch.seenIds.push(unseen.id);
        if (watch.seenIds.length > 100) watch.seenIds = watch.seenIds.slice(-100);
        watch.lastNotifiedAt = formatFullTimestamp(new Date());
        saveNewsWatches();

        // Save article URL into persistent memory address ledger so user can say "Open that news article"
        if (unseen.url) {
          memoryState.addresses[`news:${watch.topic}`] = {
            key: `news:${watch.topic}`,
            toolName: "get_globe_news",
            address: unseen.url,
            summary: `Breaking Globe News on "${watch.topic}": ${unseen.headline}`,
            agent: "globe-news",
            timestamp: formatFullTimestamp(new Date()),
            isoTimestamp: new Date().toISOString(),
          };
          saveMemoryToDiskAsync();
        }

        // Crawl 2-3 websites via Firecrawl & cache the full story so the proactive alert tells the full 'What Happened' story and supports follow-up questions!
        const crawledStory = await crawlAndSynthesizeNewsStory(
          watch.topic,
          watch.languageCode || "en-IN"
        );

        mainWindow.webContents.send("jarvis:newsAlert", {
          watchId: watch.id,
          topic: watch.topic,
          headline: crawledStory?.storyBriefing || unseen.headline,
          place: unseen.place,
          source: unseen.source,
          url: unseen.url,
          languageCode: watch.languageCode || "en-IN",
        });
        break;
      }
    } catch {
      // ignore single watch error
    }
  }
}

// Poll watched Globe News topics every 60 seconds in the background
setInterval(() => {
  checkNewsWatchesAndNotify().catch(() => {});
}, 60 * 1000);

async function getVertexCredentials() {
    const now = Date.now();
    if (cachedVertexAuth.token && now < cachedVertexAuth.expiresAt) {
    return cachedVertexAuth;
    }
    const tokenRes = await runPowerShell("gcloud auth print-access-token", 8000);
    const projRes = await runPowerShell("gcloud config get-value project", 5000);
    if (tokenRes.ok && tokenRes.stdout) {
    cachedVertexAuth = {
      token: tokenRes.stdout.split(String.fromCharCode(10)).pop().trim(),
      project: (projRes.stdout || "rakesh-lab-506212").split(String.fromCharCode(10)).pop().trim() || "rakesh-lab-506212",
      model: process.env.GEMINI_MODEL || "gemini-4-argon",
      expiresAt: now + 45 * 60 * 1000,
    };
    return cachedVertexAuth;
    }
  return { token: null, project: "rakesh-lab-506212", model: process.env.GEMINI_MODEL || "gemini-4-argon" };
}

function createTrayIcon() {
  // Create a glowing cyan 16x16 tray icon programmatically
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (d <= 6.8) {
        const edge = Math.max(0, 1 - d / 6.8);
        // BGRA format for Windows nativeImage
        buf[idx] = 255; // B
        buf[idx + 1] = Math.round(210 * edge + 45); // G
        buf[idx + 2] = Math.round(60 * edge); // R
        buf[idx + 3] = 255; // A
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createMainWindow() {
  Menu.setApplicationMenu(null);
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.workAreaSize;
  const orbWindowSize = 320;

  mainWindow = new BrowserWindow({
    width: orbWindowSize,
    height: orbWindowSize,
    x: Math.round((sw - orbWindowSize) / 2),
    y: Math.round(sh - orbWindowSize + 10),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    title: "",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.on("will-resize", (e) => e.preventDefault());
  mainWindow.on("page-title-updated", (e) => e.preventDefault());

  // Permanently clip the window to a clean circle (x: 24..296, y: 38..310) ONCE at startup
  // so Windows DWM can NEVER draw a top titlebar strip at y=0..37, while CSS handles all animations at 120fps!
  const applyCleanCircleClip = () => {
    if (!mainWindow) return;
    try {
      const hwndBuf = mainWindow.getNativeWindowHandle();
      const hwndVal =
        hwndBuf.length >= 8 ? Number(hwndBuf.readBigInt64LE(0)) : hwndBuf.readInt32LE(0);
      const clipCmd = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinClip {
  [DllImport("gdi32.dll")] public static extern IntPtr CreateEllipticRgn(int l, int t, int r, int b);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
}
"@
$rgn = [WinClip]::CreateEllipticRgn(24, 38, 296, 310)
[void][WinClip]::SetWindowRgn([IntPtr]${hwndVal}, $rgn, $true)
`;
      runPowerShell(clipCmd, 3000);
    } catch {
      // ignore
    }
  };
  applyCleanCircleClip();
  mainWindow.webContents.on("did-finish-load", applyCleanCircleClip);

  // Auto-grant microphone, camera, and screen capture permissions
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ["media", "microphone", "camera", "display-capture", "AudioCapture", "notifications"];
    callback(allowed.includes(permission));
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const distIndex = path.join(__dirname, "..", "dist", "index.html");

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl).catch(() => {
      if (fs.existsSync(distIndex)) {
        mainWindow.loadFile(distIndex);
      }
    });
  } else if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }

  // Create System Tray
  try {
    tray = new Tray(createTrayIcon());
    tray.setToolTip("J.A.R.V.I.S. — Hey Jarvis Wake Word Active");
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Summon J.A.R.V.I.S. (Alt+Space)",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send("jarvis:summon", { trigger: "tray" });
          }
        },
      },
      {
        label: "Toggle Mini Floating Orb",
        click: () => {
          toggleMiniMode(!isMiniMode);
        },
      },
      { type: "separator" },
      {
        label: "Quit J.A.R.V.I.S.",
        click: () => app.quit(),
      },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on("click", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch {
    // ignore tray error in headless environments
  }
}

function toggleMiniMode(enabled) {
  if (!mainWindow) return false;
  isMiniMode = Boolean(enabled);
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.workAreaSize;

  if (isMiniMode) {
    const current = mainWindow.getBounds();
    if (current.width > 500) {
      savedBounds = current;
    }
    const miniW = 360;
    const miniH = 430;
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.setBounds({
      x: sw - miniW - 24,
      y: sh - miniH - 24,
      width: miniW,
      height: miniH,
    });
  } else {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setBounds(savedBounds);
    mainWindow.center();
  }
  return isMiniMode;
}

// IPC Handlers
ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow?.close());
ipcMain.handle("window:setMiniMode", (_e, enabled) => toggleMiniMode(enabled));
ipcMain.handle("window:setAlwaysOnTop", (_e, enabled) => {
  mainWindow?.setAlwaysOnTop(Boolean(enabled), "screen-saver");
  return Boolean(enabled);
});

ipcMain.handle("window:setOrbVisible", (_e, visible) => {
  if (!mainWindow) return false;
  const show = Boolean(visible);
  try {
    if (show) {
      mainWindow.setAlwaysOnTop(true, "screen-saver");
    }
  } catch {
    // ignore
  }
  return show;
});

// Wake Word IPC
ipcMain.handle("wakeword:status", () => wakeStatus);
ipcMain.handle("wakeword:pcm", (_e, base64Pcm) => sendWakeCommand({ cmd: "pcm", data: base64Pcm }, 1500));
ipcMain.handle("wakeword:testPhrase", (_e, phrase) =>
  sendWakeCommand({ cmd: "test_phrase", phrase: phrase || "Hey Jarvis" }, 8000)
);
ipcMain.handle("wakeword:reset", () => sendWakeCommand({ cmd: "reset" }, 2000));

// System Telemetry
let lastCpuInfo = os.cpus();
function getCpuUsagePercent() {
  const current = os.cpus();
  let idleDiff = 0;
  let totalDiff = 0;
  for (let i = 0; i < current.length; i++) {
    const prev = lastCpuInfo[i] || current[i];
    const cur = current[i];
    const prevTotal = Object.values(prev.times).reduce((a, b) => a + b, 0);
    const curTotal = Object.values(cur.times).reduce((a, b) => a + b, 0);
    totalDiff += curTotal - prevTotal;
    idleDiff += cur.times.idle - prev.times.idle;
  }
  lastCpuInfo = current;
  if (totalDiff <= 0) return 12;
  return Math.max(1, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}

ipcMain.handle("system:telemetry", async () => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpuPercent = getCpuUsagePercent();

  // Query active window title & battery quickly via PowerShell
  const ps = `
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  using System.Text;
  public class Win32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  }
"@
$h = [Win32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[void][Win32]::GetWindowText($h, $sb, 256)
$bat = (Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1)
$disk = Get-PSDrive C -ErrorAction SilentlyContinue
@{
  activeWindow = $sb.ToString()
  batteryPercent = if ($bat) { $bat.EstimatedChargeRemaining } else { 100 }
  isCharging = if ($bat) { $bat.BatteryStatus -ne 1 } else { $true }
  diskUsedGb = if ($disk) { [math]::Round($disk.Used / 1GB, 1) } else { 0 }
  diskFreeGb = if ($disk) { [math]::Round($disk.Free / 1GB, 1) } else { 0 }
} | ConvertTo-Json -Compress
`;
  const psRes = await runPowerShell(ps, 3500);
  let extra = {
    activeWindow: "J.A.R.V.I.S. Neural Interface",
    batteryPercent: 100,
    isCharging: true,
    diskUsedGb: 120,
    diskFreeGb: 380,
  };
  if (psRes.ok && psRes.stdout) {
    try {
      extra = { ...extra, ...JSON.parse(psRes.stdout) };
    } catch {
      // ignore parse error
    }
  }

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: os.cpus()[0]?.model || "Windows x64 Processor",
    cpuCores: os.cpus().length,
    cpuPercent,
    ramUsedGb: Number((usedMem / 1024 ** 3).toFixed(1)),
    ramTotalGb: Number((totalMem / 1024 ** 3).toFixed(1)),
    ramPercent: Math.round((usedMem / totalMem) * 100),
    uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
    ...extra,
  };
});

// Screen Vision Capture
ipcMain.handle("system:captureScreen", async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (sources.length > 0) {
      return {
        ok: true,
        dataUrl: sources[0].thumbnail.toDataURL(),
        name: sources[0].name,
      };
    }
  } catch {
    // fallback to PowerShell screen capture
  }

  const psCapture = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`;
  const res = await runPowerShell(psCapture, 6000);
  if (res.ok && res.stdout) {
    return {
      ok: true,
      dataUrl: `data:image/jpeg;base64,${res.stdout.trim()}`,
      name: "Primary Display",
    };
  }
  return { ok: false, error: res.error || "Unable to capture screen" };
});

// Windows System, Web, Vision & Productivity Tools
ipcMain.handle("system:executeTool", async (_e, { toolName, args = {} }) => {
  switch (toolName) {
    case "launch_app": {
      const target = String(args.app || "").trim();
      if (!target) return { ok: false, message: "No application specified." };
      const map = {
        notepad: "notepad.exe",
        calculator: "calc.exe",
        calc: "calc.exe",
        explorer: "explorer.exe",
        "file explorer": "explorer.exe",
        terminal: "wt.exe",
        powershell: "powershell.exe",
        cmd: "cmd.exe",
        vscode: "code",
        "vs code": "code",
        code: "code",
        chrome: "chrome",
        edge: "msedge",
        browser: "chrome",
        youtube: "https://www.youtube.com",
        settings: "ms-settings:",
        "task manager": "taskmgr.exe",
        taskmgr: "taskmgr.exe",
        paint: "mspaint.exe",
        spotify: "spotify:",
      };
      const resolved = map[target.toLowerCase()] || target;
      if (resolved.endsWith(":") || resolved.startsWith("http://") || resolved.startsWith("https://")) {
        await shell.openExternal(resolved);
        return { ok: true, message: `Opened ${target}` };
      }
      const res = await runPowerShell(`Start-Process "${resolved.replace(/"/g, "")}"`, 5000);
      return {
        ok: res.ok,
        message: res.ok ? `Launched ${target} (${resolved})` : `Failed to launch ${target}: ${res.stderr || res.error}`,
      };
    }

    case "play_youtube": {
      const query = String(args.query || "").trim();
      if (!query) return { ok: false, message: "No song or video specified." };
      try {
        const resolved = await resolveSongViaYouTubeAPI(query);
        const targetUrl = resolved.videoId
          ? `https://www.youtube.com/watch?v=${resolved.videoId}&autoplay=1`
          : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

        const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        if (fs.existsSync(chromePath)) {
          spawn(chromePath, [targetUrl], { detached: true, stdio: "ignore" }).unref();
        } else {
          await shell.openExternal(targetUrl);
        }
        return {
          ok: true,
          query,
          officialSongName: resolved.officialSongName,
          officialArtist: resolved.officialArtist,
          url: targetUrl,
          address: targetUrl,
          message: `Playing "${resolved.officialSongName}"${resolved.officialArtist ? " by " + resolved.officialArtist : ""} on YouTube in Chrome.`,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "play_spotify": {
      const rawLyricsOrQuery = String(args.query || args.lyrics || "").trim();
      if (!rawLyricsOrQuery) return { ok: false, message: "No lyrics or song specified." };

      try {
        // Step 1: Resolve lyrics / hummed phrase via GCP YouTube Data API v3 -> Official Song Name & Artist
        const resolved = await resolveSongViaYouTubeAPI(rawLyricsOrQuery);
        const spotifyQuery = resolved.spotifySearchQuery;

        // Step 2: Query Spotify Developer API (/v1/search) for exact Spotify Track URI (spotify:track:<id>)
        const { token, isUserToken } = await getSpotifyAccessToken();
        let trackUri = null;
        let trackId = null;
        let trackTitle = resolved.officialSongName;
        let trackArtist = resolved.officialArtist;

        if (token) {
          const sResp = await fetch(
            `https://api.spotify.com/v1/search?type=track&market=IN&limit=1&q=${encodeURIComponent(spotifyQuery)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (sResp.ok) {
            const sData = await sResp.json();
            const track = sData?.tracks?.items?.[0];
            if (track) {
              trackUri = track.uri;
              trackId = track.id;
              trackTitle = track.name || trackTitle;
              trackArtist = track.artists?.map((a) => a.name).join(", ") || trackArtist;
            }
          }

          // Step 3A: If authenticated with Spotify Premium user token, play via /v1/me/player/play on the Windows PC device
          if (isUserToken && trackUri) {
            // Ensure Windows Spotify app is running
            const procCheck = await runPowerShell(
              '(Get-Process -Name Spotify -ErrorAction SilentlyContinue) -ne $null',
              2500
            );
            if (procCheck.stdout !== "True") {
              await shell.openExternal("spotify:");
              await new Promise((r) => setTimeout(r, 2200));
            }

            // Find active or available Windows device ID
            let deviceParam = "";
            try {
              const devResp = await fetch("https://api.spotify.com/v1/me/player/devices", {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (devResp.ok) {
                const devData = await devResp.json();
                const devices = devData?.devices || [];
                const activeDev = devices.find((d) => d.is_active) || devices[0];
                if (activeDev?.id) {
                  deviceParam = `?device_id=${encodeURIComponent(activeDev.id)}`;
                }
              }
            } catch {
              // ignore
            }

            const playResp = await fetch(
              `https://api.spotify.com/v1/me/player/play${deviceParam}`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ uris: [trackUri] }),
              }
            );
            if (playResp.status === 204 || playResp.ok) {
              return {
                ok: true,
                officialSongName: trackTitle,
                officialArtist: trackArtist,
                address: trackUri,
                message: `Identified "${trackTitle}" by ${trackArtist} via YouTube and playing it on your Windows Spotify app.`,
              };
            }
          }
        }

        // Step 3B: Open directly in the native Windows Spotify Desktop App via spotify:track:<id> URI and trigger playback!
        const nativeUri = trackUri || `spotify:search:${encodeURIComponent(spotifyQuery)}`;
        await shell.openExternal(nativeUri);

        // Wait briefly for the Windows Spotify Desktop App to focus the track, then press Enter to start playback immediately
        const autoPlayPs = `
Start-Sleep -Milliseconds 1400
$wshell = New-Object -ComObject WScript.Shell
if ($wshell.AppActivate("Spotify")) {
  Start-Sleep -Milliseconds 250
  $wshell.SendKeys("~")
}
`;
        runPowerShell(autoPlayPs, 4000);

        return {
          ok: true,
          inputLyrics: rawLyricsOrQuery,
          youtubeMatch: resolved.youtubeTitle,
          officialSongName: trackTitle,
          officialArtist: trackArtist,
          address: nativeUri,
          message: `Found official song "${trackTitle}"${trackArtist ? " by " + trackArtist : ""} via YouTube and playing it in your Windows Spotify app.`,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "connect_spotify": {
      if (args.clientId && args.clientSecret) {
        fs.writeFileSync(
          SPOTIFY_CONFIG_FILE,
          JSON.stringify({ clientId: args.clientId, clientSecret: args.clientSecret }, null, 2),
          "utf8"
        );
      }
      return startSpotifyOAuthServer();
    }

    case "close_app": {
      const procName = String(args.processName || "").replace(/\.exe$/i, "").replace(/[^a-zA-Z0-9_-]/g, "");
      if (!procName) return { ok: false, message: "Invalid process name." };
      const res = await runPowerShell(`Stop-Process -Name "${procName}" -ErrorAction Stop`, 5000);
      return {
        ok: res.ok,
        message: res.ok ? `Terminated ${procName}` : `Could not close ${procName}: ${res.stderr || res.error}`,
      };
    }

    case "set_volume": {
      const action = args.action || "set";
      const level = Math.max(0, Math.min(100, Number(args.level ?? 50)));
      if (action === "mute" || action === "unmute") {
        await runPowerShell(
          `$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]173)`,
          3000
        );
        return { ok: true, message: `Toggled system audio mute.` };
      }
      // Set exact master volume via Windows CoreAudio COM interface or key steps
      const steps = Math.round(level / 2);
      const psVol = `
$w = New-Object -ComObject WScript.Shell
1..50 | ForEach-Object { $w.SendKeys([char]174) }
1..${steps} | ForEach-Object { $w.SendKeys([char]175) }
`;
      await runPowerShell(psVol, 5000);
      return { ok: true, message: `System master volume set to ${level}%.` };
    }

    case "media_control": {
      const cmd = String(args.command || "play_pause").toLowerCase();

      // 1. Try Spotify Premium Web API first if user OAuth token is connected
      try {
        const { token, isUserToken } = await getSpotifyAccessToken();
        if (isUserToken && token) {
          if (cmd === "pause" || cmd === "stop") {
            const r = await fetch("https://api.spotify.com/v1/me/player/pause", {
              method: "PUT",
              headers: { Authorization: `Bearer ${token}` },
            });
            if (r.status === 204 || r.ok) {
              return { ok: true, message: "Paused Spotify playback." };
            }
          } else if (cmd === "play" || cmd === "resume") {
            const r = await fetch("https://api.spotify.com/v1/me/player/play", {
              method: "PUT",
              headers: { Authorization: `Bearer ${token}` },
            });
            if (r.status === 204 || r.ok) {
              return { ok: true, message: "Resumed Spotify playback." };
            }
          } else if (cmd === "next") {
            const r = await fetch("https://api.spotify.com/v1/me/player/next", {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
            });
            if (r.status === 204 || r.ok) {
              return { ok: true, message: "Skipped to next Spotify track." };
            }
          } else if (cmd === "previous") {
            const r = await fetch("https://api.spotify.com/v1/me/player/previous", {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
            });
            if (r.status === 204 || r.ok) {
              return { ok: true, message: "Returned to previous Spotify track." };
            }
          }
        }
      } catch {
        // fall through to Windows OS Media Keys
      }

      // 2. Native Windows OS Media Keys (controls Windows Spotify Desktop App & system media)
      const keyMap = {
        play_pause: 179,
        play: 179,
        resume: 179,
        pause: 179,
        next: 176,
        previous: 177,
        stop: 179,
      };
      const charCode = keyMap[cmd] || 179;
      await runPowerShell(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]${charCode})`, 3000);
      return { ok: true, message: `Executed media control: ${cmd}` };
    }

    case "lock_workstation": {
      await runPowerShell(`rundll32.exe user32.dll,LockWorkStation`, 3000);
      return { ok: true, message: "Workstation locked." };
    }

    case "get_globe_news": {
      const topic = String(args.topic || args.query || "").trim();
      const lang = String(args.languageCode || "en-IN");
      try {
        return await crawlAndSynthesizeNewsStory(topic, lang);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "watch_news_topic": {
      const topic = String(args.topic || args.query || "").trim();
      const languageCode = String(args.languageCode || "en-IN");
      if (!topic) return { ok: false, message: "No news topic specified to watch." };

      // Remove existing duplicate watch for same topic if present
      newsWatches = newsWatches.filter((w) => w.topic.toLowerCase() !== topic.toLowerCase());

      const newWatch = {
        id: `watch-${Date.now()}`,
        topic,
        languageCode,
        seenIds: [],
        createdAt: formatFullTimestamp(new Date()),
      };
      newsWatches.push(newWatch);
      saveNewsWatches();

      // Trigger first live Azure Globe News scan 9 seconds after user's command finishes
      // so the orb proactively blooms and informs the user as soon as a matching story is found!
      setTimeout(() => {
        checkNewsWatchesAndNotify(newWatch.id).catch(() => {});
      }, 9500);

      return {
        ok: true,
        topic,
        watchId: newWatch.id,
        message: `Monitoring Azure Globe News 24/7 for "${topic}". I will proactively alert you the moment news breaks on "${topic}".`,
      };
    }

    case "unwatch_news_topic": {
      const topic = String(args.topic || "").trim().toLowerCase();
      if (!topic || topic === "all") {
        newsWatches = [];
      } else {
        newsWatches = newsWatches.filter((w) => !w.topic.toLowerCase().includes(topic));
      }
      saveNewsWatches();
      return {
        ok: true,
        message: topic ? `Stopped watching news alerts for "${topic}".` : "Cleared all Globe News watches.",
      };
    }

    case "web_search": {
      const query = String(args.query || "").trim();
      if (!query) return { ok: false, results: [] };
      try {
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const resp = await fetch(ddgUrl);
        const data = await resp.json();
        const results = [];
        if (data.AbstractText) {
          results.push({
            title: data.Heading || query,
            snippet: data.AbstractText,
            url: data.AbstractURL || "",
          });
        }
        if (Array.isArray(data.RelatedTopics)) {
          for (const topic of data.RelatedTopics.slice(0, 5)) {
            if (topic.Text && topic.FirstURL) {
              results.push({
                title: topic.Text.split(" - ")[0] || "Result",
                snippet: topic.Text,
                url: topic.FirstURL,
              });
            }
          }
        }
        // Fallback to Wikipedia OpenSearch if DuckDuckGo Instant Answer is sparse
        if (results.length < 2) {
          const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&srlimit=4`;
          const wResp = await fetch(wikiUrl);
          const wData = await wResp.json();
          for (const item of wData?.query?.search || []) {
            results.push({
              title: item.title,
              snippet: item.snippet.replace(/<[^>]+>/g, ""),
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
            });
          }
        }
        return { ok: true, query, results };
      } catch (err) {
        return { ok: false, error: err.message, results: [] };
      }
    }

    case "get_weather": {
      const city = String(args.location || "New York").trim();
      try {
        const geoResp = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
        );
        const geoData = await geoResp.json();
        const loc = geoData?.results?.[0] || {
          name: city,
          country: "",
          latitude: 37.7749,
          longitude: -122.4194,
        };
        const weatherResp = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code`
        );
        const wData = await weatherResp.json();
        return {
          ok: true,
          location: `${loc.name}${loc.country ? ", " + loc.country : ""}`,
          current: wData.current,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "run_command": {
      const command = String(args.command || "").trim();
      if (!command) return { ok: false, error: "Empty command" };
      const res = await runPowerShell(command, 10000);
      return {
        ok: res.ok,
        command,
        stdout: res.stdout.slice(0, 4000),
        stderr: res.stderr.slice(0, 2000),
      };
    }

    case "clipboard_read": {
      return { ok: true, text: clipboard.readText() };
    }

    case "clipboard_write": {
      clipboard.writeText(String(args.text || ""));
      return { ok: true, message: "Copied text to Windows clipboard." };
    }

    case "sarvam_translate": {
      const key = args.apiKey || process.env.SARVAM_API_KEY || "";
      if (!key) return { ok: false, message: "SARVAM_API_KEY not configured." };
      try {
        const resp = await fetch("https://api.sarvam.ai/translate", {
          method: "POST",
          headers: {
            "api-subscription-key": key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: String(args.text || ""),
            source_language_code: args.source_language_code || "en-IN",
            target_language_code: args.target_language_code || "hi-IN",
            model: "mayura:v1",
          }),
        });
        const data = await resp.json();
        return {
          ok: resp.ok,
          translatedText: data.translated_text || "",
          message: data.translated_text || "Translation complete.",
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "open_address": {
      const address = String(args.address || "").trim();
      const openIn = String(args.openIn || "chrome").toLowerCase();
      if (!address) return { ok: false, message: "No address provided." };

      if (openIn === "vscode" || openIn === "code") {
        await runPowerShell(`code "${address.replace(/"/g, "")}"`, 5000);
        return { ok: true, address, message: `Opened ${address} in VS Code.` };
      }
      if (openIn === "explorer") {
        await runPowerShell(`explorer.exe "${address.replace(/"/g, "")}"`, 5000);
        return { ok: true, address, message: `Opened ${address} in File Explorer.` };
      }
      const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
      if (fs.existsSync(chromePath)) {
        spawn(chromePath, [address], { detached: true, stdio: "ignore" }).unref();
      } else {
        await shell.openExternal(address);
      }
      return { ok: true, address, message: `Opened ${address} in Chrome.` };
    }

    case "coding_agent": {
      const agent = String(args.agent || "gemini").toLowerCase().includes("codex") ? "codex" : "gemini";
      const rawName = String(args.projectName || "jarvis-web-app")
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "") || `project-${Date.now()}`;
      const taskPrompt = String(args.prompt || "Build a modern, responsive, visually stunning website in index.html").trim();

      const projectDir = args.existingAddress && fs.existsSync(args.existingAddress)
        ? args.existingAddress
        : path.join(PROJECTS_DIR, rawName);

      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }
      const indexHtmlPath = path.join(projectDir, "index.html");
      const startedAt = formatFullTimestamp(new Date());

      // Register in persistent address ledger immediately so Jarvis knows its exact address
      memoryState.addresses[rawName] = {
        key: rawName,
        toolName: "coding_agent",
        address: indexHtmlPath,
        projectDir,
        summary: `${agent.toUpperCase()} CLI project "${rawName}": ${taskPrompt}`,
        agent,
        timestamp: startedAt,
        isoTimestamp: new Date().toISOString(),
      };
      saveMemoryToDiskAsync();

      // Dispatch Gemini CLI or Codex CLI asynchronously in the project directory
      const fullCliPrompt = `${taskPrompt}. IMPORTANT: Create a complete, self-contained, modern, interactive, production-quality implementation inside "${projectDir}" with an "index.html" entry file (using Tailwind CDN, modern animations, and rich interactivity) so it can be opened directly in Chrome. Do not ask questions; write all files directly.`;

      const runCliInBackground = () => {
        const geminiCmd = "C:\\Users\\ADMIN\\AppData\\Roaming\\npm\\gemini.cmd";
        const codexCmd = fs.existsSync("C:\\Users\\ADMIN\\AzureCodex\\codex.cmd")
          ? "C:\\Users\\ADMIN\\AzureCodex\\codex.cmd"
          : "C:\\Users\\ADMIN\\AppData\\Roaming\\npm\\codex.cmd";

        const cmdExe = agent === "codex" ? codexCmd : geminiCmd;
        const cmdArgs =
          agent === "codex"
            ? ["exec", "--full-auto", fullCliPrompt]
            : ["--yolo", "-p", fullCliPrompt];

        const child = spawn("cmd.exe", ["/c", cmdExe, ...cmdArgs], {
          cwd: projectDir,
          windowsHide: true,
          env: { ...process.env },
        });

        child.on("close", () => {
          const completedAt = formatFullTimestamp(new Date());
          const targetToOpen = fs.existsSync(indexHtmlPath) ? indexHtmlPath : projectDir;
          const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
          if (fs.existsSync(indexHtmlPath) && fs.existsSync(chromePath)) {
            spawn(chromePath, [indexHtmlPath], { detached: true, stdio: "ignore" }).unref();
          }
          memoryState.addresses[rawName] = {
            ...memoryState.addresses[rawName],
            address: targetToOpen,
            summary: `Completed by ${agent.toUpperCase()} CLI at ${completedAt}: ${taskPrompt}`,
            timestamp: completedAt,
          };
          saveMemoryToDiskAsync();

          if (mainWindow) {
            mainWindow.webContents.send("jarvis:agentComplete", {
              agent,
              projectName: rawName,
              projectDir,
              address: targetToOpen,
              completedAt,
              prompt: taskPrompt,
            });
          }
        });
      };

      runCliInBackground();

      return {
        ok: true,
        agent,
        projectName: rawName,
        projectDir,
        address: indexHtmlPath,
        startedAt,
        message: `Dispatched ${agent.toUpperCase()} CLI to build "${rawName}". It will open automatically in Chrome when finished.`,
      };
    }

    default:
      return { ok: false, message: `Unknown tool: ${toolName}` };
  }
});

// Multi-Provider AI Chat & Vertex AI + Sarvam AI Bridge
ipcMain.handle("memory:recordTurn", (_e, entry) => {
  return recordMemoryTurn(entry);
});

ipcMain.handle("memory:query", (_e, queryText) => {
  return queryMemoryFast(queryText);
});

ipcMain.handle("ai:vertexAuth", async () => {
  return await getVertexCredentials();
});

ipcMain.handle("sarvam:status", () => {
  const envKey = process.env.SARVAM_API_KEY || "";
  return {
    configured: Boolean(envKey),
    sttModel: "saaras:v3",
    ttsModel: "bulbul:v3",
    llmModel: "sarvam-105b",
    mcpServerPath: path.join(__dirname, "sarvam_mcp_server.py"),
  };
});

// Helper: Low-latency (~68ms) Sarvam WebSocket STT via saaras:v3 with auto language detection & code-mix
function transcribeViaSarvamWebSocket(wavBase64, apiKey, languageCode = "auto") {
  return new Promise((resolve) => {
    const key = apiKey || process.env.SARVAM_API_KEY || "";
    if (!key || !wavBase64) {
      resolve({ ok: false, text: "", languageCode: "en-IN" });
      return;
    }

    const langParam =
      !languageCode || languageCode === "auto" || languageCode === "unknown"
        ? "unknown"
        : languageCode;

    const url = `wss://api.sarvam.ai/speech-to-text/ws?language-code=${encodeURIComponent(
      langParam
    )}&model=saaras:v3&mode=codemix&vad_signals=true&flush_signal=true`;

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const ws = new WebSocket(url, {
      headers: { "api-subscription-key": key },
    });

    const timer = setTimeout(() => {
      finish({ ok: true, text: "", languageCode: "en-IN", engine: "sarvam-saaras:v3-ws", latencyMs: 0 });
    }, 4500);

    ws.on("open", () => {
      try {
        ws.send(
          JSON.stringify({
            audio: {
              data: wavBase64,
              sample_rate: "16000",
              encoding: "audio/wav",
            },
          })
        );
        ws.send(JSON.stringify({ type: "flush" }));
      } catch (err) {
        finish({ ok: false, text: "", languageCode: "en-IN", error: err.message });
      }
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "events" && mainWindow) {
          mainWindow.webContents.send("sarvam:sttEvent", {
            type: msg.data?.signal_type,
            occuredAt: msg.data?.occured_at,
          });
        } else if (msg.type === "data") {
          const transcript = (msg.data?.transcript || "").trim();
          const detectedLang = msg.data?.language_code || "en-IN";
          const latencyMs = Math.round((msg.data?.metrics?.processing_latency || 0.068) * 1000);
          if (mainWindow) {
            mainWindow.webContents.send("sarvam:sttEvent", {
              type: "TRANSCRIPT",
              text: transcript,
              latencyMs,
              languageCode: detectedLang,
            });
          }
          finish({
            ok: true,
            text: transcript,
            languageCode: detectedLang,
            engine: "sarvam-saaras:v3-ws",
            latencyMs,
          });
        } else if (msg.type === "error") {
          finish({ ok: false, text: "", languageCode: "en-IN", error: JSON.stringify(msg.data || msg) });
        }
      } catch {
        // ignore parse error
      }
    });

    ws.on("error", (err) => {
      finish({ ok: false, text: "", languageCode: "en-IN", error: err.message });
    });
  });
}

// Persistent Live Streaming Sarvam STT WebSocket Session (with auto-reconnect on early empty/wake-only frame)
let activeSarvamSttWs = null;
let sttPendingChunks = [];
let sarvamSttSessionActive = false;
let sarvamSttConfig = { key: "", lang: "unknown" };

function openSarvamSttSocket() {
  if (!sarvamSttSessionActive || !sarvamSttConfig.key) return;
  if (activeSarvamSttWs) {
    try {
      activeSarvamSttWs.close();
    } catch {
      // ignore
    }
    activeSarvamSttWs = null;
  }

  const url = `wss://api.sarvam.ai/speech-to-text/ws?language-code=${encodeURIComponent(
    sarvamSttConfig.lang
  )}&model=saaras:v3&mode=codemix&vad_signals=true&flush_signal=true`;

  const ws = new WebSocket(url, { headers: { "api-subscription-key": sarvamSttConfig.key } });
  activeSarvamSttWs = ws;

  ws.on("open", () => {
    if (activeSarvamSttWs !== ws) return;
    while (sttPendingChunks.length > 0 && ws.readyState === WebSocket.OPEN) {
      const msgStr = sttPendingChunks.shift();
      ws.send(msgStr);
    }
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "events" && mainWindow) {
        mainWindow.webContents.send("sarvam:sttEvent", {
          type: msg.data?.signal_type,
          occuredAt: msg.data?.occured_at,
        });
      } else if (msg.type === "data" && mainWindow) {
        const transcript = (msg.data?.transcript || "").trim();
        const cleaned = transcript
          .replace(/^(?:hey\s+jarvis|hi\s+jarvis|ok\s+jarvis|jarvis|हे\s+जार्विस|जार्विस|जर्विस)[,!.?\s]*/i, "")
          .trim();
        const latencyMs = Math.round((msg.data?.metrics?.processing_latency || 0.055) * 1000);

        if (cleaned.length >= 2) {
          sarvamSttSessionActive = false;
          mainWindow.webContents.send("sarvam:sttEvent", {
            type: "TRANSCRIPT",
            text: cleaned,
            latencyMs,
            languageCode: msg.data?.language_code || "en-IN",
          });
        } else if (sarvamSttSessionActive) {
          // Early empty or wake-only frame caused Sarvam to close the socket; immediately reopen!
          setTimeout(() => {
            if (sarvamSttSessionActive) openSarvamSttSocket();
          }, 20);
        }
      }
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    if (activeSarvamSttWs === ws) {
      activeSarvamSttWs = null;
      if (sarvamSttSessionActive) {
        setTimeout(() => {
          if (sarvamSttSessionActive && !activeSarvamSttWs) openSarvamSttSocket();
        }, 30);
      }
    }
  });

  ws.on("error", () => {
    if (activeSarvamSttWs === ws) activeSarvamSttWs = null;
  });
}

ipcMain.handle("sarvam:sttStart", (_e, options = {}) => {
  const key = options.apiKey || process.env.SARVAM_API_KEY || "";
  if (!key) return { ok: false, error: "SARVAM_API_KEY missing" };

  sttPendingChunks = [];
  sarvamSttSessionActive = true;
  sarvamSttConfig = {
    key,
    lang:
      !options.languageCode || options.languageCode === "auto"
        ? "unknown"
        : options.languageCode,
  };
  openSarvamSttSocket();
  return { ok: true };
});

ipcMain.handle("sarvam:sttChunk", (_e, wavBase64) => {
  if (!wavBase64 || !sarvamSttSessionActive) return { ok: false };
  if (!activeSarvamSttWs) openSarvamSttSocket();
  const payload = JSON.stringify({
    audio: {
      data: wavBase64,
      sample_rate: "16000",
      encoding: "audio/wav",
    },
  });
  if (activeSarvamSttWs && activeSarvamSttWs.readyState === WebSocket.OPEN) {
    activeSarvamSttWs.send(payload);
    return { ok: true };
  }
  if (activeSarvamSttWs && activeSarvamSttWs.readyState === WebSocket.CONNECTING) {
    sttPendingChunks.push(payload);
    if (sttPendingChunks.length > 30) sttPendingChunks.shift();
    return { ok: true, queued: true };
  }
  return { ok: false };
});

ipcMain.handle("sarvam:sttFlush", () => {
  if (!activeSarvamSttWs) return { ok: false };
  const flushPayload = JSON.stringify({ type: "flush" });
  if (activeSarvamSttWs.readyState === WebSocket.OPEN) {
    activeSarvamSttWs.send(flushPayload);
    return { ok: true };
  }
  if (activeSarvamSttWs.readyState === WebSocket.CONNECTING) {
    sttPendingChunks.push(flushPayload);
    return { ok: true, queued: true };
  }
  return { ok: false };
});

ipcMain.handle("sarvam:sttStop", () => {
  sarvamSttSessionActive = false;
  sttPendingChunks = [];
  if (activeSarvamSttWs) {
    try {
      activeSarvamSttWs.close();
    } catch {
      // ignore
    }
    activeSarvamSttWs = null;
  }
  return { ok: true };
});

ipcMain.handle("voice:transcribe", async (_e, payload = {}) => {
  const { wavBase64, sarvamApiKey, geminiApiKey, languageCode = "auto" } = payload;
  if (!wavBase64) return { ok: false, text: "", languageCode: "en-IN" };

  // 1. Primary Low-Latency Path: Sarvam AI WebSocket STT (saaras:v3 — ~68ms latency!)
  const sarvamKey = sarvamApiKey || process.env.SARVAM_API_KEY || "";
  if (sarvamKey) {
    const sarvamRes = await transcribeViaSarvamWebSocket(wavBase64, sarvamKey, languageCode);
    if (sarvamRes.ok) {
      return sarvamRes;
    }
  }

  const sttPrompt =
    "Transcribe the exact spoken words from this audio recording. If the speaker starts with 'Hey Jarvis' or 'Jarvis', remove that wake phrase and return only the remaining command. If the speaker ONLY said 'Hey Jarvis' with no other command, return WAKE_ONLY. If there is no intelligible human speech (only silence or background noise), return EMPTY. Output ONLY the raw text with no quotes or formatting.";

  // 2. Fallback: Vertex AI (gemini-2.5-flash) using local GCP ADC credentials
  try {
    const auth = await getVertexCredentials();
    if (auth.token) {
      const url = `https://aiplatform.googleapis.com/v1beta1/projects/${auth.project}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
          "x-goog-user-project": auth.project,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: sttPrompt },
                { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
              ],
            },
          ],
          generationConfig: { temperature: 0.0, maxOutputTokens: 256 },
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const raw = (
          data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || ""
        ).trim();
        if (raw && raw !== "EMPTY") {
          return { ok: true, text: raw, engine: "vertex-gemini-2.5-flash" };
        }
        return { ok: true, text: "", engine: "vertex-gemini-2.5-flash" };
      }
    }
  } catch {
    // fall through to Gemini API / Windows SAPI
  }

  // 3. Fallback: Gemini API Key if provided
  if (geminiApiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: sttPrompt },
                { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
              ],
            },
          ],
          generationConfig: { temperature: 0.0 },
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const raw = (
          data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || ""
        ).trim();
        return { ok: true, text: raw === "EMPTY" ? "" : raw, engine: "gemini-api" };
      }
    } catch {
      // fall through
    }
  }

  // 4. Offline Windows System.Speech.Recognition fallback
  const psStt = `
Add-Type -AssemblyName System.Speech
$bytes = [Convert]::FromBase64String(${JSON.stringify(wavBase64)})
$ms = New-Object System.IO.MemoryStream(,$bytes)
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$rec.SetInputToWaveStream($ms)
$res = $rec.Recognize()
if ($res) { $res.Text } else { "" }
`;
  const localRes = await runPowerShell(psStt, 6000);
  return {
    ok: true,
    text: (localRes.stdout || "").trim(),
    engine: "windows-sapi",
  };
});

ipcMain.handle("ai:ollamaModels", async (_e, baseUrl = "http://localhost:11434") => {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`);
    if (!resp.ok) return { ok: false, models: [] };
    const data = await resp.json();
    return {
      ok: true,
      models: (data.models || []).map((m) => m.name),
    };
  } catch {
    return { ok: false, models: [] };
  }
});

ipcMain.handle("ai:chat", async (_e, payload) => {
  const {
    provider = "vertex",
    model,
    apiKey,
    ollamaUrl = "http://localhost:11434",
    systemPrompt,
    messages = [],
    imageDataUrl,
  } = payload;

  try {
    if (provider === "vertex" || (provider === "gemini" && !apiKey)) {
      const auth = await getVertexCredentials();
      if (!auth.token) {
        throw new Error("Google Cloud ADC token unavailable. Please configure a Gemini/OpenAI key or sign in with gcloud.");
      }
      const targetModel =
        !model || model === "gemini-4-argon" ? "gemini-2.5-flash" : model;
      const url = `https://aiplatform.googleapis.com/v1beta1/projects/${auth.project}/locations/global/publishers/google/models/${targetModel}:generateContent`;

      const contents = messages.map((m, idx) => {
        const parts = [{ text: m.content }];
        if (idx === messages.length - 1 && imageDataUrl && m.role === "user") {
          const match = imageDataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
          if (match) {
            parts.push({
              inlineData: {
                mimeType: match[1],
                data: match[2],
              },
            });
          }
        }
        return {
          role: m.role === "assistant" ? "model" : "user",
          parts,
        };
      });

      const generationConfig = {
        temperature: 0.5,
        maxOutputTokens: 350,
      };
      if (targetModel.includes("2.5-flash")) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      const body = {
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents,
        generationConfig,
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
          "x-goog-user-project": auth.project,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Vertex AI (${targetModel}) HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const text =
        data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
        "At your service, sir.";
      return { ok: true, text, provider: "vertex", model: targetModel };
    }

    if (provider === "gemini") {
      const targetModel = model || "gemini-2.5-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const contents = messages.map((m, idx) => {
        const parts = [{ text: m.content }];
        if (idx === messages.length - 1 && imageDataUrl && m.role === "user") {
          const match = imageDataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
          if (match) {
            parts.push({
              inlineData: {
                mimeType: match[1],
                data: match[2],
              },
            });
          }
        }
        return {
          role: m.role === "assistant" ? "model" : "user",
          parts,
        };
      });

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
          contents,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Gemini API HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const text =
        data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
        "At your service, sir.";
      return { ok: true, text, provider: "gemini", model: targetModel };
    }

    if (provider === "openai") {
      const targetModel = model || "gpt-4o";
      const oaMessages = [];
      if (systemPrompt) oaMessages.push({ role: "system", content: systemPrompt });
      messages.forEach((m, idx) => {
        if (idx === messages.length - 1 && imageDataUrl && m.role === "user") {
          oaMessages.push({
            role: "user",
            content: [
              { type: "text", text: m.content },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          });
        } else {
          oaMessages.push({ role: m.role, content: m.content });
        }
      });

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: targetModel,
          messages: oaMessages,
          temperature: 0.6,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`OpenAI API HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      return {
        ok: true,
        text: data?.choices?.[0]?.message?.content || "Right away, sir.",
        provider: "openai",
        model: targetModel,
      };
    }

    if (provider === "sarvam") {
      const sarvamKey = apiKey || process.env.SARVAM_API_KEY || "";
      if (!sarvamKey) {
        throw new Error("SARVAM_API_KEY not found in environment or settings.");
      }
      const targetModel = model || "sarvam-105b";
      const sMessages = [];
      if (systemPrompt) sMessages.push({ role: "system", content: systemPrompt });
      messages.forEach((m) => sMessages.push({ role: m.role, content: m.content }));

      const resp = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "api-subscription-key": sarvamKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: targetModel,
          messages: sMessages,
          temperature: 0.6,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Sarvam AI (${targetModel}) HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      return {
        ok: true,
        text: data?.choices?.[0]?.message?.content || "At your service, sir.",
        provider: "sarvam",
        model: targetModel,
      };
    }

    if (provider === "ollama") {
      const targetModel = model || "llama3.2";
      const olMessages = [];
      if (systemPrompt) olMessages.push({ role: "system", content: systemPrompt });
      messages.forEach((m) => olMessages.push({ role: m.role, content: m.content }));
      const resp = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: targetModel,
          messages: olMessages,
          stream: false,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Ollama HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      return {
        ok: true,
        text: data?.message?.content || "Ready, sir.",
        provider: "ollama",
        model: targetModel,
      };
    }

    throw new Error(`Unsupported provider: ${provider}`);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Low-Latency Sarvam WebSocket TTS Streaming (bulbul:v3)
// Streams WAV audio chunks over wss://api.sarvam.ai/text-to-speech/ws directly to the renderer as they arrive!
ipcMain.handle("sarvam:ttsStream", async (_e, { text, options = {} }) => {
  const cleanText = String(text || "")
    .replace(/[*_`#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanText) return { ok: false };

  const sarvamKey = options.apiKey || process.env.SARVAM_API_KEY || "";
  if (!sarvamKey) return { ok: false, error: "SARVAM_API_KEY not configured" };

  const streamId = options.streamId || `tts-${Date.now()}`;
  const model = options.model || "bulbul:v3";
  const speaker = options.speaker || "shubh";
  const languageCode = options.languageCode || "en-IN";
  const pace = Math.max(0.5, Math.min(2.0, Number(options.pace ?? 1.05)));

  return new Promise((resolve) => {
    const url = `wss://api.sarvam.ai/text-to-speech/ws?model=${encodeURIComponent(
      model
    )}&send_completion_event=true`;

    let chunkIndex = 0;
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(res);
    };

    const ws = new WebSocket(url, {
      headers: { "api-subscription-key": sarvamKey },
    });

    const timer = setTimeout(() => {
      finish({ ok: chunkIndex > 0, chunksCount: chunkIndex });
    }, 15000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "config",
          data: {
            target_language_code: languageCode,
            speaker,
            speech_sample_rate: 24000,
            output_audio_codec: "wav",
            pace,
            temperature: 0.6,
          },
        })
      );
      ws.send(JSON.stringify({ type: "text", data: { text: cleanText } }));
      ws.send(JSON.stringify({ type: "flush" }));
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "audio" && msg.data?.audio) {
          if (mainWindow) {
            mainWindow.webContents.send("sarvam:ttsChunk", {
              streamId,
              index: chunkIndex++,
              audioBase64: msg.data.audio,
              contentType: msg.data.content_type || "audio/wav",
              done: false,
            });
          }
        } else if (msg.type === "event") {
          if (mainWindow) {
            mainWindow.webContents.send("sarvam:ttsChunk", {
              streamId,
              index: chunkIndex,
              done: true,
            });
          }
          finish({ ok: true, chunksCount: chunkIndex, model, speaker });
        } else if (msg.type === "error") {
          finish({ ok: false, error: JSON.stringify(msg.data || msg) });
        }
      } catch {
        // ignore
      }
    });

    ws.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });
  });
});

// Synthesize speech to base64 WAV (Sarvam bulbul:v3 REST primary -> Windows SpeechSynthesizer fallback)
ipcMain.handle("tts:synthesize", async (_e, { text, options = {} }) => {
  const cleanText = String(text || "")
    .replace(/[*_`#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanText) return { ok: false };

  const sarvamKey = options.apiKey || process.env.SARVAM_API_KEY || "";
  if (sarvamKey) {
    try {
      const resp = await fetch("https://api.sarvam.ai/text-to-speech", {
        method: "POST",
        headers: {
          "api-subscription-key": sarvamKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: cleanText.slice(0, 2400),
          target_language_code: options.languageCode || "en-IN",
          speaker: options.speaker || "shubh",
          model: "bulbul:v3",
          speech_sample_rate: 24000,
          pace: 1.05,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.audios?.[0]) {
          return {
            ok: true,
            audioBase64: data.audios[0],
            mimeType: "audio/wav",
          };
        }
      }
    } catch {
      // fall through to Windows SAPI
    }
  }

  const rate = Number(options.rate ?? 1);
  const psTts = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled }
$preferred = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'en-GB*' -or $_.VoiceInfo.Name -match 'George|Hazel|David|Mark' } | Select-Object -First 1
if ($preferred) { $synth.SelectVoice($preferred.VoiceInfo.Name) }
$synth.Rate = ${Math.max(-4, Math.min(6, Math.round(rate)))}
$ms = New-Object System.IO.MemoryStream
$synth.SetOutputToWaveStream($ms)
$synth.Speak(${JSON.stringify(cleanText)})
[Convert]::ToBase64String($ms.ToArray())
`;
  const res = await runPowerShell(psTts, 15000);
  if (res.ok && res.stdout) {
    return {
      ok: true,
      audioBase64: res.stdout.trim(),
      mimeType: "audio/wav",
    };
  }
  return { ok: false, error: res.error || "TTS synthesis failed" };
});

app.whenReady().then(() => {
  startWakeWordWorker();
  getVertexCredentials().catch(() => {});
  createMainWindow();

  // If Spotify Developer credentials exist and user hasn't authorized yet, open one-time OAuth consent
  if (fs.existsSync(SPOTIFY_CONFIG_FILE) && !fs.existsSync(SPOTIFY_TOKEN_FILE)) {
    setTimeout(() => {
      try {
        startSpotifyOAuthServer();
      } catch {
        // ignore
      }
    }, 1500);
  }

  // Register global Windows shortcuts to summon J.A.R.V.I.S.
  try {
    globalShortcut.register("Alt+Space", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send("jarvis:summon", { trigger: "Alt+Space" });
      }
    });
    globalShortcut.register("CommandOrControl+Shift+J", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send("jarvis:summon", { trigger: "Ctrl+Shift+J" });
      }
    });
  } catch {
    // ignore shortcut registration conflicts
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (wakeProc) {
    try {
      wakeProc.kill();
    } catch {
      // ignore
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
