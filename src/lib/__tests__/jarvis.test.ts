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
  });
});
