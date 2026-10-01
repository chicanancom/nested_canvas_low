export function encodePdfSource(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  }
  return btoa(binary);
}

export function decodePdfSource(source) {
  return Uint8Array.from(atob(source), char => char.charCodeAt(0));
}
