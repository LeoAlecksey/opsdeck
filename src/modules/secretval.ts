/** A Secret's value: text when the bytes are valid UTF-8 without control characters, otherwise "binary"
 *  (a Helm release, a keystore) shown as its base64, wrapped, instead of garbage. */
export function decodeSecret(b64: string): { text: string; binary: boolean; size: number } {
  const clean = String(b64 ?? "").replace(/\s+/g, "");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)); } catch { return { text: clean, binary: true, size: 0 }; }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return { text, binary: false, size: bytes.length };
  } catch { /* not text */ }
  return { text: clean.replace(/(.{76})/g, "$1\n"), binary: true, size: bytes.length };
}
