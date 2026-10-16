/**
 * Unary gRPC client for NVIDIA's hosted Riva TTS.
 * The public endpoint is gRPC on grpc.nvcf.nvidia.com, which Workers fetch()
 * cannot speak. This talks HTTP/2 over a TLS byte stream (cloudflare:sockets
 * in the Worker, tls in the local check).
 */

const NVIDIA_HOST = 'grpc.nvcf.nvidia.com'
const SYNTH_PATH = '/nvidia.riva.tts.RivaSpeechSynthesis/Synthesize'
export const NVIDIA_SAMPLE_RATE = 22050
export const NVIDIA_MAX_CHARS = 450

const HPACK_STATIC = [
  [':authority', ''],
  [':method', 'GET'],
  [':method', 'POST'],
  [':path', '/'],
  [':path', '/index.html'],
  [':scheme', 'http'],
  [':scheme', 'https'],
  [':status', '200'],
  [':status', '204'],
  [':status', '206'],
  [':status', '304'],
  [':status', '400'],
  [':status', '404'],
  [':status', '500'],
  ['accept-charset', ''],
  ['accept-encoding', 'gzip, deflate'],
  ['accept-language', ''],
  ['accept-ranges', ''],
  ['accept', ''],
  ['access-control-allow-origin', ''],
  ['age', ''],
  ['allow', ''],
  ['authorization', ''],
  ['cache-control', ''],
  ['content-disposition', ''],
  ['content-encoding', ''],
  ['content-language', ''],
  ['content-length', ''],
  ['content-location', ''],
  ['content-range', ''],
  ['content-type', ''],
  ['cookie', ''],
  ['date', ''],
  ['etag', ''],
  ['expect', ''],
  ['expires', ''],
  ['from', ''],
  ['host', ''],
  ['if-match', ''],
  ['if-modified-since', ''],
  ['if-none-match', ''],
  ['if-range', ''],
  ['if-unmodified-since', ''],
  ['last-modified', ''],
  ['link', ''],
  ['location', ''],
  ['max-forwards', ''],
  ['proxy-authenticate', ''],
  ['proxy-authorization', ''],
  ['range', ''],
  ['referer', ''],
  ['refresh', ''],
  ['retry-after', ''],
  ['server', ''],
  ['set-cookie', ''],
  ['strict-transport-security', ''],
  ['transfer-encoding', ''],
  ['user-agent', ''],
  ['vary', ''],
  ['via', ''],
  ['www-authenticate', ''],
]

