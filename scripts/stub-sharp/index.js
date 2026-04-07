// Stub - Wildtrade doesn't need image processing
const noop = () => stub;
const stub = {
  resize: noop, rotate: noop, flip: noop, flop: noop, sharpen: noop,
  median: noop, blur: noop, flatten: noop, gamma: noop, negate: noop,
  normalise: noop, normalize: noop, convolve: noop, threshold: noop,
  boolean: noop, linear: noop, recomb: noop, modulate: noop,
  tint: noop, greyscale: noop, grayscale: noop, toColourspace: noop,
  toColorspace: noop, composite: noop, extract: noop, trim: noop,
  extend: noop, png: noop, jpeg: noop, webp: noop, avif: noop, tiff: noop,
  raw: noop, tile: noop, ensureAlpha: noop, removeAlpha: noop,
  toFormat: noop, withMetadata: noop, clone: noop,
  toBuffer: async () => Buffer.alloc(0),
  toFile: async () => ({ width: 0, height: 0, channels: 0, size: 0 }),
  metadata: async () => ({ width: 0, height: 0, channels: 0 }),
  stats: async () => ({}),
};

function sharp() { return Object.assign({}, stub); }
sharp.cache = noop;
sharp.concurrency = noop;
sharp.counters = () => ({});
sharp.simd = () => false;
sharp.versions = {};

module.exports = sharp;
module.exports.default = sharp;
