import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HeyJarvisTFLiteJS } from "@/lib/tflite-wakeword";
import { shdr02Orb } from "@/components/ui/shdr-02";
import { ORB_STATES, defaultValuesFor } from "@/components/ui/orbkit-core";
import { parseLocalFastIntent, detectCodeMixLanguage } from "@/lib/jarvis-agent";

describe("OrbKit SHDR-02 (Rocaille) Shader Configuration", () => {
  it("defines all 3 required states: idle, thinking, and speaking", () => {
    expect(ORB_STATES).toEqual(["idle", "thinking", "speaking"]);
    expect(shdr02Orb.key).toBe("shdr-02");
    expect(shdr02Orb.statePresets?.idle).toBeDefined();
    expect(shdr02Orb.statePresets?.thinking).toBeDefined();
    expect(shdr02Orb.statePresets?.speaking).toBeDefined();
  });

  it("escalates evolution speed across idle -> thinking -> speaking presets", () => {
    const idleSpeed = shdr02Orb.statePresets!.idle!.speed;
    const thinkingSpeed = shdr02Orb.statePresets!.thinking!.speed;
    const speakingSpeed = shdr02Orb.statePresets!.speaking!.speed;

    expect(idleSpeed).toBeLessThan(thinkingSpeed);
    expect(thinkingSpeed).toBeLessThan(speakingSpeed);

    const defaults = defaultValuesFor(shdr02Orb);
    expect(Object.keys(defaults.params).length).toBe(15);
  });
});

describe("hey_jarvis_v0.1.tflite Neural Cascade Engine", () => {
  it("loads hey_jarvis_v0.1.tflite FlatBuffer and runs 2-stage inference", () => {
    const modelPath = path.resolve(process.cwd(), "hey_jarvis_v0.1.tflite");
    expect(fs.existsSync(modelPath)).toBe(true);

    const nodeBuf = fs.readFileSync(modelPath);
    const arrayBuffer = nodeBuf.buffer.slice(
      nodeBuf.byteOffset,
      nodeBuf.byteOffset + nodeBuf.byteLength
    );

    const engine = new HeyJarvisTFLiteJS();
    const meta = engine.loadFromArrayBuffer(arrayBuffer);

    expect(meta.loaded).toBe(true);
    expect(meta.magic).toBe("TFL3");
    expect(meta.byteLength).toBe(1278912);
    expect(meta.threshold).toBeCloseTo(0.5, 4);

    // Silence embedding vector (all zeros) should produce near-zero wake word probability
    const silenceFeatures = new Float32Array(1536);
    const pred = engine.predict(silenceFeatures);
    expect(pred.score).toBeGreaterThan(0);
    expect(pred.score).toBeLessThan(0.01);
    expect(pred.stage2Verified).toBe(false);
  });
});

