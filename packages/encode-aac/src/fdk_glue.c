#include <stdlib.h>
#include <string.h>
#include "aacenc_lib.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

/* One Fraunhofer FDK AAC encoder: interleaved 16-bit PCM in, ADTS frames out. JS writes input
   into `in` (ae_input), encodes it (ae_encode / ae_flush), then drains `out` and resets it, so
   nothing waits between calls but the input frame fdk has not completed yet. */
typedef struct {
	HANDLE_AACENCODER h;
	INT_PCM *in;
	int inCap;
	UCHAR *out;
	int outLen, outCap;
	int ch, frameBytes, delay, frameLength;
} Enc;

static int lastError = 0;

/* channel count → fdk channel mode, WAV channel order (AACENC_CHANNELORDER 1) */
static CHANNEL_MODE mode(int ch) {
	switch (ch) {
		case 1: return MODE_1;
		case 2: return MODE_2;
		case 3: return MODE_1_2;
		case 4: return MODE_1_2_1;
		case 5: return MODE_1_2_2;
		case 6: return MODE_1_2_2_1;
		case 8: return MODE_7_1_BACK;
		default: return MODE_INVALID;
	}
}

#define SET(p, v) if ((lastError = aacEncoder_SetParam(e->h, p, v)) != AACENC_OK) goto fail

/* aot: 2 AAC-LC, 5 HE-AAC (SBR), 29 HE-AACv2 (SBR + PS); vbr: 0 = CBR at `bitrate` bps, 1-5 = VBR mode */
EXPORT Enc *ae_create(int sampleRate, int ch, int bitrate, int aot, int vbr) {
	if (mode(ch) == MODE_INVALID) { lastError = AACENC_INVALID_CONFIG; return 0; }
	Enc *e = calloc(1, sizeof(Enc));
	if (!e) return 0;
	if ((lastError = aacEncOpen(&e->h, 0, ch)) != AACENC_OK) { free(e); return 0; }
	SET(AACENC_AOT, aot);
	SET(AACENC_SAMPLERATE, sampleRate);
	SET(AACENC_CHANNELMODE, mode(ch));
	SET(AACENC_CHANNELORDER, 1);
	if (vbr) { SET(AACENC_BITRATEMODE, vbr); }
	else { SET(AACENC_BITRATE, bitrate); }
	SET(AACENC_TRANSMUX, TT_MP4_ADTS);
	SET(AACENC_AFTERBURNER, 1);
	if ((lastError = aacEncEncode(e->h, NULL, NULL, NULL, NULL)) != AACENC_OK) goto fail;
	AACENC_InfoStruct info;
	if ((lastError = aacEncInfo(e->h, &info)) != AACENC_OK) goto fail;
	e->ch = ch;
	e->frameBytes = info.maxOutBufBytes;
	e->delay = info.nDelay;
	e->frameLength = info.frameLength;
	return e;
fail:
	aacEncClose(&e->h);
	free(e);
	return 0;
}

EXPORT int ae_error(void) { return lastError; }
EXPORT int ae_delay(Enc *e) { return e->delay; }
EXPORT int ae_frame_length(Enc *e) { return e->frameLength; }

/* buffer for n interleaved frames of input */
EXPORT INT_PCM *ae_input(Enc *e, int n) {
	int need = n * e->ch;
	if (need > e->inCap) {
		INT_PCM *p = realloc(e->in, need * sizeof(INT_PCM));
		if (!p) return 0;
		e->in = p;
		e->inCap = need;
	}
	return e->in;
}

static int room(Enc *e) {
	if (e->outCap - e->outLen >= e->frameBytes) return 1;
	int cap = e->outCap ? e->outCap * 2 : 65536;
	while (cap - e->outLen < e->frameBytes) cap *= 2;
	UCHAR *p = realloc(e->out, cap);
	if (!p) return 0;
	e->out = p;
	e->outCap = cap;
	return 1;
}

/* Encode `samples` interleaved samples from `in`; samples < 0 flushes to the end of the stream.
   Returns bytes pending in `out`, or -error. */
static int run(Enc *e, int samples) {
	int consumed = 0, inId = IN_AUDIO_DATA, outId = OUT_BITSTREAM_DATA, inEl = sizeof(INT_PCM), outEl = 1;
	for (;;) {
		if (!room(e)) return -AACENC_MEMORY_ERROR;
		void *inPtr = e->in + consumed, *outPtr = e->out + e->outLen;
		int inSize = samples < 0 ? 0 : (samples - consumed) * (int)sizeof(INT_PCM), outSize = e->outCap - e->outLen;
		AACENC_BufDesc inDesc = { 1, &inPtr, &inId, &inSize, &inEl }, outDesc = { 1, &outPtr, &outId, &outSize, &outEl };
		AACENC_InArgs inArgs = { samples < 0 ? -1 : samples - consumed, 0 };
		AACENC_OutArgs outArgs = { 0 };
		AACENC_ERROR err = aacEncEncode(e->h, samples < 0 ? &inDesc : &inDesc, &outDesc, &inArgs, &outArgs);
		if (err == AACENC_ENCODE_EOF) break;
		if (err != AACENC_OK) return -(int)err;
		consumed += outArgs.numInSamples;
		e->outLen += outArgs.numOutBytes;
		if (samples >= 0 && consumed >= samples && !outArgs.numOutBytes) break;
		if (samples >= 0 && !outArgs.numInSamples && !outArgs.numOutBytes) break;
	}
	return e->outLen;
}

EXPORT int ae_encode(Enc *e, int frames) { return run(e, frames * e->ch); }
EXPORT int ae_flush(Enc *e) { return run(e, -1); }

EXPORT UCHAR *ae_output_ptr(Enc *e) { return e->out; }
EXPORT int ae_output_len(Enc *e) { return e->outLen; }
EXPORT void ae_output_reset(Enc *e) { e->outLen = 0; }

EXPORT void ae_destroy(Enc *e) {
	if (!e) return;
	aacEncClose(&e->h);
	free(e->in);
	free(e->out);
	free(e);
}
