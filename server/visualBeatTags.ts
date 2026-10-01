/**
 * Extract place/keyword tags from narration for archive search + voice-synced labels.
 */
import {
  NL_GEO_SLUGS,
  US_GEO_SLUGS,
  FOREIGN_GEO_SLUGS,
  ALL_GEO_SLUGS,
  assetHayHasGeoMarkers,
  beatTextMentionsGeoSlug,
} from "./worldGeoSlugs";
import { asVideoTitleString } from "./stringCoercion";
import { normalizeMediaTags } from "./db";

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
  { pattern: /\bamerika\b|\bamerica\b|\bamerican\b|\bunited states\b|\busa\b|\bu\.s\.?(?![a-z])/i, searchTags: ["america", "usa", "united states", "american"], label: "AMERIKA" },
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
  // Netherlands / Dutch / Holland u2014 added for NL geography content
  { pattern: /\bnederland\b|\bnetherlands\b|\bdutch\b|\bholland\b|\bnederlandse\b|\bnederlanden\b/i, searchTags: ["netherlands", "amsterdam", "dutch", "holland"], label: "NEDERLAND" },
  { pattern: /\bamsterdam\b/i, searchTags: ["amsterdam", "netherlands", "dutch canal"], label: "AMSTERDAM" },
  { pattern: /\brotterdam\b/i, searchTags: ["rotterdam", "netherlands", "rotterdam skyline"], label: "ROTTERDAM" },
  { pattern: /\bden haag\b|\bthe hague\b|\bdenhaag\b/i, searchTags: ["the hague", "netherlands", "dutch government"], label: "DEN HAAG" },
  { pattern: /\butrecht\b/i, searchTags: ["utrecht", "netherlands", "dutch city"], label: "UTRECHT" },
  { pattern: /\bgracht\b|\bcanal\b|\bkanaal\b/i, searchTags: ["amsterdam canal", "dutch canal", "netherlands waterway"], label: "GRACHT" },
  { pattern: /\bfietspad\b|\bfiets\b|\bcycling lane\b|\bbike lane\b|\bcycle path\b/i, searchTags: ["dutch cycling", "netherlands bicycle", "Amsterdam bike", "cycle path"], label: "FIETSPAD" },
  { pattern: /\bwindmolen\b|\bwindmill\b|\bwindmolens\b/i, searchTags: ["windmill netherlands", "dutch windmill", "holland windmill"], label: "WINDMOLEN" },
  { pattern: /\bpolder\b|\bpolders\b/i, searchTags: ["netherlands polder", "dutch landscape", "netherlands countryside"], label: "POLDER" },
  { pattern: /\btulp\b|\btulpen\b|\btulip\b|\btulips\b/i, searchTags: ["tulip netherlands", "dutch tulip field", "holland flower"], label: "TULPEN" },
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
  {
    pattern:
      /\bauto'?s?\b|\bautoverkeer\b|\bautomobiel(?:en)?\b|\bcars?\b|\bautomobiles?\b|\bvoertuig(?:en)?\b|\bsnelweg(?:en)?\b|\btraffic jam\b|\bparkeer(?:plaats|en)?\b|\brij(?:den|dt)\b|\bdriving\b|\bautomotive\b|\bmotor(?:ist|ists)?\b|\bopstopping(?:en)?\b|\bcongestion\b/i,
    searchTags: ["car", "cars", "automobile", "traffic", "highway", "driving", "parking", "vehicle"],
  },
  {
    pattern:
      /\b(government|governments|governmental|overheid|parliament|parliaments|congress|senate|capitol|city hall|town hall|gemeentehuis|gemeente|ministerie|ministry|ministries|minister|municipal(?:ity|ities)?|bestuur|administration|regering|tweede kamer|local government)\b/i,
    searchTags: ["government", "parliament", "city hall", "capitol", "municipal", "ministry", "administration"],
  },
  {
    pattern:
      /\b(urban planning|city planning|stedenbouw|stadsplanung|stadtplanung|stedelijke planning|zoning|land use|walkable city|urban design|urbanism|infrastructure planning|ruimtelijke ordening|planologie|master plan|city development|urban development|transit oriented|mixed[- ]use|woonwijk|woningbouw|housing development|compact city)\b/i,
    searchTags: ["urban planning", "city planning", "zoning", "urban design", "infrastructure", "housing", "transit"],
  },
  {
    pattern:
      /\b(infrastructure|infrastructuur|openbare werken|public works|transport infrastructure|wegennet|road network|rail network|spoorinfrastructuur|rail infrastructure|waterbeheer|water management)\b/i,
    searchTags: ["infrastructure", "transport", "public transport", "highway", "railway", "bridge", "tram"],
  },
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
  "where", "which", "who", "there", "their", "they", "them", "would", "could", "should", "became",
  "become", "what", "just", "amidst", "own",
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

