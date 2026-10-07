/**
 * libgsm WASM glue, encode half: 160 samples at 8 kHz, 16-bit → a 33-byte GSM 06.10 frame
 */

#include "gsm.h"
#include <emscripten/emscripten.h>

EMSCRIPTEN_KEEPALIVE gsm gsmw_create(void) { return gsm_create(); }

EMSCRIPTEN_KEEPALIVE void gsmw_destroy(gsm g) { gsm_destroy(g); }

/* n frames of `pcm` into `out` */
EMSCRIPTEN_KEEPALIVE void gsmw_encode(gsm g, gsm_signal *pcm, gsm_byte *out, int n) {
	for (int i = 0; i < n; i++) gsm_encode(g, pcm + 160 * i, out + 33 * i);
}
