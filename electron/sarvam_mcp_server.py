"""
Sarvam AI Model Context Protocol (MCP) Server for J.A.R.V.I.S.
Exposes tools over JSON-RPC 2.0 stdio:
  - sarvam_stt: Low-latency Speech-to-Text via wss://api.sarvam.ai/speech-to-text/ws (saaras:v3)
  - sarvam_tts: Low-latency streaming Text-to-Speech via wss://api.sarvam.ai/text-to-speech/ws (bulbul:v3)
  - sarvam_chat: Chat completion via Sarvam's flagship sarvam-105b / sarvam-105b-conversations model
  - sarvam_translate: Multi-lingual translation across 22+ Indian languages & English
"""

import os
import sys
import json
import asyncio
import urllib.request
import websockets


SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY", "")


async def sarvam_ws_tts(
    text: str,
    speaker: str = "shubh",
    language_code: str = "en-IN",
    model: str = "bulbul:v3",
    pace: float = 1.05,
    temperature: float = 0.6,
) -> list[str]:
    """Streams TTS audio chunks (base64 WAV) over Sarvam WebSocket."""
    url = f"wss://api.sarvam.ai/text-to-speech/ws?model={model}&send_completion_event=true"
    chunks: list[str] = []
    async with websockets.connect(
        url, additional_headers={"api-subscription-key": SARVAM_API_KEY}
    ) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "config",
                    "data": {
                        "target_language_code": language_code,
                        "speaker": speaker,
                        "speech_sample_rate": 24000,
                        "output_audio_codec": "wav",
                        "pace": pace,
                        "temperature": temperature,
                    },
                }
            )
        )
        await ws.send(json.dumps({"type": "text", "data": {"text": text}}))
        await ws.send(json.dumps({"type": "flush"}))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(raw)
            if msg.get("type") == "audio" and msg.get("data", {}).get("audio"):
                chunks.append(msg["data"]["audio"])
            elif msg.get("type") == "event":
                break
    return chunks


async def sarvam_ws_stt(
    wav_base64: str,
    language_code: str = "en-IN",
    model: str = "saaras:v3",
) -> dict:
    """Streams 16kHz WAV audio over Sarvam WebSocket STT (saaras:v3)."""
    url = f"wss://api.sarvam.ai/speech-to-text/ws?language-code={language_code}&model={model}&vad_signals=true&flush_signal=true"
    async with websockets.connect(
        url, additional_headers={"api-subscription-key": SARVAM_API_KEY}
    ) as ws:
        await ws.send(
            json.dumps(
                {
                    "audio": {
                        "data": wav_base64,
                        "sample_rate": "16000",
                        "encoding": "audio/wav",
                    }
                }
            )
        )
        await ws.send(json.dumps({"type": "flush"}))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=8)
            msg = json.loads(raw)
            if msg.get("type") == "data":
                return msg.get("data", {})
    return {}


def sarvam_chat(messages: list[dict], model: str = "sarvam-105b") -> str:
    req = urllib.request.Request(
        "https://api.sarvam.ai/v1/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": 0.6}).encode(),
        headers={
            "api-subscription-key": SARVAM_API_KEY,
            "Content-Type": "application/json",
        },
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    return resp["choices"][0]["message"]["content"]


def sarvam_translate(
    text: str, source_language_code: str = "en-IN", target_language_code: str = "hi-IN"
) -> str:
    req = urllib.request.Request(
        "https://api.sarvam.ai/translate",
        data=json.dumps(
            {
                "input": text,
                "source_language_code": source_language_code,
                "target_language_code": target_language_code,
                "model": "mayura:v1",
            }
        ).encode(),
        headers={
            "api-subscription-key": SARVAM_API_KEY,
            "Content-Type": "application/json",
        },
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=10).read().decode())
    return resp.get("translated_text", "")


MCP_TOOLS = [
    {
        "name": "sarvam_stt",
        "description": "Low-latency WebSocket Speech-to-Text using Sarvam saaras:v3",
        "inputSchema": {
            "type": "object",
            "properties": {
                "wav_base64": {"type": "string"},
                "language_code": {"type": "string", "default": "en-IN"},
                "model": {"type": "string", "default": "saaras:v3"},
            },
            "required": ["wav_base64"],
        },
    },
    {
        "name": "sarvam_tts",
        "description": "Low-latency WebSocket Text-to-Speech using Sarvam bulbul:v3",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "speaker": {"type": "string", "default": "shubh"},
                "language_code": {"type": "string", "default": "en-IN"},
                "model": {"type": "string", "default": "bulbul:v3"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "sarvam_chat",
        "description": "Chat completion using Sarvam's flagship sarvam-105b model",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "model": {"type": "string", "default": "sarvam-105b"},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "sarvam_translate",
        "description": "Translate text across 22+ Indian languages and English via Sarvam AI",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "source_language_code": {"type": "string", "default": "en-IN"},
                "target_language_code": {"type": "string", "default": "hi-IN"},
            },
            "required": ["text"],
        },
    },
]


def handle_mcp_request(req: dict) -> dict:
    method = req.get("method")
    req_id = req.get("id")
    params = req.get("params") or {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "sarvam-mcp-server", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": MCP_TOOLS}}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "sarvam_stt":
            res = asyncio.run(
                sarvam_ws_stt(
                    args["wav_base64"],
                    args.get("language_code", "en-IN"),
                    args.get("model", "saaras:v3"),
                )
            )
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"content": [{"type": "text", "text": json.dumps(res)}]},
            }
        if name == "sarvam_tts":
            chunks = asyncio.run(
                sarvam_ws_tts(
                    args["text"],
                    args.get("speaker", "shubh"),
                    args.get("language_code", "en-IN"),
                    args.get("model", "bulbul:v3"),
                )
            )
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"content": [{"type": "text", "text": json.dumps({"chunks": chunks})}]},
            }
        if name == "sarvam_chat":
            reply = sarvam_chat(
                [{"role": "user", "content": args["prompt"]}],
                args.get("model", "sarvam-105b"),
            )
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"content": [{"type": "text", "text": reply}]},
            }
        if name == "sarvam_translate":
            tr = sarvam_translate(
                args["text"],
                args.get("source_language_code", "en-IN"),
                args.get("target_language_code", "hi-IN"),
            )
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"content": [{"type": "text", "text": tr}]},
            }

    return {"jsonrpc": "2.0", "id": req_id, "result": {}}


def main():
    for line in sys.stdin:
        line = line.lstrip("\ufeff").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = handle_mcp_request(req)
            print(json.dumps(resp), flush=True)
        except Exception as exc:
            print(
                json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": str(exc)}}),
                flush=True,
            )


if __name__ == "__main__":
    main()
