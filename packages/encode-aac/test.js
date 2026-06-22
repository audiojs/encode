import t, { is, ok } from 'tst'
import aac from './aac-encode.js'

t('exports a function', () => {
	is(typeof aac, 'function', 'default export is a function')
})

t('rejects gracefully in Node (no AudioEncoder)', async () => {
	// Node has no WebCodecs AudioEncoder — the module must throw a clear error
	let threw = false
	let msg = ''
	try {
		await aac({ sampleRate: 44100, channels: 1, bitrate: 128 })
	} catch (e) {
		threw = true
		msg = e.message
	}
	ok(threw, 'should throw in Node')
	ok(msg.toLowerCase().includes('webcodecs') || msg.toLowerCase().includes('browser'),
		'error message mentions WebCodecs or browser; got: ' + msg)
})
