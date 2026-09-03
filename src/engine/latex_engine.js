/**
 * Bi-directional LaTeX <-> Desmos Math Expression Converter & KaTeX Visual Renderer.
 */
export class LatexEngine {
  /**
   * Converts raw LaTeX string (from OCR, keyboard, or paste) into a valid Desmos plottable expression.
   * @param {string} latex - e.g. "\\frac{1}{x} + \\sin(2x) + x^{2} - \\sqrt{x}"
   * @returns {string} - e.g. "(1)/(x) + sin(2*x) + x^2 - sqrt(x)"
   */
  /**
   * Parses LaTeX fractions with arbitrary nesting and balanced braces: \frac{num}{den} -> ((num)/(den))
   */
  static parseBalancedFractions(str) {
    let s = str;
    let idx;
    while ((idx = s.indexOf('\\frac')) !== -1) {
      let open1 = s.indexOf('{', idx + 5);
      if (open1 === -1) break;
      let depth = 1, close1 = -1;
      for (let i = open1 + 1; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) { close1 = i; break; }
        }
      }
      if (close1 === -1) break;

      let open2 = s.indexOf('{', close1);
      if (open2 === -1 || s.slice(close1 + 1, open2).trim() !== '') break;
      depth = 1; let close2 = -1;
      for (let i = open2 + 1; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) { close2 = i; break; }
        }
      }
      if (close2 === -1) break;

      const num = this.parseBalancedFractions(s.slice(open1 + 1, close1));
      const den = this.parseBalancedFractions(s.slice(open2 + 1, close2));
      s = s.slice(0, idx) + `((${num})/(${den}))` + s.slice(close2 + 1);
    }
    return s;
  }

  /**
   * Parses LaTeX roots with arbitrary nesting and degree: \sqrt[n]{x} or \sqrt{x}
   */
  static parseBalancedSqrt(str) {
    let s = str;
    let idx;
    while ((idx = s.indexOf('\\sqrt')) !== -1) {
      let afterCmd = s.slice(idx + 5).trimStart();
      if (afterCmd.startsWith('[')) {
        let closeBracket = s.indexOf(']', idx + 5);
        if (closeBracket !== -1) {
          let n = s.slice(idx + 5, closeBracket).replace('[', '').trim();
          let openBrace = s.indexOf('{', closeBracket);
          if (openBrace !== -1) {
            let depth = 1, closeBrace = -1;
            for (let i = openBrace + 1; i < s.length; i++) {
              if (s[i] === '{') depth++;
              else if (s[i] === '}') {
                depth--;
                if (depth === 0) { closeBrace = i; break; }
              }
            }
            if (closeBrace !== -1) {
              let inner = this.parseBalancedSqrt(s.slice(openBrace + 1, closeBrace));
              s = s.slice(0, idx) + `((${inner})^(1/(${n})))` + s.slice(closeBrace + 1);
              continue;
            }
          }
        }
      }

      let open = s.indexOf('{', idx + 5);
      if (open === -1) break;
      let depth = 1, close = -1;
      for (let i = open + 1; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) { close = i; break; }
        }
      }
      if (close === -1) break;

      let inner = this.parseBalancedSqrt(s.slice(open + 1, close));
      s = s.slice(0, idx) + `sqrt(${inner})` + s.slice(close + 1);
    }
    return s;
  }

  /**
   * Converts raw LaTeX string (from OCR, keyboard, or paste) into a valid Desmos plottable expression.
   * @param {string} latex - e.g. "\\frac{1}{x} + \\sin(2x) + x^{2} - \\sqrt{x}"
   * @returns {string} - e.g. "(1)/(x) + sin(2*x) + x^2 - sqrt(x)"
   */
  static latexToDesmos(latex) {
    if (!latex || typeof latex !== 'string') return 'sin(x)';

    let s = latex.trim();
    // Remove "y =" or "f(x) ="
    s = s.replace(/^(y|f\(x\))\s*=\s*/i, '');

    // 1. Balanced Fractions
    s = this.parseBalancedFractions(s);

    // 2. Balanced Sqrt
    s = this.parseBalancedSqrt(s);

    // 3. Superscripts: x^{...} -> x^(...) and x^2 -> x^(2)
    s = s.replace(/\^\{([^{}]+)\}/g, '^($1)');
    s = s.replace(/\^([0-9a-zA-Z]+)/g, '^($1)');

    // 4. Subscripts: x_{...} -> x
    s = s.replace(/_\{[^{}]+\}/g, '');
    s = s.replace(/_[0-9a-zA-Z]+/g, '');

    // 5. Trig & special functions
    s = s.replace(/\\sin\b/g, 'sin');
    s = s.replace(/\\cos\b/g, 'cos');
    s = s.replace(/\\tan\b/g, 'tan');
    s = s.replace(/\\arcsin\b/g, 'asin');
    s = s.replace(/\\arccos\b/g, 'acos');
    s = s.replace(/\\arctan\b/g, 'atan');
    s = s.replace(/\\sinh\b/g, 'sinh');
    s = s.replace(/\\cosh\b/g, 'cosh');
    s = s.replace(/\\tanh\b/g, 'tanh');
    s = s.replace(/\\ln\b/g, 'ln');
    s = s.replace(/\\log\b/g, 'log10');
    s = s.replace(/\\exp\b/g, 'exp');
    s = s.replace(/\\pi\b/gi, 'pi');

    // 6. Multiplication symbols: \cdot, \times -> *
    s = s.replace(/\\cdot/g, '*');
    s = s.replace(/\\times/g, '*');

    // 7. Remove LaTeX wrappers: \left, \right, \displaystyle, \, \! \quad
    s = s.replace(/\\left|\\right/g, '');
    s = s.replace(/\\displaystyle/g, '');
    s = s.replace(/\\[,!; ]/g, '');
    s = s.replace(/\\text\{[^{}]*\}/g, '');
    s = s.replace(/[\{\}]/g, '');

    // 8. Replace implicit multiplications: 2 x -> 2*x, x y -> x*y, 2 \sin -> 2*sin
    s = s.replace(/(\d)\s+([a-zA-Z])/g, '$1*$2');
    s = s.replace(/(\d)\s+(\d)/g, '$1$2');

    // 9. Cleanup whitespace
    s = s.replace(/\s+/g, ' ').trim();

    return s || 'sin(x)';
  }

  /**
   * Converts a Desmos plottable math expression into standard formatted LaTeX notation.
   * @param {string} expr - e.g. "(1)/(x) + sin(2x) + x^2 - sqrt(x)"
   * @returns {string} - e.g. "\\frac{1}{x} + \\sin(2x) + x^{2} - \\sqrt{x}"
   */
  static desmosToLatex(expr) {
    if (!expr || typeof expr !== 'string') return '';

    let s = expr.trim();
    // Remove "y ="
    s = s.replace(/^(y|f\(x\))\s*=\s*/i, '');

    // Fractions: ((a)/(b)) or (a)/(b) -> \frac{a}{b}
    s = s.replace(/\(([^()]+)\)\s*\/\s*\(([^()]+)\)/g, '\\frac{$1}{$2}');
    s = s.replace(/([0-9a-zA-Z]+)\s*\/\s*([0-9a-zA-Z]+)/g, '\\frac{$1}{$2}');

    // Roots: sqrt(x) -> \sqrt{x}
    s = s.replace(/sqrt\(([^()]+)\)/g, '\\sqrt{$1}');

    // Superscripts: x^2 or x^(2) -> x^{2}
    s = s.replace(/\^\(?([0-9a-zA-Z+\-]+)\)?/g, '^{$1}');

    // Functions
    s = s.replace(/\bsin\b/g, '\\sin');
    s = s.replace(/\bcos\b/g, '\\cos');
    s = s.replace(/\btan\b/g, '\\tan');
    s = s.replace(/\bln\b/g, '\\ln');
    s = s.replace(/\blog10\b/g, '\\log');
    s = s.replace(/\bpi\b/g, '\\pi');

    // Multiplication: * -> \cdot
    s = s.replace(/\*/g, ' \\cdot ');

    return s;
  }

  /**
   * Renders LaTeX typography visually into a DOM element (using KaTeX if loaded, or formatted HTML).
   * @param {HTMLElement|string} target - DOM Element or element ID
   * @param {string} latexStr - LaTeX string to render
   */
  static renderLatexToElement(target, latexStr) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;

    const cleanLatex = (latexStr || '').trim();
    if (!cleanLatex) {
      el.innerHTML = '<span style="color:var(--text-muted); font-style:italic;">(Chưa có biểu thức)</span>';
      return;
    }

    if (window.katex) {
      try {
        window.katex.render(cleanLatex, el, {
          throwOnError: false,
          displayMode: true,
        });
        return;
      } catch (err) {
        // Fallback to text
      }
    }

    // Fallback HTML formatting if KaTeX script hasn't downloaded
    let html = cleanLatex
      .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '<span style="display:inline-flex; flex-direction:column; vertical-align:middle; text-align:center; margin:0 2px;"><span style="border-bottom:1px solid currentColor; padding:0 2px;">$1</span><span>$2</span></span>')
      .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
      .replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>')
      .replace(/\\(sin|cos|tan|ln|log|pi)/g, '<b>$1</b>')
      .replace(/\\cdot/g, ' · ');

    el.innerHTML = `<span style="font-family:serif; font-size:16px;">${html}</span>`;
  }
}
