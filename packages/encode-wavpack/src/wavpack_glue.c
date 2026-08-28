#include <stdlib.h>
#include <string.h>
#include <wavpack.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define ERR_LEN 128

/* Growable buffer the WavpackBlockOutput callback appends completed blocks (and, at the end,
   the APEv2 tag) into. JS drains it after every pack/flush call and resets it, so it never
   holds more than what's pending between two JS calls. */
typedef struct {
	unsigned char *buf;
	int64_t len, cap;
} OutBuf;

static int block_output(void *id, void *data, int32_t bcount) {
	OutBuf *o = (OutBuf *)id;
	if (o->len + bcount > o->cap) {
		int64_t cap = o->cap ? o->cap * 2 : 65536;
		while (cap < o->len + bcount) cap *= 2;
		unsigned char *p = realloc(o->buf, cap);
		if (!p) return 0;
		o->buf = p;
		o->cap = cap;
	}
	memcpy(o->buf + o->len, data, bcount);
	o->len += bcount;
	return 1;
}

typedef struct {
	WavpackContext *ctx;
	OutBuf out;
	int32_t *in;
	int64_t in_cap; /* capacity in samples-per-channel */
	int channels;
	int tagged;
	char err[ERR_LEN];
} WvEncoder;

static void set_err(WvEncoder *e, const char *msg) {
	strncpy(e->err, msg, ERR_LEN - 1);
	e->err[ERR_LEN - 1] = 0;
}

/* bitDepth: bits per sample (8/16/24/32); isFloat: nonzero for 32-bit float.
   hybrid: nonzero enables CONFIG_HYBRID_FLAG with `bitrate` (bits/sample if < 24, else kbps —
   matching the WavPack CLI's own -b<n> convention). xmode: 0 = off, 1-6 = CONFIG_EXTRA_MODE level.
   quality: 0 normal, 1 high (CONFIG_HIGH_FLAG), 2 very high (CONFIG_VERY_HIGH_FLAG). fast: nonzero
   sets CONFIG_FAST_FLAG. blockSamples: 0 = library default. */
EXPORT WvEncoder *we_create(int sampleRate, int channels, int bitDepth, int isFloat,
	int hybrid, float bitrate, int xmode, int quality, int fast, int blockSamples) {
	WvEncoder *e = calloc(1, sizeof(*e));
	if (!e) return NULL;
	e->channels = channels;

	e->ctx = WavpackOpenFileOutput(block_output, &e->out, NULL);
	if (!e->ctx) { set_err(e, "WavPack: cannot create encoder context"); return e; }

	WavpackConfig config;
	memset(&config, 0, sizeof(config));
	config.sample_rate = sampleRate;
	config.num_channels = channels;
	config.channel_mask = channels >= 1 && channels <= 18 ? (1u << channels) - 1 : 0;

	if (isFloat) {
		config.bytes_per_sample = 4;
		config.bits_per_sample = 32;
		config.float_norm_exp = 127;
	} else {
		config.bytes_per_sample = (bitDepth + 7) / 8;
		config.bits_per_sample = bitDepth;
	}

	if (quality == 2) config.flags |= CONFIG_VERY_HIGH_FLAG;
	else if (quality == 1) config.flags |= CONFIG_HIGH_FLAG;
	if (fast) config.flags |= CONFIG_FAST_FLAG;

	if (xmode > 0) {
		config.flags |= CONFIG_EXTRA_MODE;
		config.xmode = xmode;
	}

	if (hybrid) {
		config.flags |= CONFIG_HYBRID_FLAG;
		config.bitrate = bitrate;
		if (bitrate >= 24.0f) config.flags |= CONFIG_BITRATE_KBPS;
	}

	if (blockSamples > 0) config.block_samples = blockSamples;

	if (!WavpackSetConfiguration64(e->ctx, &config, -1, NULL)) {
		set_err(e, WavpackGetErrorMessage(e->ctx));
		return e;
	}

	if (!WavpackPackInit(e->ctx)) {
		set_err(e, WavpackGetErrorMessage(e->ctx));
		return e;
	}

	return e;
}

EXPORT int we_ok(WvEncoder *e) { return e && e->ctx && !e->err[0]; }
EXPORT char *we_error(WvEncoder *e) { return e->err; }

/* Ensure room for `samples` samples-per-channel of interleaved int32 input and return the
   write pointer (JS fills it — raw signed PCM for int modes, IEEE-754 float32 bit pattern for
   float mode — then calls we_pack()). */
EXPORT int32_t *we_input(WvEncoder *e, int32_t samples) {
	if (samples > e->in_cap) {
		int32_t *p = realloc(e->in, (int64_t)samples * e->channels * sizeof(int32_t));
		if (!p) { set_err(e, "WavPack: out of memory"); return NULL; }
		e->in = p;
		e->in_cap = samples;
	}
	return e->in;
}

/* Pack `samples` samples-per-channel just written at we_input()'s pointer. Completed blocks
   accumulate in the output buffer (see we_output_*). Returns 1 on success, 0 on error. */
EXPORT int we_pack(WvEncoder *e, int32_t samples) {
	if (!WavpackPackSamples(e->ctx, e->in, samples)) {
		set_err(e, WavpackGetErrorMessage(e->ctx));
		return 0;
	}
	return 1;
}

EXPORT int we_tag_text(WvEncoder *e, const char *item, const char *value, int32_t vsize) {
	int ok = WavpackAppendTagItem(e->ctx, item, value, vsize);
	if (ok) e->tagged = 1; else set_err(e, "WavPack: failed to append tag item");
	return ok;
}

EXPORT int we_tag_binary(WvEncoder *e, const char *item, const unsigned char *value, int32_t vsize) {
	int ok = WavpackAppendBinaryTagItem(e->ctx, item, (const char *)value, vsize);
	if (ok) e->tagged = 1; else set_err(e, "WavPack: failed to append binary tag item");
	return ok;
}

/* Finalize: flush any partial trailing block, then write the APEv2 tag (if any items were
   appended). Output ends up in the output buffer same as we_pack(). Call once, before
   we_destroy(). Returns 1 on success, 0 on error. */
EXPORT int we_flush(WvEncoder *e) {
	if (!WavpackFlushSamples(e->ctx)) {
		set_err(e, WavpackGetErrorMessage(e->ctx));
		return 0;
	}
	if (e->tagged && !WavpackWriteTag(e->ctx)) {
		set_err(e, WavpackGetErrorMessage(e->ctx));
		return 0;
	}
	return 1;
}

EXPORT unsigned char *we_output_ptr(WvEncoder *e) { return e->out.buf; }
EXPORT int32_t we_output_len(WvEncoder *e) { return (int32_t)e->out.len; }
EXPORT void we_output_reset(WvEncoder *e) { e->out.len = 0; }

EXPORT void we_destroy(WvEncoder *e) {
	if (!e) return;
	if (e->ctx) WavpackCloseFile(e->ctx);
	free(e->out.buf);
	free(e->in);
	free(e);
}
