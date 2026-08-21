-- RONDE 28: bring existing visual_search_memory rows onto the canonical entity key.
--
-- Writes always lowercased the entity for dedupeKeyHash, but getVisualSearchMemoryForEntity
-- matched the raw `entity` column, so a row stored as "Adolf Hitler" could never be found by a
-- lookup for "adolf hitler" (or the reverse). Write and read now share canonicalEntityKey();
-- this brings the rows written before that change along, instead of leaving them stranded.
--
-- Cannot collide with the unique index: dedupeKeyHash has ALWAYS been computed from the
-- lowercased entity, so two rows that differ only by case could never have coexisted. This
-- rewrites the display column to match the key that was already in use.
UPDATE `visual_search_memory`
SET `entity` = LOWER(TRIM(`entity`))
WHERE `entity` <> LOWER(TRIM(`entity`));
