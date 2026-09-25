#!/bin/bash
set -e
cd "$(dirname "$0")"

LIB=lib/fdk-aac
OUT=src/fdk.wasm.js

if [ ! -f "$LIB/libAACenc/include/aacenc_lib.h" ]; then
  git submodule update --init --depth 1 -- "$LIB"
fi

# Encoder-only build of the Fraunhofer FDK AAC library (the Makefile.am source lists for
# AACENC, SBRENC, SACENC, MPEGTPENC, PCMUTILS, FDK and SYS; the decoder side is left out).
# Single-file WASM, no host I/O: the module graph stays host-neutral.
SRC=""
for d in libAACenc libSBRenc libSACenc libMpegTPEnc libPCMutils libFDK libSYS; do
  SRC="$SRC $(grep -oE "^[[:space:]]*$d/src/[A-Za-z0-9_]+\.cpp" $LIB/Makefile.am | tr -d ' \t' | sed "s|^|$LIB/|" | tr '\n' ' ')"
done
INC=""
for d in libAACenc libSBRenc libSACenc libMpegTPEnc libPCMutils libFDK libSYS libArithCoding libDRCdec libSACdec libSBRdec libMpegTPDec libAACdec; do INC="$INC -I $LIB/$d/include"; done

emcc \
  $SRC src/fdk_glue.c \
  $INC \
  -fno-exceptions -fno-rtti -Wno-narrowing -Wno-#warnings \
  -Oz \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_ae_create","_ae_error","_ae_delay","_ae_frame_length",
    "_ae_input","_ae_encode","_ae_flush",
    "_ae_output_ptr","_ae_output_len","_ae_output_reset",
    "_ae_destroy","_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP16"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=4194304 \
  -s MAXIMUM_MEMORY=134217728 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createFdkEncoder \
  -s ENVIRONMENT='web,worklet,shell' \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

VERSION=$(git -C "$LIB" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (fdk-aac $VERSION)"
