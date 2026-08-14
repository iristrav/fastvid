/**
 * FFmpeg Drawtext Filter Sanitization
 * 
 * FFmpeg's drawtext filter has strict requirements for text input:
 * - Single quotes must be removed or escaped
 * - Colons, hashes, backslashes, and special chars cause parsing errors
 * - Non-ASCII characters should be removed
 * - Text should be limited to reasonable length
 * 
 * This module provides a comprehensive sanitization function that handles ALL problematic characters.
 */

/**
 * Sanitize text for use in FFmpeg drawtext filter
 * Removes/replaces all characters that cause FFmpeg parsing errors
 * 
 * @param text - Raw text to sanitize
 * @param maxLength - Maximum length (default: 80)
 * @returns Safe text for FFmpeg drawtext
 */
export function sanitizeForDrawtext(text: string, maxLength: number = 80): string {
  if (!text) return '';
  
  return text
    // 1. Remove non-ASCII characters first
    .replace(/[^\x20-\x7E]/g, ' ')
    
    // 2. Remove/replace problematic FFmpeg drawtext characters
    .replace(/'/g, '')           // Single quotes - remove
    .replace(/"/g, '')           // Double quotes - remove
    .replace(/:/g, ' ')          // Colons - replace with space
    .replace(/#/g, ' ')          // Hash symbols - replace with space
    .replace(/\\/g, ' ')         // Backslashes - replace with space
    .replace(/`/g, ' ')          // Backticks - replace with space
    .replace(/\$/g, ' ')         // Dollar signs - replace with space
    .replace(/\|/g, ' ')         // Pipes - replace with space
    .replace(/\[/g, '(')         // Square brackets - replace with parens
    .replace(/\]/g, ')')
    .replace(/\{/g, '(')         // Curly braces - replace with parens
    .replace(/\}/g, ')')
    .replace(/</g, '(')          // Angle brackets - replace with parens
    .replace(/>/g, ')')
    .replace(/\n/g, ' ')         // Newlines - replace with space
    .replace(/\t/g, ' ')         // Tabs - replace with space
    .replace(/\r/g, ' ')         // Carriage returns - replace with space
    .replace(/\f/g, ' ')         // Form feeds - replace with space
    .replace(/\v/g, ' ')         // Vertical tabs - replace with space
    
    // 3. Collapse multiple spaces into single space
    .replace(/\s+/g, ' ')
    
    // 4. Trim and limit length
    .trim()
    .slice(0, maxLength)
    .trim();
}

/**
 * F3-25: hard quality gate for on-screen caption/label text. A production render showed a
 * corrupted burned-in caption ("THE GUNINSHOT ECHOESVSTEEL AND FLAMES LICK") — words glued
 * together with no separating space and an internally corrupted token ("GUNINSHOT"). Every live
 * on-screen-text extractor (extractVoiceoverKeywords, buildYearCaption, extractKeywordFromBeat,
 * extractVoiceLabelTerms, in cinematicEffectsEngine.ts/visualBeatTags.ts) derives its text via
 * regex match or word-split directly from the beat's own real narration string, so correctly
 * functioning code always produces whole words that appear, in order, in that narration —
 * `sourceText` is the source of truth this checks against, never inventing new words.
 *
 * This is a bounded-gap, in-order WORD sequence match, not a strict contiguous substring check:
 * buildYearCaption itself legitimately skips short connector words ("to", "a", "in", etc.) when
 * picking the words immediately before a year, so "rose power" is a valid caption for source text
 * "...rose to power..." even though "power" isn't literally adjacent to "rose". `maxWordGap`
 * bounds how many source words may be skipped between two consecutive caption words before that
 * stops looking like an intentional connector-word skip and starts looking like two unrelated
 * fragments (e.g. one word from the start of a beat and another from its very end, or — the
 * production defect — a glued token that isn't a real word in the source at all) stitched
 * together. A caption failing this check is the strongest available signal (plain string
 * comparison — no OCR/vision/new ML) that something upstream produced text that doesn't actually
 * belong together, and should be rejected rather than burned in.
 */
export function isCaptionTextCorrupt(captionText: string, sourceText: string, maxWordGap = 3): boolean {
  // Apostrophes/hyphens are kept as in-word characters (not split into separate tokens) —
  // matching how buildYearCaption/extractKeywordFromBeat themselves strip words
  // (`[^a-zA-ZÀ-ÿ0-9'-]`), so a contraction like "Hitler's" normalizes the same way on both
  // sides of the comparison instead of one side silently splitting it into two words.
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9À-ÿ'\-\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

  const capWords = words(captionText);
  if (capWords.length === 0) return false; // empty text isn't "corrupt" — just nothing to show
  const sourceWords = words(sourceText);
  if (sourceWords.length === 0) return false; // no source to validate against — don't false-positive

  let prevIdx = -1; // index in sourceWords of the previously matched caption word
  for (const w of capWords) {
    const searchStart = prevIdx + 1;
    // The first caption word may appear anywhere in the source; every word after it must appear
    // within maxWordGap source words of the previous match, in order.
    const searchEnd = prevIdx < 0 ? sourceWords.length : Math.min(sourceWords.length, searchStart + maxWordGap + 1);
    let foundAt = -1;
    for (let i = searchStart; i < searchEnd; i++) {
      if (sourceWords[i] === w) {
        foundAt = i;
        break;
      }
    }
    if (foundAt === -1) return true; // missing entirely, or too far from the previous word
    prevIdx = foundAt;
  }
  return false;
}

/**
 * Sanitize text for FFmpeg drawtext with strict mode
 * Only allows alphanumeric, spaces, and basic punctuation
 * 
 * @param text - Raw text to sanitize
 * @param maxLength - Maximum length (default: 80)
 * @returns Safe text for FFmpeg drawtext (strict)
 */
export function sanitizeForDrawtextStrict(text: string, maxLength: number = 80): string {
  if (!text) return '';
  
  return text
    // Keep only alphanumeric, spaces, and safe punctuation
    .replace(/[^a-zA-Z0-9\s.,!?&-]/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    // Trim and limit length
    .trim()
    .slice(0, maxLength)
    .trim();
}

/**
 * Escape text for use in FFmpeg filter strings
 * Handles escaping for use within filter_complex parameters
 * 
 * @param text - Raw text to escape
 * @returns Escaped text safe for FFmpeg filter strings
 */
export function escapeForFFmpegFilter(text: string): string {
  if (!text) return '';
  
  return text
    // First sanitize problematic characters
    .replace(/'/g, '')           // Remove single quotes
    .replace(/"/g, '')           // Remove double quotes
    .replace(/\\/g, ' ')         // Replace backslashes
    .replace(/:/g, ' ')          // Replace colons
    .replace(/#/g, ' ')          // Replace hashes
    // Escape special shell characters if needed
    .replace(/\$/g, '\\$')       // Escape dollar signs
    .replace(/`/g, '\\`')        // Escape backticks
    .trim();
}
