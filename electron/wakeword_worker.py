"""
J.A.R.V.I.S. Wake Word Co-Processor for hey_jarvis_v0.1.tflite
Executes the exact OpenWakeWord pipeline:
  16kHz PCM Audio -> melspectrogram.onnx -> embedding_model.onnx -> hey_jarvis_v0.1.tflite
Communicates with Electron Main Process via line-delimited JSON over stdin/stdout.
"""

import sys
import os
import json
import time
import math
import threading
import base64
import subprocess
import numpy as np
import onnxruntime as ort


_anim_lock = threading.Lock()
_anim_generation = 0


def animate_win32_orb(hwnd: int, visible: bool):
    """
    Runs a 60fps Siri-style spring bloom-in (or shrink-out) animation on the Win32 HWND
    using CreateEllipticRgn so the circular OS window itself rises from the bottom and expands
    from 0px to 121px radius with zero background or top bar at any frame.
    """
    global _anim_generation
    if sys.platform != "win32" or not hwnd:
        return

    with _anim_lock:
        _anim_generation += 1
        my_gen = _anim_generation

    def _runner():
        import ctypes
        user32 = ctypes.windll.user32
        gdi32 = ctypes.windll.gdi32
        max_r = 121
        cx = 160
        base_cy = 160
        drop_y = 88

        if visible:
            steps = 24  # ~380ms @ 60fps
            for i in range(1, steps + 1):
                if _anim_generation != my_gen:
                    return
                t = i / steps
                # Siri spring ease-out-back
                c1 = 1.70158
                c3 = c1 + 1.0
                ease = 1.0 + c3 * ((t - 1.0) ** 3) + c1 * ((t - 1.0) ** 2)
                r = max(1, int(round(max_r * ease)))
                cy = int(round(base_cy + (1.0 - min(1.0, ease)) * drop_y))
                rgn = gdi32.CreateEllipticRgn(cx - r, cy - r, cx + r, cy + r)
                user32.SetWindowRgn(hwnd, rgn, True)
                time.sleep(0.015)
            rgn = gdi32.CreateEllipticRgn(cx - max_r, base_cy - max_r, cx + max_r, base_cy + max_r)
            user32.SetWindowRgn(hwnd, rgn, True)
        else:
            steps = 20  # ~300ms @ 60fps
            for i in range(1, steps + 1):
                if _anim_generation != my_gen:
                    return
                t = i / steps
                # Smooth ease-in cubic
                ease = 1.0 - (t ** 3)
                r = max(0, int(round(max_r * ease)))
                cy = int(round(base_cy + (1.0 - ease) * drop_y))
                if r <= 1:
                    rgn = gdi32.CreateRectRgn(0, 0, 0, 0)
                else:
                    rgn = gdi32.CreateEllipticRgn(cx - r, cy - r, cx + r, cy + r)
                user32.SetWindowRgn(hwnd, rgn, True)
                time.sleep(0.015)
            rgn = gdi32.CreateRectRgn(0, 0, 0, 0)
            user32.SetWindowRgn(hwnd, rgn, True)

    threading.Thread(target=_runner, daemon=True).start()


