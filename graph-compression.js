async function transform(bytes, stream) {
  // Feed one buffer; Blob.stream() splits a large graph into many asynchronous
  // chunks, adding substantial scheduling overhead in background documents.
  const result = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await Promise.all([result, (async () => {
    await writer.write(bytes);
    await writer.close();
  })()]);
  return new Uint8Array(await result);
}

export async function compressGraphText(text) {
  const bytes = await transform(new TextEncoder().encode(text), new CompressionStream("gzip"));
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

export async function decompressGraphText(data) {
  const bytes = typeof Uint8Array.fromBase64 === "function"
    ? Uint8Array.fromBase64(data)
    : Uint8Array.from(atob(data), character => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await transform(bytes, new DecompressionStream("gzip"))
  );
}
