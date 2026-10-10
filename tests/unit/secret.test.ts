import { describe, expect, it } from "vitest";
import { decodeSecret } from "../../src/modules/secretval";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

describe("decodeSecret", () => {
  it("text, with line breaks, Cyrillic and trailing newline", () => {
    const r = decodeSecret(b64("line1\nстрока 2\n"));
    expect(r).toEqual({ text: "line1\nстрока 2\n", binary: false, size: Buffer.byteLength("line1\nстрока 2\n") });
  });
  it("base64 split over lines by a tool still decodes", () => {
    const wrapped = b64("hello world").replace(/(.{4})/g, "$1\n");
    expect(decodeSecret(wrapped).text).toBe("hello world");
  });
  it("binary (gzip) is not decoded to garbage: base64 back, wrapped", () => {
    const gz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xed, 0xfd, 0x07]);
    const r = decodeSecret(gz.toString("base64"));
    expect(r.binary).toBe(true);
    expect(r.size).toBe(7);
    expect(r.text.replace(/\n/g, "")).toBe(gz.toString("base64"));
  });
  it("control characters make it binary; invalid base64 is shown as it is", () => {
    expect(decodeSecret(b64("a\u0000b")).binary).toBe(true);
    expect(decodeSecret("не base64!!")).toMatchObject({ binary: true, size: 0 });
  });
});