describe("J.A.R.V.I.S. Windows Fast Intent Router", () => {
  it("parses Windows application launch commands", () => {
    expect(parseLocalFastIntent("Hey Jarvis open calculator")).toEqual({
      tool: "launch_app",
      args: { app: "calculator" },
    });
  });

  it("parses volume, weather, screen capture, and timer commands", () => {
    expect(parseLocalFastIntent("set volume to 75%")).toEqual({
      tool: "set_volume",
      args: { action: "set", level: 75 },
    });
    expect(parseLocalFastIntent("what is the weather in Tokyo?")).toEqual({
      tool: "get_weather",
      args: { location: "tokyo" },
    });
    expect(parseLocalFastIntent("set a timer for 5 minutes")).toEqual({
      tool: "set_timer",
      args: { seconds: 300, label: "5 minutes" },
    });
    expect(parseLocalFastIntent("look at my screen")).toEqual({
      tool: "capture_screen",
      args: {},
    });
  });

  it("parses English and Hinglish YouTube song playback commands and detects code-mixed scripts", () => {
    expect(parseLocalFastIntent("open YouTube and play Barsaat song")).toEqual({
      tool: "play_youtube",
      args: { query: "Barsaat song" },
    });
    expect(parseLocalFastIntent("YouTube पर बरसात song चलाओ")).toEqual({
      tool: "play_youtube",
      args: { query: "बरसात song" },
    });

    expect(detectCodeMixLanguage("बिल्कुल sir, मैं अभी YouTube पर Barsaat song play कर रहा हूँ।")).toBe("hi-IN");
    expect(detectCodeMixLanguage("நிச்சயமாக sir, YouTube open செய்கிறேன்")).toBe("ta-IN");
    expect(detectCodeMixLanguage("All systems are nominal, sir.")).toBe("en-IN");

    const geminiSite = parseLocalFastIntent("build me a modern portfolio website");
    expect(geminiSite?.tool).toBe("coding_agent");
    expect(geminiSite?.args.agent).toBe("gemini");

    const codexSite = parseLocalFastIntent("use codex to create a coffee shop landing page");
    expect(codexSite?.tool).toBe("coding_agent");
    expect(codexSite?.args.agent).toBe("codex");

    expect(parseLocalFastIntent("Play the song that goes kesariya tera ishq hai piya on Spotify")).toEqual({
      tool: "play_spotify",
      args: { query: "kesariya tera ishq hai piya" },
    });
    expect(parseLocalFastIntent("Spotify pe kesariya tera ishq hai piya play karo")).toEqual({
      tool: "play_spotify",
      args: { query: "kesariya tera ishq hai piya" },
    });
    expect(parseLocalFastIntent("Connect my Spotify")).toEqual({
      tool: "connect_spotify",
      args: {},
    });
    expect(parseLocalFastIntent("If any news comes on Virat Kohli inform me")).toEqual({
      tool: "watch_news_topic",
      args: {
        topic: "Virat Kohli",
        languageCode: "en-IN",
      },
    });
    expect(parseLocalFastIntent("अगर Bitcoin पर कोई news आए तो मुझे बताना")).toEqual({
      tool: "watch_news_topic",
      args: {
        topic: "Bitcoin",
        languageCode: "hi-IN",
      },
    });
    expect(parseLocalFastIntent("What is the latest news on India?")).toEqual({
      tool: "get_globe_news",
      args: {
        topic: "India",
        languageCode: "en-IN",
      },
    });
    expect(parseLocalFastIntent("Is there any news related to Tiger Shroff?")).toEqual({
      tool: "get_globe_news",
      args: {
        topic: "Tiger Shroff",
        languageCode: "en-IN",
      },
    });
    expect(parseLocalFastIntent("Tiger Shroff News")).toEqual({
      tool: "get_globe_news",
      args: {
        topic: "Tiger Shroff",
        languageCode: "en-IN",
      },
    });
    // Dangling incomplete sentence should NOT trigger Global/China news
    expect(parseLocalFastIntent("Is there any news related to")).toBeNull();
    expect(parseLocalFastIntent("Is there any latest news related to cockroach?")).toEqual({
      tool: "get_globe_news",
      args: {
        topic: "cockroach",
        languageCode: "en-IN",
      },
    });
  });

  it("crawls 3 websites via Firecrawl, stores full content in news_temp_cache.json, and synthesizes a 'What Happened' story without URLs", async () => {
    const mainCode = fs.readFileSync(path.resolve(process.cwd(), "electron/main.cjs"), "utf8");
    const start = mainCode.indexOf("const GLOBE_NEWS_BASE_URL");
    const end = mainCode.indexOf("async function checkNewsWatchesAndNotify");
    const fn = new Function(
      "fs",
      "path",
      "MEMORY_DIR",
      "formatFullTimestamp",
      "getVertexCredentials",
      "getSarvamKey",
      "memoryState",
      "saveMemoryToDiskAsync",
      `${mainCode.slice(start, end)}; return { crawlAndSynthesizeNewsStory, searchGlobeNews };`
    );
    const { crawlAndSynthesizeNewsStory } = fn(
      fs,
      path,
      path.resolve(process.cwd(), "memory"),
      () => new Date().toISOString(),
      async () => ({ token: null, project: null }),
      () => process.env.SARVAM_API_KEY || "sk_r19548c3_Z4nB2N2M87K6t5k1G7b9P2n3",
      { addresses: {} },
      () => {}
    );

    const res = await crawlAndSynthesizeNewsStory("Is there any news related to Tiger Shroff?", "en-IN");
    expect(res.ok).toBe(true);
    expect(res.websitesCount).toBeGreaterThanOrEqual(2);
    expect(res.storyBriefing.toLowerCase()).toContain("tiger");
    expect(res.storyBriefing).not.toMatch(/https?:\/\//i);

    // Verify Temporary News Cache file was written with full multi-website content for follow-up Q&A
    const cacheFile = path.resolve(process.cwd(), "memory/news_temp_cache.json");
    expect(fs.existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(cached.topic).toBe("Tiger Shroff");
    expect(cached.websites.length).toBeGreaterThanOrEqual(2);
    expect(cached.websites[0].content.length).toBeGreaterThan(100);
  }, 25000);
});
