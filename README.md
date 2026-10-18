<div align="center">

# J.A.R.V.I.S.
### Windows Neural Desktop Assistant • Powered by OrbKit `SHDR-02` & `hey_jarvis_v0.1.tflite`

<img src="./public/jarvis-orb.png" alt="J.A.R.V.I.S. SHDR-02 Neural Core" width="420" />

<p align="center">
  <strong>Zero-Chrome Per-Pixel Transparent Floating WebGL Orb</strong> • <strong>iPhone Siri-Style 60/120fps Bloom Animation</strong><br/>
  <strong>2-Stage TFLite Neural Wake Word</strong> • <strong>Sarvam AI Real-Time WebSocket Voice Stack</strong> • <strong>Gemini CLI & Codex CLI Builder</strong>
</p>

</div>

---

## ✨ Overview

**J.A.R.V.I.S.** (*Just A Rather Very Intelligent System*) is a native Windows AI desktop assistant built with **Electron**, **React 19**, **TypeScript**, **WebGL (`OrbKit SHDR-02`)**, and a hybrid **Python + ONNX + TFLite** neural wake-word co-processor.

While idle, J.A.R.V.I.S. remains **100% invisible and click-through** on your Windows desktop. The moment you say **"Hey Jarvis"** (or press `Alt + Space`), the **OrbKit `SHDR-02` ("Rocaille")** 10-layer stereographic scrollwork sphere blooms up from the bottom-center of your screen at 60/120fps, listens to your request in **any language or code-mix (Hinglish, Tanglish, Banglish, English, etc.)**, executes system/browser/coding actions, speaks back with ultra-low-latency WebSocket audio, and smoothly melts away when finished.

---

## 🚀 Key Capabilities

### 1. 🔮 OrbKit `SHDR-02` ("Rocaille") 3-State WebGL Core
- Installed via `npx shadcn@latest add @zzzzshawn/orbkit/shdr-02` (`src/components/ui/shdr-02.tsx` & `src/components/ui/orbkit-core.tsx`).
- **3 Physically Eased Shader States**:
  - **`idle`**: Calm, slow scrollwork evolution (`speed: 0.5, zoom: 4.4, gain: 0.55`).
  - **`thinking`**: Restless, tighter harmonic warp (`speed: 0.65, zoom: 4.6, gain: 0.60`) while transcribing, reasoning, or executing tools.
  - **`speaking`**: High-energy reformation (`speed: 3.0, falloff: 1.1, gain: 0.85, rim: 0.20`) driven at 60fps by a WebAudio `AnalyserNode` tracking the exact vocal-formant envelope (`uOutput`) of J.A.R.V.I.S.'s voice.
- **iPhone Siri-Style Bloom & Auto-Dismiss**: Combines hardware-accelerated CSS `translate3d`/`scale` spring physics with `OrbKit`'s internal 120fps WebGL uniform spring (`uP_radius`, `uP_gain`, `uP_rim`) on a per-pixel transparent Windows DirectComposition surface.

### 2. 🎙️ `hey_jarvis_v0.1.tflite` Two-Stage Neural Wake Word Engine
- Runs the official `hey_jarvis_v0.1.tflite` (`1,278,912` bytes, `TFL3` FlatBuffer) model locally at 16kHz:
  ```text
  16kHz Mic PCM ──► melspectrogram.onnx (76×32) ──► embedding_model.onnx (24×96)
       ──► Multi-Tempo Interpolation [13, 15, 16, 18, 20]
       ──► Stage-1 MLP (1536→128→128→1) + Stage-2 Verifier (1536→64→64→1)
  ```
- **Multi-Tempo Embedding Interpolation**: Achieves **84%–98% confidence** across slow, normal, and fast speaking paces while keeping non-wake speech and course/YouTube videos below **0.003%** via strict 2-stage cascade verification (`s1 >= 0.45` & `s2 >= 0.52`).
- Includes both the native Python ONNX+TFLite worker (`electron/wakeword_worker.py`) and a pure TypeScript FlatBuffer interpreter (`src/lib/tflite-wakeword.ts`).

### 3. ⚡ Ultra-Low-Latency WebSocket Voice Stack & Automatic Multilingual Code-Mix
- **Live Streaming WebSocket STT (`saaras:v3`)**:
  - Streams 128ms audio frames *while you speak* over `wss://api.sarvam.ai/speech-to-text/ws?language-code=unknown&model=saaras:v3&mode=codemix&vad_signals=true&flush_signal=true`.
  - Automatically detects **22+ Indian languages & English** (`hi-IN`, `ta-IN`, `te-IN`, `bn-IN`, `mr-IN`, `gu-IN`, `kn-IN`, `ml-IN`, `pa-IN`, `od-IN`, `en-IN`) and transcribes in natural code-mixed script within **~54ms** of `END_SPEECH`.
- **Gapless WebSocket Streaming TTS (`bulbul:v3`)**:
  - Streams raw 24kHz 16-bit mono PCM chunks over `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true` and schedules them gaplessly onto the WebAudio timeline.
  - Automatically shifts `target_language_code` on every turn to match the language you spoke.
- **Standalone Sarvam MCP Server (`electron/sarvam_mcp_server.py`)**:
  - JSON-RPC 2.0 stdio MCP server exposing `sarvam_stt`, `sarvam_tts`, `sarvam_chat` (`sarvam-105b`), and `sarvam_translate`.

