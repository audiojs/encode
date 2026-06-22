import t, { is, ok, almost } from 'tst'
import qoa from './qoa-encode.js'
import decode from 'audio-decode'

function rms(arr) {
	let sum = 0
	for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i]
	return Math.sqrt(sum / arr.length)
}

function sine(sr = 44100, freq = 440, dur = 1) {
	let n = Math.floor(sr * dur)
	let d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / sr)
	return [d]
}

t('round-trip: whole signal in one encode() call', async () => {
	let sr = 44100
	let ch = sine(sr, 440, 0.5)
	let enc = await qoa({ sampleRate: sr })
	let part = enc.encode(ch)
	is(part.length, 0, 'encode returns empty')
	let bytes = enc.flush()
	ok(bytes.length > 0, 'flush returns bytes')
	enc.free()

	let dec = await decode(bytes)
	is(dec.sampleRate, sr, 'sampleRate preserved')
	almost(rms(dec.channelData[0]), rms(ch[0]), 0.05, 'RMS within QOA lossy tolerance')
})

t('round-trip: signal split across two encode() calls', async () => {
	let sr = 44100
	let half = sine(sr, 440, 0.25)
	let enc = await qoa({ sampleRate: sr })
	enc.encode(half)
	enc.encode(half)
	let bytes = enc.flush()
	enc.free()

	let dec = await decode(bytes)
	is(dec.sampleRate, sr, 'sampleRate preserved')
	almost(rms(dec.channelData[0]), rms(half[0]), 0.05, 'RMS within QOA lossy tolerance')
})

t('one-call vs two-call produce same output length', async () => {
	let sr = 44100
	let ch = sine(sr, 440, 0.5)
	let half1 = [ch[0].slice(0, ch[0].length / 2)]
	let half2 = [ch[0].slice(ch[0].length / 2)]

	let enc1 = await qoa({ sampleRate: sr })
	enc1.encode(ch)
	let bytes1 = enc1.flush()
	enc1.free()

	let enc2 = await qoa({ sampleRate: sr })
	enc2.encode(half1)
	enc2.encode(half2)
	let bytes2 = enc2.flush()
	enc2.free()

	is(bytes1.length, bytes2.length, 'same output length regardless of chunk split')
})

t('empty input returns empty output', async () => {
	let enc = await qoa({ sampleRate: 44100 })
	let bytes = enc.flush()
	is(bytes.length, 0, 'empty flush returns empty')
	enc.free()
})
