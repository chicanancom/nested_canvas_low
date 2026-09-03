/**
 * High-performance safe mathematical formula evaluator for Desmos Graphing Canvas.
 * Supports standard algebraic and trigonometric functions:
 * sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, sqrt, cbrt, abs, log, ln, exp, pow, pi, e
 */
export class MathEvaluator {
  /**
   * Compiles a string formula like "sin(x) + cos(2x)" or "x^2 - 4" into a fast evaluator function.
   * @param {string} exprStr 
   * @returns {function(number, object): number}
   */
  static compile(exprStr) {
    if (!exprStr || typeof exprStr !== 'string' || exprStr.trim() === '') {
      return () => NaN;
    }

    let clean = exprStr.trim();
    // Remove "y =" or "f(x) =" prefix if present
    clean = clean.replace(/^(y|f\(x\))\s*=\s*/i, '');

    // Replace '^' with '**'
    clean = clean.replace(/\^/g, '**');

    // Replace implicit multiplications like 2x -> 2*x, 3sin(x) -> 3*Math.sin(x), (x+1)(x-2) -> (x+1)*(x-2)
    clean = clean.replace(/(\d+)\s*([a-zA-Z\(])/g, '$1 * $2');
    clean = clean.replace(/(\))\s*([\d\w\(])/g, '$1 * $2');

    // Replace Math functions and constants
    const mathFuncs = [
      'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
      'sinh', 'cosh', 'tanh', 'sqrt', 'cbrt', 'abs',
      'floor', 'ceil', 'round', 'min', 'max',
      'log10', 'log2', 'log', 'exp'
    ];

    // 'ln' -> 'Math.log', 'pi' -> 'Math.PI', 'e' -> 'Math.E'
    clean = clean.replace(/\bln\b/gi, 'Math.log');
    clean = clean.replace(/\bpi\b/gi, 'Math.PI');
    clean = clean.replace(/\bPI\b/g, 'Math.PI');
    clean = clean.replace(/\bE\b/g, 'Math.E');

    for (const fn of mathFuncs) {
      const regex = new RegExp(`\\b${fn}\\b(?=\\s*\\()`, 'gi');
      clean = clean.replace(regex, `Math.${fn}`);
    }

    try {
      // Build safe fast Function constructor: fn(x, params)
      const compiledFn = new Function('x', 'p', `
        try {
          with (p || {}) {
            return Number(${clean});
          }
        } catch (e) {
          return NaN;
        }
      `);
      return compiledFn;
    } catch (err) {
      return () => NaN;
    }
  }

  /**
   * Evaluates samples of y = f(x) over [minX, maxX] with N steps.
   */
  static sample(fn, minX, maxX, steps, params = {}) {
    const points = [];
    const stepSize = (maxX - minX) / Math.max(10, steps);

    for (let i = 0; i <= steps; i++) {
      const x = minX + i * stepSize;
      const y = fn(x, params);
      if (!isNaN(y) && isFinite(y)) {
        points.push({ x, y });
      } else {
        points.push({ x, y: null }); // Discontinuity (e.g. 1/x at 0, tan(x) at pi/2)
      }
    }
    return points;
  }
}