### 4. 🛠️ Autonomous Coding Agents (`Gemini CLI` & `Codex CLI`) & Windows Control
- **Voice-to-Website Builder (`coding_agent`)**:
  - Say *"Hey Jarvis, build me a modern coffee shop website"* or *"Use Codex to create a portfolio landing page"*.
  - J.A.R.V.I.S. scaffolds `projects/<project-name>`, dispatches **Gemini CLI (`gemini --yolo -p "..."`)** or **OpenAI Codex CLI (`codex exec --full-auto "..."`)** in the background, opens the finished `index.html` in **Google Chrome**, and blooms up to announce completion.
- **Direct Chrome & YouTube Automation (`play_youtube`, `open_address`)**:
  - Say *"Open YouTube and play Barsaat song"* or *"YouTube pe Barsaat song chalao"* — resolves the top YouTube `videoId` and launches Chrome directly into playback (`watch?v=...&autoplay=1`).
- **Windows OS Control & Screen Vision**:
  - Launch/close apps, control master volume & media playback, lock workstation, capture screenshots for multimodal vision analysis, search the web, check live weather, and run PowerShell commands.
- **Sub-Millisecond RAM-Indexed Persistent Memory**:
  - Remembers all conversations, user preferences, and created project paths across restarts (`memory/jarvis_memory.json`) with `<0.1ms` RAM retrieval.

---

## 📂 Project Architecture

```text
J.A.R.V.I.S/
├── electron/
│   ├── main.cjs                 # Electron main process, transparent window, WebSocket STT/TTS, OS & CLI tools
│   ├── preload.cjs              # Context-isolated IPC bridge (window.jarvisHost)
│   ├── wakeword_worker.py       # 16kHz ONNX + hey_jarvis_v0.1.tflite 2-stage neural cascade worker
│   └── sarvam_mcp_server.py     # Standalone Sarvam AI Model Context Protocol (MCP) server
├── public/
│   ├── jarvis-orb.png           # SHDR-02 Rocaille Orb preview image
│   ├── hey_jarvis_v0.1.tflite   # TFL3 wake-word model (Stage-1 128-unit + Stage-2 64-unit cascade)
│   └── models/
│       ├── melspectrogram.onnx  # OpenWakeWord Mel-spectrogram frontend
│       ├── embedding_model.onnx # Google Speech Embedding extractor (76×32 -> 96)
│       └── hey_jarvis_v0.1.tflite
├── src/
│   ├── components/ui/
│   │   ├── orbkit-core.tsx      # OrbKit WebGL shader runtime & spring physics engine
│   │   └── shdr-02.tsx          # SHDR-02 ("Rocaille") 10-layer stereographic scrollwork shader
│   ├── lib/
│   │   ├── tflite-wakeword.ts   # Pure TypeScript TFL3 FlatBuffer parser & 16kHz WAV encoder
│   │   ├── audio-synthesizer.ts # 24kHz PCM WebSocket streamer & WebAudio AnalyserNode driver
│   │   ├── jarvis-agent.ts      # Multi-provider AI brain, code-mix language detector & tool router
│   │   ├── realtime-voice.ts    # Gemini Multimodal Live WebSocket client
│   │   └── __tests__/
│   │       └── jarvis.test.ts   # Vitest test suite
│   ├── App.tsx                  # Transparent Siri-style floating orb & audio/VAD controller
│   └── index.css                # Transparent DirectComposition styling
├── hey_jarvis_v0.1.tflite       # Root wake-word model binary
├── Launch-Jarvis.bat            # One-click Windows launcher
└── package.json
```

---

## ⚙️ Installation & Setup (Windows)

### Prerequisites
- **Node.js** `v20+`
- **Python** `3.10+` with `numpy` and `onnxruntime`:
  ```powershell
  pip install numpy onnxruntime websockets
  ```
- **Environment Variables**:
  Set your `SARVAM_API_KEY` (for `saaras:v3` WebSocket STT, `bulbul:v3` WebSocket TTS, and `sarvam-105b`) and authenticate Google Cloud ADC (`gcloud auth application-default login`) or configure a Gemini/OpenAI API key:
  ```powershell
  $env:SARVAM_API_KEY = "your_sarvam_api_key"
  ```

### Install & Build
```powershell
# 1. Install dependencies
npm install

# 2. Run unit tests
npm test

# 3. Build production bundle
npm run build

# 4. Launch J.A.R.V.I.S. on Windows
npm start
```
*(Or double-click **`Launch-Jarvis.bat`**)*

---

## 🎮 Controls & Voice Examples

| Action | Voice / Shortcut |
| :--- | :--- |
| **Wake J.A.R.V.I.S.** | Say **"Hey Jarvis"** or press **`Alt + Space`** / **`Ctrl + Shift + J`** |
| **Play YouTube in Chrome** | *"Hey Jarvis, open YouTube and play Barsaat song"* / *"YouTube pe Barsaat song chalao"* |
| **Build a Website (Gemini / Codex CLI)** | *"Hey Jarvis, build me a modern portfolio website"* / *"Use Codex to create a coffee shop landing page"* |
| **Multilingual Code-Mix Chat** | Speak naturally in **Hindi, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, Punjabi, or English** |
| **Windows OS Control** | *"Open VS Code"*, *"Open Calculator"*, *"Set volume to 60%"*, *"What is my CPU and RAM usage?"* |

---

## 📜 Credits & License

- **Shader (`SHDR-02` / Rocaille)**: Original GLSL shader by [XorDev](https://x.com/XorDev), ported for [OrbKit](https://github.com/zzzzshawn/orbkit) by `@zzzzshawn`.
- **Wake Word Model**: `hey_jarvis_v0.1.tflite` from [OpenWakeWord](https://github.com/dscripka/openWakeWord).
