import { randomBytes } from 'crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let str = '';
  let t = ms;
  for (let i = 9; i >= 0; i--) {
    str = ENCODING[t % 32]! + str;
    t = Math.floor(t / 32);
  }
  return str;
}

function encodeRandom(): string {
  const bytes = randomBytes(10);
  let value = BigInt('0x' + bytes.toString('hex'));
  let str = '';
  for (let i = 0; i < 16; i++) {
    str = ENCODING[Number(value & 31n)]! + str;
    value >>= 5n;
  }
  return str;
}

/** Generate a 26-character ULID. Monotonically increasing within the same millisecond. */
export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}
