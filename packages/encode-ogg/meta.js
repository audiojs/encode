/**
 * OGG Vorbis metadata writer — rewrites the VorbisComment header packet.
 * @module @audio/encode-ogg/meta
 *
 * The three Vorbis headers (identification, comment, setup) precede the audio.
 * We replace the comment packet, re-page the headers, then renumber + re-CRC the
 * untouched audio pages so the bitstream stays valid. Audio samples are unchanged.
 */

const TE = new TextEncoder()

// VorbisComment field map (shared shape with FLAC/Opus)
const VORBIS_MAP = {
  title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', albumartist: 'ALBUMARTIST',
  composer: 'COMPOSER', genre: 'GENRE', year: 'DATE', track: 'TRACKNUMBER',
  disc: 'DISCNUMBER', bpm: 'BPM', key: 'KEY', comment: 'COMMENT',
  copyright: 'COPYRIGHT', isrc: 'ISRC', publisher: 'PUBLISHER', software: 'ENCODER',
  lyrics: 'LYRICS'
}

function concat(arrays) {
  let n = 0
  for (let a of arrays) n += a.length
  let out = new Uint8Array(n), off = 0
  for (let a of arrays) { out.set(a, off); off += a.length }
  return out
}

// ── VorbisComment packet ──────────────────────────────────────────────────

function buildCommentPacket(meta) {
  let vendor = TE.encode('audio-encode')
  let entries = []
  for (let k in VORBIS_MAP) {
    let v = meta[k]
    if (v == null || v === '') continue
    entries.push(TE.encode(VORBIS_MAP[k] + '=' + v))
  }
  let size = 7 + 4 + vendor.length + 4
  for (let e of entries) size += 4 + e.length
  size += 1 // framing bit
  let b = new Uint8Array(size)
  let d = new DataView(b.buffer)
  b[0] = 3
  b.set(TE.encode('vorbis'), 1)
  let pos = 7
  d.setUint32(pos, vendor.length, true); pos += 4
  b.set(vendor, pos); pos += vendor.length
  d.setUint32(pos, entries.length, true); pos += 4
  for (let e of entries) {
    d.setUint32(pos, e.length, true); pos += 4
    b.set(e, pos); pos += e.length
  }
  b[pos] = 1 // framing bit
  return b
}

// ── Ogg paging ──────────────────────────────────────────────────────────────

function parsePages(bytes) {
  let pages = []
  let off = 0
  while (off + 27 <= bytes.length) {
    if (!(bytes[off] === 0x4F && bytes[off + 1] === 0x67 && bytes[off + 2] === 0x67 && bytes[off + 3] === 0x53)) break
    let nSegs = bytes[off + 26]
    let segTable = bytes.subarray(off + 27, off + 27 + nSegs)
    let payloadLen = 0
    for (let i = 0; i < nSegs; i++) payloadLen += segTable[i]
    let payloadStart = off + 27 + nSegs
    pages.push({ start: off, len: 27 + nSegs + payloadLen, nSegs, segTable, payloadStart })
    off += 27 + nSegs + payloadLen
  }
  return pages
}

function buildPage(payload, segLens, serial, seq, granule, flags) {
  let nSegs = segLens.length
  let page = new Uint8Array(27 + nSegs + payload.length)
  let d = new DataView(page.buffer)
  page[0] = 0x4F; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53 // "OggS"
  page[4] = 0
  page[5] = flags
  d.setUint32(6, Number(granule & 0xFFFFFFFFn), true)
  d.setUint32(10, Number((granule >> 32n) & 0xFFFFFFFFn), true)
  d.setUint32(14, serial, true)
  d.setUint32(18, seq, true)
  d.setUint32(22, 0, true)
  page[26] = nSegs
  for (let i = 0; i < nSegs; i++) page[27 + i] = segLens[i]
  page.set(payload, 27 + nSegs)
  d.setUint32(22, oggCrc(page), true)
  return page
}

