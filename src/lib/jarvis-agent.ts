/**
 * J.A.R.V.I.S. Multi-Provider Brain & Windows Tool Orchestrator
 * Supports:
 *  - Google Cloud Vertex AI (gemini-4-argon / gemini-2.5-flash via local ADC)
 *  - Google Gemini API
 *  - OpenAI (gpt-4o / gpt-4.1)
 *  - Local Ollama (llama3.2 / qwen2.5 / deepseek)
 * Automatically parses and executes Windows OS, Web Search, Screen Vision, and Productivity tools.
 */

export type AIProviderId = "vertex" | "sarvam" | "gemini" | "openai" | "ollama";

export interface AIConfig {
  provider: AIProviderId;
  model: string;
  sarvamApiKey?: string;
  sarvamSpeaker?: string;
  sarvamLanguage?: string;
  geminiApiKey: string;
  openaiApiKey: string;
  ollamaUrl: string;
  voiceRate: number;
  autoSpeak: boolean;
  realtimeMode: boolean;
}

export interface ToolExecutionRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  timestamp: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  imageDataUrl?: string;
  toolExecutions?: ToolExecutionRecord[];
  providerModel?: string;
}

export interface SystemTelemetry {
  hostname: string;
  platform: string;
  cpuModel: string;
  cpuCores: number;
  cpuPercent: number;
  ramUsedGb: number;
  ramTotalGb: number;
  ramPercent: number;
  uptimeHours: number;
  activeWindow: string;
  batteryPercent: number;
  isCharging: boolean;
  diskUsedGb: number;
  diskFreeGb: number;
}

const FENCE = "```";
const JARVIS_SYSTEM_PROMPT = `You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), Tony Stark's ultra-capable AI assistant running natively on Windows.
Keep responses crisp, intelligent, and naturally spoken (1-3 sentences unless detailed analysis is requested).

AUTOMATIC MULTILINGUAL & CODE-MIX SHIFTING (CRITICAL):
- The user may speak in ANY language (Hindi hi-IN, Bengali bn-IN, Tamil ta-IN, Telugu te-IN, Marathi mr-IN, Gujarati gu-IN, Kannada kn-IN, Malayalam ml-IN, Punjabi pa-IN, Odia od-IN, or English en-IN) or a code-mixed blend.
- Automatically shift to the EXACT language the user spoke!
- When the user speaks an Indian language (or Hinglish/Tanglish/Banglish/etc.), ALWAYS reply in a natural, modern, effortless CODE-MIX of that language and English (for example, in Hindi/Hinglish: "बिल्कुल sir, मैं अभी Chrome में YouTube पर वो song play कर रहा हूँ।" — write the native conversational words in the native script and keep English/technical/modern words like "sir", "CPU load", "YouTube", "Chrome", "song", "play", "timer", "system" in English Latin script so the Sarvam bulbul:v3 neural voice pronounces the code-mix with 100% natural fluency).
- When the user speaks pure English, reply in crisp, natural English.
- Prefix your response with the language tag in brackets, e.g. [LANG:hi-IN], [LANG:ta-IN], [LANG:te-IN], [LANG:bn-IN], [LANG:mr-IN], [LANG:gu-IN], [LANG:kn-IN], [LANG:ml-IN], [LANG:pa-IN], [LANG:od-IN], or [LANG:en-IN].

PERSISTENT MEMORY & CLI CODING AGENTS:
- You have an internal memory ledger of past conversations, user preferences, and projects/websites built.
- CRITICAL RULE: NEVER read timestamps, dates, times, or raw file path strings out loud in your spoken reply! Keep timestamps completely silent (internal-only) and just naturally tell the user what they asked you to remember or what you did.
- When the user asks to create/build a website, web app, game, or software project (or says to use Gemini CLI or Codex CLI), emit the "coding_agent" tool call!

You have direct access to Windows OS, Chrome/YouTube, Gemini/Codex CLI & Productivity tools. When the user asks to perform an action, include a JSON tool block on its own line BEFORE your spoken confirmation:
${FENCE}jarvis_tool
{"tool": "tool_name", "args": {...}}
${FENCE}

Available tools:
- {"tool": "get_globe_news", "args": {"topic": "India or AI or Bidar or Global"}}
- {"tool": "watch_news_topic", "args": {"topic": "Bitcoin or Virat Kohli or Dhurandhar", "languageCode": "en-IN|hi-IN"}}
- {"tool": "unwatch_news_topic", "args": {"topic": "all or specific topic"}}
- {"tool": "play_spotify", "args": {"query": "hummed or sung lyrics or song name"}}
- {"tool": "connect_spotify", "args": {}}
- {"tool": "coding_agent", "args": {"agent": "gemini|codex", "projectName": "portfolio-site", "prompt": "Detailed instructions of what website/app to build", "existingAddress": "optional path if modifying an existing project from memory"}}
- {"tool": "open_address", "args": {"address": "D:\\\\Jarvis\\\\projects\\\\portfolio-site\\\\index.html", "openIn": "chrome|vscode|explorer"}}
- {"tool": "play_youtube", "args": {"query": "Barsaat song"}}
- {"tool": "launch_app", "args": {"app": "notepad|calc|explorer|terminal|vscode|chrome|edge|youtube|settings|taskmgr|spotify"}}
- {"tool": "close_app", "args": {"processName": "notepad"}}
- {"tool": "set_volume", "args": {"action": "set|mute|unmute", "level": 60}}
- {"tool": "media_control", "args": {"command": "play_pause|next|previous|stop"}}
- {"tool": "lock_workstation", "args": {}}
- {"tool": "capture_screen", "args": {}}
- {"tool": "web_search", "args": {"query": "search terms"}}
- {"tool": "get_weather", "args": {"location": "City Name"}}
- {"tool": "run_command", "args": {"command": "Get-Date"}}
- {"tool": "set_timer", "args": {"seconds": 60, "label": "Tea Timer"}}
- {"tool": "add_note", "args": {"text": "Note content"}}
- {"tool": "clipboard_write", "args": {"text": "text to copy"}}
- {"tool": "sarvam_translate", "args": {"text": "Hello sir", "source_language_code": "en-IN", "target_language_code": "hi-IN"}}
`;

