// Desktop uses the same length-prefixed JSON framing on Unix sockets and
// Windows named pipes. Its maximum frame size is 256 MiB.
export const MAX_DESKTOP_FRAME_BYTES = 256 * 1024 * 1024;

export function createDesktopFrameReader(receive) {
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let body;
  let bodyBytes = 0;
  return (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (!body) {
        const count = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        headerBytes += count;
        offset += count;
        if (headerBytes < 4) continue;
        const size = header.readUInt32LE();
        if (!size || size > MAX_DESKTOP_FRAME_BYTES) throw new Error("Invalid IPC frame size");
        body = Buffer.allocUnsafe(size);
        bodyBytes = 0;
        headerBytes = 0;
      }
      const count = Math.min(body.length - bodyBytes, chunk.length - offset);
      chunk.copy(body, bodyBytes, offset, offset + count);
      bodyBytes += count;
      offset += count;
      if (bodyBytes === body.length) {
        const complete = body;
        body = undefined;
        receive(JSON.parse(complete.toString("utf8")));
      }
    }
  };
}
