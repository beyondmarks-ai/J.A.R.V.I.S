import { useEffect, useRef, useState, useCallback } from "react";
import { Shdr02 } from "@/components/ui/shdr-02";
import type { OrbState } from "@/components/ui/orbkit-core";
import {
  HeyJarvisTFLiteJS,
  int16ToBase64,
  encodeWavBase64FromChunks,
} from "@/lib/tflite-wakeword";
import { JarvisAudioEngine } from "@/lib/audio-synthesizer";
import {
  processJarvisTurn,
  type AIConfig,
  type ChatMessage,
  type SystemTelemetry,
} from "@/lib/jarvis-agent";

export default function App() {
  // Orb State: "idle" | "thinking" | "speaking"
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [orbVisible, setOrbVisible] = useState<boolean>(false);
  const [micVolume, setMicVolume] = useState<number>(0);
  const [agentVolume, setAgentVolume] = useState<number>(0);
  const [isListeningCommand, setIsListeningCommand] = useState<boolean>(false);

  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [aiConfig] = useState<AIConfig>(() => {
    try {
      const saved = localStorage.getItem("jarvis_ai_config");
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return {
      provider: "vertex",
      model: "gemini-4-argon",
      sarvamApiKey: "",
      sarvamSpeaker: "shubh",
      sarvamLanguage: "en-IN",
      geminiApiKey: "",
      openaiApiKey: "",
      ollamaUrl: "http://localhost:11434",
      voiceRate: 1,
      autoSpeak: true,
      realtimeMode: false,
    };
  });

  const tfliteJsRef = useRef<HeyJarvisTFLiteJS>(new HeyJarvisTFLiteJS());
  const audioEngineRef = useRef<JarvisAudioEngine>(new JarvisAudioEngine());
  const isBusyRef = useRef<boolean>(false);
  const agentSpeakingRef = useRef<boolean>(false);
  const postSpeakMuteUntilRef = useRef<number>(0);
  const wakeCooldownRef = useRef<number>(0);
  const commandListenRef = useRef<boolean>(false);
  const preRollChunksRef = useRef<Int16Array[]>([]);
  const recordedChunksRef = useRef<Int16Array[]>([]);
  const noiseFloorRef = useRef<number>(0.012);
  const vadStateRef = useRef<{
    startedAt: number;
    hasSpoken: boolean;
    speechFrames: number;
    lastSpeechAt: number;
    peakRms: number;
    flushed: boolean;
    liveTranscript: string;
    liveLang: string;
    alreadyPromptedYesSir: boolean;
    processing: boolean;
  }>({
    startedAt: 0,
    hasSpoken: false,
    speechFrames: 0,
    lastSpeechAt: 0,
    peakRms: 0.04,
    flushed: false,
    liveTranscript: "",
    liveLang: "en-IN",
    alreadyPromptedYesSir: false,
    processing: false,
  });

  const handleUserCommandRef = useRef<(cmd: string, detectedLang?: string) => Promise<void>>(async () => {});
  const finalizeVoiceRecordingRef = useRef<() => Promise<void>>(async () => {});

  const host = (window as unknown as {
    jarvisHost?: {
      setOrbVisible?: (visible: boolean) => Promise<boolean>;
      wakewordSendPcm?: (b64: string) => Promise<{
        score?: number;
        stage1Score?: number;
        stage2Verified?: boolean;
        framesProcessed?: number;
      }>;
      wakewordReset?: () => Promise<void>;
      getSystemTelemetry?: () => Promise<SystemTelemetry>;
      sarvamSttStart?: (opts?: { languageCode?: string; apiKey?: string }) => Promise<{ ok: boolean }>;
      sarvamSttChunk?: (wavBase64: string) => Promise<{ ok: boolean }>;
      sarvamSttFlush?: () => Promise<{ ok: boolean }>;
      sarvamSttStop?: () => Promise<{ ok: boolean }>;
      onSarvamSttEvent?: (
        cb: (ev: { type: string; text?: string; latencyMs?: number; languageCode?: string }) => void
      ) => () => void;
      transcribeAudio?: (payload: {
        wavBase64: string;
        sarvamApiKey?: string;
        languageCode?: string;
        geminiApiKey?: string;
        openaiApiKey?: string;
      }) => Promise<{ ok: boolean; text?: string; languageCode?: string; engine?: string; latencyMs?: number }>;
      memoryQuery?: (query: string) => Promise<{
        recentTurns?: Array<{
          id: string;
          humanTimestamp: string;
          userText: string;
          assistantReply: string;
        }>;
      }>;
      onAgentComplete?: (
        cb: (data: {
          agent: string;
          projectName: string;
          projectDir: string;
          address: string;
          completedAt: string;
        }) => void
      ) => () => void;
      onNewsAlert?: (
        cb: (data: {
          watchId: string;
          topic: string;
          headline: string;
          place: string;
          source: string;
          url: string;
          languageCode: string;
        }) => void
      ) => () => void;
      onGlobalSummon?: (cb: (data: { trigger: string }) => void) => () => void;
    };
  }).jarvisHost;

  const showOrbSiri = useCallback(() => {
    setOrbVisible(true);
    host?.setOrbVisible?.(true).catch(() => {});
  }, [host]);

  const dismissOrbSiri = useCallback(() => {
    setOrbState("idle");
    setTimeout(() => {
      if (!isBusyRef.current && !commandListenRef.current) {
        setOrbVisible(false);
        host?.setOrbVisible?.(false).catch(() => {});
      }
    }, 450);
  }, [host]);

  // Load `hey_jarvis_v0.1.tflite` & restore persistent conversation memory
  useEffect(() => {
    tfliteJsRef.current.loadFromUrl("./hey_jarvis_v0.1.tflite").catch(() => {});
    if (host?.memoryQuery) {
      host.memoryQuery("").then((mem) => {
        if (Array.isArray(mem?.recentTurns) && mem.recentTurns.length > 0) {
          const restored: ChatMessage[] = [];
          for (const t of mem.recentTurns) {
            restored.push({
              id: `${t.id}-u`,
              role: "user",
              content: t.userText,
              timestamp: t.humanTimestamp,
            });
            restored.push({
              id: `${t.id}-a`,
              role: "assistant",
              content: t.assistantReply,
              timestamp: t.humanTimestamp,
            });
          }
          setMessages(restored);
        }
      });
    }
  }, [host]);

  // Announce when background Gemini CLI or Codex CLI finishes building a website/project
  useEffect(() => {
    if (!host?.onAgentComplete) return;
    return host.onAgentComplete(async ({ agent, projectName }) => {
      if (isBusyRef.current || commandListenRef.current) return;
      isBusyRef.current = true;
      agentSpeakingRef.current = true;
      showOrbSiri();
      setOrbState("speaking");
      const msg = `Sir, ${agent.toUpperCase()} CLI has finished building your ${projectName.replace(/-/g, " ")} project and I have opened it in Chrome.`;
      await audioEngineRef.current.speak(msg, {
        rate: aiConfig.voiceRate,
        speaker: aiConfig.sarvamSpeaker || "shubh",
        languageCode: "en-IN",
        sarvamApiKey: aiConfig.sarvamApiKey,
        onStart: () => setOrbState("speaking"),
        onVolume: (v) => setAgentVolume(v),
        onEnd: () => {
          agentSpeakingRef.current = false;
          postSpeakMuteUntilRef.current = Date.now() + 500;
          setAgentVolume(0);
        },
      });
      agentSpeakingRef.current = false;
      postSpeakMuteUntilRef.current = Date.now() + 500;
      isBusyRef.current = false;
      dismissOrbSiri();
    });
  }, [aiConfig.sarvamApiKey, aiConfig.sarvamSpeaker, aiConfig.voiceRate, dismissOrbSiri, host, showOrbSiri]);

  // Proactive Azure Globe News Sentinel Alert: blooms the orb & speaks breaking news on watched topics
  useEffect(() => {
    if (!host?.onNewsAlert) return;
    return host.onNewsAlert(async ({ topic, headline, languageCode }) => {
      if (isBusyRef.current || commandListenRef.current) return;
      isBusyRef.current = true;
      agentSpeakingRef.current = true;
      showOrbSiri();
      audioEngineRef.current.playWakeChime();
      setOrbState("speaking");

      const isHindi = languageCode === "hi-IN" || languageCode === "mr-IN";
      const alertSpeech = isHindi
        ? `Excuse me sir, Azure Globe News पर ${topic} को लेकर एक नई खबर आई है: ${headline}.`
        : `Excuse me, sir. Breaking update on ${topic} from Azure Globe News: ${headline}.`;

      await audioEngineRef.current.speak(alertSpeech, {
        rate: aiConfig.voiceRate,
        speaker: aiConfig.sarvamSpeaker || "shubh",
        languageCode: languageCode || "en-IN",
        sarvamApiKey: aiConfig.sarvamApiKey,
        onStart: () => {
          agentSpeakingRef.current = true;
          setOrbState("speaking");
        },
        onVolume: (v) => setAgentVolume(v),
        onEnd: () => {
          agentSpeakingRef.current = false;
          postSpeakMuteUntilRef.current = Date.now() + 500;
          setAgentVolume(0);
        },
      });
      agentSpeakingRef.current = false;
      postSpeakMuteUntilRef.current = Date.now() + 500;
      isBusyRef.current = false;
      dismissOrbSiri();
    });
  }, [aiConfig.sarvamApiKey, aiConfig.sarvamSpeaker, aiConfig.voiceRate, dismissOrbSiri, host, showOrbSiri]);

  // Poll Windows System Telemetry silently in background
  useEffect(() => {
    const fetchTelemetry = async () => {
      if (host?.getSystemTelemetry) {
        try {
          const data = await host.getSystemTelemetry();
          setTelemetry(data);
        } catch {
          // ignore
        }
      }
    };
    fetchTelemetry();
    const timer = setInterval(fetchTelemetry, 4000);
    return () => clearInterval(timer);
  }, [host]);

  // Main Turn Handler: Idle -> Thinking -> Speaking -> Auto-Dismiss (Siri style)
  const handleUserCommand = useCallback(
    async (rawCommand: string, detectedLang = "en-IN") => {
      const cleaned = rawCommand.trim();
      if (!cleaned || isBusyRef.current) return;

      isBusyRef.current = true;
      commandListenRef.current = false;
      setIsListeningCommand(false);
      showOrbSiri();

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        content: cleaned,
        timestamp: new Date().toLocaleTimeString(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setOrbState("thinking");
      audioEngineRef.current.playThinkingPulse();

      try {
        const result = await processJarvisTurn({
          userText: cleaned,
          detectedLanguage: detectedLang,
          history: [...messages, userMsg],
          config: aiConfig,
          telemetry,
        });

        const assistantMsg: ChatMessage = {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: result.reply,
          timestamp: new Date().toLocaleTimeString(),
          toolExecutions: result.toolExecutions,
          providerModel: result.providerModel,
        };
        setMessages((prev) => [...prev, assistantMsg]);

        setOrbState("speaking");
        agentSpeakingRef.current = true;
        await audioEngineRef.current.speak(result.reply, {
          rate: aiConfig.voiceRate,
          speaker: aiConfig.sarvamSpeaker || "shubh",
          languageCode: result.replyLanguageCode || detectedLang || "en-IN",
          sarvamApiKey: aiConfig.sarvamApiKey,
          onStart: () => {
            agentSpeakingRef.current = true;
            setOrbState("speaking");
          },
          onVolume: (vol) => setAgentVolume(vol),
          onEnd: () => {
            agentSpeakingRef.current = false;
            postSpeakMuteUntilRef.current = Date.now() + 500;
            setAgentVolume(0);
            setOrbState("idle");
          },
        });
      } catch {
        agentSpeakingRef.current = false;
        setOrbState("idle");
      } finally {
        agentSpeakingRef.current = false;
        postSpeakMuteUntilRef.current = Date.now() + 500;
        wakeCooldownRef.current = Date.now();
        await host?.wakewordReset?.().catch(() => {});
        isBusyRef.current = false;
        dismissOrbSiri();
      }
    },
    [aiConfig, dismissOrbSiri, host, messages, showOrbSiri, telemetry]
  );

  useEffect(() => {
    handleUserCommandRef.current = handleUserCommand;
  }, [handleUserCommand]);

  const startCommandRecording = useCallback(
    (alreadyPrompted = false, includePreRoll = false) => {
      recordedChunksRef.current = includePreRoll ? [...preRollChunksRef.current] : [];
      const now = Date.now();
      vadStateRef.current = {
        startedAt: now,
        hasSpoken: false,
        speechFrames: 0,
        lastSpeechAt: now,
        peakRms: Math.max(noiseFloorRef.current * 2.2, 0.035),
        flushed: false,
        liveTranscript: "",
        liveLang: "en-IN",
        alreadyPromptedYesSir: alreadyPrompted,
        processing: false,
      };
      commandListenRef.current = true;
      setIsListeningCommand(true);
      setOrbState("thinking");

      // Open live Sarvam saaras:v3 WebSocket immediately so audio streams while user speaks!
      host?.sarvamSttStart?.({
        languageCode: "auto",
        apiKey: aiConfig.sarvamApiKey,
      }).catch(() => {});
    },
    [aiConfig.sarvamApiKey, host]
  );

  // Listen for live WebSocket transcripts from Sarvam saaras:v3, accumulating clauses if user pauses mid-sentence!
  useEffect(() => {
    if (!host?.onSarvamSttEvent) return;
    return host.onSarvamSttEvent(async (ev) => {
      if (!commandListenRef.current || vadStateRef.current.processing) return;

      const elapsed = Date.now() - vadStateRef.current.startedAt;
      if (ev.type === "START_SPEECH" && elapsed > 320) {
        vadStateRef.current.hasSpoken = true;
        vadStateRef.current.lastSpeechAt = Date.now();
        vadStateRef.current.flushed = false;
      } else if (ev.type === "TRANSCRIPT") {
        const piece = (ev.text || "")
          .replace(
            /^(?:hey\s+jarvis|hi\s+jarvis|ok\s+jarvis|jarvis|हे\s+जार्विस|हे\s+जर्विस|यार\s+जार्विस|यार\s+जर्विस|जार्विस|जर्विस)[,!.?\s]*/i,
            ""
          )
          .trim();

        if (piece && piece !== "WAKE_ONLY" && piece !== "EMPTY") {
          vadStateRef.current.liveTranscript = vadStateRef.current.liveTranscript
            ? `${vadStateRef.current.liveTranscript} ${piece}`.trim()
            : piece;
          if (ev.languageCode) {
            vadStateRef.current.liveLang = ev.languageCode;
          }
        }

        const fullText = vadStateRef.current.liveTranscript;
        const silenceDuration = Date.now() - vadStateRef.current.lastSpeechAt;
        // Check if sentence ends with an incomplete dangling word (e.g. "Is there any news related to...")
        const isDanglingIncomplete =
          /\b(?:to|from|about|on|in|for|with|of|by|that| goes|related\s+to|play|open|search)\s*[?.!]*$/i.test(
            fullText
          ) || /(?:पर|में|का|की|के|को|से)\s*[।?.!]*$/.test(fullText);

        // Only execute immediately from WebSocket if we already flushed after real silence AND sentence is complete!
        if (
          fullText.length >= 2 &&
          vadStateRef.current.flushed &&
          silenceDuration >= 1000 &&
          (!isDanglingIncomplete || silenceDuration >= 2000)
        ) {
          vadStateRef.current.processing = true;
          commandListenRef.current = false;
          setIsListeningCommand(false);
          recordedChunksRef.current = [];
          host.sarvamSttStop?.().catch(() => {});
          host.wakewordReset?.().catch(() => {});
          vadStateRef.current.processing = false;
          await handleUserCommandRef.current(fullText, vadStateRef.current.liveLang);
        }
      }
    });
  }, [host]);

  const finalizeVoiceRecording = useCallback(async () => {
    if (vadStateRef.current.processing || !commandListenRef.current) return;
    vadStateRef.current.processing = true;
    commandListenRef.current = false;
    setIsListeningCommand(false);
    host?.sarvamSttStop?.().catch(() => {});

    const chunks = recordedChunksRef.current;
    recordedChunksRef.current = [];
    const hadSpeech = vadStateRef.current.hasSpoken;
    const alreadyPrompted = vadStateRef.current.alreadyPromptedYesSir;

    if (chunks.length === 0) {
      vadStateRef.current.processing = false;
      dismissOrbSiri();
      return;
    }

    setOrbState("thinking");

    try {
      let transcribed = vadStateRef.current.liveTranscript.trim();
      let detectedLang = vadStateRef.current.liveLang || "en-IN";
      if (!transcribed && host?.transcribeAudio && (hadSpeech || chunks.length >= 6)) {
        const wavBase64 = encodeWavBase64FromChunks(chunks, 16000);
        const sttRes = await host.transcribeAudio({
          wavBase64,
          sarvamApiKey: aiConfig.sarvamApiKey,
          languageCode: "auto",
          geminiApiKey: aiConfig.geminiApiKey,
          openaiApiKey: aiConfig.openaiApiKey,
        });
        transcribed = (sttRes?.text || "").trim();
        detectedLang = sttRes?.languageCode || "en-IN";
      }

      const cleanedCommand = transcribed
        .replace(/^(?:hey\s+jarvis|hi\s+jarvis|ok\s+jarvis|jarvis|हे\s+जार्विस|हे\s+जर्विस|यार\s+जार्विस|यार\s+जर्विस|जार्विस|जर्विस)[,!.?\s]*/i, "")
        .trim();

      if (
        cleanedCommand &&
        cleanedCommand !== "WAKE_ONLY" &&
        cleanedCommand !== "EMPTY" &&
        cleanedCommand.length >= 2
      ) {
        vadStateRef.current.processing = false;
        await handleUserCommandRef.current(cleanedCommand, detectedLang);
        return;
      }

      if (!alreadyPrompted) {
        setOrbState("speaking");
        agentSpeakingRef.current = true;
        await audioEngineRef.current.speak("Yes, sir? I am listening.", {
          rate: aiConfig.voiceRate,
          speaker: aiConfig.sarvamSpeaker || "shubh",
          languageCode: aiConfig.sarvamLanguage || "en-IN",
          sarvamApiKey: aiConfig.sarvamApiKey,
          onStart: () => {
            agentSpeakingRef.current = true;
            setOrbState("speaking");
          },
          onVolume: (v) => setAgentVolume(v),
          onEnd: () => {
            agentSpeakingRef.current = false;
            postSpeakMuteUntilRef.current = Date.now() + 450;
            setAgentVolume(0);
          },
        });
        agentSpeakingRef.current = false;
        postSpeakMuteUntilRef.current = Date.now() + 450;
        await new Promise((r) => setTimeout(r, 400));
        vadStateRef.current.processing = false;
        startCommandRecording(true, false);
        return;
      }

      dismissOrbSiri();
    } catch {
      dismissOrbSiri();
    } finally {
      vadStateRef.current.processing = false;
      host?.wakewordReset?.().catch(() => {});
    }
  }, [
    aiConfig.geminiApiKey,
    aiConfig.openaiApiKey,
    aiConfig.sarvamApiKey,
    aiConfig.sarvamLanguage,
    aiConfig.sarvamSpeaker,
    aiConfig.voiceRate,
    dismissOrbSiri,
    host,
    startCommandRecording,
  ]);

  useEffect(() => {
    finalizeVoiceRecordingRef.current = finalizeVoiceRecording;
  }, [finalizeVoiceRecording]);

  const triggerWakeActivation = useCallback(() => {
    const now = Date.now();
    if (now - wakeCooldownRef.current < 2500 || isBusyRef.current || commandListenRef.current) return;
    wakeCooldownRef.current = now;

    showOrbSiri();
    audioEngineRef.current.stopSpeaking();
    audioEngineRef.current.playWakeChime();
    startCommandRecording(false, false);
  }, [showOrbSiri, startCommandRecording]);

  // Global Hotkey Summon Listener (Alt+Space / Ctrl+Shift+J / System Tray)
  useEffect(() => {
    if (!host?.onGlobalSummon) return;
    return host.onGlobalSummon(() => {
      triggerWakeActivation();
    });
  }, [host, triggerWakeActivation]);

  // 16kHz Microphone Audio Stream -> `hey_jarvis_v0.1.tflite` & Command VAD Recorder
  useEffect(() => {
    let cancelled = false;
    let audioCtx: AudioContext | null = null;
    let mediaStream: MediaStream | null = null;
    let processor: ScriptProcessorNode | null = null;
    let drainingWakeQueue = false;
    const pendingWakeQueue: Int16Array[] = [];

    const drainWakeQueue = async () => {
      if (drainingWakeQueue || !host?.wakewordSendPcm) return;
      drainingWakeQueue = true;
      try {
        while (
          pendingWakeQueue.length > 0 &&
          !cancelled &&
          !isBusyRef.current &&
          !commandListenRef.current
        ) {
          const totalLen = pendingWakeQueue.reduce((acc, c) => acc + c.length, 0);
          const merged = new Int16Array(totalLen);
          let offset = 0;
          while (pendingWakeQueue.length > 0) {
            const c = pendingWakeQueue.shift()!;
            merged.set(c, offset);
            offset += c.length;
          }
          const b64 = int16ToBase64(merged);
          const res = await host.wakewordSendPcm(b64);
          if (typeof res?.score === "number" && res.score >= 0.22 && !commandListenRef.current) {
            pendingWakeQueue.length = 0;
            triggerWakeActivation();
            break;
          }
        }
      } catch {
        // ignore IPC error
      } finally {
        drainingWakeQueue = false;
      }
    };

    const startAudioPipeline = async () => {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }

        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtx = new AudioCtx({ sampleRate: 16000 });
        const actualRate = audioCtx.sampleRate;
        const source = audioCtx.createMediaStreamSource(mediaStream);
        processor = audioCtx.createScriptProcessor(2048, 1, 1);

        processor.onaudioprocess = (e) => {
          if (cancelled) return;

          // Hard-mute microphone while Jarvis is speaking or during speaker-reverb tail
          if (agentSpeakingRef.current || Date.now() < postSpeakMuteUntilRef.current) {
            pendingWakeQueue.length = 0;
            setMicVolume(0);
            return;
          }

          const rawInput = e.inputBuffer.getChannelData(0);

          // Resample to 16000 Hz if Windows audio driver locked AudioContext to 48000 / 44100 Hz
          let floatSamples: Float32Array;
          if (actualRate !== 16000) {
            const ratio = actualRate / 16000;
            const outLen = Math.round(rawInput.length / ratio);
            floatSamples = new Float32Array(outLen);
            for (let i = 0; i < outLen; i++) {
              floatSamples[i] = rawInput[Math.min(rawInput.length - 1, Math.floor(i * ratio))];
            }
          } else {
            floatSamples = rawInput;
          }

          const pcm16 = new Int16Array(floatSamples.length);
          let sumSq = 0;
          for (let i = 0; i < floatSamples.length; i++) {
            sumSq += floatSamples[i] * floatSamples[i];
          }

          const rawRms = Math.sqrt(sumSq / floatSamples.length);
          const visualRms = Math.min(1, rawRms * 6.0);
          setMicVolume(visualRms);

          // Mode A: Recording & Live-Streaming User's Spoken Command to Sarvam saaras:v3 WebSocket
          if (commandListenRef.current && !vadStateRef.current.processing) {
            pendingWakeQueue.length = 0;
            const now = Date.now();
            const elapsed = now - vadStateRef.current.startedAt;

            // Skip the first 300ms while the wake chime plays so chime audio never enters STT
            if (elapsed <= 300) {
              return;
            }

            // Relative-to-Peak Speech Detection: adapts to user's voice peak and drops immediately when user stops talking
            const minSpeechRms = Math.max(noiseFloorRef.current * 2.2, 0.022);
            const dynamicThreshold = vadStateRef.current.hasSpoken
              ? Math.max(minSpeechRms, vadStateRef.current.peakRms * 0.28)
              : minSpeechRms;

            const isSpeechFrame = rawRms > dynamicThreshold;

            if (isSpeechFrame) {
              vadStateRef.current.speechFrames += 1;
              vadStateRef.current.lastSpeechAt = now;
              if (rawRms > vadStateRef.current.peakRms) {
                vadStateRef.current.peakRms = rawRms * 0.85 + vadStateRef.current.peakRms * 0.15;
              }
              if (vadStateRef.current.speechFrames >= 2 && !vadStateRef.current.hasSpoken) {
                vadStateRef.current.hasSpoken = true;
              }
            }

            // Keep natural 1.45x gain during speech and natural pauses so Sarvam never cuts off mid-sentence
            const gain = 1.45;

            for (let i = 0; i < floatSamples.length; i++) {
              const s = Math.max(-1, Math.min(1, floatSamples[i] * gain));
              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }

            recordedChunksRef.current.push(pcm16);

            // Stream this 128ms chunk live to the open Sarvam saaras:v3 WebSocket!
            if (host?.sarvamSttChunk) {
              host.sarvamSttChunk(encodeWavBase64FromChunks([pcm16], 16000)).catch(() => {});
            }

            const silenceDuration = now - vadStateRef.current.lastSpeechAt;
            // Wait 1150ms of real silence after speaking before flushing so natural pauses ("related to ... Tiger Shroff") are never cut off!
            if (vadStateRef.current.hasSpoken && silenceDuration > 1150 && !vadStateRef.current.flushed) {
              vadStateRef.current.flushed = true;
              host?.sarvamSttFlush?.().catch(() => {});
            }

            // Finalize at 1450ms after last word if WebSocket didn't already resolve via onSarvamSttEvent
            const finishedSpeaking = vadStateRef.current.hasSpoken && silenceDuration > 1450;
            const maxTimeReached = elapsed > 20000;
            const noSpeechTimeout = !vadStateRef.current.hasSpoken && elapsed > 5000;

            if (finishedSpeaking || maxTimeReached || noSpeechTimeout) {
              finalizeVoiceRecordingRef.current();
            }
            return;
          }

          // Update ambient noise floor estimate while idle
          if (!isBusyRef.current && rawRms > 0.0005 && rawRms < 0.04) {
            noiseFloorRef.current = noiseFloorRef.current * 0.92 + rawRms * 0.08;
          }

          for (let i = 0; i < floatSamples.length; i++) {
            const s = Math.max(-1, Math.min(1, floatSamples[i] * 1.35));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }

          preRollChunksRef.current.push(pcm16);
          if (preRollChunksRef.current.length > 8) {
            preRollChunksRef.current.shift();
          }

          // Mode B: Zero-drop queue to hey_jarvis_v0.1.tflite worker when Idle
          if (!isBusyRef.current && !commandListenRef.current) {
            pendingWakeQueue.push(pcm16);
            if (pendingWakeQueue.length > 16) {
              pendingWakeQueue.shift();
            }
            drainWakeQueue();
          }
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
      } catch {
        // ignore
      }
    };

    startAudioPipeline();

    return () => {
      cancelled = true;
      if (processor) {
        try {
          processor.disconnect();
        } catch {
          // ignore
        }
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
      }
      if (audioCtx && audioCtx.state !== "closed") {
        audioCtx.close().catch(() => {});
      }
    };
  }, [host, triggerWakeActivation]);

  const liveVolumes =
    orbState === "speaking"
      ? { input: micVolume, output: Math.max(0.35, agentVolume) }
      : isListeningCommand
        ? { input: Math.max(0.25, micVolume), output: 0.45 }
        : { input: micVolume, output: undefined };

  // Pure Transparent Floating Orb with iPhone Siri-style Bloom & Rise Animation
  return (
    <div
      onDoubleClick={() => {
        if (isListeningCommand) {
          finalizeVoiceRecording();
        } else {
          triggerWakeActivation();
        }
      }}
      className="w-screen h-screen bg-transparent flex items-center justify-center overflow-hidden app-drag"
    >
      <div
        style={{
          transform: orbVisible
            ? "translate3d(0, 0px, 0) scale(1)"
            : "translate3d(0, 64px, 0) scale(0.12)",
          opacity: orbVisible ? 1 : 0,
          transition: orbVisible
            ? "transform 520ms cubic-bezier(0.16, 1, 0.3, 1), opacity 280ms ease-out"
            : "transform 420ms cubic-bezier(0.4, 0, 0.2, 1), opacity 320ms ease-in",
          willChange: "transform, opacity",
        }}
      >
        <Shdr02
          state={orbState}
          size={270}
          wrapper="none"
          volumes={liveVolumes}
          params={
            orbVisible
              ? undefined
              : { radius: 0.15, gain: 0.02, rim: 0, baseVis: 0, alphaGain: 0.1 }
          }
        />
      </div>
    </div>
  );
}
