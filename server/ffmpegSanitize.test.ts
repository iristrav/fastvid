import { describe, it, expect } from 'vitest';
import { sanitizeForDrawtext, sanitizeForDrawtextStrict, escapeForFFmpegFilter } from './ffmpegSanitize';

describe('FFmpeg Drawtext Sanitization', () => {
  describe('sanitizeForDrawtext', () => {
    it('should remove single quotes', () => {
      expect(sanitizeForDrawtext("It's a test")).toBe('Its a test');
    });

    it('should remove double quotes', () => {
      expect(sanitizeForDrawtext('He said "hello"')).toBe('He said hello');
    });

    it('should replace colons with spaces', () => {
      expect(sanitizeForDrawtext('Title: Subtitle')).toBe('Title Subtitle');
    });

    it('should replace hash symbols with spaces', () => {
      expect(sanitizeForDrawtext('#VID-0021')).toBe('VID-0021');
    });

    it('should replace backslashes with spaces', () => {
      expect(sanitizeForDrawtext('path\\to\\file')).toBe('path to file');
    });

    it('should replace dollar signs with spaces', () => {
      expect(sanitizeForDrawtext('Price: $99')).toBe('Price 99');
    });

    it('should replace pipes with spaces', () => {
      expect(sanitizeForDrawtext('Option A | Option B')).toBe('Option A Option B');
    });

    it('should replace square brackets with parentheses', () => {
      expect(sanitizeForDrawtext('Array[0]')).toBe('Array(0)');
    });

    it('should replace curly braces with parentheses', () => {
      expect(sanitizeForDrawtext('{object}')).toBe('(object)');
    });

    it('should replace angle brackets with parentheses', () => {
      expect(sanitizeForDrawtext('<tag>')).toBe('(tag)');
    });

    it('should remove backticks', () => {
      expect(sanitizeForDrawtext('`code`')).toBe('code');
    });

    it('should remove non-ASCII characters', () => {
      expect(sanitizeForDrawtext('Café ☕ München')).toBe('Caf M nchen');
    });

    it('should replace newlines with spaces', () => {
      expect(sanitizeForDrawtext('Line 1\nLine 2')).toBe('Line 1 Line 2');
    });

    it('should replace tabs with spaces', () => {
      expect(sanitizeForDrawtext('Col1\tCol2')).toBe('Col1 Col2');
    });

    it('should collapse multiple spaces', () => {
      expect(sanitizeForDrawtext('Multiple   spaces')).toBe('Multiple spaces');
    });

    it('should trim whitespace', () => {
      expect(sanitizeForDrawtext('  text  ')).toBe('text');
    });

    it('should limit length to default 80 chars', () => {
      const longText = 'a'.repeat(100);
      expect(sanitizeForDrawtext(longText).length).toBe(80);
    });

    it('should limit length to custom max', () => {
      const longText = 'a'.repeat(100);
      expect(sanitizeForDrawtext(longText, 50).length).toBe(50);
    });

    it('should handle real-world title with special chars', () => {
      const title = '# Decoding the Rumors: Kylie Jenner\'s Life Under the Microscope';
      const result = sanitizeForDrawtext(title, 60);
      expect(result).not.toContain('#');
      expect(result).not.toContain(':');
      expect(result).not.toContain("'");
      expect(result.length).toBeLessThanOrEqual(60);
    });

    it('should handle empty string', () => {
      expect(sanitizeForDrawtext('')).toBe('');
    });

    it('should handle null-like values gracefully', () => {
      expect(sanitizeForDrawtext('null')).toBe('null');
      expect(sanitizeForDrawtext('undefined')).toBe('undefined');
    });

    it('should handle scene badge format', () => {
      const badge = '1/12';
      const result = sanitizeForDrawtext(badge, 20);
      expect(result).toBe('1/12');
    });

    it('should handle mixed special characters', () => {
      const text = "Test's #1: \"Quote\" [Bracket] {Brace} <Angle> $Price";
      const result = sanitizeForDrawtext(text);
      expect(result).not.toMatch(/[':#{}<>$\[\]]/);
    });
  });

  describe('sanitizeForDrawtextStrict', () => {
    it('should only allow alphanumeric and safe punctuation', () => {
      const result = sanitizeForDrawtextStrict('Hello World! Test-123.');
      expect(result).toBe('Hello World! Test-123.');
    });

    it('should remove all special characters', () => {
      const result = sanitizeForDrawtextStrict('Test@#$%^&*()_+={}[]|:;"<>,.?/');
      expect(result).toBe('Test & ,.?');
    });

    it('should preserve spaces', () => {
      const result = sanitizeForDrawtextStrict('Multiple   spaces');
      expect(result).toBe('Multiple spaces');
    });

    it('should limit length', () => {
      const longText = 'a'.repeat(100);
      expect(sanitizeForDrawtextStrict(longText, 50).length).toBeLessThanOrEqual(50);
    });
  });

  describe('escapeForFFmpegFilter', () => {
    it('should remove single quotes', () => {
      expect(escapeForFFmpegFilter("It's")).toBe('Its');
    });

    it('should remove double quotes', () => {
      expect(escapeForFFmpegFilter('He said "hi"')).toBe('He said hi');
    });

    it('should replace colons', () => {
      expect(escapeForFFmpegFilter('Time: 12:30')).toBe('Time  12 30');
    });

    it('should escape dollar signs', () => {
      expect(escapeForFFmpegFilter('Price $99')).toBe('Price \\$99');
    });

    it('should escape backticks', () => {
      expect(escapeForFFmpegFilter('`code`')).toBe('\\`code\\`');
    });
  });

  describe('Edge cases', () => {
    it('should handle Unicode emoji', () => {
      const result = sanitizeForDrawtext('Hello 👋 World 🌍');
      expect(result).not.toContain('👋');
      expect(result).not.toContain('🌍');
    });

    it('should handle mixed case', () => {
      const result = sanitizeForDrawtext('MiXeD CaSe TeXt');
      expect(result).toBe('MiXeD CaSe TeXt');
    });

    it('should handle numbers', () => {
      const result = sanitizeForDrawtext('Test 123 456');
      expect(result).toBe('Test 123 456');
    });

    it('should handle repeated special characters', () => {
      const result = sanitizeForDrawtext('!!!???###');
      // These are not in the sanitization list, so they remain
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle all special chars at once', () => {
      const allSpecial = `!@#$%^&*()_+-={}[]|:;"'<>,.?/\\`;
      const result = sanitizeForDrawtext(allSpecial);
      // Should not throw and should return a clean string
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
