import { qrImageBounds } from "./image-bounds";
import { normalizeTotp } from "../../../../packages/core/src/index.ts";
export function parseTotpQr(input: string) {
  if (input.length > 4096 || !input.startsWith("otpauth://"))
    throw new Error("Этот QR не содержит настройки TOTP.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Некорректный QR-код TOTP.");
  }
  if (
    url.hostname !== "totp" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new Error("Поддерживаются QR-коды TOTP без дополнительных адресов.");
  for (const key of ["secret", "issuer", "algorithm", "digits", "period"])
    if (url.searchParams.getAll(key).length > 1)
      throw new Error("QR содержит неоднозначные параметры.");
  const config = normalizeTotp(input);
  let label: string;
  try {
    label = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("Некорректная подпись QR-кода TOTP.");
  }
  const issuer = (
    url.searchParams.get("issuer") ??
    label.split(":")[0] ??
    ""
  ).slice(0, 200);
  const account = (
    label.includes(":") ? label.slice(label.indexOf(":") + 1) : label
  ).slice(0, 200);
  return { uri: input, config, issuer, account };
}
export async function readQrImage(blob: Blob): Promise<string> {
  if (blob.size > 10 * 1024 * 1024)
    throw new Error("Изображение больше 10 МБ.");
  qrImageBounds(new Uint8Array(await blob.arrayBuffer()));
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 16_777_216)
      throw new Error(
        "Слишком большое изображение. Обрежьте область с QR-кодом.",
      );
    const canvas = document.createElement("canvas"),
      scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Не удалось прочитать изображение.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const { BrowserQRCodeReader } = await import("@zxing/browser");
    try {
      return new BrowserQRCodeReader().decodeFromCanvas(canvas).getText();
    } catch {
      throw new Error(
        "QR-код не найден. Обрежьте изображение до области с кодом и попробуйте снова.",
      );
    }
  } finally {
    bitmap.close();
  }
}