export function detectCodeMixLanguage(text: string, fallback = "en-IN"): string {
  if (/[\u0980-\u09FF]/.test(text)) return "bn-IN"; // Bengali
  if (/[\u0A00-\u0A7F]/.test(text)) return "pa-IN"; // Punjabi (Gurmukhi)
  if (/[\u0A80-\u0AFF]/.test(text)) return "gu-IN"; // Gujarati
  if (/[\u0B00-\u0B7F]/.test(text)) return "od-IN"; // Odia
  if (/[\u0B80-\u0BFF]/.test(text)) return "ta-IN"; // Tamil
  if (/[\u0C00-\u0C7F]/.test(text)) return "te-IN"; // Telugu
  if (/[\u0C80-\u0CFF]/.test(text)) return "kn-IN"; // Kannada
  if (/[\u0D00-\u0D7F]/.test(text)) return "ml-IN"; // Malayalam
  if (/[\u0900-\u097F]/.test(text)) {
    return fallback === "mr-IN" ? "mr-IN" : "hi-IN"; // Hindi / Marathi (Devanagari)
  }
  return fallback || "en-IN";
}

const TOPIC_STOPWORDS = new Set([
  "hey", "hi", "ok", "okay", "jarvis", "sir", "please",
  "is", "there", "are", "was", "were", "be", "do", "does", "did", "can", "could", "will", "would",
  "any", "some", "the", "a", "an", "what", "whats", "what's", "tell", "me", "give", "show", "check", "find", "get",
  "latest", "breaking", "recent", "new", "current", "today", "todays", "today's", "right", "now",
  "globe", "news", "update", "updates", "headline", "headlines", "story", "stories", "report", "reports",
  "related", "relating", "regarding", "concerning", "connected", "about", "on", "in", "from", "for", "of", "to", "with", "by",
  "if", "when", "whenever", "comes", "come", "coming", "happens", "happening", "inform", "notify", "alert", "watch", "monitor", "track", "let", "know", "then",
  "हे", "जार्विस", "अरे", "यार", "क्या", "कोई", "भी", "है", "हैं", "में", "पर", "पे", "की", "का", "के", "को", "से", "तो",
  "अगर", "जब", "खबर", "खबरें", "न्यूज़", "समाचार", "ताज़ा", "आज", "मुझे", "बताना", "बता", "देना", "बताओ", "सुनाओ", "इंफॉर्म", "करना", "करो", "अलर्ट", "लेकर", "बारे", "आए", "आता", "आती", "मिले",
]);

