#!/usr/bin/env python3
"""
Unified Local AI Vision Server for NestedCanvas.
Combines:
  1. Math OCR (LaTeX Formula & Expression Recognition)
  2. Vietnamese & English Handwriting Text OCR (Full tone marks & diacritics)
Into a single, high-performance Vision-Language pipeline powered by Qwen2.5-VL-3B.

Hardware Optimization:
  - NVIDIA RTX (CUDA) via Float16 (~3.0GB VRAM)
  - Apple Silicon M1/M2/M3 (MPS / Unified Memory)
  - Standard CPU fallback

Usage:
    python server/ai_vision_server.py [port]

Default Port: 8000
"""

import io
import os
import sys
import json
import base64
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from PIL import Image, ImageOps, ImageEnhance
import torch

# Ensure UTF-8 output on Windows console
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Ensure cache is stored on D drive if present
os.environ['HF_HOME'] = 'D:/hf_cache'
os.environ['TORCH_HOME'] = 'D:/torch_cache'
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'

# ─── Device Selection ───────────────────────────────────────────────────────────
if torch.cuda.is_available():
    DEVICE = "cuda"
    TORCH_DTYPE = torch.float16
elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
    DEVICE = "mps"
    TORCH_DTYPE = torch.float16
else:
    DEVICE = "cpu"
    TORCH_DTYPE = torch.float32

MODEL_ID = "Qwen/Qwen2.5-VL-3B-Instruct"
MODEL_NAME = "Unified Qwen2.5-VL-3B (Math LaTeX & Vietnamese Handwriting AI)"
MODEL = None
PROCESSOR = None


def init_model():
    """Loads the Unified Qwen2.5-VL Model into GPU / Unified Memory."""
    global MODEL, PROCESSOR

    if MODEL is not None and PROCESSOR is not None:
        return True

    print("=" * 70)
    print(f"[*] Dang khoi dong {MODEL_NAME}...")
    print(f"[*] Thiet bi tang toc: {DEVICE.upper()} (Dtype: {TORCH_DTYPE})")
    print(f"[*] HuggingFace Repo: {MODEL_ID}")
    print("=" * 70)

    try:
        from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

        print("[*] Dang nap processor...")
        PROCESSOR = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)

        print("[*] Dang nap weights vao bo nho GPU...")
        if DEVICE == "cuda":
            torch.cuda.empty_cache()
            MODEL = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                MODEL_ID,
                device_map="auto",
                torch_dtype=TORCH_DTYPE,
                trust_remote_code=True,
            )
        elif DEVICE == "mps":
            MODEL = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                MODEL_ID,
                torch_dtype=TORCH_DTYPE,
                trust_remote_code=True,
            ).to("mps")
        else:
            MODEL = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                MODEL_ID,
                device_map="cpu",
                torch_dtype=torch.float32,
                trust_remote_code=True,
            )

        MODEL.eval()
        print(f"[+] {MODEL_NAME} da san sang phuc vu ca Toan va Chu Viet Tay tren {DEVICE.upper()}!\n")
        return True

    except Exception as e:
        print(f"[-] Loi khoi dong AI Model: {e}")
        import traceback
        traceback.print_exc()
        return False


def preprocess_image(img: Image.Image) -> Image.Image:
    """Preprocesses and normalizes canvas image to clean black ink on white background."""
    gray = img.convert('L')
    pixels = list(gray.getdata())
    avg_val = sum(pixels) / max(1, len(pixels))

    # Dark background -> Invert to black ink on white paper with high contrast
    if avg_val < 128:
        gray_inv = ImageOps.invert(gray)
        enhancer = ImageEnhance.Contrast(gray_inv)
        enhanced = enhancer.enhance(2.0)
        return enhanced.convert('RGB')

    # Light background -> Maximize ink contrast
    enhancer = ImageEnhance.Contrast(gray)
    enhanced = enhancer.enhance(1.8)
    return enhanced.convert('RGB')


