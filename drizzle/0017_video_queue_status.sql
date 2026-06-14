ALTER TABLE `videos` MODIFY COLUMN `status` enum(
  'pending',
  'queued',
  'generating_script',
  'awaiting_approval',
  'generating_voiceover',
  'generating_visuals',
  'generating_effects',
  'completed',
  'failed'
) NOT NULL DEFAULT 'pending';
