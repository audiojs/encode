#!/bin/bash
# Build libgsm 1.0.22 (GSM 06.10 full rate, Degener & Bormann, TU Berlin) + glue -> src/gsm.wasm.js
set -e
cd "$(dirname "$0")"

LIB=lib/gsm
if [ ! -d "$LIB" ]; then
  echo "Fetching libgsm 1.0.22..."
  mkdir -p lib
  curl -sL http://www.quut.com/gsm/gsm-1.0.22.tar.gz -o lib/gsm.tar.gz
  tar xzf lib/gsm.tar.gz -C lib/
  mv lib/gsm-1.0-pl22 "$LIB"
  rm lib/gsm.tar.gz
fi

OUT=src/gsm.wasm.js
S=$LIB/src
# the library's own flags (its Makefile): arithmetic shift right, the WAV #49 option compiled in, no speed hacks
emcc \
  src/gsm_glue.c \
  $S/add.c $S/code.c $S/long_term.c $S/lpc.c $S/preprocess.c $S/rpe.c $S/short_term.c $S/table.c \
  $S/gsm_create.c $S/gsm_destroy.c $S/gsm_encode.c \
  -I$LIB/inc \
  -DSASR -DWAV49 -DNeedFunctionPrototypes=1 -Wno-comment \
  -O3 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_gsmw_create","_gsmw_destroy","_gsmw_encode","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP16"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createGSM \
  -s ENVIRONMENT='web,worklet,shell' \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

echo "Built: $(wc -c < "$OUT") bytes (libgsm 1.0.22)"
