import { expect, it } from "vitest";
import QRCode from "qrcode";
import { qrImageBounds } from "../apps/web/src/lib/image-bounds.ts";
import { parseTotpQr } from "../apps/web/src/lib/qr-totp.ts";
it("recognizes actual PNG dimensions and rejects huge allocations before decoding", async () => {
  const png = await QRCode.toBuffer("Synthetic QR", { width: 512 });
  expect(qrImageBounds(png)).toEqual({ width: 512, height: 512 });
  const huge = Buffer.from(png);
  huge.writeUInt32BE(100_000, 16);
  expect(() => qrImageBounds(huge)).toThrow("Слишком большое");
  expect(() =>
    qrImageBounds(new TextEncoder().encode('<svg onload="alert(1)"/>')),
  ).toThrow();
});
it("accepts supported TOTP parameters and rejects ambiguous, remote and HOTP payloads without exposing them", () => {
  const uri =
    "otpauth://totp/Synthetic:owner?secret=AAAAAAAAAAAAAAAA&digits=8&period=60&algorithm=SHA256";
  expect(parseTotpQr(uri).config).toMatchObject({
    digits: 8,
    period: 60,
    algorithm: "SHA256",
  });
  for (const value of [
    "https://evil.example/secret",
    uri + "&secret=BBBBBBBBBBBBBBBB",
    uri.replace("totp", "hotp"),
    uri.replace("period=60", "period=45"),
    "otpauth://private-secret@:bad",
  ]) {
    try {
      parseTotpQr(value);
      throw Error("accepted");
    } catch (error) {
      expect((error as Error).message).not.toContain("private-secret");
      expect((error as Error).message).not.toBe("accepted");
    }
  }
});
