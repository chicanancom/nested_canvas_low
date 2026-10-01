import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { encodePdfSource, decodePdfSource } from './pdfSource.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

async function renderPage(pdf, index) {
  const page = await pdf.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const largest = Math.max(base.width, base.height);
  if (!Number.isFinite(largest) || largest <= 0) throw new Error('Trang PDF có kích thước không hợp lệ.');
  const viewport = page.getViewport({ scale: Math.min(2, 1600 / largest) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Không tạo được canvas để đọc PDF.');
    await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
    return { src: canvas.toDataURL('image/jpeg', 0.82), width: canvas.width, height: canvas.height };
  } finally {
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
}

export async function openPdfFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error('PDF vượt quá 25 MB. Hãy chia tệp thành các phần nhỏ hơn.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const source = encodePdfSource(bytes);
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  try {
    const pdf = await task.promise;
    return { name: file.name, source, pageCount: pdf.numPages, page: await renderPage(pdf, 0) };
  } finally {
    await task.destroy();
  }
}

export async function renderPdfPage(source, index) {
  const task = pdfjs.getDocument({ data: decodePdfSource(source), isEvalSupported: false });
  try {
    const pdf = await task.promise;
    if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) throw new Error('Trang PDF không hợp lệ.');
    return await renderPage(pdf, index);
  } finally {
    await task.destroy();
  }
}
