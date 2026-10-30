import { splitParagraphs } from './text.js'

/** 64-bit SimHash stored as a small non-negative bigint (0 .. 2^64-1). */
export type SimHash = bigint

const MASK64 = (1n << 64n) - 1n

/** FNV-1a over UTF-16 code units; deterministic across platforms and Node versions. */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index) & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
    hash ^= input.charCodeAt(index) >>> 8
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

const shingleHash = (shingle: string): SimHash => {
  const low = BigInt(fnv1a(shingle, 0x811c9dc5))
  const high = BigInt(fnv1a(shingle, 0x01000193))
  return ((high << 32n) | low) & MASK64
}

/** Character shingles of width 2; short inputs degrade to the whole string. */
function shingles(text: string): string[] {
  const chars = Array.from(text.replace(/\s+/g, ''))
  if (chars.length <= 2) return chars.length === 0 ? [] : [chars.join('')]
  const result: string[] = []
  for (let index = 0; index + 1 < chars.length; index += 1) result.push(chars[index]! + chars[index + 1]!)
  return result
}

/** Deterministic paragraph-level SimHash. Same input always yields the same value. */
export function simhash(text: string): SimHash {
  const weights = new Int32Array(64)
  for (const shingle of shingles(text)) {
    const hash = shingleHash(shingle)
    for (let bit = 0; bit < 64; bit += 1) {
      const on = ((hash >> BigInt(bit)) & 1n) === 1n
      weights[bit] = weights[bit]! + (on ? 1 : -1)
    }
  }
  let value = 0n
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit]! > 0) value |= 1n << BigInt(bit)
  }
  return value & MASK64
}

/** Hamming distance in bits. */
export function hammingDistance(a: SimHash, b: SimHash): number {
  let diff = (a ^ b) & MASK64
  let count = 0
  while (diff !== 0n) {
    count += Number(diff & 1n)
    diff >>= 1n
  }
  return count
}

/** Similarity in [0, 1]; 1 means identical fingerprints. */
export function similarity(a: SimHash, b: SimHash): number {
  return 1 - hammingDistance(a, b) / 64
}

/** Similarity of two raw texts. */
export function textSimilarity(a: string, b: string): number {
  return similarity(simhash(a), simhash(b))
}

/** Character-bigram Dice similarity; unlike SimHash this has a ~0 baseline for unrelated short text. */
export function bigramSimilarity(a: string, b: string): number {
  const grams = (text: string): string[] => {
    const chars = Array.from(text.replace(/\s+/g, ''))
    if (chars.length < 2) return chars.length === 0 ? [] : [chars[0]!]
    const result: string[] = []
    for (let index = 0; index + 1 < chars.length; index += 1) {
      result.push(chars[index]! + chars[index + 1]!)
    }
    return result
  }
  const left = grams(a)
  const right = grams(b)
  if (left.length === 0 || right.length === 0) return 0
  const counts = new Map<string, number>()
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  let intersection = 0
  for (const gram of right) {
    const count = counts.get(gram) ?? 0
    if (count > 0) {
      counts.set(gram, count - 1)
      intersection += 1
    }
  }
  return (2 * intersection) / (left.length + right.length)
}

/** Fingerprints of every paragraph, in document order. */
export function paragraphSimhashes(text: string): SimHash[] {
  return splitParagraphs(text).map((paragraph) => simhash(paragraph))
}

/** Highest similarity any paragraph of `candidate` has with any paragraph of `existing`. */
export function maxParagraphSimilarity(candidate: string, existing: readonly string[]): number {
  const left = paragraphSimhashes(candidate)
  const right = existing.flatMap((text) => paragraphSimhashes(text))
  let best = 0
  for (const a of left) {
    for (const b of right) best = Math.max(best, similarity(a, b))
  }
  return best
}
