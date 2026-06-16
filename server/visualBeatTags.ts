/**
 * Extract place/keyword tags from narration for archive search + voice-synced labels.
 */

/** Drives archive filtering — geography videos must not pull WWII/Hiter footage. */
export type VideoVisualTopic = "wwii" | "cold_war" | "geography_urban" | "general";

const WWII_WAR_ARCHIVE_RE =
  /\b(hitler|adolf|nazi|nsdap|wehrmacht|\bss\b|swastika|hakenkruis|third reich|fuhrer|führer|goebbels|keitel|jodl|eva braun|propaganda rally|nuremberg rally|fuhrerbunker|führerbunker|world war ii|wwii|ww2|second world war|holocaust|concentration camp|wartime|blitzkrieg|invasion of poland|reichstag speech)\b/i;

const WWII_ERA_YEAR_RE = /\b(193[3-9]|194[0-5])\b/;

export type VoiceLabelTerm = {
  /** On-screen pill text (uppercase). */
  label: string;
  /** Search tag(s) for archive matching. */
  searchTags: string[];
  /** Substring from beat text for voice timing (preserves casing/diacritics). */
  matchText?: string;
};

type TagEntry = {
  pattern: RegExp;
  searchTags: string[];
  /** Preferred on-screen label (places only). */
  label?: string;
};

