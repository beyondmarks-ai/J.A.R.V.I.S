/**
 * Native TypeScript FlatBuffer Loader & Evaluator for `hey_jarvis_v0.1.tflite`
 * Plus Hybrid Streaming Microphone Wake-Word Detector (16kHz PCM -> TFLite Co-Processor + JS Cascade).
 */

export interface TFLiteModelMetadata {
  loaded: boolean;
  magic: string;
  byteLength: number;
  stage1Shape: string;
  stage2Shape: string;
  threshold: number;
  epsilon: number;
}

export interface WakeWordScoreEvent {
  score: number;
  stage1Score: number;
  stage2Verified: boolean;
  inputVolume: number;
  triggered: boolean;
  source: "tflite-native" | "tflite-js" | "speech-phrase" | "manual";
  framesProcessed: number;
}

/**
 * Pure TypeScript evaluator for the exact 2-stage neural cascade inside `hey_jarvis_v0.1.tflite`.
 * Reads the float32 weight buffers directly from the `.tflite` ArrayBuffer at their exact FlatBuffer offsets.
 */
export class HeyJarvisTFLiteJS {
  private W1!: Float32Array;
  private b1!: Float32Array;
  private g1!: Float32Array;
  private bt1!: Float32Array;
  private W2!: Float32Array;
  private b2!: Float32Array;
  private g2!: Float32Array;
  private bt2!: Float32Array;
  private W3!: Float32Array;
  private b3!: Float32Array;

  private s2_W1!: Float32Array;
  private s2_b1!: Float32Array;
  private s2_g1!: Float32Array;
  private s2_bt1!: Float32Array;
  private s2_W2!: Float32Array;
  private s2_b2!: Float32Array;
  private s2_g2!: Float32Array;
  private s2_bt2!: Float32Array;
  private s2_W3!: Float32Array;
  private s2_b3!: Float32Array;

  public metadata: TFLiteModelMetadata = {
    loaded: false,
    magic: "",
    byteLength: 0,
    stage1Shape: "1536 -> 128 -> 128 -> 1 (LayerNorm + ReLU + Sigmoid)",
    stage2Shape: "1536 -> 64 -> 64 -> 1 (LayerNorm + ReLU + Sigmoid)",
    threshold: 0.5,
    epsilon: 1e-5,
  };

