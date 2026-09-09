/**
 * T0 passphrase strength (phase 5 ruling 9, audit row A5-08). `op=identity&pass=` is a free,
 * unauthenticated oracle that maps a passphrase to the address it controls, so a guessable T0 pass is
 * a guessable member: the only defence is that the pass itself carries real entropy. The relay
 * therefore refuses any pass whose entropy this estimator puts below 128 bits.
 *
 * The estimator is deliberately conservative and takes the MINIMUM of two models, because a character
 * model alone accepts sentences ("correct horse battery staple ..." is 44 characters of a 59-character
 * alphabet = 258 "bits" and trivially guessable):
 *   char model  length x log2(alphabet classes present), after collapsing repetition (a repeated character
 *               or a repeated short block adds nothing however long it runs)
 *   token model applied only when the pass IS a phrase (letters-only words, one case each, joined by
 *               single ordinary separators): the sum over DISTINCT words, each worth at most 12.9 bits
 *               (an EFF-diceware word, 2^12.9 = 7776); a repeated word adds nothing
 * What passes: 32 random bytes as base64url (43 chars, 258 bits), 32 hex characters (165 bits), 10+
 * random diceware words (129 bits). What fails: any sentence, and any short pass.
 * What it cannot catch (no dictionary is shipped): dictionary words concatenated without separators
 * beyond 28 characters, e.g. "correcthorsebatterystaplecorrect" (documented in docs/RELAY.md).
 */

/** Minimum entropy the relay accepts for a T0 pass, in bits (phase 5 ruling 9). */
export const PASS_ENTROPY_FLOOR = 128;

/** Bits per dictionary-shaped word: the EFF long list is 7776 words = 2^12.925 (a word is worth no more). */
const WORD_BITS = Math.log2(7776);

/** Longest token still assumed to be a dictionary word; longer letter runs are scored per character. */
const MAX_WORD_LENGTH = 12;

/**
 * Size of the character pool a string draws from, by the classes it uses.
 *
 * @param text The string.
 * @returns The pool size (26 lower + 26 upper + 10 digits + 33 other printable ASCII).
 */
function poolSize(text: string): number {
  let pool = 0;
  if (/[a-z]/u.test(text)) pool += 26;
  if (/[A-Z]/u.test(text)) pool += 26;
  if (/[0-9]/u.test(text)) pool += 10;
  if (/[^A-Za-z0-9]/u.test(text)) pool += 33;
  return Math.max(pool, 1);
}

/**
 * Collapse repetition: three or more identical characters ("aaaaa" -> "aa") and a short block repeated
 * three or more times ("ERERERER" -> "ERER"). A repetition is not new entropy, however long it runs.
 *
 * @param text The passphrase.
 * @returns The passphrase with its repetitions collapsed.
 */
function collapseRuns(text: string): string {
  return text.replace(/(.)\1{2,}/gu, "$1$1").replace(/(.{2,8}?)\1{2,}/gu, "$1$1");
}

/** Character-model entropy of a string in bits. */
function charBits(text: string): number {
  return text.length * Math.log2(poolSize(text));
}

/**
 * Conservative entropy estimate of a T0 passphrase, in bits.
 *
 * @param pass The passphrase as the caller sent it.
 * @returns The estimated bits (the minimum of the character and token models; 0 for an empty pass).
 */
export function passEntropyBits(pass: string): number {
  const collapsed = collapseRuns(pass);
  if (collapsed.length === 0) return 0;
  const bits = charBits(collapsed);
  const tokens = collapsed.split(/[^A-Za-z0-9]+/u).filter((token) => token.length > 0);
  // The word model applies only to a pass that IS a sequence of words: letters-only tokens, each in one
  // case, joined by single ordinary separators. A random base64url or hex pass never matches, so it is
  // never mis-scored as a phrase (a false rejection would push agents back to weaker passes).
  const wordShaped = /^[A-Za-z]+(?:[ \-_.''][A-Za-z]+)*[!?.]?$/u.test(collapsed)
    && tokens.length >= 2
    && tokens.every((token) => token === token.toLowerCase() || token === token.toUpperCase() || /^[A-Z][a-z]*$/u.test(token));
  if (!wordShaped) return bits;
  let tokenTotal = 0;
  const seen = new Set<string>();
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokenTotal += token.length <= MAX_WORD_LENGTH ? Math.min(WORD_BITS, charBits(token)) : charBits(token);
  }
  return Math.min(bits, tokenTotal);
}

/**
 * Whether a passphrase clears the floor.
 *
 * @param pass The passphrase.
 * @returns True when `passEntropyBits(pass) >= PASS_ENTROPY_FLOOR`.
 */
export function passStrongEnough(pass: string): boolean {
  return passEntropyBits(pass) >= PASS_ENTROPY_FLOOR;
}
