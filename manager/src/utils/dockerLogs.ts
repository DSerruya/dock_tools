// Docker's raw container.logs() response is multiplexed (an 8-byte header per frame: stream type
// + big-endian length, then that many bytes of payload) whenever the container wasn't started
// with a TTY — which none of ours are. Shared by every service that reads logs directly off a
// Dockerode Container rather than going through modem.demuxStream on a live follow() stream.
export function demuxLogs(buf: Buffer): string {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;
    lines.push(buf.slice(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return lines.join('');
}
