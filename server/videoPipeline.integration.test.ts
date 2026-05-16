import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeForDrawtext } from './ffmpegSanitize';

describe('Video Pipeline Integration - FFmpeg Sanitization', () => {
  const testWorkDir = '/tmp/test_video_pipeline';

  beforeAll(() => {
    // Create test directory
    if (!fs.existsSync(testWorkDir)) {
      fs.mkdirSync(testWorkDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(testWorkDir)) {
      fs.rmSync(testWorkDir, { recursive: true, force: true });
    }
  });

  describe('FFmpeg Drawtext Sanitization in Pipeline', () => {
    it('should sanitize scene titles with special characters', () => {
      const titles = [
        '# Decoding the Rumors: Kylie Jenner\'s Life Under the Microscope',
        'Breaking News! "Kylie" Updates [2024]',
        'The Truth About {Kylie} & Her $$$',
        'Kylie\'s Journey: From <Unknown> to Star',
        'Rumors|Facts|Updates',
      ];

      titles.forEach((title) => {
        const sanitized = sanitizeForDrawtext(title, 80);
        
        // Should not contain problematic characters
        expect(sanitized).not.toMatch(/[':#{}<>$\[\]|]/);
        
        // Should have content
        expect(sanitized.length).toBeGreaterThan(0);
        
        // Should be within length limit
        expect(sanitized.length).toBeLessThanOrEqual(80);
        
        console.log(`✓ Title sanitized: "${title}" → "${sanitized}"`);
      });
    });

    it('should handle scene badges with special characters', () => {
      const badges = ['1/8', '5/12', '10/20'];
      
      badges.forEach((badge) => {
        const sanitized = sanitizeForDrawtext(badge, 20);
        expect(sanitized).toBeTruthy();
        expect(sanitized.length).toBeLessThanOrEqual(20);
        console.log(`✓ Badge sanitized: "${badge}" → "${sanitized}"`);
      });
    });

    it('should handle subtitle text with emojis and unicode', () => {
      const subtitles = [
        'Kylie Jenner 👑 is a billionaire 💰',
        'Breaking: New rumors 🔥 about her life 📱',
        'Café ☕ gossip: What\'s really happening? 🤔',
      ];

      subtitles.forEach((subtitle) => {
        const sanitized = sanitizeForDrawtext(subtitle, 100);
        
        // Should not contain emoji
        expect(sanitized).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
        
        // Should have meaningful content
        expect(sanitized.length).toBeGreaterThan(0);
        
        console.log(`✓ Subtitle sanitized: "${subtitle}" → "${sanitized}"`);
      });
    });

    it('should handle very long titles gracefully', () => {
      const longTitle = 'A'.repeat(200) + ': ' + 'B'.repeat(200);
      const sanitized = sanitizeForDrawtext(longTitle, 80);
      
      expect(sanitized.length).toBeLessThanOrEqual(80);
      expect(sanitized).toBeTruthy();
      console.log(`✓ Long title truncated to ${sanitized.length} chars`);
    });

    it('should handle titles with all problematic characters', () => {
      const problematicTitle = `!@#$%^&*()_+-={}[]|:;"'<>,.?/\\~`;
      const sanitized = sanitizeForDrawtext(problematicTitle, 100);
      
      // Should not throw
      expect(sanitized).toBeTruthy();
      
      // Should remove most special chars
      expect(sanitized.length).toBeLessThan(problematicTitle.length);
      
      console.log(`✓ Problematic title handled: "${problematicTitle}" → "${sanitized}"`);
    });

    it('should preserve important information in sanitized text', () => {
      const testCases = [
        {
          input: '# Episode 1: Kylie\'s Secrets',
          shouldContain: ['Episode', '1', 'Kylie', 'Secrets'],
        },
        {
          input: 'Breaking: $1M Kylie Deal [EXCLUSIVE]',
          shouldContain: ['Breaking', '1M', 'Kylie', 'Deal', 'EXCLUSIVE'],
        },
      ];

      testCases.forEach(({ input, shouldContain }) => {
        const sanitized = sanitizeForDrawtext(input, 100);
        
        shouldContain.forEach((word) => {
          expect(sanitized.toLowerCase()).toContain(word.toLowerCase());
        });
        
        console.log(`✓ Important info preserved: "${input}" → "${sanitized}"`);
      });
    });
  });

  describe('Real-world Video Pipeline Scenarios', () => {
    it('should handle Kylie Jenner gossip video scenario', () => {
      const videoMetadata = {
        title: '# Decoding the Rumors: Kylie Jenner\'s Life Under the Microscope',
        scenes: [
          { index: 0, text: 'Breaking: New rumors about Kylie\'s $$$' },
          { index: 1, text: 'The Truth Behind [Her Success]' },
          { index: 2, text: 'What\'s Really Happening? {Exclusive}' },
          { index: 3, text: 'Kylie\'s Response: "No Comment"' },
          { index: 4, text: 'The Real Story | Facts vs Fiction' },
        ],
      };

      // Sanitize title
      const sanitizedTitle = sanitizeForDrawtext(videoMetadata.title, 80);
      expect(sanitizedTitle).not.toMatch(/[':#{}<>$\[\]|]/);

      // Sanitize all scenes
      videoMetadata.scenes.forEach((scene) => {
        const sanitizedText = sanitizeForDrawtext(scene.text, 100);
        const badge = sanitizeForDrawtext(`${scene.index + 1}/${videoMetadata.scenes.length}`, 20);
        
        expect(sanitizedText).toBeTruthy();
        expect(badge).toBeTruthy();
        
        console.log(`✓ Scene ${scene.index + 1} sanitized successfully`);
      });

      console.log(`✓ Full video metadata sanitized successfully`);
    });

    it('should handle edge case: title with only special characters', () => {
      const edgeCases = [
        '!!!???###',
        ':::;;;"""',
        '<<<>>>',
        '{{{}}}',
        '[[[]]]',
      ];

      edgeCases.forEach((edgeCase) => {
        const sanitized = sanitizeForDrawtext(edgeCase, 50);
        
        // Should not throw and should return something
        expect(sanitized).toBeTruthy();
        
        console.log(`✓ Edge case handled: "${edgeCase}" → "${sanitized}"`);
      });
    });
  });
});
