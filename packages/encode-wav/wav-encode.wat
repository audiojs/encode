;; i16(l, r, o, n): n frames of two float32 channels at l and r (byte offsets) → 16-bit PCM interleaved at o:
;; floor(v · 32768 + 0.5) in float64, clipped to the codes, NaN as 0. The same float64 ops as wav-encode.js's q16, the
;; clip a saturating conversion: the same bytes.
;; wat2wasm wav-encode.wat -o - | node -e "process.stdin.on('data', b => console.log([...b].join(',')))"
(module
  (memory (export "memory") 1)
  (func (export "i16") (param $l i32) (param $r i32) (param $o i32) (param $n i32)
    (local $e i32) (local $a v128) (local $b v128) (local $k v128) (local $h v128) (local $va v128) (local $vb v128) (local $x i32)
    (local.set $k (f64x2.splat (f64.const 32768)))
    (local.set $h (f64x2.splat (f64.const 0.5)))
    (local.set $r (i32.sub (local.get $r) (local.get $l)))
    (local.set $e (i32.add (local.get $l) (i32.shl (i32.and (local.get $n) (i32.const -4)) (i32.const 2))))
    (block $done
      (br_if $done (i32.ge_u (local.get $l) (local.get $e)))
      (loop $l4
        (local.set $a (v128.load (local.get $l)))
        (local.set $b (v128.load (i32.add (local.get $l) (local.get $r))))
        ;; each half in float64, floored, to int32 (saturating, NaN 0), the four as one i32x4
        (local.set $va (i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
          (i32x4.trunc_sat_f64x2_s_zero (f64x2.floor (f64x2.add (f64x2.mul (f64x2.promote_low_f32x4 (local.get $a)) (local.get $k)) (local.get $h))))
          (i32x4.trunc_sat_f64x2_s_zero (f64x2.floor (f64x2.add (f64x2.mul (f64x2.promote_low_f32x4 (i8x16.shuffle 8 9 10 11 12 13 14 15 0 1 2 3 4 5 6 7 (local.get $a) (local.get $a))) (local.get $k)) (local.get $h))))))
        (local.set $vb (i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
          (i32x4.trunc_sat_f64x2_s_zero (f64x2.floor (f64x2.add (f64x2.mul (f64x2.promote_low_f32x4 (local.get $b)) (local.get $k)) (local.get $h))))
          (i32x4.trunc_sat_f64x2_s_zero (f64x2.floor (f64x2.add (f64x2.mul (f64x2.promote_low_f32x4 (i8x16.shuffle 8 9 10 11 12 13 14 15 0 1 2 3 4 5 6 7 (local.get $b) (local.get $b))) (local.get $k)) (local.get $h))))))
        ;; to int16, saturating (the clip), then L R L R
        (v128.store (local.get $o) (i8x16.shuffle 0 1 8 9 2 3 10 11 4 5 12 13 6 7 14 15
          (i16x8.narrow_i32x4_s (local.get $va) (local.get $vb)) (i16x8.narrow_i32x4_s (local.get $va) (local.get $vb))))
        (local.set $l (i32.add (local.get $l) (i32.const 16)))
        (local.set $o (i32.add (local.get $o) (i32.const 16)))
        (br_if $l4 (i32.lt_u (local.get $l) (local.get $e)))))
    (local.set $e (i32.add (local.get $e) (i32.shl (i32.and (local.get $n) (i32.const 3)) (i32.const 2))))
    (block $end
      (br_if $end (i32.ge_u (local.get $l) (local.get $e)))
      (loop $l1
        (local.set $x (i32.trunc_sat_f64_s (f64.floor (f64.add (f64.mul (f64.promote_f32 (f32.load (local.get $l))) (f64.const 32768)) (f64.const 0.5)))))
        (i32.store16 (local.get $o) (select (i32.const 32767) (select (i32.const -32768) (local.get $x) (i32.lt_s (local.get $x) (i32.const -32768))) (i32.gt_s (local.get $x) (i32.const 32767))))
        (local.set $x (i32.trunc_sat_f64_s (f64.floor (f64.add (f64.mul (f64.promote_f32 (f32.load (i32.add (local.get $l) (local.get $r)))) (f64.const 32768)) (f64.const 0.5)))))
        (i32.store16 offset=2 (local.get $o) (select (i32.const 32767) (select (i32.const -32768) (local.get $x) (i32.lt_s (local.get $x) (i32.const -32768))) (i32.gt_s (local.get $x) (i32.const 32767))))
        (local.set $l (i32.add (local.get $l) (i32.const 4)))
        (local.set $o (i32.add (local.get $o) (i32.const 4)))
        (br_if $l1 (i32.lt_u (local.get $l) (local.get $e))))))
)