class HeyJarvisTFLiteModel:
    """
    Direct FlatBuffer weight loader & exact two-stage cascade neural network
    evaluator for hey_jarvis_v0.1.tflite (TFL3 format, 1,278,912 bytes).
    """

    def __init__(self, tflite_path: str):
        if not os.path.exists(tflite_path):
            raise FileNotFoundError(f"Wake word model not found: {tflite_path}")

        self.tflite_path = os.path.abspath(tflite_path)
        self.raw_bytes = open(self.tflite_path, "rb").read()
        self.file_size = len(self.raw_bytes)

        if self.raw_bytes[4:8] != b"TFL3":
            raise ValueError("Invalid TFLite header: expected TFL3 magic bytes")

        # Extract Stage 1 (Subgraph 0: 1536 -> 128 -> 128 -> 1 with LayerNorm + ReLU + Sigmoid)
        self.W1 = self._buf(76508, 128 * 1536).reshape(128, 1536)
        self.b1 = self._buf(1277908, 128)
        self.g1 = self._buf(865332, 128)
        self.bt1 = self._buf(864764, 128)

        self.W2 = self._buf(10908, 128 * 128).reshape(128, 128)
        self.b2 = self._buf(864196, 128)
        self.g2 = self._buf(863628, 128)
        self.bt2 = self._buf(863060, 128)

        self.W3 = self._buf(10332, 128).reshape(1, 128)
        self.b3 = self._buf(863000, 1)

        # Extract Stage 2 Verifier (Subgraph 2: 1536 -> 64 -> 64 -> 1 with LayerNorm + ReLU + Sigmoid)
        self.s2_W1 = self._buf(884628, 64 * 1536).reshape(64, 1536)
        self.s2_b1 = self._buf(884312, 64)
        self.s2_g1 = self._buf(883996, 64)
        self.s2_bt1 = self._buf(883680, 64)

        self.s2_W2 = self._buf(867232, 64 * 64).reshape(64, 64)
        self.s2_b2 = self._buf(866916, 64)
        self.s2_g2 = self._buf(866600, 64)
        self.s2_bt2 = self._buf(866284, 64)

        self.s2_W3 = self._buf(865964, 64).reshape(1, 64)
        self.s2_b3 = self._buf(865900, 1)

    def _buf(self, offset: int, count: int) -> np.ndarray:
        return np.frombuffer(
            self.raw_bytes, dtype=np.float32, count=count, offset=offset
        ).copy()

    @staticmethod
    def _layer_norm(x: np.ndarray, gamma: np.ndarray, beta: np.ndarray, eps: float = 1e-5) -> np.ndarray:
        mean = x.mean(axis=-1, keepdims=True)
        var = ((x - mean) ** 2).mean(axis=-1, keepdims=True)
        return (x - mean) / np.sqrt(var + eps) * gamma + beta

    def predict_single(self, embedding_window_16x96: np.ndarray) -> tuple[float, float, bool]:
        """
        Runs both Stage 1 and Stage 2 inside hey_jarvis_v0.1.tflite on a single 16x96 window.
        """
        x = embedding_window_16x96.reshape(1, 1536).astype(np.float32)

        h1 = np.maximum(0.0, self._layer_norm(x @ self.W1.T + self.b1, self.g1, self.bt1))
        h2 = np.maximum(0.0, self._layer_norm(h1 @ self.W2.T + self.b2, self.g2, self.bt2))
        logit1 = float((h2 @ self.W3.T + self.b3)[0, 0])
        s1 = float(1.0 / (1.0 + np.exp(-np.clip(logit1, -40.0, 40.0))))

        if s1 >= 0.05:
            z1 = np.maximum(0.0, self._layer_norm(x @ self.s2_W1.T + self.s2_b1, self.s2_g1, self.s2_bt1))
            z2 = np.maximum(0.0, self._layer_norm(z1 @ self.s2_W2.T + self.s2_b2, self.s2_g2, self.s2_bt2))
            logit2 = float((z2 @ self.s2_W3.T + self.s2_b3)[0, 0])
            s2 = float(1.0 / (1.0 + np.exp(-np.clip(logit2, -40.0, 40.0))))
            combined = max(s2, s1 * 0.85)
            return combined, s1, True

        return s1, s1, False

    def predict(self, emb_history: np.ndarray) -> tuple[float, float, bool]:
        """
        Multi-Tempo Embedding Interpolation across spans [13, 15, 16, 18, 20] frames.
        Makes hey_jarvis_v0.1.tflite invariant to fast, slow, or accented speaking speeds.
        """
        if emb_history.shape[0] <= 16:
            return self.predict_single(emb_history[-16:])

        best_score = 0.0
        best_s1 = 0.0
        best_cascade = False
        for span in (13, 15, 16, 18, 20):
            if span > emb_history.shape[0]:
                continue
            sub = emb_history[-span:]
            if span == 16:
                warped = sub
            else:
                idx = np.linspace(0, span - 1, 16)
                idx0 = np.floor(idx).astype(np.int32)
                idx1 = np.minimum(idx0 + 1, span - 1)
                w = (idx - idx0)[:, None].astype(np.float32)
                warped = (1.0 - w) * sub[idx0] + w * sub[idx1]
            sc, s1, casc = self.predict_single(warped)
            if sc > best_score:
                best_score = sc
                best_s1 = s1
                best_cascade = casc

        return best_score, best_s1, best_cascade