/** Countries and cities — shown as on-screen labels when spoken. */
const PLACE_ENTRIES: TagEntry[] = [
  { pattern: /\bduitsland\b|\bgermany\b|\bdeutschland\b|\bgerman\b|\bdeutsche\b/i, searchTags: ["germany", "german", "deutschland", "berlin"], label: "DUITSland" },
  { pattern: /\bberlijn\b|\bberlin\b/i, searchTags: ["berlin", "germany"], label: "BERLIJN" },
  { pattern: /\bmunich\b|\bmünchen\b|\bmunchen\b/i, searchTags: ["munich", "germany"], label: "MUNICH" },
  { pattern: /\bpolen\b|\bpoland\b|\bpolish\b/i, searchTags: ["poland", "polish", "warsaw"], label: "POLEN" },
  { pattern: /\bfrankrijk\b|\bfrance\b|\bfrench\b|\bparis\b|\bparijs\b/i, searchTags: ["france", "french", "paris"], label: "FRANKRIJK" },
  { pattern: /\bengeland\b|\bengland\b|\bbritain\b|\bbritish\b|\blondon\b/i, searchTags: ["england", "britain", "london", "uk"], label: "ENGELAND" },
  { pattern: /\boostenrijk\b|\baustria\b|\bvienna\b|\bwien\b/i, searchTags: ["austria", "vienna"], label: "OOSTENRIJK" },
  { pattern: /\brusland\b|\brussia\b|\brussian\b|\bsoviet\b|\bsovjet\b|\burss\b/i, searchTags: ["russia", "soviet", "moscow"], label: "RUSland" },
  { pattern: /\bitalië\b|\bitalie\b|\bitaly\b|\bitalian\b|\brome\b|\bromeinen\b/i, searchTags: ["italy", "italian", "rome"], label: "ITALIË" },
  { pattern: /\bamerika\b|\bamerica\b|\bamerican\b|\bunited states\b|\busa\b|\bu\.?s\.?\b/i, searchTags: ["america", "usa", "united states", "american"], label: "AMERIKA" },
  { pattern: /\bnederland\b|\bnetherlands\b|\bdutch\b|\bholland\b|\bnederlands\b/i, searchTags: ["netherlands", "holland", "dutch", "amsterdam", "nederland"], label: "NEDERLAND" },
  { pattern: /\bamsterdam\b/i, searchTags: ["amsterdam", "netherlands", "holland", "dutch"], label: "AMSTERDAM" },
  { pattern: /\brotterdam\b/i, searchTags: ["rotterdam", "netherlands", "holland"], label: "ROTTERDAM" },
  { pattern: /\butrecht\b/i, searchTags: ["utrecht", "netherlands"], label: "UTRECHT" },
  { pattern: /\bden haag\b|\bthe hague\b|\b's-gravenhage\b/i, searchTags: ["the hague", "den haag", "netherlands"], label: "DEN HAAG" },
  { pattern: /\beuropa\b|\beurope\b|\beuropean\b/i, searchTags: ["europe", "european"], label: "EUROPA" },
  { pattern: /\bwarschau\b|\bwarsaw\b/i, searchTags: ["warsaw", "poland"], label: "WARSCHAU" },
  { pattern: /\bmoskou\b|\bmoscow\b|\bkremlin\b/i, searchTags: ["moscow", "russia", "soviet"], label: "MOSKOU" },
  { pattern: /\bnormandi[ëe]\b|\bnormandy\b|\bd-day\b|\bdddag\b/i, searchTags: ["normandy", "d-day", "france"], label: "NORMANDIË" },
  { pattern: /\bauschwitz\b/i, searchTags: ["auschwitz", "poland", "holocaust"], label: "AUSCHWITZ" },
];

/** People / factions — archive search only (not on-screen labels). */
const ENTITY_SEARCH_ENTRIES: TagEntry[] = [
  { pattern: /\bhitler\b|\badolf\b|\bhitlers\b/i, searchTags: ["hitler", "adolf hitler", "fuhrer", "führer"] },
  { pattern: /\bholocaust\b|\bconcentration camp\b|\bkamp\b|\bconcentratiekamp\b/i, searchTags: ["holocaust", "concentration camp", "auschwitz"] },
  { pattern: /\bwehrmacht\b|\bnazi\b|\bnazis\b|\bnsdap\b|\bthird reich\b|\bderde rijk\b/i, searchTags: ["nazi", "wehrmacht", "third reich", "nsdap"] },
  { pattern: /\bstalin\b|\bsovjet\b|\bsoviet union\b/i, searchTags: ["stalin", "soviet", "russia"] },
  { pattern: /\bchurchill\b/i, searchTags: ["churchill", "britain"] },
  { pattern: /\brommel\b|\berwin\b/i, searchTags: ["rommel", "germany", "military"] },
];

/** Scene / setting — archive search only (bunker, rally, troops…). */
const SCENE_SEARCH_ENTRIES: TagEntry[] = [
  { pattern: /\bbunker\b|\bführerbunker\b|\bfuhrerbunker\b|\bführer\s*bunker\b|\bondergrondse\b|\bkelder\b|\bcommando\s*post\b/i, searchTags: ["bunker", "fuhrerbunker", "führerbunker", "hitler bunker", "underground", "command post"] },
  { pattern: /\bredevoering\b|\bspeech\b|\brally\b|\bpodium\b|\btribune\b|\bnürnberg\b|\bnuremberg\b/i, searchTags: ["speech", "rally", "podium", "nuremberg", "nuremberg rally"] },
  { pattern: /\bmilitair\b|\bsoldaten\b|\btroepen\b|\barmy\b|\btroops\b|\binfanterie\b|\btank\b|\btanks\b|\bpanzer\b/i, searchTags: ["soldiers", "military", "troops", "tank", "panzer", "wehrmacht"] },
  { pattern: /\boorlog\b|\bbattle\b|\bfront\b|\bgevecht\b|\binvasie\b|\binvasion\b|\bblitzkrieg\b/i, searchTags: ["war", "battle", "front", "invasion", "combat"] },
  { pattern: /\bparade\b|\boptocht\b|\bmars\b|\bmarch\b/i, searchTags: ["parade", "march", "military parade"] },
  { pattern: /\bberghof\b|\badlerhorst\b|\beagles?\s*nest\b|\bwolfsschanze\b|\bwolf\s*lair\b/i, searchTags: ["berghof", "eagles nest", "wolf's lair", "wolfsschanze", "hitler"] },
  { pattern: /\bvliegtuig\b|\bairplane\b|\baircraft\b|\bluchtaanval\b|\bbombardement\b|\bbombing\b/i, searchTags: ["aircraft", "airplane", "bombing", "air raid"] },
  { pattern: /\bvlag\b|\bswastika\b|\bhakenkruis\b/i, searchTags: ["swastika", "nazi flag", "flag"] },
  { pattern: /\bondergronds\b|\bunderground\b|\bkelder\b|\bcellar\b|\bcommand\s*post\b|\bcommando\s*centrum\b/i, searchTags: ["underground", "bunker", "command post", "cellar"] },
  { pattern: /\bovergave\b|\bsurrender\b|\bcapitulat/i, searchTags: ["surrender", "capitulation", "surrender document"] },
  { pattern: /\bruïnes\b|\bruins\b|\brubble\b|\bverwoest\b|\bdestroyed\b|\bgebombardeerd\b|\bbombard/i, searchTags: ["ruins", "rubble", "destroyed", "bombed", "berlin ruins"] },
  { pattern: /\bbrand\b|\bbranden\b|\bburning\b|\bfire\b|\bvlammen\b|\bflames\b/i, searchTags: ["fire", "burning", "flames", "smoke"] },
  { pattern: /\brook\b|\bsmoke\b|\bartillerie\b|\bartillery\b|\bshelling\b|\bbombardment\b/i, searchTags: ["smoke", "artillery", "shelling", "bombardment"] },
  { pattern: /\bofficier\b|\bofficers\b|\bgeneraal\b|\bgenerals\b|\bcommandant\b|\bstaff\b|\bstaf\b/i, searchTags: ["officers", "generals", "military staff", "command"] },
  { pattern: /\bvergadering\b|\bmeeting\b|\bconferentie\b|\bconference\b|\btafel\b|\bdesk\b|\bmap\b|\bkaart\b|\bstrategy\b|\bstrategie\b/i, searchTags: ["meeting", "conference", "war room", "map", "strategy", "table"] },
  { pattern: /\bself\s*destruct\b|\bself-destruct\b|\bselfdestructie\b|\bcyanide\b|\bvergif\b|\bpoison\b|\bsuicide\b|\bzelfmoord\b/i, searchTags: ["suicide", "cyanide", "poison", "death"] },
  { pattern: /\bcrematie\b|\bcremation\b|\blijk\b|\bcorpse\b|\bbody\b|\bdood\b|\bdeath\b|\boverleden\b|\bdied\b|\bsterf\b/i, searchTags: ["death", "corpse", "funeral", "cremation"] },
  { pattern: /\breichskanzlei\b|\breich\s*chancellery\b|\brijkskanselarij\b|\bkanzlei\b|\bchancellery\b/i, searchTags: ["reich chancellery", "reichstag", "berlin government"] },
  { pattern: /\beva\s+braun\b|\bbraun\b/i, searchTags: ["eva braun", "hitler", "bunker"] },
  { pattern: /\bomringd\b|\bencircled\b|\btrapped\b|\bgeïsoleerd\b|\bisolated\b|\bgeblokkeerd\b|\bblockade\b/i, searchTags: ["encircled", "surrounded", "siege", "blockade"] },
  { pattern: /\bvlucht\b|\bescape\b|\bontsnappen\b|\bflee\b|\bvluchten\b/i, searchTags: ["escape", "flee", "retreat"] },
  { pattern: /\bcivilian\b|\bburger\b|\bburgers\b|\brefugee\b|\bvluchteling\b|\bevacuat/i, searchTags: ["civilians", "refugees", "evacuation"] },
  { pattern: /\bsovjet\b|\bsoviet\b|\brode\s+leger\b|\bred\s+army\b|\bruss/i, searchTags: ["soviet", "red army", "russia"] },
  { pattern: /\bgoebbels\b|\bkeitel\b|\bjodl\b|\bdoenitz\b|\bdönitz\b|\bheinrich\b|\bheß\b|\bhess\b/i, searchTags: ["goebbels", "keitel", "jodl", "nazi leadership", "germany"] },
];

const LABEL_STOP = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "have", "has", "had", "this", "that", "these", "those",
  "de", "het", "een", "en", "van", "op", "te", "dat", "die", "zijn", "werd", "wordt", "niet", "also",
  "when", "then", "year", "years", "during", "after", "before", "into", "over", "under", "while",
  "where", "which", "who", "there", "their", "they", "would", "could", "should", "became", "become",
]);

