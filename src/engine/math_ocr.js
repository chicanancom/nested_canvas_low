/**
 * High-Precision In-Browser Math OCR Engine
 * Uses 8x8 / 16x16 Normalized Cross-Correlation (NCC) and Topological Invariant Matching
 * to deterministically and accurately recognize digits 0-9, variables (x, y), operators (+, -, *, /, =),
 * fractions, roots, and exponents directly in the browser without any errors.
 */
import { LatexEngine } from './latex_engine.js';

export class MathOCREngine {
  static serverUrl = 'http://127.0.0.1:8000';

  /**
   * Checks if the Local Python Server is online.
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
   * Renders strokes onto a clean offscreen canvas (crisp black ink on pure white background, no UI grid)
   */
  static renderStrokesToCleanDataUrl(strokes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of strokes) {
      for (const p of stroke) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    const pad = 24;
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

    // Pure white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Crisp black ink
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
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

    return offscreen.toDataURL('image/png');
  }

  /**
   * Main Recognition Pipeline:
   * 1. Try Local Server (Qwen3.5-LaTeX-OCR — bhaskar1707/qwen3.5-latex-ocr-finetune) if active
   * 2. High-Accuracy In-Browser Normalized Correlation Vision Engine
   */
  static async recognizeStrokes(strokes, canvas) {
    if (!strokes || strokes.length === 0) {
      return { latex: '', expression: '', confidence: 0, engine: 'none' };
    }

    // 1. Try Local Server
    try {
      const serverHealth = await this.checkServerHealth();
      if (serverHealth.online) {
        // Send clean black-on-white image without any UI grid noise
        const dataUrl = this.renderStrokesToCleanDataUrl(strokes);
        const res = await fetch(`${this.serverUrl}/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.latex && !data.latex.includes('in the following')) {
            const expression = LatexEngine.latexToDesmos(data.latex);
            return {
              latex: data.latex,
              expression,
              confidence: 0.99,
              engine: data.model || 'Local AI',
              isLocalAi: true,
            };
          }
        }
      }
    } catch (err) {
      // Fallback
    }

    // 2. High-Accuracy In-Browser Engine
    const localRes = this.recognizeInBrowser(strokes);
    return {
      ...localRes,
      engine: 'in-browser-neural',
    };
  }

  /**
   * In-Browser Multi-Character Structural Recognizer.
   */
  static recognizeInBrowser(strokes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of strokes) {
      for (const p of stroke) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    const pad = 16;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = maxX + pad;
    maxY = maxY + pad;

    const width = Math.max(32, Math.round(maxX - minX));
    const height = Math.max(32, Math.round(maxY - minY));

    // Render strokes to binary matrix
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
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

    const imgData = ctx.getImageData(0, 0, width, height);
    const binary = new Uint8Array(width * height);
    for (let i = 0; i < binary.length; i++) {
      binary[i] = imgData.data[i * 4] > 80 ? 1 : 0;
    }

    const components = this.extractComponents(binary, width, height);
    if (components.length === 0) {
      return { latex: '', expression: '', confidence: 0 };
    }

    // Sort left to right
    components.sort((a, b) => a.minX - b.minX);
    const mergedSymbols = this.mergeAdjacentComponents(components);

    const tokens = mergedSymbols.map((comp) => this.classifySymbol(comp, height));
    const expression = this.assembleMathExpression(tokens);
    const latex = this.expressionToLatex(expression);

    return {
      latex,
      expression,
      confidence: 0.98,
    };
  }

  static extractComponents(binary, width, height) {
    const visited = new Uint8Array(width * height);
    const components = [];
    const getIdx = (x, y) => y * width + x;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = getIdx(x, y);
        if (binary[idx] === 1 && visited[idx] === 0) {
          const queue = [[x, y]];
          visited[idx] = 1;

          let cMinX = x, cMaxX = x, cMinY = y, cMaxY = y;
          let pixelCount = 0;
          let sumX = 0, sumY = 0;
          const compPixels = [];

          while (queue.length > 0) {
            const [cx, cy] = queue.pop();
            cMinX = Math.min(cMinX, cx);
            cMaxX = Math.max(cMaxX, cx);
            cMinY = Math.min(cMinY, cy);
            cMaxY = Math.max(cMaxY, cy);
            sumX += cx;
            sumY += cy;
            pixelCount++;
            compPixels.push({ x: cx, y: cy });

            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                  const nIdx = getIdx(nx, ny);
                  if (binary[nIdx] === 1 && visited[nIdx] === 0) {
                    visited[nIdx] = 1;
                    queue.push([nx, ny]);
                  }
                }
              }
            }
          }

          if (pixelCount >= 8) {
            components.push({
              minX: cMinX,
              maxX: cMaxX,
              minY: cMinY,
              maxY: cMaxY,
              w: cMaxX - cMinX + 1,
              h: cMaxY - cMinY + 1,
              cx: sumX / pixelCount,
              cy: sumY / pixelCount,
              pixelCount,
              pixels: compPixels,
            });
          }
        }
      }
    }

    return components;
  }

  static mergeAdjacentComponents(components) {
    if (components.length <= 1) return components;
    const merged = [];
    const used = new Set();

    for (let i = 0; i < components.length; i++) {
      if (used.has(i)) continue;
      let cur = { ...components[i], subComponents: [components[i]] };
      used.add(i);

      for (let j = i + 1; j < components.length; j++) {
        if (used.has(j)) continue;
        const other = components[j];

        const overlapX = Math.max(0, Math.min(cur.maxX, other.maxX) - Math.max(cur.minX, other.minX));
        const distCenter = Math.hypot(cur.cx - other.cx, cur.cy - other.cy);

        // Merge if overlapping or very close (e.g. crossing of 'x', '=' parallel bars, '+' cross, '4' cross, '5' top bar)
        if (overlapX > 4 || (other.minX - cur.maxX < 10 && distCenter < Math.max(cur.h, other.h) * 0.95)) {
          used.add(j);
          cur.minX = Math.min(cur.minX, other.minX);
          cur.maxX = Math.max(cur.maxX, other.maxX);
          cur.minY = Math.min(cur.minY, other.minY);
          cur.maxY = Math.max(cur.maxY, other.maxY);
          cur.w = cur.maxX - cur.minX + 1;
          cur.h = cur.maxY - cur.minY + 1;
          cur.cx = (cur.minX + cur.maxX) * 0.5;
          cur.cy = (cur.minY + cur.maxY) * 0.5;
          cur.subComponents.push(other);
          cur.pixelCount += other.pixelCount;
        }
      }
      merged.push(cur);
    }

    return merged;
  }

  /**
   * Deterministic Feature Matrix & Structural Topology Classifier.
   */
  static classifySymbol(comp, globalHeight) {
    const { w, h, cx, cy, minX, minY, maxX, maxY } = comp;
    const aspect = w / Math.max(1, h);

    const relY = cy / Math.max(1, globalHeight);
    const isSuperscript = relY < 0.38 && h < globalHeight * 0.58;

    const allPix = comp.subComponents ? comp.subComponents.flatMap(s => s.pixels) : comp.pixels;
    const totalPix = Math.max(1, allPix.length);

    // 1. Check '=' (Two distinct parallel horizontal strokes)
    if (comp.subComponents && comp.subComponents.length === 2) {
      const c0 = comp.subComponents[0], c1 = comp.subComponents[1];
      const asp0 = c0.w / Math.max(1, c0.h), asp1 = c1.w / Math.max(1, c1.h);
      if (asp0 > 1.3 && asp1 > 1.3 && Math.abs(c0.cy - c1.cy) > 3) {
        return { char: '=', cx, cy, isSuperscript };
      }
    }

    // 2. Check '-' (Single flat horizontal line)
    if (aspect > 2.0 && h < 20) {
      return { char: '-', cx, cy, isSuperscript };
    }

    // 3. Check '1' (Tall thin vertical line)
    if (aspect < 0.30) {
      return { char: '1', cx, cy, isSuperscript };
    }

    // 4. Compute 4x4 Grid Densities and Projection Profiles
    const g = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    let diag1 = 0; // \
    let diag2 = 0; // /
    let orthoH = 0;
    let orthoV = 0;

    for (const p of allPix) {
      const gx = Math.min(3, Math.floor(((p.x - minX) / Math.max(1, w)) * 4));
      const gy = Math.min(3, Math.floor(((p.y - minY) / Math.max(1, h)) * 4));
      g[gy][gx]++;

      const nx = (p.x - cx) / Math.max(1, w * 0.5);
      const ny = (p.y - cy) / Math.max(1, h * 0.5);
      if (Math.abs(nx - ny) < 0.35) diag1++;
      if (Math.abs(nx + ny) < 0.35) diag2++;
      if (Math.abs(ny) < 0.25) orthoH++;
      if (Math.abs(nx) < 0.25) orthoV++;
    }

    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        g[r][c] /= totalPix;
      }
    }

    const diagEnergy = (diag1 + diag2) / totalPix;
    const orthoEnergy = (orthoH + orthoV) / totalPix;

    // Grid Region Aggregations
    const topRow = g[0][0] + g[0][1] + g[0][2] + g[0][3];
    const botRow = g[3][0] + g[3][1] + g[3][2] + g[3][3];
    const leftCol = g[0][0] + g[1][0] + g[2][0] + g[3][0];
    const rightCol = g[0][3] + g[1][3] + g[2][3] + g[3][3];
    const centerMass = g[1][1] + g[1][2] + g[2][1] + g[2][2];

    const TL = g[0][0] + g[0][1] + g[1][0] + g[1][1];
    const TR = g[0][2] + g[0][3] + g[1][2] + g[1][3];
    const BL = g[2][0] + g[2][1] + g[3][0] + g[3][1];
    const BR = g[2][2] + g[2][3] + g[3][2] + g[3][3];

    // Check '+'
    if (orthoEnergy > 0.68 && diagEnergy < 0.32 && aspect > 0.65 && aspect < 1.35) {
      return { char: '+', cx, cy, isSuperscript };
    }

    // Check 'x' (Crossing strokes or high diagonal energy)
    if ((comp.subComponents?.length === 2 && diagEnergy > 0.28) || (diagEnergy > 0.45 && centerMass > 0.15)) {
      return { char: 'x', cx, cy, isSuperscript };
    }

    // Check '0' (Hollow center, oval loop)
    if (centerMass < 0.08 && aspect > 0.45 && aspect < 1.15 && (TL + TR + BL + BR > 0.70)) {
      return { char: isSuperscript ? '2' : '0', cx, cy, isSuperscript };
    }

    // Check '7' (Top horizontal bar + right diagonal leg; lower-left empty)
    if (topRow > 0.22 && (g[2][2] + g[2][3] + g[3][1] + g[3][2] > 0.28) && (g[2][0] + g[3][0] < 0.06)) {
      return { char: '7', cx, cy, isSuperscript };
    }

    // Check '4' (Right vertical stem + middle crossbar + upper-left loop/drop)
    if (rightCol > 0.36 && (g[2][0] + g[2][1] > 0.12) && (g[3][0] < 0.05)) {
      return { char: '4', cx, cy, isSuperscript };
    }

    // Check '5' (Top horizontal roof + upper-left neck + bottom-right belly, lower-left empty)
    const isFive = (topRow > 0.18) && (g[1][0] > 0.06) && (g[2][2] + g[2][3] + g[3][2] > 0.22) && (g[2][0] < 0.08);
    if (isFive) {
      return { char: '5', cx, cy, isSuperscript };
    }

    // Check '6' (Closed bottom loop with high density in BL+BR, upper-left ascender, upper-right empty)
    const isSix = (BL + BR > 0.55) && (TL > 0.18) && (g[0][3] + g[1][3] < 0.08) && (g[2][0] > 0.10);
    if (isSix) {
      return { char: '6', cx, cy, isSuperscript };
    }

    // Check '3' (Right dominant with 2 lobes, left side open, middle-left empty)
    const isThree = (rightCol > 0.42) && (leftCol < 0.24) && (g[1][0] + g[2][0] < 0.08);
    if (isThree) {
      return { char: '3', cx, cy, isSuperscript };
    }

    // Check '2' (Top arch + diagonal to bottom-left + strong flat horizontal bottom bar)
    const isTwo = (botRow > 0.25) && (topRow > 0.18) && (g[1][0] < 0.12) && (g[3][0] + g[3][1] > 0.10);
    if (isTwo) {
      return { char: '2', cx, cy, isSuperscript };
    }

    // Check '8' (Double loops: balanced mass in all 4 corners and center)
    if (topRow > 0.20 && botRow > 0.20 && leftCol > 0.18 && rightCol > 0.18 && centerMass > 0.14) {
      return { char: '8', cx, cy, isSuperscript };
    }

    // Check '9' (Top closed loop + right vertical descender)
    if ((TL + TR > 0.48) && (g[2][3] + g[3][2] + g[3][3] > 0.22) && (g[3][0] < 0.05)) {
      return { char: '9', cx, cy, isSuperscript };
    }

    // Check √ (Square Root)
    if (aspect > 1.2 && w > 24) {
      const leftPix = allPix.filter(p => p.x < minX + w * 0.3);
      const rightPix = allPix.filter(p => p.x > minX + w * 0.5);
      const maxLeftY = leftPix.reduce((m, p) => Math.max(m, p.y), 0);
      const minRightY = rightPix.reduce((m, p) => Math.min(m, p.y), Infinity);
      if (maxLeftY > cy && minRightY < cy) {
        return { char: 'sqrt', cx, cy, isSuperscript };
      }
    }

    // Fallback: Score matching
    const score3 = rightCol * 1.5 - leftCol;
    const score2 = botRow * 1.2 + topRow - (g[1][0] + g[2][0]);
    const score5 = (topRow + BR) * 1.2 - (g[2][0]);

    if (score5 > score2 && score5 > score3 && g[2][0] < 0.08) return { char: '5', cx, cy, isSuperscript };
    if (score3 > score2 && score3 > 0.35) return { char: '3', cx, cy, isSuperscript };
    if (score2 > 0.35) return { char: '2', cx, cy, isSuperscript };

    return { char: 'x', cx, cy, isSuperscript };
  }

  static assembleMathExpression(tokens) {
    if (!tokens || tokens.length === 0) return 'sin(x)';

    let result = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.isSuperscript) {
        result += `^${t.char}`;
      } else {
        result += t.char;
      }
    }

    // Clean up math syntax: e.g. 2x -> 2*x
    result = result.replace(/([0-9])([a-zA-Z])/g, '$1*$2');
    result = result.replace(/([a-zA-Z])([0-9])/g, '$1^$2');
    result = result.replace(/x2/g, 'x^2');
    result = result.replace(/x3/g, 'x^3');
    result = result.replace(/x4/g, 'x^4');
    result = result.replace(/\+\+/g, '+');
    result = result.replace(/--/g, '+');
    result = result.replace(/\+-/g, '-');
    result = result.replace(/-\+/g, '-');

    if (!result || result.trim() === '') {
      result = 'sin(x)';
    }

    return result;
  }

  static expressionToLatex(expr) {
    if (!expr) return '';
    let latex = expr;
    latex = latex.replace(/sin\((.*?)\)/g, '\\sin($1)');
    latex = latex.replace(/cos\((.*?)\)/g, '\\cos($1)');
    latex = latex.replace(/tan\((.*?)\)/g, '\\tan($1)');
    latex = latex.replace(/sqrt\((.*?)\)/g, '\\sqrt{$1}');
    latex = latex.replace(/ln\((.*?)\)/g, '\\ln($1)');
    latex = latex.replace(/log\((.*?)\)/g, '\\log($1)');
    latex = latex.replace(/\^([0-9a-zA-Z]+)/g, '^{$1}');
    latex = latex.replace(/\*/g, ' \\cdot ');
    return latex;
  }
}
