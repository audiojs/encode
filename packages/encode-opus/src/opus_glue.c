#include <stdlib.h>
#include <opus.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

/* libopus recommends 4000 bytes as a packet ceiling; 120 ms at 48 kHz is the longest frame. */
#define MAX_PACKET 4000
#define MAX_FRAME 5760

typedef struct {
	OpusEncoder *encoder;
	float *pcm;              /* interleaved input, MAX_FRAME * channels */
	unsigned char *packet;   /* MAX_PACKET */
	int channels;
} AudioOpusEncoder;

static int last_error = OPUS_OK;

EXPORT AudioOpusEncoder *audio_opus_enc_create(int sample_rate, int channels, int application) {
	last_error = OPUS_OK;
	if (channels < 1 || channels > 2) {
		last_error = OPUS_BAD_ARG;
		return NULL;
	}

	AudioOpusEncoder *state = calloc(1, sizeof(*state));
	if (!state) {
		last_error = OPUS_ALLOC_FAIL;
		return NULL;
	}

	state->channels = channels;
	state->encoder = opus_encoder_create(sample_rate, channels, application, &last_error);
	if (!state->encoder || last_error != OPUS_OK) goto fail;

	state->pcm = malloc(sizeof(float) * MAX_FRAME * channels);
	state->packet = malloc(MAX_PACKET);
	if (!state->pcm || !state->packet) {
		last_error = OPUS_ALLOC_FAIL;
		goto fail;
	}
	return state;

fail:
	if (state->encoder) opus_encoder_destroy(state->encoder);
	free(state->pcm);
	free(state->packet);
	free(state);
	return NULL;
}

/* Generic integer CTL: OPUS_SET_BITRATE_REQUEST, OPUS_SET_COMPLEXITY_REQUEST, OPUS_SET_VBR_REQUEST, ... */
EXPORT int audio_opus_enc_set(AudioOpusEncoder *state, int request, int value) {
	if (!state) return OPUS_BAD_ARG;
	return opus_encoder_ctl(state->encoder, request, value);
}

/* Encoder delay in samples at 48 kHz — the Ogg pre-skip (RFC 7845 §4.2). */
EXPORT int audio_opus_enc_lookahead(AudioOpusEncoder *state) {
	if (!state) return OPUS_BAD_ARG;
	opus_int32 lookahead = 0;
	int err = opus_encoder_ctl(state->encoder, OPUS_GET_LOOKAHEAD(&lookahead));
	return err == OPUS_OK ? lookahead : err;
}

EXPORT float *audio_opus_enc_input(AudioOpusEncoder *state) {
	return state ? state->pcm : NULL;
}

/* Encode one frame of `frame_size` interleaved float samples from the input buffer. Returns packet length or a negative error. */
EXPORT int audio_opus_enc_encode(AudioOpusEncoder *state, int frame_size) {
	if (!state || frame_size <= 0 || frame_size > MAX_FRAME) return OPUS_BAD_ARG;
	return opus_encode_float(state->encoder, state->pcm, frame_size, state->packet, MAX_PACKET);
}

EXPORT unsigned char *audio_opus_enc_output(AudioOpusEncoder *state) {
	return state ? state->packet : NULL;
}

EXPORT int audio_opus_enc_last_error(void) {
	return last_error;
}

EXPORT void audio_opus_enc_destroy(AudioOpusEncoder *state) {
	if (!state) return;
	opus_encoder_destroy(state->encoder);
	free(state->pcm);
	free(state->packet);
	free(state);
}
