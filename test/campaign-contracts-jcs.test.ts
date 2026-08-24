// test/campaign-contracts-jcs.test.ts
import { expect, test } from 'bun:test';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';

// RFC 8785 Appendix B, Table 1 — ECMAScript-compatible JSON number
// serialization samples (finite entries, verbatim).
const RFC_NUMBER_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [0, '0'],
  [-0, '0'], // minus zero serializes as 0
  [5e-324, '5e-324'],
  [-5e-324, '-5e-324'],
  [1.7976931348623157e308, '1.7976931348623157e+308'],
  [-1.7976931348623157e308, '-1.7976931348623157e+308'],
  [9007199254740992, '9007199254740992'],
  [-9007199254740992, '-9007199254740992'],
  // biome-ignore lint/correctness/noPrecisionLoss: RFC 8785 vector is verbatim — the literal's precision loss into 2**68 is what the serialization column documents
  [295147905179352825856, '295147905179352830000'], // ~2**68
  [9.999999999999997e22, '9.999999999999997e+22'],
  [1e23, '1e+23'],
  [1.0000000000000001e23, '1.0000000000000001e+23'],
  [999999999999999700000, '999999999999999700000'],
  [999999999999999900000, '999999999999999900000'],
  [1e21, '1e+21'],
  [9.999999999999997e-7, '9.999999999999997e-7'],
  [0.000001, '0.000001'],
  [333333333.3333332, '333333333.3333332'],
  [333333333.33333325, '333333333.33333325'],
  [333333333.3333333, '333333333.3333333'],
  [333333333.3333334, '333333333.3333334'],
  [333333333.33333343, '333333333.33333343'],
  [-0.0000033333333333333333, '-0.0000033333333333333333'],
  [1424953923781206.2, '1424953923781206.2'], // round-to-even case
];

test('RFC 8785 Appendix B number serialization vectors', () => {
  for (const [value, expected] of RFC_NUMBER_VECTORS) {
    expect(jcsCanonicalize(value)).toBe(expected);
  }
});

test('object keys sort by UTF-16 code units at every depth', () => {
  expect(jcsCanonicalize({ b: 2, a: 1, A: 3 })).toBe('{"A":3,"a":1,"b":2}');
  // Euro sign U+20AC sorts after ASCII letters (0x20AC > 0x007A)…
  expect(jcsCanonicalize({ z: 1, '\u20ac': 2 })).toBe('{"z":1,"\u20ac":2}');
  // …and a surrogate-pair key (U+1F600, first code unit 0xD83D) sorts before
  // U+FFFD (0xFFFD) even though the astral code point is larger.
  expect(jcsCanonicalize({ '\ufffd': 1, '\ud83d\ude00': 2 })).toBe(
    '{"\ud83d\ude00":2,"\ufffd":1}',
  );
  // Nested objects sort too.
  expect(jcsCanonicalize({ outer: { b: 1, a: 2 } })).toBe(
    '{"outer":{"a":2,"b":1}}',
  );
});

test('arrays keep order; strings use ES6 escaping; non-ASCII stays literal', () => {
  expect(jcsCanonicalize([3, 1, 2])).toBe('[3,1,2]');
  expect(jcsCanonicalize('a"b\\\n\t\u0001')).toBe('"a\\"b\\\\\\n\\t\\u0001"');
  expect(jcsCanonicalize('€')).toBe('"€"');
});

test('primitives, null, and empty containers', () => {
  expect(jcsCanonicalize(true)).toBe('true');
  expect(jcsCanonicalize(false)).toBe('false');
  expect(jcsCanonicalize(null)).toBe('null');
  expect(jcsCanonicalize({})).toBe('{}');
  expect(jcsCanonicalize([])).toBe('[]');
});

test('non-finite numbers and non-JSON types are rejected loud', () => {
  expect(() => jcsCanonicalize(Number.NaN)).toThrow(/finite/);
  expect(() => jcsCanonicalize(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  expect(() => jcsCanonicalize(undefined)).toThrow();
  expect(() => jcsCanonicalize(() => 1)).toThrow();
});

test('no whitespace anywhere in canonical output', () => {
  const canonical = jcsCanonicalize({ a: [1, { b: null }], c: 'x' });
  expect(canonical).toBe('{"a":[1,{"b":null}],"c":"x"}');
});

test('sha256Hex digests UTF-8 bytes', () => {
  // Known SHA-256 of the empty string.
  expect(sha256Hex('')).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});
