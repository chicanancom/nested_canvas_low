import { registerPlugin } from '@capacitor/core';

const PdfImport = registerPlugin('PdfImport');

/** Import only the first page; keep PDF bytes for later navigation and saved sessions. */
export async function pickNativePdf(onProgress = () => {}, plugin = PdfImport) {
  const document = await plugin.pick();
  if (document.cancelled) return null;
  try {
    const page = await plugin.renderPage({ token: document.token, pageIndex: 0 });
    onProgress(1, document.pageCount);
    return { name: document.name || 'PDF.pdf', source: document.source, pageCount: document.pageCount, page };
  } finally {
    await plugin.release({ token: document.token });
  }
}

export async function renderNativePdfPage(source, index, plugin = PdfImport) {
  return plugin.renderPage({ source, pageIndex: index });
}
