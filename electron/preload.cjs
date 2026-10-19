const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvisHost", {
  isElectron: true,

  // Window & Desktop Widget Controls
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  setMiniMode: (enabled) => ipcRenderer.invoke("window:setMiniMode", enabled),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("window:setAlwaysOnTop", enabled),
  setOrbVisible: (visible) => ipcRenderer.invoke("window:setOrbVisible", visible),

  // Wake Word Co-Processor (hey_jarvis_v0.1.tflite)
  wakewordGetStatus: () => ipcRenderer.invoke("wakeword:status"),
  wakewordSendPcm: (base64Pcm) => ipcRenderer.invoke("wakeword:pcm", base64Pcm),
  wakewordTestPhrase: (phrase) => ipcRenderer.invoke("wakeword:testPhrase", phrase),
  wakewordReset: () => ipcRenderer.invoke("wakeword:reset"),

  // Windows System Telemetry & Capabilities
  getSystemTelemetry: () => ipcRenderer.invoke("system:telemetry"),
  captureScreen: () => ipcRenderer.invoke("system:captureScreen"),
  executeTool: (toolName, args) => ipcRenderer.invoke("system:executeTool", { toolName, args }),

  // Ultra-Fast Timestamped Persistent Memory Engine
  memoryRecordTurn: (entry) => ipcRenderer.invoke("memory:recordTurn", entry),
  memoryQuery: (query) => ipcRenderer.invoke("memory:query", query),

  // Background Gemini CLI / Codex CLI completion event
  onAgentComplete: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("jarvis:agentComplete", listener);
    return () => ipcRenderer.removeListener("jarvis:agentComplete", listener);
  },

  // Proactive Azure Globe News topic alert event
  onNewsAlert: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("jarvis:newsAlert", listener);
    return () => ipcRenderer.removeListener("jarvis:newsAlert", listener);
  },

  // Multi-Provider AI Brain & Auth
  aiChat: (payload) => ipcRenderer.invoke("ai:chat", payload),
  transcribeAudio: (payload) => ipcRenderer.invoke("voice:transcribe", payload),
  getVertexAuth: () => ipcRenderer.invoke("ai:vertexAuth"),
  getSarvamStatus: () => ipcRenderer.invoke("sarvam:status"),
  listOllamaModels: (baseUrl) => ipcRenderer.invoke("ai:ollamaModels", baseUrl),

  // Sarvam Real-Time WebSocket STT (saaras:v3)
  sarvamSttStart: (options) => ipcRenderer.invoke("sarvam:sttStart", options),
  sarvamSttChunk: (wavBase64) => ipcRenderer.invoke("sarvam:sttChunk", wavBase64),
  sarvamSttFlush: () => ipcRenderer.invoke("sarvam:sttFlush"),
  sarvamSttStop: () => ipcRenderer.invoke("sarvam:sttStop"),
  onSarvamSttEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("sarvam:sttEvent", listener);
    return () => ipcRenderer.removeListener("sarvam:sttEvent", listener);
  },

  // Sarvam Real-Time WebSocket TTS Streaming (bulbul:v3) + Windows SAPI Fallback
  synthesizeSpeech: (text, options) => ipcRenderer.invoke("tts:synthesize", { text, options }),
  streamSarvamTts: (text, options) => ipcRenderer.invoke("sarvam:ttsStream", { text, options }),
  onSarvamTtsChunk: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("sarvam:ttsChunk", listener);
    return () => ipcRenderer.removeListener("sarvam:ttsChunk", listener);
  },

  // Global hotkey & tray events from Main Process
  onGlobalSummon: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("jarvis:summon", listener);
    return () => ipcRenderer.removeListener("jarvis:summon", listener);
  },
});
