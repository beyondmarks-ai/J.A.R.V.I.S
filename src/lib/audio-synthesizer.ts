/**
 * Audio Synthesizer & Low-Latency Sarvam WebSocket TTS Streaming Engine (`bulbul:v3`)
 * Drives the OrbKit Shdr02 `speaking` state and `uOutput` uniform in real-time
 * using a WebAudio AnalyserNode connected to the gapless WebSocket audio stream.
 */

export class JarvisAudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private rafId = 0;
  private isSpeaking = false;
  private activeStreamId: string | null = null;

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.72;
      this.analyser.connect(this.ctx.destination);
      this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * Plays a futuristic Stark-style two-tone harmonic chime when "Hey Jarvis" triggers.
   */
  playWakeChime() {
    try {
      const ctx = this.ensureContext();
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = "sine";
      osc2.type = "triangle";

      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(880.0, now + 0.14); // A5

      osc2.frequency.setValueAtTime(293.66, now); // D4
      osc2.frequency.exponentialRampToValueAtTime(440.0, now + 0.18); // A4

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.16, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.36);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.37);
      osc2.stop(now + 0.37);
    } catch {
      // ignore audio context restrictions before user gesture
    }
  }

  /**
   * Plays a subtle confirmation pulse when Jarvis begins thinking / executing a tool.
   */
  playThinkingPulse() {
    try {
      const ctx = this.ensureContext();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.1); // E5
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.17);
    } catch {
      // ignore
    }
  }

  stopSpeaking(onVolume?: (vol: number) => void, onDone?: () => void) {
    this.activeStreamId = null;
    cancelAnimationFrame(this.rafId);
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    this.isSpeaking = false;
    onVolume?.(0);
    onDone?.();
  }

  private startAnalyserLoop(onVolume?: (vol: number) => void) {
    cancelAnimationFrame(this.rafId);
    const monitorVolume = () => {
      if (!this.isSpeaking || !this.analyser || !this.freqData) return;
      this.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      const count = Math.min(48, this.freqData.length);
      for (let i = 2; i < count; i++) {
        sum += this.freqData[i];
      }
      const avg = sum / ((count - 2) * 255);
      const boosted = Math.min(1, Math.pow(avg * 2.35, 0.82));
      onVolume?.(boosted);
      this.rafId = requestAnimationFrame(monitorVolume);
    };
    this.rafId = requestAnimationFrame(monitorVolume);
  }

  /**
   * Speaks text using:
   *  1. Sarvam AI WebSocket Streaming TTS (`bulbul:v3` over `wss://api.sarvam.ai/text-to-speech/ws`)
   *     with real-time gapless chunk playback as chunks arrive over the WebSocket!
   *  2. Native Windows SpeechSynthesizer WAV fallback
   *  3. Browser SpeechSynthesis fallback
   */
  async speak(
    text: string,
    options: {
      rate?: number;
      speaker?: string;
      languageCode?: string;
      sarvamApiKey?: string;
      onStart?: () => void;
      onVolume?: (vol: number) => void;
      onEnd?: () => void;
    } = {}
  ): Promise<void> {
    this.stopSpeaking();
    const cleanText = text
      .replace(/```[\s\S]*?```/g, "Code block displayed on HUD.")
      .replace(/[*_`#>~-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleanText) {
      options.onEnd?.();
      return;
    }

    const host = (window as unknown as {
      jarvisHost?: {
        streamSarvamTts?: (
          t: string,
          o?: unknown
        ) => Promise<{ ok: boolean; chunksCount?: number }>;
        onSarvamTtsChunk?: (
          cb: (data: {
            streamId: string;
            index: number;
            audioBase64?: string;
            done?: boolean;
          }) => void
        ) => () => void;
        synthesizeSpeech?: (
          t: string,
          o?: unknown
        ) => Promise<{ ok: boolean; audioBase64?: string }>;
      };
    }).jarvisHost;

    // 1. Primary Low-Latency Path: Sarvam WebSocket TTS Streaming (`bulbul:v3`)
    if (host?.streamSarvamTts && host?.onSarvamTtsChunk) {
      const streamedOk = await this.playSarvamWebSocketStream(cleanText, options, host);
      if (streamedOk) return;
    }

    // 2. Fallback: Native Windows SpeechSynthesizer WAV
    if (host?.synthesizeSpeech) {
      try {
        const res = await host.synthesizeSpeech(cleanText, { rate: options.rate ?? 1 });
        if (res?.ok && res.audioBase64) {
          await this.playBase64Wav(res.audioBase64, options);
          return;
        }
      } catch {
        // fall through to Web Speech API fallback
      }
    }

    // 3. Fallback: Browser SpeechSynthesis
    await this.speakWithWebSpeech(cleanText, options);
  }

  private async playSarvamWebSocketStream(
    cleanText: string,
    options: {
      rate?: number;
      speaker?: string;
      languageCode?: string;
      sarvamApiKey?: string;
      onStart?: () => void;
      onVolume?: (vol: number) => void;
      onEnd?: () => void;
    },
    host: {
      streamSarvamTts?: (
        t: string,
        o?: unknown
      ) => Promise<{ ok: boolean; chunksCount?: number }>;
      onSarvamTtsChunk?: (
        cb: (data: {
          streamId: string;
          index: number;
          audioBase64?: string;
          done?: boolean;
        }) => void
      ) => () => void;
    }
  ): Promise<boolean> {
    const ctx = this.ensureContext();
    const streamId = `sarvam-tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.activeStreamId = streamId;

    let nextPlayTime = ctx.currentTime;
    let startedPlayback = false;
    let streamFinished = false;
    let sampleRate = 24000;

    return new Promise<boolean>((resolve) => {
      let unsubscribe: (() => void) | null = null;

      const checkAllDone = () => {
        if (streamFinished && this.activeSources.size === 0) {
          unsubscribe?.();
          if (startedPlayback) {
            this.isSpeaking = false;
            cancelAnimationFrame(this.rafId);
            options.onVolume?.(0);
            options.onEnd?.();
            resolve(true);
          } else {
            resolve(false);
          }
        }
      };

      unsubscribe = host.onSarvamTtsChunk!((chunk) => {
        if (chunk.streamId !== streamId || this.activeStreamId !== streamId) return;

        if (chunk.done) {
          streamFinished = true;
          checkAllDone();
          return;
        }

        if (chunk.audioBase64) {
          const binary = atob(chunk.audioBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }

          // Check if this chunk starts with a 44-byte RIFF WAV header (Chunk 0 in Sarvam WS)
          let pcmOffset = 0;
          if (
            bytes.length >= 44 &&
            bytes[0] === 0x52 && // 'R'
            bytes[1] === 0x49 && // 'I'
            bytes[2] === 0x46 && // 'F'
            bytes[3] === 0x46 // 'F'
          ) {
            const headerView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const parsedRate = headerView.getUint32(24, true);
            if (parsedRate >= 8000 && parsedRate <= 48000) {
              sampleRate = parsedRate;
            }
            pcmOffset = 44;
          }

          const pcmByteLen = bytes.length - pcmOffset;
          const numSamples = Math.floor(pcmByteLen / 2);
          if (numSamples <= 0) {
            // Header-only chunk (44 bytes); wait for PCM data chunks
            return;
          }

          const view = new DataView(
            bytes.buffer,
            bytes.byteOffset + pcmOffset,
            numSamples * 2
          );
          const audioBuffer = ctx.createBuffer(1, numSamples, sampleRate);
          const channelData = audioBuffer.getChannelData(0);
          for (let i = 0; i < numSamples; i++) {
            channelData[i] = view.getInt16(i * 2, true) / 32768.0;
          }

          if (!startedPlayback) {
            startedPlayback = true;
            this.isSpeaking = true;
            options.onStart?.();
            this.startAnalyserLoop(options.onVolume);
          }

          const src = ctx.createBufferSource();
          src.buffer = audioBuffer;
          src.connect(this.analyser!);
          this.activeSources.add(src);

          const startAt = Math.max(ctx.currentTime + 0.015, nextPlayTime);
          src.start(startAt);
          nextPlayTime = startAt + audioBuffer.duration;

          src.onended = () => {
            this.activeSources.delete(src);
            checkAllDone();
          };
        }
      });

      const pace = options.rate ? Math.max(0.7, Math.min(1.6, 1 + options.rate * 0.08)) : 1.05;
      host
        .streamSarvamTts!(cleanText, {
          streamId,
          model: "bulbul:v3",
          speaker: options.speaker || "shubh",
          languageCode: options.languageCode || "en-IN",
          pace,
          apiKey: options.sarvamApiKey,
        })
        .then((res) => {
          streamFinished = true;
          if (!res?.ok && !startedPlayback) {
            unsubscribe?.();
            resolve(false);
            return;
          }
          checkAllDone();
        })
        .catch(() => {
          streamFinished = true;
          if (!startedPlayback) {
            unsubscribe?.();
            resolve(false);
          } else {
            checkAllDone();
          }
        });
    });
  }

  public async playBase64Wav(
    base64Audio: string,
    options: {
      onStart?: () => void;
      onVolume?: (vol: number) => void;
      onEnd?: () => void;
    }
  ): Promise<void> {
    const ctx = this.ensureContext();
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.analyser!);
      this.activeSources.add(source);
      this.isSpeaking = true;
      options.onStart?.();
      this.startAnalyserLoop(options.onVolume);

      source.onended = () => {
        this.activeSources.delete(source);
        this.isSpeaking = false;
        cancelAnimationFrame(this.rafId);
        options.onVolume?.(0);
        options.onEnd?.();
        resolve();
      };

      source.start(0);
    });
  }

  private speakWithWebSpeech(
    text: string,
    options: {
      rate?: number;
      onStart?: () => void;
      onVolume?: (vol: number) => void;
      onEnd?: () => void;
    }
  ): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        options.onEnd?.();
        resolve();
        return;
      }

      const utter = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const british =
        voices.find((v) => v.lang.includes("en-GB") && /George|Ryan|Daniel|Male|Natural/i.test(v.name)) ||
        voices.find((v) => v.lang.includes("en-GB")) ||
        voices[0];
      if (british) utter.voice = british;
      utter.rate = options.rate ? 1 + options.rate * 0.1 : 1.05;
      utter.pitch = 0.94;

      this.isSpeaking = true;
      options.onStart?.();

      const startTime = performance.now();
      const animateEnvelope = () => {
        if (!this.isSpeaking) return;
        const t = (performance.now() - startTime) / 1000;
        const syllabic =
          0.55 +
          0.28 * Math.sin(t * 11.5) * Math.cos(t * 4.3) +
          0.15 * Math.sin(t * 23.0);
        options.onVolume?.(Math.max(0.15, Math.min(1, syllabic)));
        this.rafId = requestAnimationFrame(animateEnvelope);
      };
      this.rafId = requestAnimationFrame(animateEnvelope);

      const finish = () => {
        this.isSpeaking = false;
        cancelAnimationFrame(this.rafId);
        options.onVolume?.(0);
        options.onEnd?.();
        resolve();
      };

      utter.onend = finish;
      utter.onerror = finish;
      window.speechSynthesis.speak(utter);
    });
  }
}