export function inferVideoVisualTopic(videoTitle?: unknown, extraText?: unknown): VideoVisualTopic {
  const hay = `${asVideoTitleString(videoTitle)} ${asVideoTitleString(extraText)}`.toLowerCase();
  if (isGeoWelcomeBeat(hay)) return "geography_urban";
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
  // Netherlands / Holland / Dutch country or geography video — treat as geography_urban
  // so WWII archive clips are blocked unless the beat itself mentions war content.
  if (
    /\b(nederland|netherlands|dutch|holland|nederlanden)\b/.test(hay) &&
    !/\b(hitler|nazi|wwii|ww2|holocaust|third reich|bezetting|occupation|world war|bezet|oorlog)\b/.test(hay)
  ) {
    return "geography_urban";
  }
  return "general";
}

/**
 * True when the beat text itself explicitly references war, WWII, or armed conflict.
 * Used to decide whether WWII archive clips are appropriate for a specific sentence,
 * even inside a geography_urban or general-topic video.
 */
export function beatMentionsWwiiContent(beatText: string): boolean {
  const lower = beatText.toLowerCase();
  return (
    WWII_WAR_ARCHIVE_RE.test(lower) ||
    /\b(oorlog|war\b|battle\b|slag\b|invasie|invasion|occupation|bezetting|soldier|soldiers|military|troepen|troops|bombing|bombardement|liberation|bevrijding|verzet|resistance|persecution|vervolging|genocide|concentration camp|concentratiekamp|bevrijdd?e|executed|geëxecuteerd)\b/i.test(lower)
  );
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

/**
 * NL→EN token translation for archive tag matching.
 * Dutch beat-text tokens won't match English archive tags without this.
 */
const NL_TO_EN_TOKENS: Record<string, string[]> = {
  // People / actions
  soldaten: ["soldiers"],
  troepen: ["troops"],
  leger: ["army", "troops"],
  officier: ["officer"],
  generaal: ["general"],
  admiraal: ["admiral"],
  piloot: ["pilot"],
  vliegenier: ["pilot", "aviator"],
  gevangenen: ["prisoners"],
  burgers: ["civilians"],
  bevolking: ["population", "civilians"],
  // War / events
  oorlog: ["war"],
  gevecht: ["battle", "combat"],
  slag: ["battle"],
  aanval: ["attack", "offensive"],
  invasie: ["invasion"],
  bezetting: ["occupation"],
  bevrijding: ["liberation"],
  bombardement: ["bombing", "bombardment"],
  bom: ["bomb"],
  explosie: ["explosion"],
  capitulatie: ["surrender", "capitulation"],
  overgave: ["surrender"],
  mars: ["march"],
  marcheert: ["march", "marching"],
  parade: ["parade"],
  optocht: ["parade", "procession"],
  toespraak: ["speech"],
  vergadering: ["meeting", "assembly"],
  rally: ["rally"],
  // Locations
  parijs: ["paris"],
  berlijn: ["berlin"],
  londen: ["london"],
  moskou: ["moscow"],
  amsterdam: ["amsterdam"],
  rotterdam: ["rotterdam"],
  brussel: ["brussels"],
  rome: ["rome"],
  warschau: ["warsaw"],
  praag: ["prague"],
  wenen: ["vienna"],
  // Objects / vehicles
  tank: ["tank"],
  tanks: ["tanks"],
  vliegtuig: ["aircraft", "airplane"],
  vliegtuigen: ["aircraft"],
  schip: ["ship", "vessel"],
  schepen: ["ships"],
  kanon: ["cannon", "artillery"],
  geweer: ["rifle", "gun"],
  // General
  stad: ["city"],
  straat: ["street"],
  haven: ["harbor", "port"],
  brug: ["bridge"],
  paleis: ["palace"],
  gebouw: ["building"],
  mensen: ["people", "crowd"],
  menigte: ["crowd"],
  leider: ["leader"],
  president: ["president"],
  minister: ["minister"],
  koning: ["king"],
  koningin: ["queen"],
  vlag: ["flag"],
  grens: ["border"],
};

/**
 * Expand beatTags with English equivalents for Dutch tokens.
 * Ensures Dutch beat text finds English-tagged archive clips.
 */
export function expandBeatTagsWithTranslations(tags: string[]): string[] {
  const extra: string[] = [];
  for (const tag of tags) {
    const translations = NL_TO_EN_TOKENS[tag.toLowerCase()];
    if (translations) extra.push(...translations);
  }
  if (extra.length === 0) return tags;
  return [...new Set([...tags, ...extra])];
}

/** Phase 10: broader English synonym/related-term expansion for common documentary topics
 *  beyond the WWII/Netherlands-specific entity tables above (PLACE_ENTRIES/ENTITY_SEARCH_ENTRIES/
 *  SCENE_SEARCH_ENTRIES already cover that domain richly) — the primary curated-archive query
 *  path otherwise only extracts literal tokens already present in the narration verbatim, with
 *  no broadening for topics like economy/technology/health/etc. Deterministic lookup table, not
 *  an LLM call, so it can't introduce hallucinated search terms — same additive-merge pattern as
 *  expandBeatTagsWithTranslations, just a different (English synonym, not translation) table. */
const GENERAL_SYNONYM_TOKENS: Record<string, string[]> = {
  economy: ["economic", "market", "finance", "trade"],
  economic: ["economy", "market", "finance"],
  market: ["economy", "trade", "stock exchange"],
  finance: ["economy", "money", "bank"],
  technology: ["tech", "innovation", "digital", "computer"],
  tech: ["technology", "innovation", "digital"],
  innovation: ["technology", "invention", "breakthrough"],
  business: ["company", "corporate", "industry"],
  company: ["business", "corporate", "office"],
  industry: ["factory", "manufacturing", "business"],
  crisis: ["emergency", "disaster", "collapse"],
  disaster: ["crisis", "catastrophe", "emergency"],
  climate: ["environment", "weather", "global warming"],
  environment: ["climate", "nature", "pollution"],
  pollution: ["environment", "smog", "waste"],
  health: ["medical", "medicine", "hospital"],
  medicine: ["health", "medical", "doctor"],
  hospital: ["medical", "health", "doctor", "nurse"],
  space: ["nasa", "rocket", "astronaut", "spacecraft"],
  science: ["research", "laboratory", "scientist"],
  research: ["science", "laboratory", "study"],
  crime: ["police", "justice", "court"],
  justice: ["court", "law", "legal"],
  law: ["justice", "court", "legal"],
  sports: ["athlete", "competition", "stadium"],
  education: ["school", "university", "classroom"],
  university: ["education", "college", "campus"],
  energy: ["power plant", "electricity", "fuel"],
  electricity: ["energy", "power grid", "power plant"],
};

/** Same additive-merge pattern as expandBeatTagsWithTranslations, English synonyms instead of
 *  Dutch→English translation. */
export function expandBeatTagsWithSynonyms(tags: string[]): string[] {
  const extra: string[] = [];
  for (const tag of tags) {
    const synonyms = GENERAL_SYNONYM_TOKENS[tag.toLowerCase()];
    if (synonyms) extra.push(...synonyms);
  }
  if (extra.length === 0) return tags;
  return [...new Set([...tags, ...extra])];
}

/** Strip war-era search bias when beat is modern/geo — not tied to video topic enum. */
export function refineVisualSearchTagsForTopic(
  tags: string[],
  topic: VideoVisualTopic,
  beatText: string
): string[] {
  const geoTags = extractBeatGeoPlaceTags(beatText);
  const modernBeat =
    geoTags.length > 0 ||
    isGeoWelcomeBeat(beatText) ||
    isUrbanPlanningBeat(beatText) ||
    isInfrastructureBeat(beatText);
  if (!modernBeat || topic === "wwii" || beatMentionsWwiiContent(beatText)) return tags;
  const lower = beatText.toLowerCase();
  const out = new Set<string>();
  for (const t of tags) {
    const tl = t.toLowerCase();
    if (GEOGRAPHY_BLOCKED_TAGS.has(tl)) continue;
    if ([...GEOGRAPHY_BLOCKED_TAGS].some((b) => tl.includes(b))) continue;
    if (tl === "germany" || tl === "german" || tl === "deutschland") continue;
    out.add(t);
  }
  // Phase 11: germany/german/deutschland tags are stripped above (war-era bias) for every
  // modern/geo beat, but unlike berlin/netherlands/america below, nothing was ever added
  // back — a beat about modern Germany (not WWII) lost its country tag entirely instead of
  // getting a modern-context replacement. Restore the same tags PLACE_ENTRIES already uses
  // for Germany (searchTags: ["germany", "german", "deutschland", "berlin"]) rather than
  // inventing new ones, so archive matching sees the same vocabulary it does everywhere else.
  if (/germany|duitsland|deutschland|\bgerman\b/.test(lower)) {
    out.add("germany");
    out.add("german");
    out.add("deutschland");
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
  if (/america|american|united states|\bu\.s\.?(?![a-z])|\busa\b/.test(lower)) {
    out.add("united states");
    out.add("american city");
    out.add("usa skyline");
  }
  if (/\b(transit|metro|subway|u-bahn|s-?bahn|trains?|trein|trams?|bus|buses|public transport|ov)\b/.test(lower)) {
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
  if (isCyclingBeat(beatText)) {
    out.add("cyclists");
    out.add("cycling");
    out.add("bicycle");
    out.add("people cycling");
    if (contextMentionsNetherlands(beatText)) {
      out.add("amsterdam cyclists");
      out.add("netherlands cycling");
    }
  }
  if (isCarBeat(beatText)) {
    out.add("car");
    out.add("cars");
    out.add("traffic");
    out.add("highway");
    out.add("driving");
    out.add("parking");
  }
  if (isGovernmentBeat(beatText)) {
    out.add("government");
    out.add("parliament");
    out.add("city hall");
    out.add("capitol");
    out.add("municipal");
    out.add("ministry");
  }
  if (isUrbanPlanningBeat(beatText)) {
    out.add("urban planning");
    out.add("city planning");
    out.add("zoning");
    out.add("urban design");
    out.add("infrastructure");
    out.add("public transport");
    out.add("bike lane");
  }
  if (isInfrastructureBeat(beatText)) {
    out.add("infrastructure");
    out.add("public transport");
    out.add("highway");
    out.add("railway");
    out.add("bridge");
    out.add("tram");
    if (contextMentionsNetherlands(beatText)) {
      out.add("netherlands infrastructure");
      out.add("dutch tram");
      out.add("cycling infrastructure");
    }
  }
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
  for (const slug of ALL_GEO_SLUGS) {
    if (beatTextMentionsGeoSlug(cleaned, slug)) tags.add(slug);
  }
  return [...tags];
}

const CYCLING_RE =
  /\b(fiets|fietsen|fietser|fietsers|wielrennen|cyclist|cyclists|cycling|bicycle|bicycles|bike lane|bike lanes|fietspad|fietspaden)\b/i;

const CAR_RE =
  /\b(auto'?s?|autoverkeer|automobiel(?:en)?|cars?|automobiles?|voertuig(?:en)?|snelweg(?:en)?|traffic jam|parkeer(?:plaats|en)?|parking lot|rij(?:den|dt)|driving|automotive|motor(?:ist|ists)?|opstopping(?:en)?|congestion)\b/i;

const GOVERNMENT_RE =
  /\b(government|governments|governmental|overheid|parliament|parliaments|congress|senate|capitol|city hall|town hall|gemeentehuis|gemeente|ministerie|ministry|ministries|minister|municipal(?:ity|ities)?|bestuur|administration|regering|tweede kamer|local government)\b/i;

const URBAN_PLANNING_RE =
  /\b(urban planning|city planning|stedenbouw|stadsplanung|stadtplanung|stedelijke planning|zoning|zoning code|land use|walkable city|urban design|urbanism|infrastructure planning|ruimtelijke ordening|planologie|master plan|city development|urban development|transit oriented|mixed[- ]use|woonwijk|woningbouw|housing development|compact city|smart city planning)\b/i;

const INFRASTRUCTURE_RE =
  /\b(infrastructure|infrastructuur|openbare werken|public works|transport infrastructure|wegennet|road network|rail network|spoorinfrastructuur|rail infrastructure|waterbeheer|water management)\b/i;

/** Narration about cycling / fietsen — needs people on bikes, not generic city shots. */
export function isCyclingBeat(beatText: string): boolean {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  return CYCLING_RE.test(cleaned);
}

export function extractBeatCyclingTags(beatText: string): string[] {
  if (!isCyclingBeat(beatText)) return [];
  return ["cycling", "cyclists", "bicycle", "bike lane", "people cycling"];
}

function contextMentionsNetherlands(...parts: Array<string | undefined>): boolean {
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return /netherlands|nederland|holland|amsterdam|dutch|rotterdam|utrecht|den haag|the hague/.test(hay);
}

/** Stock/archive queries when narration is about cycling — place + visible cyclists. */
export function buildCyclingVisualQueries(
  beatText: string,
  videoTitle?: string,
  sceneText?: string
): string[] {
  if (!isCyclingBeat(beatText)) return [];

  const geoTags = extractBeatGeoPlaceTags(beatText);
  const wantsNl =
    geoTags.some((t) => /netherlands|holland|amsterdam|dutch|nederland/.test(t)) ||
    contextMentionsNetherlands(beatText, sceneText, videoTitle);

  const queries: string[] = [];
  if (wantsNl) {
    queries.push(
      "amsterdam cyclists street",
      "netherlands people cycling",
      "dutch cyclists city traffic",
      "amsterdam bicycle commuters",
      "netherlands cycling rain street"
    );
  } else {
    queries.push("people cycling city street", "cyclists urban traffic", "bicycle commuters street");
  }

  for (const tag of geoTags.slice(0, 2)) {
    queries.push(`${tag} cyclists street`, `${tag} people cycling`);
  }

  return [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 10);
}

export function assetShowsCycling(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">
): boolean {
  const hay = `${(asset.title ?? "").toLowerCase()} ${(asset.tags ?? []).join(" ").toLowerCase()}`;
  return /\b(cyclists?|cycling|bicycles?|bikes?|fiets(?:en|er|ers)?|fietspad(?:en)?)\b/.test(hay);
}

/** Narration about cars / auto's — needs visible automobiles, not generic skyline. */
export function isCarBeat(beatText: string): boolean {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  if (!cleaned) return false;
  return CAR_RE.test(cleaned);
}

export function extractBeatCarTags(beatText: string): string[] {
  if (!isCarBeat(beatText)) return [];
  return ["car", "cars", "automobile", "traffic", "highway", "driving", "parking", "vehicle"];
}

/** Stock/archive queries when narration is about cars — place + visible traffic/automobiles. */
export function buildCarVisualQueries(
  beatText: string,
  videoTitle?: string,
  sceneText?: string
): string[] {
  if (!isCarBeat(beatText)) return [];

  const geoTags = extractBeatGeoPlaceTags(beatText);
  const context = `${beatText} ${sceneText ?? ""} ${asVideoTitleString(videoTitle)}`.toLowerCase();
  const wantsUs =
    geoTags.some((t) => /america|usa|united states|american/.test(t)) ||
    /\bamerica|american|united states|\bu\.s\.?(?![a-z])|\busa\b/.test(context);
  const wantsNl =
    geoTags.some((t) => /netherlands|holland|amsterdam|dutch|nederland/.test(t)) ||
    contextMentionsNetherlands(beatText, sceneText, videoTitle);

  const queries: string[] = [];
  if (wantsUs) {
    queries.push(
      "american highway traffic cars",
      "usa city traffic jam",
      "united states cars freeway",
      "american parking lot cars",
      "usa downtown traffic driving"
    );
  }
  if (wantsNl) {
    queries.push(
      "netherlands highway traffic cars",
      "dutch cars street traffic",
      "amsterdam traffic cars driving",
      "netherlands parking lot cars"
    );
  }

  queries.push(
    "cars city traffic street",
    "automobile highway driving",
    "traffic jam cars urban",
    "parking lot cars aerial"
  );

  for (const tag of geoTags.slice(0, 2)) {
    queries.push(`${tag} cars traffic`, `${tag} highway driving`);
  }

  return [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 10);
}

export function assetShowsCars(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">
): boolean {
  const hay = assetHay(asset);
  return /\b(cars?|automobiles?|automotive|traffic|highway|motorway|freeway|snelweg|driving|dashcam|parking|vehicles?|voertuig(?:en)?|auto(?:s|'s)?|congestion|opstopping)\b/.test(
    hay
  );
}

/** Narration about government / overheid — needs parliament, city hall, capitol… */
export function isGovernmentBeat(beatText: string): boolean {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  if (!cleaned) return false;
  return GOVERNMENT_RE.test(cleaned);
}

export function extractBeatGovernmentTags(beatText: string): string[] {
  if (!isGovernmentBeat(beatText)) return [];
  return ["government", "parliament", "city hall", "capitol", "municipal", "ministry", "administration"];
}

/** Stock/archive queries when narration is about government. */
export function buildGovernmentVisualQueries(
  beatText: string,
  videoTitle?: string,
  sceneText?: string
): string[] {
  if (!isGovernmentBeat(beatText)) return [];

  const geoTags = extractBeatGeoPlaceTags(beatText);
  const context = `${beatText} ${sceneText ?? ""} ${asVideoTitleString(videoTitle)}`.toLowerCase();
  const wantsUs =
    geoTags.some((t) => /america|usa|united states|american/.test(t)) ||
    /\bamerica|american|united states|\bu\.s\.?(?![a-z])|\busa\b/.test(context);
  const wantsNl =
    geoTags.some((t) => /netherlands|holland|amsterdam|dutch|nederland/.test(t)) ||
    contextMentionsNetherlands(beatText, sceneText, videoTitle);

  const queries: string[] = [];
  if (wantsUs) {
    queries.push(
      "us capitol building washington",
      "congress building exterior",
      "american city hall government",
      "state capitol building",
      "usa government building facade"
    );
  }
  if (wantsNl) {
    queries.push(
      "dutch parliament den haag",
      "gemeentehuis netherlands",
      "tweede kamer den haag",
      "netherlands government building",
      "dutch city hall municipal"
    );
  }

  queries.push(
    "government building city hall",
    "parliament building exterior",
    "municipal city hall facade",
    "capitol government architecture"
  );

  for (const tag of geoTags.slice(0, 2)) {
    queries.push(`${tag} government building`, `${tag} city hall parliament`);
  }

  return [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 10);
}

export function assetShowsGovernment(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">
): boolean {
  const hay = assetHay(asset);
  return /\b(government|parliament|congress|capitol|city hall|town hall|gemeentehuis|ministerie|ministry|municipal|overheid|regering|senate|assembly|bestuur|tweede kamer|binnenhof|rijksgebouw)\b/.test(
    hay
  );
}

/** Narration about roads, rail, bridges, public transport — not generic city shots. */
export function isInfrastructureBeat(beatText: string): boolean {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  if (!cleaned) return false;
  if (isUrbanPlanningBeat(beatText)) return false;
  return INFRASTRUCTURE_RE.test(cleaned);
}

export function extractBeatInfrastructureTags(beatText: string): string[] {
  if (!isInfrastructureBeat(beatText)) return [];
  return [
    "infrastructure",
    "public transport",
    "highway",
    "railway",
    "bridge",
    "tram",
    "train",
    "transit",
    "canal",
  ];
}

/** Stock/archive queries when narration is about infrastructure. */
export function buildInfrastructureVisualQueries(
  beatText: string,
  videoTitle?: string,
  sceneText?: string
): string[] {
  if (!isInfrastructureBeat(beatText)) return [];

  const geoTags = extractBeatGeoPlaceTags(beatText);
  const context = `${beatText} ${sceneText ?? ""} ${asVideoTitleString(videoTitle)}`.toLowerCase();
  const wantsUs =
    geoTags.some((t) => /america|usa|united states|american/.test(t)) ||
    /\bamerica|american|united states|\bu\.s\.?(?![a-z])|\busa\b/.test(context);
  const wantsNl =
    geoTags.some((t) => /netherlands|holland|amsterdam|dutch|nederland/.test(t)) ||
    contextMentionsNetherlands(beatText, sceneText, videoTitle);

  const queries: string[] = [];
  if (wantsNl) {
    queries.push(
      "netherlands infrastructure aerial",
      "dutch highway interchange drone",
      "netherlands train railway",
      "amsterdam tram public transport",
      "netherlands cycling infrastructure",
      "rotterdam port infrastructure",
      "dutch bridge canal",
      "netherlands public transport metro"
    );
  }
  if (wantsUs) {
    queries.push(
      "american highway infrastructure aerial",
      "usa bridge infrastructure",
      "united states railway train",
      "american public transport subway"
    );
  }

  queries.push(
    "city infrastructure aerial",
    "highway interchange drone",
    "train railway public transport",
    "bridge urban infrastructure",
    "tram metro city street"
  );

  for (const tag of geoTags.slice(0, 2)) {
    queries.push(`${tag} infrastructure`, `${tag} public transport railway`);
  }

  return [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 10);
}

export function assetShowsInfrastructure(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">,
  beatText?: string
): boolean {
  const hay = assetHay(asset);
  if (
    /\b(infrastructure|infrastructuur|highway|motorway|snelweg|interchange|viaduct|overpass|bridge|brug|tunnel|railway|railroad|train|spoor|tram|metro|public transport|openbaar vervoer|fietspad|bike lane|canal|harbor|harbour|port|airport|dike|dijk|polder)\b/.test(
      hay
    )
  ) {
    return true;
  }
  if (beatText && contextMentionsNetherlands(beatText)) {
    const hasNl = /\b(netherlands|holland|amsterdam|dutch|nederland|rotterdam|utrecht)\b/.test(hay);
    const hasInfraFabric =
      /\b(tram|train|cycling|bike|canal|highway|bridge|port|metro|transit|road|aerial|rail)\b/.test(hay);
    if (hasNl && hasInfraFabric) return true;
  }
  return /\b(tram|metro|train|railway|highway|bridge|port|transit|public transport)\b/.test(hay);
}

/** Narration about urban planning / stedenbouw — needs planning, transit, housing design… */
export function isUrbanPlanningBeat(beatText: string): boolean {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  if (!cleaned) return false;
  return URBAN_PLANNING_RE.test(cleaned);
}

export function extractBeatUrbanPlanningTags(beatText: string): string[] {
  if (!isUrbanPlanningBeat(beatText)) return [];
  return [
    "urban planning",
    "city planning",
    "zoning",
    "urban design",
    "infrastructure",
    "housing",
    "transit",
    "bike lane",
    "public transport",
  ];
}

/** Stock/archive queries when narration is about urban planning. */
export function buildUrbanPlanningVisualQueries(
  beatText: string,
  videoTitle?: string,
  sceneText?: string
): string[] {
  if (!isUrbanPlanningBeat(beatText)) return [];

  const geoTags = extractBeatGeoPlaceTags(beatText);
  const context = `${beatText} ${sceneText ?? ""} ${asVideoTitleString(videoTitle)}`.toLowerCase();
  const wantsUs =
    geoTags.some((t) => /america|usa|united states|american/.test(t)) ||
    /\bamerica|american|united states|\bu\.s\.?(?![a-z])|\busa\b/.test(context);
  const wantsNl =
    geoTags.some((t) => /netherlands|holland|amsterdam|dutch|nederland/.test(t)) ||
    contextMentionsNetherlands(beatText, sceneText, videoTitle);

  const queries: string[] = [];
  if (wantsNl) {
    queries.push(
      "netherlands urban planning aerial",
      "amsterdam city planning bike lanes",
      "dutch urban design street tram",
      "rotterdam modern architecture city",
      "netherlands cycling infrastructure planning",
      "amsterdam canal city planning timelapse"
    );
  }
  if (wantsUs) {
    queries.push(
      "american suburban sprawl aerial",
      "usa urban planning city zoning",
      "united states highway urban sprawl",
      "american city downtown planning"
    );
  }

  queries.push(
    "urban planning city aerial",
    "city master plan model",
    "modern apartment blocks city",
    "bike lane city planning street",
    "public transport urban city"
  );

  for (const tag of geoTags.slice(0, 2)) {
    queries.push(`${tag} urban planning city`, `${tag} city planning infrastructure`);
  }

  return [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 10);
}

export function assetShowsUrbanPlanning(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">,
  beatText?: string
): boolean {
  const hay = assetHay(asset);
  if (
    /\b(urban planning|city planning|stedenbouw|zoning|urban design|urbanism|infrastructure|master plan|mixed use|planning|compact city|architect)\b/.test(
      hay
    )
  ) {
    return true;
  }
  if (beatText && contextMentionsNetherlands(beatText)) {
    const hasNl = /\b(netherlands|holland|amsterdam|dutch|nederland|rotterdam|utrecht)\b/.test(hay);
    const hasUrbanFabric =
      /\b(bike lane|fietspad|cycl|tram|metro|transit|apartment|housing|infrastructure|aerial city|skyline|urban|canal|modern)\b/.test(
        hay
      );
    if (hasNl && hasUrbanFabric) return true;
  }
  return /\b(bike lane|fietspad|transit|tram|metro|apartment|housing|infrastructure|aerial city|public transport)\b/.test(
    hay
  );
}

const GEO_WELCOME_RE =
  /\b(welcome|welkom)\b(?:\s+\w+){0,3}\s+\b(to|naar|in)\b|\b(welkom|welcome)\s+(in|naar)\b/i;

/** Intro line naming a country/city — opening B-roll should be video, not a Ken Burns still. */
export function isGeoWelcomeBeat(beatText: string): boolean {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  if (!cleaned) return false;
  if (!GEO_WELCOME_RE.test(cleaned)) return false;
  return extractBeatGeoPlaceTags(cleaned).length > 0;
}

/** Stock/archive queries for "Welcome to {place}" — video B-roll (drone, timelapse, city footage). */
function extractBeatPercentStat(beatText: string): { displayText: string; matchText: string } | null {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  const m = cleaned.match(/(\d[\d,.]*\s*(?:%|percent|procent))/i);
  if (!m?.[1]) return null;
  const raw = m[1].trim();
  const numStr = raw.match(/[\d,.]+/)?.[0]?.replace(",", ".");
  if (!numStr) return null;
  const n = parseFloat(numStr);
  if (Number.isNaN(n)) return null;
  const displayText = raw.includes("%") ? `${n}%` : `${n}%`;
  return { displayText, matchText: m[1].trim() };
}

export type GeoStatBeatInfo = {
  geoTags: string[];
  statLabel: string;
  statMatchText: string;
};

/** Beat names a place and a percentage (e.g. "America 1%") — show geo B-roll + stat on screen. */
export function extractGeoStatFromBeat(beatText: string): GeoStatBeatInfo | null {
  const geoTags = extractBeatGeoPlaceTags(beatText);
  if (geoTags.length === 0) return null;
  const stat = extractBeatPercentStat(beatText);
  if (!stat) return null;
  return {
    geoTags,
    statLabel: stat.displayText,
    statMatchText: stat.matchText,
  };
}

export function isGeoStatBeat(beatText: string): boolean {
  return extractGeoStatFromBeat(beatText) !== null;
}

export function buildGeoWelcomeVisualQueries(beatText: string): string[] {
  const geoTags = extractBeatGeoPlaceTags(beatText);
  const queries: string[] = [];
  const lower = beatText.toLowerCase();

  const wantsNl = geoTags.some((t) =>
    /netherlands|holland|amsterdam|dutch|nederland|rotterdam|utrecht|hague|den haag/.test(t)
  );
  const wantsUs = geoTags.some((t) => /america|usa|united states|american/.test(t));

  if (wantsNl) {
    queries.push(
      "netherlands aerial drone video",
      "amsterdam canal timelapse",
      "netherlands city broll",
      "dutch cycling street video"
    );
  }
  if (wantsUs) {
    queries.push("united states city aerial video", "american skyline timelapse");
  }
  if (/berlin|berlijn/i.test(lower) || geoTags.includes("berlin")) {
    queries.push("berlin city aerial video", "berlin skyline timelapse");
  }

  for (const tag of geoTags.slice(0, 3)) {
    queries.push(`${tag} aerial city video`, `${tag} skyline timelapse`);
  }

  return [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 10);
}

function slugSetIncludes(slugs: string[], markers: readonly string[]): boolean {
  return slugs.some((s) => markers.some((m) => s === m || s.includes(m) || m.includes(s)));
}

function assetHay(asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">): string {
  return `${(asset.title ?? "").toLowerCase()} ${effectiveArchiveAssetTags(asset).join(" ").toLowerCase()}`;
}

function assetHayHasMarkers(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">,
  markers: readonly string[]
): boolean {
  return assetHayHasGeoMarkers(asset, markers);
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
  const hasForeign = assetHayHasMarkers(asset, FOREIGN_GEO_SLUGS);
  const nlSpecificTags = requiredGeoTags.filter((t) =>
    NL_GEO_SLUGS.some((nl) => t === nl || t.includes(nl) || nl.includes(t))
  );
  const nlGeoHits = nlSpecificTags.length > 0 ? geoTagHitCount(asset, nlSpecificTags) : geoTagHitCount(asset, requiredGeoTags);
  const geoHits = geoTagHitCount(asset, requiredGeoTags);

  if (needsNl && !needsUs) {
    if (hasForeign && !hasNl) return true;
    if (hasUs && !hasNl) return true;
    if (!hasNl && nlGeoHits === 0) return true;
    return false;
  }
  if (needsUs && !needsNl) {
    if (hasForeign && !hasUs && !hasNl) return true;
    if (hasNl && !hasUs) return true;
    if (!hasUs && geoHits === 0) return true;
    return false;
  }
  if (needsNl && needsUs) {
    return geoHits === 0;
  }
  const needsForeignOnly =
    requiredGeoTags.some((t) => slugSetIncludes([t], FOREIGN_GEO_SLUGS)) &&
    !needsNl &&
    !needsUs;
  if (needsForeignOnly) {
    if ((hasUs || hasNl) && geoHits === 0) return true;
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
  const assetTags = effectiveArchiveAssetTags(asset).map((t) => t.toLowerCase());
  let hits = 0;
  for (const vt of visualTags) {
    if (title.includes(vt)) hits += 2;
    for (const t of assetTags) {
      if (t === vt || t.includes(vt) || vt.includes(t)) hits++;
    }
  }
  return hits;
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

/**
 * Highest-confidence anchor: a beat that names both a specific person/entity
 * (Hitler, Eva Braun, Stalin…) AND a specific scene/setting (bunker, rally,
 * surrender…) from the WWII tag tables. Exposed separately so callers can
 * short-circuit generic single-keyword hint tables (e.g. a bare "Berlin" ->
 * "berlin city skyline" hint) that would otherwise outrank this more specific,
 * beat-level match.
 */
export function extractEntitySceneAnchor(beatText: string): string | null {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const scenes = collectTagsFromEntries(cleaned, SCENE_SEARCH_ENTRIES);
  const entities = collectTagsFromEntries(cleaned, ENTITY_SEARCH_ENTRIES);
  if (entities.length > 0 && scenes.length > 0) {
    return `${entities[0]} ${scenes[0]}`;
  }
  return null;
}

export function extractPrimaryVisualAnchor(beatText: string): string | null {
  const entityScene = extractEntitySceneAnchor(beatText);
  if (entityScene) return entityScene;
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const scenes = collectTagsFromEntries(cleaned, SCENE_SEARCH_ENTRIES);
  const entities = collectTagsFromEntries(cleaned, ENTITY_SEARCH_ENTRIES);
  if (isGeoStatBeat(beatText)) {
    const geo = extractPrimaryGeoSearchTag(beatText);
    if (geo && /america|usa|united states|american/.test(geo)) return "united states city skyline";
    if (geo) return `${geo} city skyline`;
    return "city skyline";
  }
  if (isInfrastructureBeat(beatText)) {
    const geo = extractPrimaryGeoSearchTag(beatText);
    if (geo && /netherlands|holland|amsterdam|dutch|nederland/.test(geo)) {
      return "netherlands infrastructure aerial";
    }
    if (geo && /america|usa|united states|american/.test(geo)) return "american highway infrastructure";
    if (geo) return `${geo} infrastructure`;
    return "city infrastructure aerial";
  }
  if (isUrbanPlanningBeat(beatText)) {
    const geo = extractPrimaryGeoSearchTag(beatText);
    if (geo && /netherlands|holland|amsterdam|dutch|nederland/.test(geo)) {
      return "netherlands urban planning aerial";
    }
    if (geo && /america|usa|united states|american/.test(geo)) return "american urban planning suburban";
    if (geo) return `${geo} urban planning city`;
    return "urban planning city aerial";
  }
  if (isCarBeat(beatText)) {
    const geo = extractPrimaryGeoSearchTag(beatText);
    if (geo && /america|usa|united states|american/.test(geo)) return "american highway traffic cars";
    if (geo && /netherlands|holland|amsterdam|dutch|nederland/.test(geo)) return "netherlands cars traffic";
    if (geo) return `${geo} cars traffic`;
    return "cars city traffic";
  }
  if (isGovernmentBeat(beatText)) {
    const geo = extractPrimaryGeoSearchTag(beatText);
    if (geo && /america|usa|united states|american/.test(geo)) return "us capitol government building";
    if (geo && /netherlands|holland|amsterdam|dutch|nederland/.test(geo)) return "dutch parliament den haag";
    if (geo) return `${geo} government building`;
    return "government building city hall";
  }
  if (isCyclingBeat(beatText)) {
    const geo = extractPrimaryGeoSearchTag(beatText);
    const place =
      geo && /netherlands|holland|amsterdam|dutch|nederland/.test(geo) ? "amsterdam" : geo;
    if (place) return `${place} cyclists`;
    return "people cycling street";
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

/** Infer searchable geo/subject tags from clip title when metadata tags are sparse. */
export function inferArchiveAssetTagsFromTitle(
  asset: { title?: string | null; tags?: string[] | null }
): string[] {
  const title = (asset.title ?? "").trim();
  if (!title) return [];
  return normalizeMediaTags([
    ...extractBeatGeoPlaceTags(title),
    ...extractVisualSearchTags(title),
    ...extractBeatCyclingTags(title),
    ...extractBeatInfrastructureTags(title),
  ]);
}

/** Tags used for archive matching — stored tags plus title-inferred geo/subject tokens. */
export function effectiveArchiveAssetTags(
  asset: { title?: string | null; tags?: string[] | null }
): string[] {
  return normalizeMediaTags([
    ...normalizeMediaTags(asset.tags ?? []),
    ...inferArchiveAssetTagsFromTitle(asset),
  ]);
}
