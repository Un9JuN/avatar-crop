/*!
 * zip.js — 极简 ZIP 打包（仅 store，不压缩），用于“全部下载”。
 * 浏览器的多个文件下载会被拦截，打包成一个 zip 更可靠。
 */
(function (root) {
  'use strict';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function encodeName(name) {
    if (encoder) return encoder.encode(name);
    // 极端兜底：无 TextEncoder 时按 UTF-8 手工编码
    const out = [];
    for (const ch of name) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return new Uint8Array(out);
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  /**
   * @param {Array<{name: string, data: Uint8Array}>} files
   * @param {Date} [now]
   * @returns {Uint8Array} zip 字节
   */
  function build(files, now) {
    const dt = dosDateTime(now || new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    files.forEach((file) => {
      const name = encodeName(file.name);
      const data = file.data;
      const crc = crc32(data);

      const header = new Uint8Array(30 + name.length);
      const hv = new DataView(header.buffer);
      hv.setUint32(0, 0x04034b50, true);   // local file header
      hv.setUint16(4, 20, true);           // version needed
      hv.setUint16(6, 0x0800, true);       // UTF-8 文件名
      hv.setUint16(8, 0, true);            // store
      hv.setUint16(10, dt.time, true);
      hv.setUint16(12, dt.day, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, data.length, true);
      hv.setUint32(22, data.length, true);
      hv.setUint16(26, name.length, true);
      hv.setUint16(28, 0, true);
      header.set(name, 30);

      chunks.push(header, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central directory header
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.day, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);

      offset += header.length + data.length;
    });

    const centralSize = central.reduce((sum, c) => sum + c.length, 0);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);     // end of central directory
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const total = offset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let pos = 0;
    chunks.forEach((c) => { out.set(c, pos); pos += c.length; });
    central.forEach((c) => { out.set(c, pos); pos += c.length; });
    out.set(eocd, pos);
    return out;
  }

  root.SimpleZip = { build, crc32 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
