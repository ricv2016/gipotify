// Lectura de etiquetas sin librerías externas: ID3v2.2/2.3/2.4, ID3v1 y RIFF INFO (WAV).
const latin = new TextDecoder('windows-1252');
const utf8 = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const u16le = new TextDecoder('utf-16le');
const u16be = new TextDecoder('utf-16be');

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const isID3 = (b) => b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function deUnsync(u8) {
  const out = new Uint8Array(u8.length);
  let j = 0;
  for (let i = 0; i < u8.length; i++) {
    out[j++] = u8[i];
    if (u8[i] === 0xff && u8[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decode(bytes, enc) {
  if (enc === 1) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return u16be.decode(bytes.subarray(2));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return u16le.decode(bytes.subarray(2));
    return u16le.decode(bytes);
  }
  if (enc === 2) return u16be.decode(bytes);
  if (enc === 3) return utf8.decode(bytes);
  return latin.decode(bytes);
}

const clean = (s) => s.replace(/﻿/g, '').split('\0').map((x) => x.trim()).filter(Boolean).join(' / ');

// Posición del terminador nulo (1 byte en latin/utf8, 2 bytes alineados en utf16).
function findTerm(b, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, start);
  return i < 0 ? b.length : i;
}

const TEXT_FRAMES = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album',
  TRCK: 'track', TRK: 'track',
  TPOS: 'disc', TPA: 'disc',
  TYER: 'year', TYE: 'year', TDRC: 'year',
  TCON: 'genre', TCO: 'genre',
};

function handleFrame(id, data, out) {
  const key = TEXT_FRAMES[id];
  if (key) {
    if (out[key]) return;
    let v = clean(decode(data.subarray(1), data[0]));
    if (key === 'genre') {
      const rest = v.replace(/^\(\d+\)\s*/, '');
      v = /^\(?\d+\)?$/.test(v) ? '' : rest;
    }
    if (key === 'year') v = v.slice(0, 4);
    if (v) out[key] = v;
    return;
  }
  if (id === 'APIC' || id === 'PIC') {
    const enc = data[0];
    let p, mime;
    if (id === 'PIC') {
      mime = latin.decode(data.subarray(1, 4)).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
      p = 4;
    } else {
      const e = data.indexOf(0, 1);
      if (e < 0) return;
      mime = latin.decode(data.subarray(1, e)).toLowerCase().trim();
      if (!mime.includes('/')) mime = 'image/' + (mime || 'jpeg');
      if (mime === 'image/jpg') mime = 'image/jpeg';
      p = e + 1;
    }
    const type = data[p++];
    p = findTerm(data, p, enc) + (enc === 1 || enc === 2 ? 2 : 1);
    if (p >= data.length) return;
    if (!out.picture || (type === 3 && out._picType !== 3)) {
      out.picture = new Blob([data.slice(p)], { type: mime });
      out._picType = type;
    }
  }
}

export function parseID3v2(u8) {
  const ver = u8[3];
  const flags = u8[5];
  const size = syncsafe(u8, 6);
  let body = u8.subarray(10, 10 + size);
  if ((flags & 0x80) && ver < 4) body = deUnsync(body);
  let pos = 0;
  if (flags & 0x40) {
    if (ver === 3) pos = 4 + be32(body, 0);
    else if (ver === 4) pos = syncsafe(body, 0);
  }
  const out = {};
  const idLen = ver === 2 ? 3 : 4;
  const hdr = ver === 2 ? 6 : 10;
  while (pos + hdr <= body.length) {
    const id = String.fromCharCode(...body.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // relleno (padding)
    let fsize;
    if (ver === 2) fsize = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
    else if (ver === 4) fsize = syncsafe(body, pos + 4);
    else fsize = be32(body, pos + 4);
    const fflags = ver === 2 ? 0 : body[pos + 9];
    let data = body.subarray(pos + hdr, pos + hdr + fsize);
    pos += hdr + fsize;
    if (!fsize) continue;
    if (ver === 4) {
      if (fflags & 0x0c) continue; // comprimido o cifrado
      if (fflags & 0x40) data = data.subarray(1);
      if (fflags & 0x01) data = data.subarray(4);
      if (fflags & 0x02) data = deUnsync(data);
    } else if (ver === 3) {
      if (fflags & 0xc0) continue;
      if (fflags & 0x20) data = data.subarray(1);
    }
    try { handleFrame(id, data, out); } catch { /* frame dañado: se ignora */ }
  }
  delete out._picType;
  return out;
}

function str1(b, o, n) {
  const s = b.subarray(o, o + n);
  const z = s.indexOf(0);
  return latin.decode(z < 0 ? s : s.subarray(0, z)).trim();
}

async function parseID3v1(file) {
  if (file.size < 128) return {};
  const t = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
  if (!(t[0] === 0x54 && t[1] === 0x41 && t[2] === 0x47)) return {};
  const out = { title: str1(t, 3, 30), artist: str1(t, 33, 30), album: str1(t, 63, 30), year: str1(t, 93, 4) };
  if (t[125] === 0 && t[126]) out.track = String(t[126]);
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

function decodeInfo(bytes) {
  const z = bytes.indexOf(0);
  const b = z < 0 ? bytes : bytes.subarray(0, z);
  try { return utf8Strict.decode(b).trim(); } catch { return latin.decode(b).trim(); }
}

const INFO = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year', IPRT: 'track', ITRK: 'track', IGNR: 'genre' };

async function parseWav(file) {
  const out = {};
  let off = 12, byteRate = 0, dataSize = 0, guard = 0;
  while (off + 8 <= file.size && guard++ < 64) {
    const h = new Uint8Array(await file.slice(off, off + 8).arrayBuffer());
    const id = fourcc(h, 0);
    const sz = le32(h, 4);
    const start = off + 8;
    if (id === 'fmt ') {
      const f = new Uint8Array(await file.slice(start, start + 16).arrayBuffer());
      byteRate = le32(f, 8);
    } else if (id === 'data') {
      dataSize = sz && start + sz <= file.size ? sz : file.size - start;
    } else if (id === 'LIST' && sz < 1e6) {
      const b = new Uint8Array(await file.slice(start, start + sz).arrayBuffer());
      if (fourcc(b, 0) === 'INFO') {
        let p = 4;
        while (p + 8 <= b.length) {
          const sid = fourcc(b, p);
          const ssz = le32(b, p + 4);
          const key = INFO[sid];
          if (key && !out[key]) {
            const v = decodeInfo(b.subarray(p + 8, p + 8 + ssz));
            if (v) out[key] = key === 'year' ? v.slice(0, 4) : v;
          }
          p += 8 + ssz + (ssz & 1);
        }
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && sz < 3e7) {
      const b = new Uint8Array(await file.slice(start, start + sz).arrayBuffer());
      if (isID3(b)) Object.assign(out, parseID3v2(b)); // ID3 manda sobre INFO
    }
    if (sz === 0xffffffff) break;
    off = start + sz + (sz & 1);
  }
  if (byteRate && dataSize) out.duration = dataSize / byteRate;
  return out;
}

export async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'WAVE') return await parseWav(file);
    let tags = {};
    if (isID3(head)) {
      const size = syncsafe(head, 6) + 10;
      tags = parseID3v2(new Uint8Array(await file.slice(0, size).arrayBuffer()));
    }
    if (!tags.title || !tags.artist) {
      const v1 = await parseID3v1(file);
      for (const k of Object.keys(v1)) if (!tags[k]) tags[k] = v1[k];
    }
    return tags;
  } catch (e) {
    console.warn('No se pudieron leer las etiquetas de', file.name, e);
    return {};
  }
}