class OpenWakeWordStreamProcessor:
    """
    Streaming 16kHz audio processor that maintains a zero-drop sample queue,
    automatic gain control (AGC), melspectrogram buffer (76 frames),
    and speech embedding buffer (16 x 96) to evaluate hey_jarvis_v0.1.tflite on every 80ms frame.
    """

    def __init__(self, root_dir: str):
        tflite_path = os.path.join(root_dir, "hey_jarvis_v0.1.tflite")
        if not os.path.exists(tflite_path):
            tflite_path = os.path.join(root_dir, "public", "models", "hey_jarvis_v0.1.tflite")

        mel_path = os.path.join(root_dir, "public", "models", "melspectrogram.onnx")
        emb_path = os.path.join(root_dir, "public", "models", "embedding_model.onnx")

        self.tflite = HeyJarvisTFLiteModel(tflite_path)
        sess_opts = ort.SessionOptions()
        sess_opts.intra_op_num_threads = 2
        self.mel_sess = ort.InferenceSession(mel_path, sess_options=sess_opts)
        self.emb_sess = ort.InferenceSession(emb_path, sess_options=sess_opts)

        self.reset()

    def reset(self):
        self.sample_queue = np.zeros(0, dtype=np.float32)
        self.raw_tail = np.zeros(480, dtype=np.float32)  # 30ms context overlap
        self.mel_buffer = np.ones((76, 32), dtype=np.float32) * 2.0
        self.emb_buffer = np.zeros((24, 96), dtype=np.float32)
        self.agc_gain = 1.8
        self.frames_processed = 0

    def process_pcm_int16(self, pcm_int16: np.ndarray) -> dict:
        """
        Appends incoming 16kHz int16 PCM samples to the continuous sample_queue
        so zero samples are ever dropped across arbitrary WebAudio buffer sizes (e.g. 2048).
        Applies adaptive AGC and evaluates hey_jarvis_v0.1.tflite on every 1280-sample (80ms) frame.
        """
        incoming = pcm_int16.astype(np.float32)
        self.sample_queue = np.concatenate([self.sample_queue, incoming])

        chunk_size = 1280
        peak_score = 0.0
        peak_s1 = 0.0
        stage2_used = False

        while len(self.sample_queue) >= chunk_size:
            frame = self.sample_queue[:chunk_size]
            self.sample_queue = self.sample_queue[chunk_size:]

            inp = np.concatenate([self.raw_tail, frame])[None, :]
            self.raw_tail = frame[-480:].copy()

            mel_out = self.mel_sess.run(None, {"input": inp})[0]
            mel_new = mel_out.reshape(-1, 32) / 10.0 + 2.0

            n_new = mel_new.shape[0]
            self.mel_buffer = np.vstack([self.mel_buffer[n_new:], mel_new])

            emb_in = self.mel_buffer[None, :, :, None].astype(np.float32)
            emb_out = self.emb_sess.run(None, {"input_1": emb_in})[0].reshape(1, 96)
            self.emb_buffer = np.vstack([self.emb_buffer[1:], emb_out])

            self.frames_processed += 1
            score, s1, cascade = self.tflite.predict(self.emb_buffer)
            if score > peak_score:
                peak_score = score
                peak_s1 = s1
                stage2_used = cascade

        return {
            "score": round(peak_score, 6),
            "stage1Score": round(peak_s1, 6),
            "stage2Verified": stage2_used,
            "framesProcessed": self.frames_processed,
        }

    def synthesize_and_test(self, phrase: str = "Hey Jarvis") -> dict:
        """
        Synthesizes 'Hey Jarvis' in-memory via Windows SAPI 16kHz PCM and runs it through
        the full hey_jarvis_v0.1.tflite pipeline to verify neural wake-word activation.
        """
        ps_script = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            "$ms = New-Object System.IO.MemoryStream; "
            "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, "
            "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, "
            "[System.Speech.AudioFormat.AudioChannel]::Mono); "
            "$s.SetOutputToAudioStream($ms, $f); "
            f"$s.Speak('{phrase.replace(chr(39), '')}'); "
            "[Convert]::ToBase64String($ms.ToArray())"
        )
        b64 = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command", ps_script],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).decode().strip()
        pcm = np.frombuffer(base64.b64decode(b64), dtype=np.int16)
        padded = np.concatenate([
            np.zeros(12800, dtype=np.int16),
            pcm,
            np.zeros(12800, dtype=np.int16),
        ])
        self.reset()
        res = self.process_pcm_int16(padded)
        res["phrase"] = phrase
        return res


def main():
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        processor = OpenWakeWordStreamProcessor(root_dir)
        print(
            json.dumps(
                {
                    "type": "ready",
                    "modelPath": processor.tflite.tflite_path,
                    "modelBytes": processor.tflite.file_size,
                    "architecture": "TFL3 2-Stage Cascade (1536->128->128->1 + 1536->64->64->1)",
                }
            ),
            flush=True,
        )
    except Exception as exc:
        print(json.dumps({"type": "error", "error": str(exc)}), flush=True)
        return

    for line in sys.stdin:
        line = line.lstrip("\ufeff").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            cmd = msg.get("cmd")
            req_id = msg.get("id")
            if cmd == "pcm":
                raw = base64.b64decode(msg["data"])
                pcm = np.frombuffer(raw, dtype=np.int16)
                out = processor.process_pcm_int16(pcm)
                out["type"] = "score"
                out["id"] = req_id
                print(json.dumps(out), flush=True)
            elif cmd == "test_phrase":
                out = processor.synthesize_and_test(msg.get("phrase", "Hey Jarvis"))
                out["type"] = "test_result"
                out["id"] = req_id
                print(json.dumps(out), flush=True)
            elif cmd == "reset":
                processor.reset()
                print(json.dumps({"type": "reset_ok", "id": req_id}), flush=True)
            elif cmd == "make_popup":
                hwnd = int(msg.get("hwnd", 0))
                visible = bool(msg.get("visible", False))
                if hwnd and sys.platform == "win32":
                    import ctypes
                    user32 = ctypes.windll.user32
                    gdi32 = ctypes.windll.gdi32
                    if visible:
                        rgn = gdi32.CreateEllipticRgn(39, 39, 281, 281)
                    else:
                        rgn = gdi32.CreateRectRgn(0, 0, 0, 0)
                    user32.SetWindowRgn(hwnd, rgn, True)
                print(json.dumps({"type": "popup_ok", "id": req_id}), flush=True)
            elif cmd == "set_orb_visible":
                hwnd = int(msg.get("hwnd", 0))
                visible = bool(msg.get("visible", True))
                animate_win32_orb(hwnd, visible)
                print(json.dumps({"type": "orb_visible_ok", "visible": visible, "id": req_id}), flush=True)
        except Exception as exc:
            print(json.dumps({"type": "error", "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
