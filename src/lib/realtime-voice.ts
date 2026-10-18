/**
 * Realtime Native Voice API Client (Gemini Multimodal Live API & OpenAI Realtime API)
 * Streams 16kHz/24kHz PCM audio bidirectionally over WebSockets and drives
 * the OrbKit Shdr02 `idle`, `thinking`, and `speaking` states in real time.
 */

import type { OrbState } from "@/components/ui/orbkit-core";

export interface RealtimeVoiceCallbacks {
  onStateChange: (state: OrbState) => void;
  onVolumeChange: (volumes: { input?: number; output?: number }) => void;
  onTranscript: (role: "user" | "assistant", text: string) => void;
  onError: (err: string) => void;
  onClose: () => void;
}

export class RealtimeVoiceSession {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private nextPlayTime = 0;
  private active = false;

  async startGeminiLive(apiKey: string, model = "models/gemini-2.0-flash-exp", cb: RealtimeVoiceCallbacks) {
    this.stop();
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;

    this.ws = new WebSocket(url);
    this.active = true;

    this.ws.onopen = async () => {
      const setupMsg = {
        setup: {
          model: model.startsWith("models/") ? model : `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Charon",
                },
              },
            },
          },
          systemInstruction: {
            parts: [
              {
                text: "You are J.A.R.V.I.S., Tony Stark's refined British AI assistant running natively on Windows. Be concise, witty, composed, and helpful.",
              },
            ],
          },
        },
      };
      this.ws?.send(JSON.stringify(setupMsg));
      await this.startMicCapture(16000, (base64Pcm, inputRms) => {
        cb.onVolumeChange({ input: inputRms });
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(
            JSON.stringify({
              realtimeInput: {
                mediaChunks: [
                  {
                    mimeType: "audio/pcm;rate=16000",
                    data: base64Pcm,
                  },
                ],
              },
            })
          );
        }
      });
      cb.onStateChange("idle");
    };

    this.ws.onmessage = async (event) => {
      try {
        const textData = event.data instanceof Blob ? await event.data.text() : String(event.data);
        const msg = JSON.parse(textData);
        const parts = msg?.serverContent?.modelTurn?.parts || [];
        for (const part of parts) {
          if (part.text) {
            cb.onTranscript("assistant", part.text);
          }
          if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith("audio/pcm")) {
            cb.onStateChange("speaking");
            this.playPcm24kChunk(part.inlineData.data, (outVol) => {
              cb.onVolumeChange({ output: outVol });
            }, () => {
              cb.onStateChange("idle");
              cb.onVolumeChange({ output: 0 });
            });
          }
        }
      } catch {
        // ignore non-JSON frame
      }
    };

    this.ws.onerror = () => {
      cb.onError("Gemini Live WebSocket error. Verify your Gemini API key.");
    };

    this.ws.onclose = () => {
      this.stop();
      cb.onClose();
    };
  }

  private async startMicCapture(
    sampleRate: number,
    onChunk: (base64Pcm: string, rms: number) => void
  ) {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new AudioCtx({ sampleRate });
    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this.active) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        sumSq += s * s;
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const rms = Math.min(1, Math.sqrt(sumSq / input.length) * 4.5);
      const bytes = new Uint8Array(pcm16.buffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      onChunk(btoa(bin), rms);
    };

    source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  private playPcm24kChunk(
    base64Pcm: string,
    onVolume: (v: number) => void,
    onEndedAll: () => void
  ) {
    if (!this.audioCtx) return;
    const bin = atob(base64Pcm);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    let sumSq = 0;
    for (let i = 0; i < pcm16.length; i++) {
      const f = pcm16[i] / 32768;
      float32[i] = f;
      sumSq += f * f;
    }
    const rms = Math.min(1, Math.sqrt(sumSq / Math.max(1, pcm16.length)) * 3.8);
    onVolume(rms);

    const buf = this.audioCtx.createBuffer(1, float32.length, 24000);
    buf.getChannelData(0).set(float32);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.audioCtx.destination);

    const now = this.audioCtx.currentTime;
    const startAt = Math.max(now, this.nextPlayTime);
    src.start(startAt);
    this.nextPlayTime = startAt + buf.duration;

    src.onended = () => {
      if (this.audioCtx && this.audioCtx.currentTime >= this.nextPlayTime - 0.05) {
        onEndedAll();
      }
    };
  }

  stop() {
    this.active = false;
    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch {
        // ignore
      }
      this.processor = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
