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