function extractCleanTopicFromSentence(sentence: string): string {
  const tokens = sentence
    .replace(/[।?!.,;:"'()[\]{}]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !TOPIC_STOPWORDS.has(t.toLowerCase()));
  return tokens.join(" ").trim();
}

export function parseLocalFastIntent(userText: string): {
  tool: string;
  args: Record<string, unknown>;
} | null {
  const lower = userText.toLowerCase().trim();

  // Connect Spotify OAuth intent
  if (/\b(?:connect|login|link|authorize)\s+(?:my\s+)?spotify\b/i.test(lower)) {
    return { tool: "connect_spotify", args: {} };
  }

  // Stop / Pause / Resume / Next / Previous Spotify & Media Controls (English + Hinglish/Hindi)
  if (
    /^(?:hey\s+jarvis[,\s]*)?(?:please\s+)?(?:pause|stop)(?:\s+(?:the\s+)?(?:music|song|track|spotify|playback|audio|it))?$/i.test(
      lower
    ) ||
    /\b(?:pause|stop)\s+(?:the\s+)?(?:music|song|track|spotify|playback|audio)\b/i.test(lower) ||
    /\bspotify\s+(?:pause|stop|band\s+karo|rok\s+do|roko)\b/i.test(lower)
  ) {
    return { tool: "media_control", args: { command: "pause" } };
  }
  if (
    /^(?:hey\s+jarvis[,\s]*)?(?:please\s+)?(?:resume|continue|unpause)(?:\s+(?:the\s+)?(?:music|song|track|spotify|playback|it))?$/i.test(
      lower
    ) ||
    /\b(?:resume|continue|unpause)\s+(?:the\s+)?(?:music|song|track|spotify|playback)\b/i.test(lower)
  ) {
    return { tool: "media_control", args: { command: "resume" } };
  }
  if (/\b(next\s+track|next\s+song|skip\s+track|skip\s+song|agla\s+gaana)\b/i.test(lower)) {
    return { tool: "media_control", args: { command: "next" } };
  }
  if (/\b(previous\s+track|previous\s+song|pichla\s+gaana)\b/i.test(lower)) {
    return { tool: "media_control", args: { command: "previous" } };
  }

  // Stop watching news topic intent
  if (
    /\b(?:stop\s+watching|unwatch|clear|remove|cancel)\b.*\b(?:news|alert|alerts)\b/i.test(lower)
  ) {
    return { tool: "unwatch_news_topic", args: { topic: "all" } };
  }

  // Proactive News Topic Watch intent ("if any news comes on X inform me", "alert me when news comes about X", "अगर X पर कोई news आए तो मुझे बताना")
  if (
    /(?:\b(?:news|update|updates|story|headline)\b|खबर|खबरें|न्यूज़|समाचार)/i.test(userText) &&
    /(?:\b(?:inform|notify|alert|let\s+me\s+know|watch|monitor|whenever)\b|बताना|बता\s+देना|इंफॉर्म|अलर्ट|जब\s+भी|अगर)/i.test(
      userText
    )
  ) {
    const cleanedTopic = extractCleanTopicFromSentence(userText);
    if (cleanedTopic) {
      return {
        tool: "watch_news_topic",
        args: {
          topic: cleanedTopic,
          languageCode: detectCodeMixLanguage(userText, "en-IN"),
        },
      };
    }
  }

  // Live Globe News Query intent ("Is there any news related to Tiger Shroff?", "Tiger Shroff news", "what is the latest news on X", "आज की ताज़ा ख़बरें")
  if (
    /\b(?:news|headlines|headline)\b/i.test(lower) ||
    /(?:ताज़ा\s+खबर|ताज़ा\s+खबरें|आज\s+की\s+खबर|न्यूज़|खबरें|खबर|समाचार)/.test(userText)
  ) {
    // Check if the user stopped mid-sentence after a preposition ("Is there any news related to", "news about", "news from")
    if (/\b(?:related\s+to|about|regarding|from|on|for|in)\s*[?.!]*$/i.test(lower)) {
      return null;
    }
    const cleanedNewsQuery = extractCleanTopicFromSentence(userText);
    return {
      tool: "get_globe_news",
      args: {
        topic: cleanedNewsQuery || "Global",
        languageCode: detectCodeMixLanguage(userText, "en-IN"),
      },
    };
  }

  // Explicit YouTube play intent (only when user explicitly mentions YouTube)
  if (/\byoutube\b|यूट्यूब/i.test(userText)) {
    const cleanedYt = userText
      .replace(/^(?:hey\s+jarvis|jarvis|हे\s+जार्विस|जार्विस)[,!.?\s]*/i, "")
      .replace(
        /\b(?:open\s+youtube\s+and\s+play|play\s+on\s+youtube|on\s+youtube|youtube\s+(?:pe|par|per|on)|play\s+karo|chalao|chala\s+do|lagao|baja\s+do|please|play|youtube)\b/gi,
        " "
      )
      .replace(/(?:यूट्यूब|चलाओ|लगाओ|बजाओ|प्ले\s+करो|प्ले|में|पर|पे)/g, " ")
      .replace(/[।.?!]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleanedYt) return { tool: "play_youtube", args: { query: cleanedYt } };
  }

  // Spotify / Lyrics / Movie Song / Hindi & English Song Play Intent -> Resolves via YouTube API & plays in Windows Spotify App!
  if (
    /\bspotify\b|स्पॉटिफाई/i.test(userText) ||
    /^(?:hey\s+jarvis[,\s]*)?(?:please\s+)?(?:play|प्ले)\s+/i.test(userText) ||
    /(?:\b(?:song|gaana|music|track)\b|गाना|सॉन्ग).*(?:\b(?:play|chalao|chala\s+do|lagao|baja\s+do)\b|चलाओ|लगाओ|बजाओ|प्ले)/i.test(
      userText
    ) ||
    /(?:ये\s+गाना\s+चलाओ|वो\s+गाना\s+चलाओ|गाना\s+चलाओ|गाना\s+लगाओ)/i.test(userText)
  ) {
    const cleanedSongQuery = userText
      .replace(/^(?:hey\s+jarvis|jarvis|हे\s+जार्विस|जार्विस)[,!.?\s]*/i, "")
      .replace(
        /\b(?:open\s+spotify\s+and\s+play|play\s+the\s+song\s+that\s+goes|play\s+that\s+song\s+that\s+goes|play\s+the\s+song|play\s+on\s+spotify|on\s+spotify|in\s+spotify|spotify\s+(?:pe|par|per|on|mein|me)|play\s+karo|chalao|chala\s+do|lagao|laga\s+do|baja\s+do|please|play|spotify)\b/gi,
        " "
      )
      .replace(
        /(?:स्पॉटिफाई\s*(?:में|पर|पे)?|लगाओ|लगा\s+दो|चलाओ|चला\s+दो|बजाओ|प्ले\s+करो|प्ले|ये\s+गाना|वो\s+गाना|में|पर|पे)/g,
        " "
      )
      .replace(/[।.?!]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (
      cleanedSongQuery &&
      !/^(?:pause|resume|stop|next|previous|music)$/i.test(cleanedSongQuery)
    ) {
      return { tool: "play_spotify", args: { query: cleanedSongQuery } };
    }
  }

  // Gemini CLI / Codex CLI website or app builder intent
  const buildMatch = userText.match(
    /(?:build|create|make|generate|develop|banao|bana\s+do|बनाओ|बना\s+दो)\s+(?:me\s+)?(?:a\s+|an\s+|ek\s+)?(.+?\b(?:website|web\s*app|landing\s*page|portfolio|dashboard|game\s+website)\b.*)/i
  );
  if (buildMatch) {
    const desc = buildMatch[1].trim();
    const agent = /\bcodex\b/i.test(userText) ? "codex" : "gemini";
    const slug =
      desc
        .toLowerCase()
        .replace(/\b(website|web|app|page|using|with|gemini|codex|cli|banao|bana|do)\b/g, "")
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 28) || `site-${Date.now()}`;
    return {
      tool: "coding_agent",
      args: {
        agent,
        projectName: slug,
        prompt: `Build a complete, visually stunning, interactive ${desc}`,
      },
    };
  }

  // Launch app intent
  const openMatch = lower.match(/^(?:hey jarvis[,\s]*)?(?:please\s+)?(?:open|launch|start)\s+([a-z0-9\s.-]+)$/i);
  if (openMatch) {
    const appName = openMatch[1].replace(/\b(app|application|program|for me|please)\b/gi, "").trim();
    if (appName && !appName.includes("timer") && !appName.includes("note")) {
      return { tool: "launch_app", args: { app: appName } };
    }
  }

  // Volume intent
  const volMatch = lower.match(/(?:set\s+)?volume\s+(?:to\s+)?(\d{1,3})\s*%?/i);
  if (volMatch) {
    return { tool: "set_volume", args: { action: "set", level: Number(volMatch[1]) } };
  }
  if (/\b(mute|unmute)\s+(?:the\s+)?(?:volume|audio|sound)\b/i.test(lower)) {
    return { tool: "set_volume", args: { action: "mute" } };
  }

  // Weather intent
  const weatherMatch = lower.match(/weather\s+in\s+([a-z\s,]+?)(?:\?|$|\.)/i);
  if (weatherMatch) {
    return { tool: "get_weather", args: { location: weatherMatch[1].trim() } };
  }

  // Timer intent
  const timerMatch = lower.match(/timer\s+(?:for\s+)?(\d+)\s*(seconds|second|secs|sec|minutes|minute|mins|min)/i);
  if (timerMatch) {
    const qty = Number(timerMatch[1]);
    const unit = timerMatch[2].toLowerCase();
    const seconds = unit.startsWith("min") ? qty * 60 : qty;
    return { tool: "set_timer", args: { seconds, label: `${qty} ${unit}` } };
  }

  // Note intent
  const noteMatch = userText.match(/(?:save\s+a\s+note|add\s+a\s+note|remember\s+that|take\s+a\s+note)[:\s]+(.+)$/i);
  if (noteMatch) {
    return { tool: "add_note", args: { text: noteMatch[1].trim() } };
  }

  // Screenshot / screen vision intent
  if (/\b(take a screenshot|capture my screen|look at my screen|what is on my screen|what's on my screen)\b/i.test(lower)) {
    return { tool: "capture_screen", args: {} };
  }

  // Web search intent
  const searchMatch = userText.match(/(?:search\s+(?:the\s+web\s+)?for|google|look\s+up)\s+(.+)$/i);
  if (searchMatch) {
    return { tool: "web_search", args: { query: searchMatch[1].replace(/[?.!]+$/, "").trim() } };
  }

  return null;
}

export async function processJarvisTurn(params: {
  userText: string;
  detectedLanguage?: string;
  history: ChatMessage[];
  config: AIConfig;
  telemetry: SystemTelemetry | null;
  attachedImage?: string | null;
  onExecuteLocalUIAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
}): Promise<{
  reply: string;
  replyLanguageCode: string;
  toolExecutions: ToolExecutionRecord[];
  capturedImage?: string;
  providerModel: string;
}> {
  const { userText, detectedLanguage = "en-IN", history, config, telemetry, attachedImage, onExecuteLocalUIAction } = params;
  const host = (window as unknown as {
    jarvisHost?: {
      executeTool?: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      captureScreen?: () => Promise<{ ok: boolean; dataUrl?: string; name?: string }>;
      aiChat?: (payload: unknown) => Promise<{ ok: boolean; text?: string; provider?: string; model?: string; error?: string }>;
      memoryQuery?: (query: string) => Promise<{ formattedContext?: string; totalMemories?: number }>;
      memoryRecordTurn?: (entry: unknown) => Promise<unknown>;
    };
  }).jarvisHost;

  const toolExecutions: ToolExecutionRecord[] = [];
  let activeImage = attachedImage || undefined;

  // Sub-millisecond RAM-indexed memory recall (timestamps + project/file/URL addresses + conversation timeline)
  let memoryContextBlock = "";
  if (host?.memoryQuery) {
    try {
      const mem = await host.memoryQuery(userText);
      if (mem?.formattedContext) {
        memoryContextBlock = `\n[PERSISTENT MEMORY & TIMELINE LEDGER]\n${mem.formattedContext}\n`;
      }
    } catch {
      // ignore
    }
  }

  const runSingleTool = async (toolName: string, args: Record<string, unknown>) => {
    if (toolName === "set_timer" || toolName === "add_note") {
      const uiRes = (await onExecuteLocalUIAction?.(toolName, args)) || { ok: true };
      const rec: ToolExecutionRecord = {
        toolName,
        args,
        result: uiRes,
        timestamp: new Date().toLocaleTimeString(),
      };
      toolExecutions.push(rec);
      return uiRes;
    }

    if (toolName === "capture_screen" && host?.captureScreen) {
      const cap = await host.captureScreen();
      if (cap.ok && cap.dataUrl) {
        activeImage = cap.dataUrl;
      }
      const res = { ok: cap.ok, screen: cap.name || "Primary Display" };
      toolExecutions.push({
        toolName,
        args,
        result: res,
        timestamp: new Date().toLocaleTimeString(),
      });
      return res;
    }

    if (host?.executeTool) {
      const res = await host.executeTool(toolName, args);
      toolExecutions.push({
        toolName,
        args,
        result: res,
        timestamp: new Date().toLocaleTimeString(),
      });
      return res;
    }

    const fallback = { ok: true, simulated: true, message: `Executed ${toolName}` };
    toolExecutions.push({
      toolName,
      args,
      result: fallback,
      timestamp: new Date().toLocaleTimeString(),
    });
    return fallback;
  };

  // Pre-execute deterministic fast intent (e.g. screenshot, weather, search, launch app)
  const fastIntent = parseLocalFastIntent(userText);
  let toolContextNote = "";
  if (fastIntent) {
    const fastRes = await runSingleTool(fastIntent.tool, fastIntent.args);
    toolContextNote = `\n[Executed System Tool "${fastIntent.tool}": ${JSON.stringify(fastRes)}]`;

    const fastLang = detectCodeMixLanguage(userText, detectedLanguage);
    const isHindi = fastLang === "hi-IN" || fastLang === "mr-IN";

    // Instant zero-LLM-latency response for direct OS, YouTube, Spotify, Globe News, and CLI builder commands!
    const instantTools = new Set([
      "get_globe_news",
      "watch_news_topic",
      "unwatch_news_topic",
      "play_spotify",
      "connect_spotify",
      "play_youtube",
      "launch_app",
      "set_volume",
      "media_control",
      "lock_workstation",
      "set_timer",
      "add_note",
      "coding_agent",
    ]);

    if (instantTools.has(fastIntent.tool) && fastRes?.ok !== false) {
      let instantReply = String(("message" in fastRes ? fastRes.message : "") || "Done, sir.");
      const officialSong =
        ("officialSongName" in fastRes && fastRes.officialSongName
          ? String(fastRes.officialSongName)
          : String(fastIntent.args.query || ""));
      const officialArtist =
        "officialArtist" in fastRes && fastRes.officialArtist
          ? ` by ${fastRes.officialArtist}`
          : "";

      if (fastIntent.tool === "watch_news_topic") {
        const watchedTopic = String(fastIntent.args.topic || "");
        instantReply = isHindi
          ? `बिल्कुल sir, मैंने Azure Globe News पर "${watchedTopic}" के लिए live alert लगा दिया है। जैसे ही इस पर कोई नई खबर आएगी, मैं खुद आपको तुरंत inform करूँगा।`
          : `Right away, sir. I am now monitoring Azure Globe News for "${watchedTopic}" and will inform you immediately when a story breaks.`;
      } else if (fastIntent.tool === "get_globe_news") {
        const story =
          "storyBriefing" in fastRes && fastRes.storyBriefing
            ? String(fastRes.storyBriefing)
            : String(("message" in fastRes ? fastRes.message : "") || "");
        if (story) {
          instantReply = story;
        }
      } else if (fastIntent.tool === "play_spotify") {
        instantReply = isHindi
          ? `बिल्कुल sir, मैंने YouTube से "${officialSong}"${officialArtist} identify कर लिया है और Spotify पर play कर रहा हूँ।`
          : `Right away, sir. Identified "${officialSong}"${officialArtist} via YouTube and playing it on Spotify.`;
      } else if (fastIntent.tool === "play_youtube") {
        instantReply = isHindi
          ? `बिल्कुल sir, मैं अभी Chrome में YouTube पर ${officialSong} play कर रहा हूँ।`
          : `Right away, sir. Playing ${officialSong}${officialArtist} on YouTube in Chrome.`;
      } else if (fastIntent.tool === "launch_app") {
        instantReply = isHindi
          ? `बिल्कुल sir, मैंने ${fastIntent.args.app} open कर दिया है।`
          : `Right away, sir. Opening ${fastIntent.args.app}.`;
      } else if (fastIntent.tool === "coding_agent") {
        const ag = String(fastIntent.args.agent || "gemini").toUpperCase();
        instantReply = isHindi
          ? `बिल्कुल sir, मैंने ${ag} CLI को आपका project बनाने के लिए लगा दिया है, तैयार होते ही Chrome में खुल जाएगा।`
          : `Right away, sir. I have dispatched ${ag} CLI to build your website, and it will open in Chrome automatically.`;
      }

      host?.memoryRecordTurn?.({
        userText,
        assistantReply: instantReply,
        languageCode: fastLang,
        actions: toolExecutions,
      }).catch(() => {});

      return {
        reply: instantReply,
        replyLanguageCode: fastLang,
        toolExecutions,
        capturedImage: activeImage,
        providerModel: "JARVIS INSTANT REFLEX",
      };
    }
  }

  const telemetrySummary = telemetry
    ? `Current Windows Host Telemetry: Host=${telemetry.hostname}, CPU=${telemetry.cpuPercent}% (${telemetry.cpuCores} cores), RAM=${telemetry.ramUsedGb}/${telemetry.ramTotalGb} GB (${telemetry.ramPercent}%), Battery=${telemetry.batteryPercent}%, ActiveWindow="${telemetry.activeWindow}".`
    : "Windows Host Online.";

  const userDetectedLang = detectCodeMixLanguage(userText, detectedLanguage);
  const fullSystemPrompt = `${JARVIS_SYSTEM_PROMPT}\n${telemetrySummary}\n${memoryContextBlock}\nUser's Detected Spoken Language Code: ${userDetectedLang} (Respond in a natural code-mixed blend of ${userDetectedLang} and English).`;
  const messagesPayload = [
    ...history.slice(-8).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    {
      role: "user",
      content: userText + toolContextNote,
    },
  ];

  const saveTurnToMemory = (replyText: string, lang: string) => {
    host?.memoryRecordTurn?.({
      userText,
      assistantReply: replyText,
      languageCode: lang,
      actions: toolExecutions,
    }).catch(() => {});
  };

  if (host?.aiChat) {
    const apiKey =
      config.provider === "sarvam"
        ? config.sarvamApiKey || ""
        : config.provider === "gemini"
          ? config.geminiApiKey
          : config.provider === "openai"
            ? config.openaiApiKey
            : "";

    const aiRes = await host.aiChat({
      provider: config.provider,
      model: config.model,
      apiKey,
      ollamaUrl: config.ollamaUrl,
      systemPrompt: fullSystemPrompt,
      messages: messagesPayload,
      imageDataUrl: activeImage,
    });

    if (aiRes.ok && aiRes.text) {
      let cleanReply = aiRes.text;

      // Extract any ```jarvis_tool ... ``` blocks emitted by the LLM and execute them if not already run
      const toolRegex = /```jarvis_tool\s*([\s\S]*?)```/g;
      let match: RegExpExecArray | null;
      while ((match = toolRegex.exec(aiRes.text)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim());
          if (parsed.tool && (!fastIntent || fastIntent.tool !== parsed.tool)) {
            await runSingleTool(parsed.tool, parsed.args || {});
          }
        } catch {
          // ignore malformed tool block
        }
      }

      let tagLang = userDetectedLang;
      const langTagMatch = cleanReply.match(/\[LANG:([a-z]{2}-[A-Z]{2})\]/i);
      if (langTagMatch) {
        tagLang = langTagMatch[1];
      }

      cleanReply = cleanReply
        .replace(/```jarvis_tool[\s\S]*?```/g, "")
        .replace(/\[LANG:[a-z]{2}-[A-Z]{2}\]/gi, "")
        .trim();

      const finalReply = cleanReply || "Done, sir.";
      const finalLang = detectCodeMixLanguage(finalReply, tagLang);
      saveTurnToMemory(finalReply, finalLang);

      return {
        reply: finalReply,
        replyLanguageCode: finalLang,
        toolExecutions,
        capturedImage: activeImage,
        providerModel: `${aiRes.provider?.toUpperCase() || config.provider.toUpperCase()} // ${aiRes.model || config.model}`,
      };
    }
  }

  // Intelligent Local Fallback if offline or provider unconfigured
  if (toolExecutions.length > 0) {
    const last = toolExecutions[toolExecutions.length - 1];
    const fallbackReply = String(
      last.result.message || `I have completed the ${last.toolName.replace("_", " ")} operation, sir.`
    );
    saveTurnToMemory(fallbackReply, userDetectedLang);
    return {
      reply: fallbackReply,
      replyLanguageCode: userDetectedLang,
      toolExecutions,
      capturedImage: activeImage,
      providerModel: "JARVIS LOCAL CORE",
    };
  }

  if (/\b(cpu|ram|memory|system status|diagnostics|telemetry|battery)\b/i.test(userText) && telemetry) {
    return {
      reply: `All systems are nominal, sir. CPU utilization is at ${telemetry.cpuPercent}% across ${telemetry.cpuCores} cores, memory usage stands at ${telemetry.ramUsedGb} of ${telemetry.ramTotalGb} gigabytes (${telemetry.ramPercent}%), and battery reserves are at ${telemetry.batteryPercent}%.`,
      replyLanguageCode: userDetectedLang,
      toolExecutions,
      providerModel: "JARVIS LOCAL CORE",
    };
  }

  return {
    reply: `At your service, sir. All Windows neural subsystems and the hey_jarvis_v0.1.tflite wake-word array are online.`,
    replyLanguageCode: userDetectedLang,
    toolExecutions,
    capturedImage: activeImage,
    providerModel: "JARVIS LOCAL CORE",
  };
}
