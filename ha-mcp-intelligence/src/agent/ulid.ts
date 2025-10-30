/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) generator
 * Based on https://github.com/ulid/spec
 *
 * 26 character string: TTTTTTTTTTRRRRRRRRRRRRRRRR
 * - T: Timestamp (10 chars, 48 bits, millisecond precision)
 * - R: Randomness (16 chars, 80 bits)
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford's Base32
const ENCODING_LEN = ENCODING.length;
const TIME_MAX = Math.pow(2, 48) - 1;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: number[] = [];

/**
 * Generate a new ULID
 */
export function ulid(seedTime?: number): string {
  const now = seedTime !== undefined ? seedTime : Date.now();

  if (now > TIME_MAX) {
    throw new Error(`Cannot generate ULID for timestamp > ${TIME_MAX}`);
  }

  // Monotonicity: If same millisecond, increment random component
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = generateRandom();
  }

  return encodeTime(now, TIME_LEN) + encodeRandom(lastRandom, RANDOM_LEN);
}

/**
 * Encode timestamp as base32 string
 */
function encodeTime(now: number, len: number): string {
  let str = '';
  let mod: number;

  for (let i = len; i > 0; i--) {
    mod = now % ENCODING_LEN;
    str = ENCODING[mod] + str;
    now = (now - mod) / ENCODING_LEN;
  }

  return str;
}

/**
 * Encode random bytes as base32 string
 */
function encodeRandom(random: number[], len: number): string {
  let str = '';

  for (let i = 0; i < len; i++) {
    str += ENCODING[random[i]];
  }

  return str;
}

/**
 * Generate random component (16 chars = 80 bits)
 */
function generateRandom(): number[] {
  const random: number[] = [];

  for (let i = 0; i < RANDOM_LEN; i++) {
    random.push(Math.floor(Math.random() * ENCODING_LEN));
  }

  return random;
}

/**
 * Increment random component for monotonicity
 */
function incrementRandom(random: number[]): number[] {
  const result = [...random];

  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const val = result[i];

    if (val < ENCODING_LEN - 1) {
      result[i] = val + 1;
      return result;
    } else {
      result[i] = 0;
    }
  }

  // If we've rolled over, generate new random
  return generateRandom();
}

/**
 * Decode ULID timestamp
 */
export function decodeTime(id: string): number {
  if (id.length !== TIME_LEN + RANDOM_LEN) {
    throw new Error('Invalid ULID length');
  }

  const time = id.substring(0, TIME_LEN);
  let timestamp = 0;

  for (let i = 0; i < TIME_LEN; i++) {
    const char = time[i];
    const index = ENCODING.indexOf(char);

    if (index === -1) {
      throw new Error(`Invalid ULID character: ${char}`);
    }

    timestamp = timestamp * ENCODING_LEN + index;
  }

  return timestamp;
}

/**
 * Validate ULID format
 */
export function isValidUlid(id: string): boolean {
  if (id.length !== TIME_LEN + RANDOM_LEN) {
    return false;
  }

  for (let i = 0; i < id.length; i++) {
    if (ENCODING.indexOf(id[i]) === -1) {
      return false;
    }
  }

  return true;
}