// [bitLength, code] for symbols 0..256. Codes are right-aligned, MSB first.
const HUFFMAN = [
  [13, 8184], [23, 8388568], [28, 268435426], [28, 268435427], [28, 268435428], [28, 268435429], [28, 268435430], [28, 268435431],
  [28, 268435432], [24, 16777194], [30, 1073741820], [28, 268435433], [28, 268435434], [30, 1073741821], [28, 268435435], [28, 268435436],
  [28, 268435437], [28, 268435438], [28, 268435439], [28, 268435440], [28, 268435441], [28, 268435442], [30, 1073741822], [28, 268435443],
  [28, 268435444], [28, 268435445], [28, 268435446], [28, 268435447], [28, 268435448], [28, 268435449], [28, 268435450], [28, 268435451],
  [6, 20], [10, 1016], [10, 1017], [12, 4090], [13, 8185], [6, 21], [8, 248], [11, 2042], [10, 1018], [10, 1019], [8, 249], [11, 2043],
  [8, 250], [6, 22], [6, 23], [6, 24], [5, 0], [5, 1], [5, 2], [6, 25], [6, 26], [6, 27], [6, 28], [6, 29], [6, 30], [6, 31],
  [7, 92], [8, 251], [15, 32764], [6, 32], [12, 4091], [10, 1020], [13, 8186], [6, 33], [7, 93], [7, 94], [7, 95], [7, 96], [7, 97],
  [7, 98], [7, 99], [7, 100], [7, 101], [7, 102], [7, 103], [7, 104], [7, 105], [7, 106], [7, 107], [7, 108], [7, 109], [7, 110],
  [7, 111], [7, 112], [7, 113], [7, 114], [8, 252], [7, 115], [8, 253], [13, 8187], [19, 524272], [13, 8188], [14, 16380], [6, 34],
  [15, 32765], [5, 3], [6, 35], [5, 4], [6, 36], [5, 5], [6, 37], [6, 38], [6, 39], [5, 6], [7, 116], [7, 117], [6, 40], [6, 41],
  [6, 42], [5, 7], [6, 43], [7, 118], [6, 44], [5, 8], [5, 9], [6, 45], [7, 119], [7, 120], [7, 121], [7, 122], [7, 123], [15, 32766],
  [11, 2044], [14, 16381], [13, 8189], [28, 268435452], [20, 1048550], [22, 4194258], [20, 1048551], [20, 1048552], [22, 4194259],
  [22, 4194260], [22, 4194261], [23, 8388569], [22, 4194262], [23, 8388570], [23, 8388571], [23, 8388572], [23, 8388573], [23, 8388574],
  [24, 16777195], [23, 8388575], [24, 16777196], [24, 16777197], [22, 4194263], [23, 8388576], [24, 16777198], [23, 8388577],
  [23, 8388578], [23, 8388579], [23, 8388580], [21, 2097116], [22, 4194264], [23, 8388581], [22, 4194265], [23, 8388582], [23, 8388583],
  [24, 16777199], [22, 4194266], [21, 2097117], [20, 1048553], [22, 4194267], [22, 4194268], [23, 8388584], [23, 8388585], [21, 2097118],
  [23, 8388586], [22, 4194269], [22, 4194270], [24, 16777200], [21, 2097119], [22, 4194271], [23, 8388587], [23, 8388588], [21, 2097120],
  [21, 2097121], [22, 4194272], [21, 2097122], [23, 8388589], [22, 4194273], [23, 8388590], [23, 8388591], [20, 1048554], [22, 4194274],
  [22, 4194275], [22, 4194276], [23, 8388592], [22, 4194277], [22, 4194278], [23, 8388593], [26, 67108832], [26, 67108833], [20, 1048555],
  [19, 524273], [22, 4194279], [23, 8388594], [22, 4194280], [25, 33554412], [26, 67108834], [26, 67108835], [26, 67108836],
  [27, 134217694], [27, 134217695], [26, 67108837], [24, 16777201], [25, 33554413], [19, 524274], [21, 2097123], [26, 67108838],
  [27, 134217696], [27, 134217697], [26, 67108839], [27, 134217698], [24, 16777202], [21, 2097124], [21, 2097125], [26, 67108840],
  [26, 67108841], [28, 268435453], [27, 134217699], [27, 134217700], [27, 134217701], [20, 1048556], [24, 16777203], [20, 1048557],
  [21, 2097126], [22, 4194281], [21, 2097127], [21, 2097128], [23, 8388595], [22, 4194282], [22, 4194283], [25, 33554414], [25, 33554415],
  [24, 16777204], [24, 16777205], [26, 67108842], [23, 8388596], [26, 67108843], [27, 134217702], [26, 67108844], [26, 67108845],
  [27, 134217703], [27, 134217704], [27, 134217705], [27, 134217706], [27, 134217707], [28, 268435454], [27, 134217708], [27, 134217709],
  [27, 134217710], [27, 134217711], [27, 134217712], [26, 67108846], [30, 1073741823],
]

const huffmanRoot = buildHuffmanTrie()

function buildHuffmanTrie() {
  const root = { zero: null, one: null, sym: -1 }
  HUFFMAN.forEach(([len, code], sym) => {
    let node = root
    for (let i = len - 1; i >= 0; i -= 1) {
      const bit = (code >> i) & 1
      const key = bit ? 'one' : 'zero'
      if (!node[key]) node[key] = { zero: null, one: null, sym: -1 }
      node = node[key]
    }
    node.sym = sym
  })
  return root
}