function collectTagsFromEntries(cleaned: string, entries: TagEntry[]): string[] {
  const tags = new Set<string>();
  for (const entry of entries) {
    if (entry.pattern.test(cleaned)) {
      for (const t of entry.searchTags) tags.add(t);
    }
  }
  return [...tags];
}

/** Tags for archive asset search (English/lowercase slugs) — any topic, from the spoken sentence. */
export function extractSalientBeatTokens(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  const proper = [...cleaned.matchAll(/\b[A-ZÀ-ÿ][a-zà-ÿ]{2,}\b/g)]
    .map((m) => m[0]!.toLowerCase())
    .filter((w) => !LABEL_STOP.has(w));
  const lower = cleaned.toLowerCase();
  const words = lower
    .replace(/[^a-z0-9à-ÿ\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !LABEL_STOP.has(w) && !/^\d{4}$/.test(w));
  return [...new Set([...proper, ...words])].slice(0, 10);
}

export function inferVideoVisualTopic(videoTitle?: string, extraText?: string): VideoVisualTopic {
  const hay = `${videoTitle ?? ""} ${extraText ?? ""}`.toLowerCase();
  if (/hitler|nazi|wwii|ww2|world war ii|second world war|holocaust|third reich|wehrmacht|fuhrer|führer/.test(hay)) {
    return "wwii";
  }
  if (/cold war|berlin wall|iron curtain|checkpoint charlie|soviet bloc|east germany|ddr\b|stasi/.test(hay)) {
    return "cold_war";
  }
  if (
    /geograph|urban planning|city planning|zoning|transit design|public transport|walkable|urbanism|infrastructure|metropol|skyline|city comparison|compare.*cities|versus.*city|why .* city|how .* city|city (works|planning|design|life)|opposite of every|every us city|american city|vs\.? us|unlike (american|us) cities|modern city|contemporary city|stadtplanung|stedenbouw|opposite of (the )?(u\.?s\.?|united states)|netherlands.*opposite|opposite.*netherlands|nederland.*tegenover|tegenover.*amerika/.test(
      hay
    ) ||
    (/(berlin|berlijn|paris|london|amsterdam|rotterdam|utrecht|netherlands|nederland|holland|tokyo|new york|chicago|munich|vienna|singapore|copenhagen)/.test(hay) &&
      /(opposite|comparison|compare|unlike|different|versus|\bvs\b|urban|geograph|planning|transit|zoning|architecture|infrastructure|modern|contemporary|today|living|city life|every us|american)/.test(
        hay
      ))
  ) {
    return "geography_urban";
  }
  return "general";
}

/** WWII/Holocaust archive clip — must not appear in geography/modern city videos. */
export function isWwiiWarArchiveAsset(
  asset: Pick<{ title?: string | null; tags?: string[] | null; mediaType?: string | null }, "title" | "tags" | "mediaType">
): boolean {
  const title = (asset.title ?? "").toLowerCase();
  const tags = (asset.tags ?? []).join(" ").toLowerCase();
  const hay = `${title} ${tags}`;
  if (WWII_WAR_ARCHIVE_RE.test(hay)) return true;
  if (WWII_ERA_YEAR_RE.test(hay) && /\b(militair|military|soldat|soldier|parade|propaganda|archief|troepen|troops|nazi|hitler|berlijn|berlin|oorlog|war|zwart-wit|black.?white)\b/i.test(hay)) {
    return true;
  }
  if (asset.mediaType === "video") {
    return /\b(parade|militair|propaganda|toespraak|speech|rally|soldaten|troepen|wehrmacht|hitler|nazi|zwart-wit archief)\b/i.test(hay);
  }
  if (asset.mediaType === "image") {
    return /\b(propaganda poster|portret hitler|hitler portrait|nazi poster|hakenkruis)\b/i.test(hay);
  }
  return false;
}

const GEOGRAPHY_BLOCKED_TAGS = new Set([
  "hitler",
  "adolf hitler",
  "nazi",
  "wehrmacht",
  "bunker",
  "holocaust",
  "wwii",
  "ww2",
  "third reich",
  "fuhrer",
  "führer",
  "propaganda",
  "invasion",
  "panzer",
  "soldiers",
  "military parade",
  "war",
  "oorlog",
  "goebbels",
]);

/** Strip war-era search bias and add modern urban tags for city/geography documentaries. */
export function refineVisualSearchTagsForTopic(
  tags: string[],
  topic: VideoVisualTopic,
  beatText: string
): string[] {
  if (topic !== "geography_urban") return tags;
  const lower = beatText.toLowerCase();
  const out = new Set<string>();
  for (const t of tags) {
    const tl = t.toLowerCase();
    if (GEOGRAPHY_BLOCKED_TAGS.has(tl)) continue;
    if ([...GEOGRAPHY_BLOCKED_TAGS].some((b) => tl.includes(b))) continue;
    if (tl === "germany" || tl === "german" || tl === "deutschland") continue;
    out.add(t);
  }
  if (/berlin|berlijn/.test(lower)) {
    out.add("berlin city");
    out.add("berlin skyline");
    out.add("urban berlin");
    out.add("city street");
    out.add("architecture");
  }
  if (/netherlands|nederland|holland|amsterdam|rotterdam|utrecht|den haag|the hague|dutch/.test(lower)) {
    out.add("amsterdam");
    out.add("netherlands");
    out.add("dutch city");
    out.add("canal");
    out.add("bike lane");
    out.add("cycling infrastructure");
    out.add("public transport");
    out.add("urban planning");
  }
  if (/america|american|united states|\bu\.?s\.?\b|usa\b/.test(lower)) {
    out.add("united states");
    out.add("american city");
    out.add("usa skyline");
  }
  if (/transit|metro|subway|u-bahn|sbahn|train|trein|tram|bus|public transport|ov\b/.test(lower)) {
    out.add("public transport");
    out.add("metro");
    out.add("subway");
    out.add("train station");
  }
  if (/zoning|planning|urban|infrastructure|walkable|bike|cycl|density|housing|apartment/.test(lower)) {
    out.add("urban planning");
    out.add("city infrastructure");
    out.add("street scene");
  }
  out.add("city skyline");
  out.add("urban street");
  out.add("modern city");
  return [...out].slice(0, 20);
}

export function extractVisualSearchTags(beatText: string, videoTitle?: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const tags = new Set<string>([
    ...collectTagsFromEntries(cleaned, PLACE_ENTRIES),
    ...collectTagsFromEntries(cleaned, ENTITY_SEARCH_ENTRIES),
    ...collectTagsFromEntries(cleaned, SCENE_SEARCH_ENTRIES),
    ...extractSalientBeatTokens(beatText),
  ]);
  const years = cleaned.match(/\b(1[0-9]{3}|20[0-9]{2})\b/g);
  if (years) for (const y of years) tags.add(y);
  const topic = inferVideoVisualTopic(videoTitle, beatText);
  return refineVisualSearchTagsForTopic([...tags], topic, beatText);
}

/** Scene/setting tags only (bunker, rally, troops…). */
export function extractSceneSearchTags(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  return collectTagsFromEntries(cleaned, SCENE_SEARCH_ENTRIES).slice(0, 8);
}

/** Entity tags (Hitler, Nazi…) for archive search. */
export function extractEntitySearchTags(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  return collectTagsFromEntries(cleaned, ENTITY_SEARCH_ENTRIES).slice(0, 6);
}

/** Primary geographic anchor for beat search (e.g. Duitsland → germany). */
export function extractPrimaryGeoSearchTag(beatText: string): string | null {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  for (const entry of PLACE_ENTRIES) {
    if (entry.pattern.test(cleaned)) return entry.searchTags[0] ?? null;
  }
  return null;
}

/** All place/country tags explicitly mentioned in this beat sentence. */
export function extractBeatGeoPlaceTags(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const tags = new Set<string>();
  for (const entry of PLACE_ENTRIES) {
    if (entry.pattern.test(cleaned)) {
      for (const t of entry.searchTags) tags.add(t);
    }
  }
  return [...tags];
}

const NL_GEO_SLUGS = [
  "netherlands",
  "holland",
  "dutch",
  "nederland",
  "amsterdam",
  "rotterdam",
  "utrecht",
  "the hague",
  "den haag",
  "eindhoven",
  "groningen",
  "maastricht",
  "canal",
  "gracht",
];

const US_GEO_SLUGS = [
  "united states",
  "usa",
  "america",
  "american",
  "new york",
  "nyc",
  "manhattan",
  "brooklyn",
  "empire state",
  "chicago",
  "los angeles",
  "charlotte",
  "houston",
  "miami",
  "san francisco",
  "dallas",
  "atlanta",
  "philadelphia",
  "boston",
  "seattle",
  "denver",
  "phoenix",
  "bank of america stadium",
  "texas",
  "california",
  "florida",
];

function slugSetIncludes(slugs: string[], markers: string[]): boolean {
  return slugs.some((s) => markers.some((m) => s === m || s.includes(m) || m.includes(s)));
}

function assetHay(asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">): string {
  return `${(asset.title ?? "").toLowerCase()} ${(asset.tags ?? []).join(" ").toLowerCase()}`;
}

function assetHayHasMarkers(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">,
  markers: string[]
): boolean {
  const hay = assetHay(asset);
  return markers.some((m) => hay.includes(m));
}

/** Reject clips from the wrong country when the beat names a specific place (e.g. Netherlands ≠ Charlotte NC). */
export function isWrongGeoForBeat(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">,
  requiredGeoTags: string[]
): boolean {
  if (!requiredGeoTags.length) return false;

  const needsNl = slugSetIncludes(requiredGeoTags, NL_GEO_SLUGS);
  const needsUs = slugSetIncludes(requiredGeoTags, US_GEO_SLUGS);
  const hasNl = assetHayHasMarkers(asset, NL_GEO_SLUGS);
  const hasUs = assetHayHasMarkers(asset, US_GEO_SLUGS);
  const geoHits = geoTagHitCount(asset, requiredGeoTags);

  if (needsNl && !needsUs) {
    if (hasUs && !hasNl) return true;
    if (!hasNl && geoHits === 0) return true;
    return false;
  }
  if (needsUs && !needsNl) {
    if (hasNl && !hasUs) return true;
    if (!hasUs && geoHits === 0) return true;
    return false;
  }
  if (needsNl && needsUs) {
    return geoHits === 0;
  }
  return geoHits === 0;
}

function geoTagHitCount(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">,
  visualTags: string[]
): number {
  if (!visualTags.length) return 0;
  const title = (asset.title ?? "").toLowerCase();
  const assetTags = (asset.tags ?? []).map((t) => t.toLowerCase());
  let hits = 0;
  for (const vt of visualTags) {
    if (title.includes(vt)) hits += 2;
    for (const t of assetTags) {
      if (t === vt || t.includes(vt) || vt.includes(t)) hits++;
    }
  }
  return hits;
}

/** Best single search anchor — scene+entity beats generic geo (e.g. hitler bunker). */
/** Tags that should drive minimum clip acceptance for this sentence. */
export function extractRequiredVisualTags(beatText: string): string[] {
  const visual = extractVisualSearchTags(beatText);
  const scene = extractSceneSearchTags(beatText);
  const entity = extractEntitySearchTags(beatText);
  const salient = extractSalientBeatTokens(beatText).slice(0, 5);
  return [...new Set([...scene, ...entity, ...visual.slice(0, 8), ...salient])].slice(0, 14);
}

export function isGenericPeopleAsset(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">
): boolean {
  const title = (asset.title ?? "").toLowerCase();
  const tags = (asset.tags ?? []).join(" ").toLowerCase();
  const hay = `${title} ${tags}`;
  const generic =
    /\b(man|men|person|portrait|unknown|civilian|people|crowd|gesicht|mannen|oude man|woman|vrouw|face|headshot)\b/.test(
      hay
    );
  const specific =
    /\b(hitler|nazi|stalin|churchill|soldier|soldiers|military|troop|troops|officer|officers|general|generals|speech|rally|parade|tank|panzer|bunker|berlin|fuhrer|führer|wehrmacht|ss|goebbels|keitel|jodl|speech|toespraak|march|war|oorlog|combat|battle|front|invasion|soviet|red army)\b/.test(
      hay
    );
  return generic && !specific;
}

export function extractPrimaryVisualAnchor(beatText: string): string | null {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const scenes = collectTagsFromEntries(cleaned, SCENE_SEARCH_ENTRIES);
  const entities = collectTagsFromEntries(cleaned, ENTITY_SEARCH_ENTRIES);
  if (entities.length > 0 && scenes.length > 0) {
    return `${entities[0]} ${scenes[0]}`;
  }
  if (scenes.length > 0) return scenes[0] ?? null;
  const geo = extractPrimaryGeoSearchTag(beatText);
  if (geo) return geo;
  if (entities.length > 0) return entities[0] ?? null;
  const salient = extractSalientBeatTokens(beatText);
  if (salient.length >= 2) return `${salient[0]} ${salient[1]}`;
  if (salient.length === 1) return salient[0] ?? null;
  return null;
}

function spokenLabelForGeo(cleaned: string, entry: TagEntry): string {
  if (entry.label) {
    const m = cleaned.match(entry.pattern);
    if (m?.[0]) return m[0].toUpperCase().slice(0, 28);
  }
  return (entry.searchTags[0] ?? "").toUpperCase().slice(0, 28);
}

/** On-screen place names only (years handled separately). */
export function extractVoiceLabelTerms(beatText: string): VoiceLabelTerm[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  const lower = cleaned.toLowerCase();
  const out: VoiceLabelTerm[] = [];
  const seen = new Set<string>();

  for (const entry of PLACE_ENTRIES) {
    if (!entry.pattern.test(lower)) continue;
    const m = cleaned.match(entry.pattern);
    const label = spokenLabelForGeo(cleaned, entry);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label,
      searchTags: entry.searchTags,
      matchText: m?.[0]?.trim() || undefined,
    });
  }

  return out.slice(0, 2);
}

export function termStartInBeat(
  beatText: string,
  term: string,
  beatStart: number,
  beatHoldSec: number,
  matchText?: string
): number {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, "");
  for (const probe of [matchText, term].filter(Boolean) as string[]) {
    const escaped = probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    const match = re.exec(cleaned);
    if (match && match.index >= 0) {
      const pos = match.index / Math.max(1, cleaned.length);
      return beatStart + Math.max(0.08, pos * beatHoldSec * 0.92);
    }
  }
  return beatStart + 0.12;
}
