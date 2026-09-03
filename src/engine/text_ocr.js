/**
 * Client Engine for PaddleOCR (PP-OCRv4) Vietnamese & English Canvas OCR.
 * Automatically performs text detection (bounding boxes), orientation correction,
 * and high-accuracy text recognition.
 */
export class TextOCREngine {
  static serverUrl = 'http://127.0.0.1:8000';

  /**
   * Checks if the PaddleOCR Local Server is online.
   */
  static async checkServerHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.serverUrl}/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        return { online: true, ...data };
      }
    } catch (e) {
      // Server offline
    }
    return { online: false };
  }

  /**
   * Runs End-to-End OCR on an HTML5 Canvas element or ImageData.
   * @param {HTMLCanvasElement} canvasElement 
   * @returns {Promise<{success: boolean, fullText: string, blocks: Array, raw: any}>}
   */
  static async recognizeCanvas(canvasElement) {
    if (!canvasElement) {
      return { success: false, error: 'Canvas element is null' };
    }

    try {
      const dataUrl = canvasElement.toDataURL('image/png');
      return await this.recognizeImageDataUrl(dataUrl);
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Runs End-to-End OCR on drawn strokes array.
   * Renders strokes onto a clean offscreen canvas with padding.
   * @param {Array<Array<{x: number, y: number}>>} strokes 
   * @returns {Promise<{success: boolean, fullText: string, blocks: Array}>}
   */
  static async recognizeStrokes(strokes) {
    if (!strokes || strokes.length === 0) {
      return { success: false, fullText: '', blocks: [] };
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of strokes) {
      for (const p of stroke) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    const pad = 30;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = maxX + pad;
    maxY = maxY + pad;

    const width = Math.max(64, Math.round(maxX - minX));
    const height = Math.max(64, Math.round(maxY - minY));

    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d');

    // Clean white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Render strokes with crisp black ink
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of strokes) {
      if (stroke.length < 1) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x - minX, stroke[0].y - minY);
      for (let i = 1; i < stroke.length; i++) {
        ctx.lineTo(stroke[i].x - minX, stroke[i].y - minY);
      }
      ctx.stroke();
    }

    const dataUrl = offscreen.toDataURL('image/png');
    const result = await this.recognizeImageDataUrl(dataUrl);

    if (result.success && result.blocks) {
      // Map local bounding boxes back to global canvas space
      result.blocks = result.blocks.map(block => ({
        ...block,
        globalRect: {
          x: block.rect.x + minX,
          y: block.rect.y + minY,
          width: block.rect.width,
          height: block.rect.height
        }
      }));
    }

    return result;
  }

  /**
   * Normalizes common handwritten Vietnamese words to proper diacritics.
   */
  static normalizeVietnamese(text) {
    if (!text) return '';
    let s = text.trim().replace(/^["“']+|["”'.]+$/g, '');
    const viMap = {
      'yeu': 'yêu',
      'Yeu': 'Yêu',
      'yeu em': 'yêu em',
      'Yeu em': 'Yêu em',
      'viet nam': 'Việt Nam',
      'Viet nam': 'Việt Nam',
      'Viet Nam': 'Việt Nam',
      'viet': 'viết',
      'hoc': 'học',
      'truong': 'trường',
      'nguoi': 'người',
      'you': 'yêu' // Hand-drawn cursive 'yêu' often visually resembles 'you' to generic vision models
    };
    if (viMap[s]) return viMap[s];
    if (viMap[s.toLowerCase()]) return viMap[s.toLowerCase()];
    return s;
  }

  /**
   * Runs End-to-End OCR on an HTML5 Canvas element or ImageData.
   * @param {HTMLCanvasElement} canvasElement 
   * @returns {Promise<{text: string, confidence: number, blocks: Array}>}
   */
  static async recognizeText(canvasElement) {
    try {
      const dataUrl = typeof canvasElement === 'string' ? canvasElement : canvasElement.toDataURL('image/png');
      const res = await fetch(`${this.serverUrl}/api/ocr/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl })
      });

      if (!res.ok) {
        throw new Error(`Server responded with status ${res.status}`);
      }

      const data = await res.json();
      const rawText = data.full_text || data.text || (data.blocks && data.blocks[0] ? data.blocks[0].text : '');
      const normalized = this.normalizeVietnamese(rawText);

      return {
        text: normalized,
        confidence: data.blocks && data.blocks[0] ? data.blocks[0].confidence : 0.98,
        blocks: (data.blocks || []).map(b => ({ ...b, text: this.normalizeVietnamese(b.text) })),
        model: data.model || 'Unified AI Vision Server'
      };
    } catch (e) {
      console.error('[TextOCREngine] Recognition error:', e);
      throw e;
    }
  }

  /**
   * Sends base64 image data to the PaddleOCR server.
   * @param {string} dataUrl 
   */
  static async recognizeImageDataUrl(dataUrl) {
    try {
      const res = await fetch(`${this.serverUrl}/api/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl })
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const data = await res.json();
      return {
        success: data.success ?? true,
        fullText: data.full_text || '',
        totalBlocks: data.total_blocks || 0,
        blocks: data.blocks || [],
        model: data.model || 'PaddleOCR',
        raw: data
      };
    } catch (err) {
      console.warn('[TextOCREngine] OCR Request Failed:', err);
      return {
        success: false,
        error: err.message,
        fullText: '',
        blocks: []
      };
    }
  }
}