function decodeHuffman(bytes) {
  const out = []
  let node = huffmanRoot
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      node = ((byte >> bit) & 1) ? node.one : node.zero
      if (!node) throw new Error('Invalid HPACK Huffman data.')
      if (node.sym >= 0) {
        if (node.sym === 256) return new TextDecoder().decode(Uint8Array.from(out))
        out.push(node.sym)
        node = huffmanRoot
      }
    }
  }
  return new TextDecoder().decode(Uint8Array.from(out))
}

function concatBytes(parts) {
  const len = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(len)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function encodeVarint(value) {
  const out = []
  let rest = value >>> 0
  while (rest > 127) {
    out.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return out
}

function encodeStringField(fieldNumber, value) {
  const bytes = new TextEncoder().encode(value)
  return Uint8Array.from([
    ...encodeVarint((fieldNumber << 3) | 2),
    ...encodeVarint(bytes.length),
    ...bytes,
  ])
}

function encodeVarintField(fieldNumber, value) {
  return Uint8Array.from([
    ...encodeVarint((fieldNumber << 3) | 0),
    ...encodeVarint(value),
  ])
}

export function encodeSynthesizeRequest({ text, languageCode, voice, sampleRate = NVIDIA_SAMPLE_RATE }) {
  return concatBytes([
    encodeStringField(1, text),
    encodeStringField(2, languageCode),
    encodeVarintField(3, 1),
    encodeVarintField(4, sampleRate),
    encodeStringField(5, voice),
  ])
}

export function extractPcm(message) {
  let offset = 0
  const chunks = []
  while (offset < message.length) {
    let key = 0
    let shift = 0
    while (offset < message.length) {
      const byte = message[offset]
      offset += 1
      key += (byte & 0x7f) * (2 ** shift)
      if ((byte & 0x80) === 0) break
      shift += 7
    }
    const field = key >> 3
    const wire = key & 7
    if (wire === 0) {
      while (offset < message.length && (message[offset] & 0x80) !== 0) offset += 1
      offset += 1
    } else if (wire === 2) {
      let len = 0
      shift = 0
      while (offset < message.length) {
        const byte = message[offset]
        offset += 1
        len += (byte & 0x7f) * (2 ** shift)
        if ((byte & 0x80) === 0) break
        shift += 7
      }
      const slice = message.subarray(offset, offset + len)
      if (field === 1) chunks.push(slice)
      offset += len
    } else if (wire === 5) {
      offset += 4
    } else if (wire === 1) {
      offset += 8
    } else {
      break
    }
  }
  return concatBytes(chunks)
}

function hpackString(value) {
  const bytes = new TextEncoder().encode(value)
  return Uint8Array.from([bytes.length, ...bytes])
}

function literalHeader(nameIndex, value) {
  const indexByte = nameIndex < 15 ? nameIndex : 15
  const extra = nameIndex >= 15 ? [nameIndex - 15] : []
  return concatBytes([Uint8Array.from([indexByte, ...extra]), hpackString(value)])
}

function newLiteralHeader(name, value) {
  return concatBytes([Uint8Array.of(0), hpackString(name), hpackString(value)])
}

function encodeRequestHeaders({ path, authorization, functionId }) {
  return concatBytes([
    Uint8Array.of(0x80 | 3),
    Uint8Array.of(0x80 | 7),
    literalHeader(4, path),
    literalHeader(1, NVIDIA_HOST),
    literalHeader(31, 'application/grpc'),
    newLiteralHeader('te', 'trailers'),
    literalHeader(23, authorization),
    newLiteralHeader('function-id', functionId),
  ])
}

function decodeHpack(block) {
  const headers = []
  const dynamic = []
  let i = 0
  const readPrefix = (bits) => {
    const mask = (1 << bits) - 1
    let value = block[i] & mask
    i += 1
    if (value < mask) return value
    let m = 0
    while (i < block.length) {
      const byte = block[i]
      i += 1
      value += (byte & 0x7f) * (2 ** m)
      if ((byte & 0x80) === 0) break
      m += 7
    }
    return value
  }
  const readString = () => {
    const huffman = (block[i] & 0x80) !== 0
    const len = readPrefix(7)
    const raw = block.subarray(i, i + len)
    i += len
    return huffman ? decodeHuffman(raw) : new TextDecoder().decode(raw)
  }
  const lookup = (index) => {
    if (index > 0 && index <= HPACK_STATIC.length) return HPACK_STATIC[index - 1]
    const found = dynamic[index - HPACK_STATIC.length - 1]
    if (!found) throw new Error(`Bad HPACK index ${index}.`)
    return found
  }
  while (i < block.length) {
    const lead = block[i]
    if (lead & 0x80) {
      headers.push(lookup(readPrefix(7)))
    } else if (lead & 0x40) {
      const nameIndex = readPrefix(6)
      const name = nameIndex === 0 ? readString() : lookup(nameIndex)[0]
      const value = readString()
      headers.push([name, value])
      dynamic.unshift([name, value])
    } else if (lead & 0x20) {
      readPrefix(5)
    } else {
      const nameIndex = readPrefix(4)
      const name = nameIndex === 0 ? readString() : lookup(nameIndex)[0]
      const value = readString()
      headers.push([name, value])
    }
  }
  return headers
}

function frame(type, flags, streamId, payload) {
  const out = new Uint8Array(9 + payload.length)
  out[0] = (payload.length >> 16) & 0xff
  out[1] = (payload.length >> 8) & 0xff
  out[2] = payload.length & 0xff
  out[3] = type
  out[4] = flags
  out[5] = (streamId >> 24) & 0x7f
  out[6] = (streamId >> 16) & 0xff
  out[7] = (streamId >> 8) & 0xff
  out[8] = streamId & 0xff
  out.set(payload, 9)
  return out
}

function settingsFrame() {
  const payload = new Uint8Array(12)
  const view = new DataView(payload.buffer)
  view.setUint16(0, 2)
  view.setUint32(2, 0)
  view.setUint16(6, 4)
  view.setUint32(8, 16_777_215)
  return frame(0x4, 0, 0, payload)
}

function windowUpdate(streamId, increment) {
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint32(0, increment & 0x7fffffff)
  return frame(0x8, 0, streamId, payload)
}

function grpcMessage(body) {
  const out = new Uint8Array(5 + body.length)
  new DataView(out.buffer).setUint32(1, body.length)
  out.set(body, 5)
  return out
}

class ByteQueue {
  constructor() {
    this.chunks = []
    this.length = 0
  }

  push(chunk) {
    if (!chunk?.length) return
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  take(size) {
    if (this.length < size) return null
    const out = new Uint8Array(size)
    let filled = 0
    while (filled < size) {
      const chunk = this.chunks[0]
      const need = size - filled
      if (chunk.length <= need) {
        out.set(chunk, filled)
        filled += chunk.length
        this.chunks.shift()
      } else {
        out.set(chunk.subarray(0, need), filled)
        this.chunks[0] = chunk.subarray(need)
        filled = size
      }
    }
    this.length -= size
    return out
  }
}

function sliceFramePayload(payload, flags, priority) {
  let start = 0
  let end = payload.length
  if (flags & 0x8) {
    const pad = payload[0] ?? 0
    start = 1
    end -= pad
  }
  if (priority && (flags & 0x20)) start += 5
  return payload.subarray(start, Math.max(start, end))
}

export function languageCodeForNvidiaVoice(voice) {
  const match = String(voice).match(/\.([a-z]{2}-[A-Z]{2})\./)
  return match?.[1] ?? 'en-US'
}

export function splitNvidiaText(text) {
  const source = text.replace(/\s+/g, ' ').trim()
  if (!source) return []
  if (source.length <= NVIDIA_MAX_CHARS) return [source]
  const parts = []
  let rest = source
  while (rest.length > NVIDIA_MAX_CHARS) {
    let cut = rest.lastIndexOf(' ', NVIDIA_MAX_CHARS)
    if (cut < 40) cut = NVIDIA_MAX_CHARS
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/**
 * @param {{ read: () => Promise<Uint8Array | null>, write: (bytes: Uint8Array) => Promise<void>, close: () => void }} conn
 */
export async function grpcUnary(conn, { path, authorization, functionId, message }) {
  const preface = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n')
  const headers = encodeRequestHeaders({
    path,
    authorization,
    functionId,
  })
  await conn.write(concatBytes([
    preface,
    settingsFrame(),
    windowUpdate(0, 1_048_576),
    frame(0x1, 0x4, 1, headers),
    windowUpdate(1, 1_048_576),
    frame(0x0, 0x1, 1, grpcMessage(message)),
  ]))

  const queue = new ByteQueue()
  const dataParts = []
  const responseHeaders = []
  let headerParts = []
  let streamEnded = false

  const readExact = async (size) => {
    while (queue.length < size) {
      const chunk = await conn.read()
      if (!chunk) return null
      queue.push(chunk)
    }
    return queue.take(size)
  }

  while (!streamEnded) {
    const head = await readExact(9)
    if (!head) break
    const length = (head[0] << 16) | (head[1] << 8) | head[2]
    const type = head[3]
    const flags = head[4]
    const streamId = ((head[5] & 0x7f) << 24) | (head[6] << 16) | (head[7] << 8) | head[8]
    const payload = length ? await readExact(length) : new Uint8Array()
    if (!payload) break

    if (type === 0x4 && (flags & 0x1) === 0) {
      await conn.write(frame(0x4, 0x1, 0, new Uint8Array()))
    } else if (type === 0x6 && (flags & 0x1) === 0) {
      await conn.write(frame(0x6, 0x1, 0, payload))
    } else if (type === 0x7) {
      const code = payload.length >= 8 ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4) : -1
      throw new Error(`NVIDIA closed the speech connection (${code}).`)
    } else if (type === 0x3 && streamId === 1) {
      const code = payload.length >= 4 ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0) : -1
      throw new Error(`NVIDIA reset the speech request (${code}).`)
    } else if ((type === 0x1 || type === 0x9) && streamId === 1) {
      headerParts.push(sliceFramePayload(payload, flags, type === 0x1))
      if (flags & 0x4) {
        responseHeaders.push(...decodeHpack(concatBytes(headerParts)))
        headerParts = []
      }
      if (flags & 0x1) streamEnded = true
    } else if (type === 0x0 && streamId === 1) {
      dataParts.push(sliceFramePayload(payload, flags, false))
      if (flags & 0x1) streamEnded = true
    }
  }

  const data = concatBytes(dataParts)
  const messages = []
  let offset = 0
  while (offset + 5 <= data.length) {
    const compressed = data[offset]
    const size = new DataView(data.buffer, data.byteOffset + offset + 1, 4).getUint32(0)
    if (offset + 5 + size > data.length) break
    if (compressed) throw new Error('NVIDIA returned compressed audio, which this client does not unpack.')
    messages.push(data.subarray(offset + 5, offset + 5 + size))
    offset += 5 + size
  }

  const statusHeader = responseHeaders.find(([name]) => name === 'grpc-status')
  const messageHeader = responseHeaders.find(([name]) => name === 'grpc-message')
  const status = statusHeader ? Number(statusHeader[1]) : (messages.length ? 0 : 13)
  if (status !== 0) {
    const detail = messageHeader ? decodeURIComponent(messageHeader[1].replace(/\+/g, ' ')) : `gRPC status ${status}`
    const error = new Error(detail)
    error.status = status
    throw error
  }
  if (!messages.length) throw new Error('NVIDIA returned no speech audio.')
  return messages[0]
}

export async function synthesizeNvidiaPcm(conn, { apiKey, functionId, text, voice, languageCode }) {
  const message = encodeSynthesizeRequest({ text, languageCode, voice })
  return grpcUnary(conn, {
    path: SYNTH_PATH,
    authorization: `Bearer ${apiKey}`,
    functionId,
    message,
  }).then(extractPcm)
}

export function pcmToWav(pcm, sampleRate = NVIDIA_SAMPLE_RATE) {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  const wav = new Uint8Array(44 + pcm.byteLength)
  wav.set(new Uint8Array(header), 0)
  wav.set(pcm, 44)
  return wav
}