  async loadFromUrl(url = "./hey_jarvis_v0.1.tflite"): Promise<TFLiteModelMetadata> {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
    }
    const buffer = await resp.arrayBuffer();
    return this.loadFromArrayBuffer(buffer);
  }

  loadFromArrayBuffer(buffer: ArrayBuffer): TFLiteModelMetadata {
    const bytes = new Uint8Array(buffer);
    const magic = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (magic !== "TFL3") {
      throw new Error(`Invalid TFLite file header: expected TFL3, got ${magic}`);
    }

    const sliceFloats = (byteOffset: number, floatCount: number): Float32Array => {
      return new Float32Array(buffer.slice(byteOffset, byteOffset + floatCount * 4));
    };

    // Stage 1 buffers (Subgraph 0)
    this.W1 = sliceFloats(76508, 128 * 1536);
    this.b1 = sliceFloats(1277908, 128);
    this.g1 = sliceFloats(865332, 128);
    this.bt1 = sliceFloats(864764, 128);

    this.W2 = sliceFloats(10908, 128 * 128);
    this.b2 = sliceFloats(864196, 128);
    this.g2 = sliceFloats(863628, 128);
    this.bt2 = sliceFloats(863060, 128);

    this.W3 = sliceFloats(10332, 128);
    this.b3 = sliceFloats(863000, 1);

    // Stage 2 verifier buffers (Subgraph 2)
    this.s2_W1 = sliceFloats(884628, 64 * 1536);
    this.s2_b1 = sliceFloats(884312, 64);
    this.s2_g1 = sliceFloats(883996, 64);
    this.s2_bt1 = sliceFloats(883680, 64);

    this.s2_W2 = sliceFloats(867232, 64 * 64);
    this.s2_b2 = sliceFloats(866916, 64);
    this.s2_g2 = sliceFloats(866600, 64);
    this.s2_bt2 = sliceFloats(866284, 64);

    this.s2_W3 = sliceFloats(865964, 64);
    this.s2_b3 = sliceFloats(865900, 1);

    const eps = sliceFloats(1278628, 1)[0] || 1e-5;
    const thresh = sliceFloats(1278552, 1)[0] || 0.5;

    this.metadata = {
      loaded: true,
      magic,
      byteLength: buffer.byteLength,
      stage1Shape: "1536 -> 128 -> 128 -> 1",
      stage2Shape: "1536 -> 64 -> 64 -> 1",
      threshold: thresh,
      epsilon: eps,
    };

    return this.metadata;
  }

  private denseLayerNormRelu(
    input: Float32Array,
    inDim: number,
    outDim: number,
    W: Float32Array,
    b: Float32Array,
    gamma: Float32Array,
    beta: Float32Array
  ): Float32Array {
    const out = new Float32Array(outDim);
    let sum = 0;
    for (let o = 0; o < outDim; o++) {
      let acc = b[o];
      const rowOffset = o * inDim;
      for (let i = 0; i < inDim; i++) {
        acc += input[i] * W[rowOffset + i];
      }
      out[o] = acc;
      sum += acc;
    }
    const mean = sum / outDim;
    let varSum = 0;
    for (let o = 0; o < outDim; o++) {
      const diff = out[o] - mean;
      varSum += diff * diff;
    }
    const invStd = 1 / Math.sqrt(varSum / outDim + this.metadata.epsilon);
    for (let o = 0; o < outDim; o++) {
      const norm = (out[o] - mean) * invStd * gamma[o] + beta[o];
      out[o] = norm > 0 ? norm : 0;
    }
    return out;
  }

  /**
   * Evaluates a 1536-dim feature vector ([1, 16, 96] flattened) through the exact
   * two-stage neural cascade in `hey_jarvis_v0.1.tflite`.
   */
  predict(features1536: Float32Array): {
    score: number;
    stage1Score: number;
    stage2Verified: boolean;
  } {
    if (!this.metadata.loaded) {
      return { score: 0, stage1Score: 0, stage2Verified: false };
    }

    const h1 = this.denseLayerNormRelu(
      features1536,
      1536,
      128,
      this.W1,
      this.b1,
      this.g1,
      this.bt1
    );
    const h2 = this.denseLayerNormRelu(
      h1,
      128,
      128,
      this.W2,
      this.b2,
      this.g2,
      this.bt2
    );

    let logit1 = this.b3[0];
    for (let i = 0; i < 128; i++) {
      logit1 += h2[i] * this.W3[i];
    }
    const s1 = 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, logit1))));

    if (s1 >= this.metadata.threshold) {
      const z1 = this.denseLayerNormRelu(
        features1536,
        1536,
        64,
        this.s2_W1,
        this.s2_b1,
        this.s2_g1,
        this.s2_bt1
      );
      const z2 = this.denseLayerNormRelu(
        z1,
        64,
        64,
        this.s2_W2,
        this.s2_b2,
        this.s2_g2,
        this.s2_bt2
      );
      let logit2 = this.s2_b3[0];
      for (let i = 0; i < 64; i++) {
        logit2 += z2[i] * this.s2_W3[i];
      }
      const s2 = 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, logit2))));
      return { score: s2, stage1Score: s1, stage2Verified: true };
    }

    return { score: s1, stage1Score: s1, stage2Verified: false };
  }
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Encodes an array of 16kHz mono Int16Array PCM chunks into a standard 44-byte RIFF WAV base64 string.
 */
export function encodeWavBase64FromChunks(chunks: Int16Array[], sampleRate = 16000): string {
  const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0);
  const dataByteLength = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // 16 bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataByteLength, true);

  const int16Out = new Int16Array(buffer, 44, totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    int16Out.set(chunk, offset);
    offset += chunk.length;
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
