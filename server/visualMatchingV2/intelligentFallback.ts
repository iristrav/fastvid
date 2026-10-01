

/** Generic, safe-default categories for "a named organization/object exists but we have no
 *  footage of it specifically." Deliberately broad and inoffensive — a last-resort substitute,
 *  not a precise match. Exported so other modules (e.g. cinematicEditingEngine's ShotPlanner)
 *  can recognize footage retrieved via this fallback tier without hardcoding a second copy of
 *  the same list. */
export const GENERIC_ENTITY_FALLBACK_CATEGORIES = [
  "office",
  "servers",
  "employees",
  "conference",
  "technology",
  "workspace",
  "meeting room",
];

