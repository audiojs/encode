import t, { is, ok, almost } from 'tst'
import caf from './caf-encode.js'

function sine(rate, freq, dur) {
	let n = rate * dur, d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / rate)
	return d
}

// Parse CAF chunks: returns { desc, dataOffset, dataBodySize }
function parseCAF(buf) {
	let dv = new DataView(buf.buffer)
	// File header: 'caff'(4) + version(2) + flags(2) = 8 bytes
	let magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3])
	let version = dv.getUint16(4, false)
	let chunks = {}
	let pos = 8
	while (pos < buf.length) {
		let type = String.fromCharCode(buf[pos], buf[pos+1], buf[pos+2], buf[pos+3])
		let sizeHi = dv.getUint32(pos + 4, false)
		let sizeLo = dv.getUint32(pos + 8, false)
		let bodyStart = pos + 12
		chunks[type] = { bodyStart, size: sizeLo }
		pos = bodyStart + sizeLo
	}
	return { magic, version, chunks, dv }
}

t('mono 16-bit int — header + desc chunk', async () => {
	let enc = await caf({ sampleRate: 44100, bitDepth: 16 })
	enc.encode([sine(44100, 440, 0.1)])
	let buf = enc.flush()

	ok(buf instanceof Uint8Array, 'returns Uint8Array')
	let { magic, version, chunks, dv } = parseCAF(buf)
	is(magic, 'caff', 'CAF magic')
	is(version, 1, 'file version 1')

	ok(chunks.desc, 'has desc chunk')
	is(chunks.desc.size, 32, 'desc body = 32 bytes')

	let d = chunks.desc.bodyStart
	// mSampleRate: Float64 BE
	almost(dv.getFloat64(d, false), 44100, 0.001, 'sampleRate 44100')
	// mFormatID: 'lpcm'
	let fmt = String.fromCharCode(buf[d+8], buf[d+9], buf[d+10], buf[d+11])
	is(fmt, 'lpcm', 'formatID lpcm')
	// mFormatFlags: 0 for int
	is(dv.getUint32(d + 12, false), 0, 'flags=0 for int')
	// mBytesPerPacket: channels * bytesPerSample = 1 * 2
	is(dv.getUint32(d + 16, false), 2, 'bytesPerPacket=2')
	// mFramesPerPacket: 1
	is(dv.getUint32(d + 20, false), 1, 'framesPerPacket=1')
	// mChannelsPerFrame: 1
	is(dv.getUint32(d + 24, false), 1, 'channels=1')
	// mBitsPerChannel: 16
	is(dv.getUint32(d + 28, false), 16, 'bitDepth=16')
})

t('mono 16-bit int — data chunk size + sample reconstruction', async () => {
	let sr = 44100, freq = 440, dur = 0.1
	let enc = await caf({ sampleRate: sr, bitDepth: 16 })
	let ch = sine(sr, freq, dur)
	enc.encode([ch])
	let buf = enc.flush()
	let { chunks, dv } = parseCAF(buf)

	ok(chunks.data, 'has data chunk')
	let expectedPcm = ch.length * 1 * 2  // frames * channels * bytesPerSample
	is(chunks.data.size, 4 + expectedPcm, 'data chunk size = 4 + pcmBytes')

	// Read back first sample: skip mEditCount(4) at body start
	let sampleOff = chunks.data.bodyStart + 4
	let s0 = dv.getInt16(sampleOff, false) / 0x7FFF
	almost(s0, ch[0], 0.0002, 'first sample reconstructs')
})

t('stereo 16-bit int — channels=2, bytesPerPacket=4', async () => {
	let enc = await caf({ sampleRate: 48000, bitDepth: 16 })
	enc.encode([sine(48000, 440, 0.1), sine(48000, 880, 0.1)])
	let buf = enc.flush()
	let { chunks, dv } = parseCAF(buf)

	let d = chunks.desc.bodyStart
	is(dv.getUint32(d + 24, false), 2, 'channels=2')
	is(dv.getUint32(d + 16, false), 4, 'bytesPerPacket=4')
})

t('mono 32-bit float — flags=1, bytesPerPacket=4', async () => {
	let enc = await caf({ sampleRate: 44100, bitDepth: 32 })
	enc.encode([sine(44100, 440, 0.1)])
	let buf = enc.flush()
	let { chunks, dv } = parseCAF(buf)

	let d = chunks.desc.bodyStart
	almost(dv.getFloat64(d, false), 44100, 0.001, 'sampleRate 44100')
	let fmt = String.fromCharCode(buf[d+8], buf[d+9], buf[d+10], buf[d+11])
	is(fmt, 'lpcm', 'formatID lpcm')
	is(dv.getUint32(d + 12, false), 1, 'flags=1 for float')
	is(dv.getUint32(d + 16, false), 4, 'bytesPerPacket=4')
	is(dv.getUint32(d + 28, false), 32, 'bitDepth=32')
})

t('32-bit float — data size + sample reconstruction', async () => {
	let sr = 44100, dur = 0.1
	let enc = await caf({ sampleRate: sr, bitDepth: 32 })
	let ch = sine(sr, 440, dur)
	enc.encode([ch])
	let buf = enc.flush()
	let { chunks, dv } = parseCAF(buf)

	let expectedPcm = ch.length * 4
	is(chunks.data.size, 4 + expectedPcm, 'data chunk size = 4 + pcmBytes')

	let sampleOff = chunks.data.bodyStart + 4
	let s0 = dv.getFloat32(sampleOff, false)
	almost(s0, ch[0], 0.000001, 'float32 sample exact')
})

t('stereo 32-bit float — data size', async () => {
	let sr = 44100, dur = 0.1
	let enc = await caf({ sampleRate: sr, bitDepth: 32 })
	let L = sine(sr, 440, dur), R = sine(sr, 880, dur)
	enc.encode([L, R])
	let buf = enc.flush()
	let { chunks, dv } = parseCAF(buf)

	let expectedPcm = L.length * 2 * 4
	is(chunks.data.size, 4 + expectedPcm, 'stereo float data size')
})

t('streaming chunks accumulate', async () => {
	let enc = await caf({ sampleRate: 44100 })
	enc.encode([sine(44100, 440, 0.05)])
	enc.encode([sine(44100, 440, 0.05)])
	let buf = enc.flush()
	let { chunks, dv } = parseCAF(buf)
	let expectedPcm = Math.round(44100 * 0.05) * 2 * 2  // 2 chunks * frames * 2 bytes
	is(chunks.data.size, 4 + expectedPcm, 'two chunks accumulated')
})
