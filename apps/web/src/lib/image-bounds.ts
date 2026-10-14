// Read dimensions before decoding to bound image memory. No image content is retained.
export function qrImageBounds(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ascii = (offset: number) =>
      new TextDecoder().decode(bytes.subarray(offset, offset + 4));
  let width = 0,
    height = 0;
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1) === "PNG\r") {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 12 && ascii(0) === "RIFF" && ascii(8) === "WEBP") {
    for (let position = 12; position + 8 <= bytes.length;) {
      const kind = ascii(position),
        length = view.getUint32(position + 4, true),
        offset = position + 8;
      if (offset + length > bytes.length) break;
      if (kind === "VP8X" && length >= 10) {
        if (bytes[offset]! & 2)
          throw new Error("Для QR используйте неподвижное изображение.");
        width =
          1 +
          bytes[offset + 4]! +
          (bytes[offset + 5]! << 8) +
          (bytes[offset + 6]! << 16);
        height =
          1 +
          bytes[offset + 7]! +
          (bytes[offset + 8]! << 8) +
          (bytes[offset + 9]! << 16);
        break;
      }
      if (kind === "VP8L" && length >= 5 && bytes[offset] === 47) {
        const packed = view.getUint32(offset + 1, true);
        width = (packed & 16383) + 1;
        height = ((packed >>> 14) & 16383) + 1;
        break;
      }
      if (
        kind === "VP8 " &&
        length >= 10 &&
        bytes[offset + 3] === 157 &&
        bytes[offset + 4] === 1 &&
        bytes[offset + 5] === 42
      ) {
        width = view.getUint16(offset + 6, true) & 16383;
        height = view.getUint16(offset + 8, true) & 16383;
        break;
      }
      position = offset + length + (length % 2);
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let position = 2;
    while (position + 4 <= bytes.length) {
      if (bytes[position++] !== 255) break;
      while (bytes[position] === 255) position++;
      const marker = bytes[position++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (position + 2 > bytes.length) break;
      const length = view.getUint16(position);
      if (length < 2 || position + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 7
      ) {
        height = view.getUint16(position + 3);
        width = view.getUint16(position + 5);
        break;
      }
      position += length;
    }
  }
  if (!width || !height)
    throw new Error("Выберите корректный PNG, JPEG или WebP.");
  if (width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new Error(
      "Слишком большое изображение. Обрежьте область с QR-кодом.",
    );
  return { width, height };
}
