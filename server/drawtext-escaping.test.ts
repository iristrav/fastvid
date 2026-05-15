/**
 * Unit tests for FFmpeg drawtext filter escaping
 * Tests the sanitization of text for use in FFmpeg drawtext filters
 */
import { describe, it, expect } from "vitest";

// Helper function to mimic the escaping logic from buildSubtitleFilter
function escapeDrawtextText(text: string): string {
  let safeText = text
    .replace(/[^\x20-\x7E]/g, ' ')  // Remove non-ASCII
    .slice(0, 80)
    .trim()
    .replace(/'/g, '')  // Remove single quotes
    .replace(/:/g, ' ')  // Replace colons
    .replace(/\\/g, ' ')  // Replace backslashes
    .replace(/"/g, ' ')  // Replace double quotes
    .replace(/\[/g, '(')  // Replace brackets
    .replace(/\]/g, ')')
    .replace(/\{/g, '(')  // Replace braces
    .replace(/\}/g, ')')
    .replace(/\n/g, ' ')  // Remove newlines
    .replace(/\t/g, ' '); // Remove tabs
  
  return safeText;
}

describe("FFmpeg Drawtext Filter Escaping", () => {
  it("should remove non-ASCII characters", () => {
    const input = "Decoding the Rumors: s Life Under the Microsoc™";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain("™");
    expect(result).toMatch(/^[A-Za-z0-9 .,!?:-]*$/);
  });

  it("should remove single quotes", () => {
    const input = "It's a beautiful day";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain("'");
    expect(result).toBe("Its a beautiful day");
  });

  it("should replace colons with spaces", () => {
    const input = "Title: Subtitle";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain(":");
    expect(result).toBe("Title  Subtitle");
  });

  it("should replace backslashes with spaces", () => {
    const input = "Path\\to\\file";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain("\\");
    expect(result).toBe("Path to file");
  });

  it("should replace double quotes with spaces", () => {
    const input = 'He said "hello"';
    const result = escapeDrawtextText(input);
    expect(result).not.toContain('"');
    expect(result).toBe("He said  hello ");
  });

  it("should replace brackets with parentheses", () => {
    const input = "Item [1] and [2]";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain("[");
    expect(result).not.toContain("]");
    expect(result).toBe("Item (1) and (2)");
  });

  it("should replace braces with parentheses", () => {
    const input = "Code {block}";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain("{");
    expect(result).not.toContain("}");
    expect(result).toBe("Code (block)");
  });

  it("should remove newlines", () => {
    const input = "Line 1\nLine 2";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain("\n");
    expect(result).toBe("Line 1 Line 2");
  });

  it("should remove tabs", () => {
    const input = "Column1\tColumn2";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain("\t");
    expect(result).toBe("Column1 Column2");
  });

  it("should limit text to 80 characters", () => {
    const input = "a".repeat(100);
    const result = escapeDrawtextText(input);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("should trim whitespace", () => {
    const input = "   Hello World   ";
    const result = escapeDrawtextText(input);
    expect(result).toBe("Hello World");
  });

  it("should handle real-world problematic text", () => {
    const input = "Decoding the Rumors: s Life Under the Microsoc";
    const result = escapeDrawtextText(input);
    // Should not throw and should produce valid text
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9 .,!?()-]*$/);
  });

  it("should handle empty string", () => {
    const input = "";
    const result = escapeDrawtextText(input);
    expect(result).toBe("");
  });

  it("should handle string with only special characters", () => {
    const input = "!@#$%^&*()";
    const result = escapeDrawtextText(input);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it("should handle mixed content", () => {
    const input = "The 'Best' Way: To [Escape] {Text}";
    const result = escapeDrawtextText(input);
    expect(result).not.toContain("'");
    expect(result).not.toContain(":");
    expect(result).not.toContain("[");
    expect(result).not.toContain("]");
    expect(result).not.toContain("{");
    expect(result).not.toContain("}");
    expect(result).toBe("The Best Way  To (Escape) (Text)");
  });

  it("should produce FFmpeg-safe output", () => {
    const testCases = [
      "Rumors about Kylie Jenner",
      "AI-Generated Content",
      "Breaking News: Update",
      "What's the Latest?",
      "Behind the Scenes [Exclusive]",
    ];

    for (const input of testCases) {
      const result = escapeDrawtextText(input);
      // Should not contain problematic characters
      expect(result).not.toContain("'");
      expect(result).not.toContain(":");
      expect(result).not.toContain("\\");
      expect(result).not.toContain('"');
      expect(result).not.toContain("[");
      expect(result).not.toContain("]");
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
      // Should be non-empty for non-empty input
      if (input.trim().length > 0) {
        expect(result.length).toBeGreaterThan(0);
      }
    }
  });
});
