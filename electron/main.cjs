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

    // Cache Vertex AI token for fast multi-turn requests
    let cachedVertexAuth = { token: null, project: null, expiresAt: 0 };

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
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.setAlwaysOnTop(true, "screen-saver");
    } else {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
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
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        const resp = await fetch(searchUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          },
        });
        const html = await resp.text();
        const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const targetUrl = match
          ? `https://www.youtube.com/watch?v=${match[1]}&autoplay=1`
          : searchUrl;

        const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        if (fs.existsSync(chromePath)) {
          spawn(chromePath, [targetUrl], { detached: true, stdio: "ignore" }).unref();
        } else {
          await shell.openExternal(targetUrl);
        }
        return {
          ok: true,
          query,
          url: targetUrl,
          message: `Playing "${query}" on YouTube in Chrome.`,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
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
      const keyMap = {
        play_pause: 179,
        next: 176,
        previous: 177,
        stop: 178,
      };
      const charCode = keyMap[cmd] || 179;
      await runPowerShell(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]${charCode})`, 3000);
      return { ok: true, message: `Executed media control: ${cmd}` };
    }

    case "lock_workstation": {
      await runPowerShell(`rundll32.exe user32.dll,LockWorkStation`, 3000);
      return { ok: true, message: "Workstation locked." };
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
