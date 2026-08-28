#!/bin/bash
set -e
cd "$(dirname "$0")"

LIB=lib/wavpack
OUT=src/wavpack.wasm.js

if [ ! -f "$LIB/include/wavpack.h" ]; then
  git submodule update --init --depth 1 -- "$LIB"
fi

SRC="$LIB/src"

# Single-file WASM uses no host I/O. Omitting Emscripten's Node loader keeps the module graph
# host-neutral. Encode-only build: the file-input/decode side (open_*.c, unpack_*.c) is left out
# entirely, and so is DSD (pack_dsd.c / -DENABLE_DSD) — this package only ever writes PCM/float
# WavPack streams.
emcc \
  $SRC/common_utils.c $SRC/decorr_utils.c $SRC/entropy_utils.c $SRC/extra1.c $SRC/extra2.c \
  $SRC/pack.c $SRC/pack_dns.c $SRC/pack_floats.c $SRC/pack_utils.c \
  $SRC/read_words.c $SRC/write_words.c $SRC/tags.c $SRC/tag_utils.c \
  src/wavpack_glue.c \
  -I src -I "$LIB/include" -I "$SRC" \
  -DHAVE___BUILTIN_CLZ \
  -Oz \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_we_create","_we_ok","_we_error",
    "_we_input","_we_pack","_we_tag_text","_we_tag_binary","_we_flush",
    "_we_output_ptr","_we_output_len","_we_output_reset",
    "_we_destroy","_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=4194304 \
  -s MAXIMUM_MEMORY=134217728 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createWavpackEncoder \
  -s ENVIRONMENT='web,worklet,shell' \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

VERSION=$(git -C "$LIB" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (WavPack $VERSION)"