// Lace packets into pages (<=255 segments each), granule 0 (header pages).
function pageify(packets, serial, startSeq, firstFlags) {
  let allBytes = concat(packets)
  let segLens = []
  for (let p of packets) {
    let n = Math.floor(p.length / 255)
    for (let i = 0; i < n; i++) segLens.push(255)
    segLens.push(p.length % 255)
  }
  let pages = [], segIdx = 0, byteOff = 0, seq = startSeq, pageNo = 0, prevLast = -1
  while (segIdx < segLens.length) {
    let count = Math.min(255, segLens.length - segIdx)
    let pageSegs = segLens.slice(segIdx, segIdx + count)
    let payloadLen = pageSegs.reduce((a, b) => a + b, 0)
    let flags = pageNo === 0 ? firstFlags : (prevLast === 255 ? 0x01 : 0)
    pages.push(buildPage(allBytes.subarray(byteOff, byteOff + payloadLen), pageSegs, serial, seq++, 0n, flags))
    prevLast = pageSegs[pageSegs.length - 1]
    segIdx += count; byteOff += payloadLen; pageNo++
  }
  return { pages, nextSeq: seq }
}

/** Splice VorbisComment tags into Ogg Vorbis bytes. Returns new Uint8Array. */
export function writeMeta(bytes, { meta = {} } = {}) {
  let pages = parsePages(bytes)
  if (pages.length < 2) return bytes
  let serial = new DataView(bytes.buffer, bytes.byteOffset).getUint32(pages[0].start + 14, true)

  // reassemble the first 3 packets (id, comment, setup)
  let packets = [], cur = [], lastHeaderPage = -1, bailed = false
  for (let pi = 0; pi < pages.length && packets.length < 3; pi++) {
    let pg = pages[pi], segOff = pg.payloadStart
    for (let s = 0; s < pg.nSegs; s++) {
      let segLen = pg.segTable[s]
      cur.push(bytes.subarray(segOff, segOff + segLen))
      segOff += segLen
      if (segLen < 255) {
        packets.push(concat(cur)); cur = []
        if (packets.length === 3) {
          if (s < pg.nSegs - 1) bailed = true // audio shares the setup page — leave untouched
          lastHeaderPage = pi
          break
        }
      }
    }
  }
  if (bailed || packets.length < 3) return bytes
  // packet[1] must be the comment header
  let c = packets[1]
  if (!(c[0] === 3 && c[1] === 0x76 && c[2] === 0x6F && c[3] === 0x72 && c[4] === 0x62 && c[5] === 0x69 && c[6] === 0x73)) return bytes

  let header = [packets[0], buildCommentPacket(meta), packets[2]]
  // id header alone on the BOS page (Vorbis requires this), then comment+setup
  let p0 = pageify([header[0]], serial, 0, 0x02)
  let p1 = pageify([header[1], header[2]], serial, p0.nextSeq, 0)

  // renumber + re-CRC the untouched audio pages
  let seq = p1.nextSeq
  let audio = []
  for (let pi = lastHeaderPage + 1; pi < pages.length; pi++) {
    let pg = pages[pi]
    let copy = bytes.slice(pg.start, pg.start + pg.len)
    let d = new DataView(copy.buffer)
    d.setUint32(18, seq++, true)
    d.setUint32(22, 0, true)
    d.setUint32(22, oggCrc(copy), true)
    audio.push(copy)
  }
  return concat([...p0.pages, ...p1.pages, ...audio])
}

// Ogg CRC32: poly=0x04C11DB7, init=0, no reflection, no xorout
let crcTbl
function oggCrc(data) {
  if (!crcTbl) {
    crcTbl = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let r = i << 24
      for (let j = 0; j < 8; j++) r = ((r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1)) >>> 0
      crcTbl[i] = r >>> 0
    }
  }
  let crc = 0
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ crcTbl[((crc >>> 24) ^ data[i]) & 0xFF]) >>> 0
  return crc >>> 0
}