def clean_latex(raw_output: str) -> str:
    """Extracts and sanitizes clean LaTeX mathematical notation."""
    if not raw_output:
        return ""
    s = raw_output.strip()

    # Remove Markdown LaTeX fences
    s = re.sub(r'```(?:latex|tex|math)?', '', s, flags=re.IGNORECASE).replace('```', '').strip()
    s = re.sub(r'^\$+(.*?)\$+$', r'\1', s, flags=re.DOTALL).strip()
    s = re.sub(r'^\\\[(.*?)\\\]$', r'\1', s, flags=re.DOTALL).strip()
    s = re.sub(r'^\\\((.*?)\\\)$', r'\1', s, flags=re.DOTALL).strip()

    # Clean prefixes
    prefixes = [
        r'^(?:The\s+)?(?:latex|formula|equation|math|expression)(?:\s+is)?\s*:?\s*',
        r'^(?:LaTeX|Formula)\s*:?\s*',
    ]
    for pattern in prefixes:
        s = re.sub(pattern, '', s, flags=re.IGNORECASE).strip()

    # Remove trailing newlines
    lines = [line.strip() for line in s.split('\n') if line.strip()]
    return " ".join(lines) if lines else s


def clean_text(raw_output: str) -> str:
    """Extracts exact transcription and removes conversational prefixes."""
    if not raw_output:
        return ""
    s = raw_output.strip()

    # Remove Markdown code blocks
    s = re.sub(r'```(?:text|markdown)?', '', s, flags=re.IGNORECASE).replace('```', '').strip()

    # If the model produced a quoted phrase e.g. 'The text is "yêu".', extract it
    quote_match = re.search(r'["“]([^"”\n]+)["”]', s)
    if quote_match:
        res = quote_match.group(1).strip()
    else:
        prefixes = [
            r'^(?:The\s+)?(?:handwritten\s+)?text(?:\s+in\s+the\s+image)?\s+(?:is|reads|says|shows|appears\s+to\s+be)\s*:?\s*',
            r'^(?:Transcription|OCR|Recognized\s+text)\s*:?\s*',
            r'^Văn\s+bản(?:\s+trong\s+ảnh)?\s+là\s*:?\s*',
        ]
        for pattern in prefixes:
            s = re.sub(pattern, '', s, flags=re.IGNORECASE).strip()
        res = s.strip('"\'”“. ')

    return res


def run_vision_inference(pil_image: Image.Image, task_type="text") -> dict:
    """
    Executes Vision-Language inference for either 'math' (LaTeX) or 'text' (Vietnamese/English).
    """
    global MODEL, PROCESSOR

    if MODEL is None or PROCESSOR is None:
        if not init_model():
            return {"success": False, "error": "Model initialization failed"}

    try:
        processed_img = preprocess_image(pil_image)

        if task_type == "math":
            prompt = (
                "Transcribe the mathematical formula, equation, or handwritten math expression shown in this image into clean standard LaTeX notation. "
                "Output ONLY the raw LaTeX string, without dollar signs, markdown blocks, or commentary."
            )
        else:
            prompt = (
                "Transcribe the handwritten text in this image strictly and verbatim. "
                "Transcribe ONLY what is visually drawn. Do NOT guess, infer, or add any accents, tone marks, or diacritics if they are not explicitly drawn in the image. "
                "For example, if a word is written without accents (e.g. 'chan'), output exactly 'chan' and never add tones like 'chán'. "
                "Output ONLY the exact transcribed text, without any quotes or commentary."
            )

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": prompt},
                ],
            }
        ]

        input_text = PROCESSOR.apply_chat_template(messages, add_generation_prompt=True)
        inputs = PROCESSOR(processed_img, input_text, add_special_tokens=False, return_tensors="pt").to(MODEL.device)

        with torch.no_grad():
            output_ids = MODEL.generate(
                **inputs,
                max_new_tokens=64,
                do_sample=False,
            )

        raw_output = PROCESSOR.batch_decode(
            output_ids[:, inputs["input_ids"].shape[1]:],
            skip_special_tokens=True,
        )[0].strip()

        if task_type == "math":
            cleaned = clean_latex(raw_output)
            print(f"[+] Math LaTeX Output: '{cleaned}' (raw: '{raw_output}')")
            return {
                "success": True,
                "latex": cleaned,
                "raw": raw_output,
                "model": MODEL_NAME,
                "device": DEVICE
            }
        else:
            cleaned = clean_text(raw_output)
            print(f"[+] Vietnamese Text Output: '{cleaned}' (raw: '{raw_output}')")
            blocks = [{
                "text": cleaned,
                "confidence": 0.99,
                "rect": {
                    "x": 0,
                    "y": 0,
                    "width": pil_image.width,
                    "height": pil_image.height
                }
            }]
            return {
                "success": True,
                "full_text": cleaned,
                "total_blocks": len(blocks),
                "blocks": blocks,
                "model": MODEL_NAME,
                "device": DEVICE
            }

    except Exception as e:
        print(f"[-] Loi suy luan Vision AI ({task_type}): {e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


class UnifiedVisionRequestHandler(BaseHTTPRequestHandler):
    """CORS-enabled HTTP Request Handler for Unified Math & Text OCR."""

    def _send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path in ('/health', '/api/health'):
            self.send_response(200)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            vram_mb = 0
            if DEVICE == "cuda" and torch.cuda.is_available():
                vram_mb = round(torch.cuda.memory_allocated() / (1024 * 1024), 1)
            response = {
                "status": "ok",
                "ready": MODEL is not None,
                "model": MODEL_NAME,
                "device": DEVICE,
                "vram_allocated_mb": vram_mb,
                "features": ["math_latex_ocr", "vietnamese_english_text_ocr"],
                "endpoints": {
                    "math": "/api/ocr/math",
                    "text": "/api/ocr/text"
                }
            }
            self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        path = self.path.split('?')[0].rstrip('/')

        # Determine task type
        if path in ('/api/ocr/math', '/predict'):
            task_type = "math"
        elif path in ('/api/ocr/text', '/api/ocr', '/ocr'):
            task_type = "text"
        else:
            self.send_response(404)
            self.end_headers()
            return

        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode('utf-8'))

            img_data_str = data.get('image', '')
            if not img_data_str:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "No image data provided"}).encode('utf-8'))
                return

            if ',' in img_data_str:
                img_data_str = img_data_str.split(',', 1)[1]

            img_bytes = base64.b64decode(img_data_str)
            pil_image = Image.open(io.BytesIO(img_bytes))

            # Run Unified AI Inference
            result = run_vision_inference(pil_image, task_type=task_type)

            self.send_response(200)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))

        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_response(500)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))

    def log_message(self, format, *args):
        sys.stdout.write(f"[{self.log_date_time_string()}] {format % args}\n")
        sys.stdout.flush()


from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

def run_server(port=8000):
    init_model()

    # Khoi dong WebSocket LAN Sync Server (Port 8765) tren luong ngam
    try:
        from server.sync_server import run_sync_server_in_thread
        run_sync_server_in_thread()
    except Exception as e:
        print(f"[!] Khong the khoi dong WebSocket Sync Server: {e}")

    server_address = ('', port)
    httpd = ThreadingHTTPServer(server_address, UnifiedVisionRequestHandler)
    print(f"\n[+] Unified Vision AI Server dang hoat dong tai http://127.0.0.1:{port}")
    print("    - Health Check: http://127.0.0.1:8000/health")
    print("    - Math OCR:     POST http://127.0.0.1:8000/api/ocr/math (hoac /predict)")
    print("    - Text OCR:     POST http://127.0.0.1:8000/api/ocr/text (hoac /api/ocr)")
    print("    - Nhan Ctrl+C de dung server.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Dang dung Unified Server...")
        httpd.server_close()


if __name__ == '__main__':
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    run_server(port)
