/**
 * Rule-based visual fallback intents for Dutch/English narration.
 * Used whenever LLM intent is missing or weak — every sentence gets searchable English B-roll.
 */

export type VisualFallbackHint = {
  re: RegExp;
  primary: string;
  visual_intent: string;
  scene_type: string;
  priority_subject: string;
  secondary?: string;
  fallback?: string;
};

/** Ordered most-specific first — first match wins. */
export const VISUAL_FALLBACK_HINTS: VisualFallbackHint[] = [
  // ── Geography / Netherlands documentaries ──
  {
    re: /\b(welkom|welcome)\b.{0,40}\b(nederland|netherlands|holland)\b|\b(nederland|netherlands|holland)\b.{0,40}\b(welkom|welcome)\b/i,
    primary: "netherlands aerial drone video",
    visual_intent: "aerial drone shot over dutch landscape and cities",
    scene_type: "aerial",
    priority_subject: "netherlands",
    secondary: "amsterdam canal timelapse",
    fallback: "dutch countryside aerial",
  },
  {
    re: /\b(infrastructuur|infrastructure)\b.{0,50}\b(nederland|netherlands|holland|dutch)\b|\b(nederland|netherlands|holland|dutch)\b.{0,50}\b(infrastructuur|infrastructure)\b/i,
    primary: "netherlands infrastructure aerial",
    visual_intent: "dutch highways trains and cycling infrastructure from above",
    scene_type: "transport",
    priority_subject: "infrastructure",
    secondary: "netherlands train railway",
    fallback: "dutch highway interchange",
  },
  {
    re: /\b(infrastructuur|infrastructure|wegennet|spoor)\b/i,
    primary: "city infrastructure aerial",
    visual_intent: "modern urban infrastructure roads and transit",
    scene_type: "transport",
    priority_subject: "infrastructure",
    secondary: "highway interchange drone",
    fallback: "urban transport network",
  },
  {
    re: /\b(stedenbouw|urban planning|city planning|zoning|ruimtelijke ordening)\b.{0,40}\b(nederland|netherlands|holland|amsterdam|dutch)\b|\b(nederland|netherlands|holland|amsterdam|dutch)\b.{0,40}\b(stedenbouw|urban planning|planning)\b/i,
    primary: "netherlands urban planning aerial",
    visual_intent: "dutch city planning with bike lanes and trams",
    scene_type: "city",
    priority_subject: "amsterdam",
    secondary: "amsterdam city planning bike lanes",
    fallback: "dutch urban design street",
  },
  {
    re: /\b(stedenbouw|urban planning|city planning|zoning)\b/i,
    primary: "urban planning city aerial",
    visual_intent: "city master plan and urban street design",
    scene_type: "city",
    priority_subject: "city",
    secondary: "city planning model",
    fallback: "modern city aerial",
  },
  {
    re: /\b(fiets|fietsen|fietser|fietsers|fietspad|cyclist|cyclists|cycling|bicycle)\b.{0,40}\b(nederland|netherlands|holland|amsterdam|dutch)\b|\b(nederland|netherlands|holland|amsterdam|dutch)\b.{0,40}\b(fiets|fietsen|cycl)\b/i,
    primary: "amsterdam cyclists street",
    visual_intent: "people cycling through amsterdam streets",
    scene_type: "street",
    priority_subject: "cyclists",
    secondary: "netherlands cycling infrastructure",
    fallback: "dutch bike lane traffic",
  },
  {
    re: /\b(fiets|fietsen|fietser|fietsers|fietspad|cyclist|cyclists|cycling|bicycle|bike lane)\b/i,
    primary: "people cycling city street",
    visual_intent: "cyclists riding in urban bike lane",
    scene_type: "street",
    priority_subject: "cyclists",
    secondary: "bike lane city traffic",
    fallback: "urban cycling street",
  },
  {
    re: /\b(nederland|netherlands|holland|amsterdam|dutch|nederlands)\b/i,
    primary: "amsterdam canal netherlands",
    visual_intent: "amsterdam canals bikes and dutch city life",
    scene_type: "city",
    priority_subject: "amsterdam",
    secondary: "netherlands aerial drone",
    fallback: "dutch city street tram",
  },
  {
    re: /\b(amerika|america|american|united states|\bu\.?s\.?\b|usa)\b.{0,30}\b(\d[\d,.]*\s*(?:%|percent|procent))\b|\b(\d[\d,.]*\s*(?:%|percent|procent))\b.{0,30}\b(amerika|america|american|usa)\b/i,
    primary: "american city skyline aerial",
    visual_intent: "united states city skyline establishing shot",
    scene_type: "city",
    priority_subject: "america",
    secondary: "usa downtown drone",
    fallback: "american urban street",
  },
  {
    re: /\b(amerika|america|american|united states|\bu\.?s\.?\b|usa)\b.{0,40}\b(auto|car|cars|driving|highway|traffic)\b|\b(auto|car|cars|driving|highway)\b.{0,40}\b(amerika|america|american|usa)\b/i,
    primary: "american highway traffic cars",
    visual_intent: "cars driving on american highway",
    scene_type: "transport",
    priority_subject: "cars",
    secondary: "usa freeway traffic jam",
    fallback: "american suburban driving",
  },
  {
    re: /\b(amerika|america|american|united states|\bu\.?s\.?\b|usa)\b/i,
    primary: "american city skyline",
    visual_intent: "united states downtown skyline and streets",
    scene_type: "city",
    priority_subject: "america",
    secondary: "usa urban street traffic",
    fallback: "american downtown aerial",
  },
  {
    re: /\b(auto'?s?|autoverkeer|cars?|automobiles?|snelweg|highway|motorway|traffic jam|driving)\b/i,
    primary: "cars city traffic street",
    visual_intent: "cars and traffic on urban road",
    scene_type: "transport",
    priority_subject: "cars",
    secondary: "highway traffic aerial",
    fallback: "urban driving commute",
  },
  {
    re: /\b(overheid|government|parliament|regering|gemeente|capitol|tweede kamer|city hall)\b/i,
    primary: "government building city hall",
    visual_intent: "parliament or city hall government building exterior",
    scene_type: "government",
    priority_subject: "government",
    secondary: "parliament building facade",
    fallback: "municipal city hall",
  },
  {
    re: /\b(berlijn|berlin)\b/i,
    primary: "berlin city skyline",
    visual_intent: "berlin urban skyline and public transport",
    scene_type: "city",
    priority_subject: "berlin",
    secondary: "berlin public transport",
    fallback: "germany capital aerial",
  },

  // ── Business / office (Dutch + English) ──
  {
    re: /\bondernemer|\bondernemers\b|\bentrepreneur|\bentrepreneurs\b/i,
    primary: "entrepreneur working laptop",
    visual_intent: "entrepreneur working late at laptop in office",
    scene_type: "office",
    priority_subject: "entrepreneur",
    secondary: "office worker overwhelmed",
    fallback: "busy business owner",
  },
  {
    re: /\bhandmatig\s+werk|manual\s+work|repetitive\s+tasks?\b/i,
    primary: "office paperwork computer",
    visual_intent: "person doing repetitive office work at desk",
    scene_type: "office",
    priority_subject: "worker",
    secondary: "busy office worker",
    fallback: "office desk typing",
  },
  {
    re: /\badministrat(?:ie|ief)|paperwork|paper\s+work\b/i,
    primary: "office paperwork desk",
    visual_intent: "stack of paperwork and person at office desk",
    scene_type: "office",
    priority_subject: "paperwork",
    secondary: "office worker documents",
    fallback: "business office desk",
  },
  {
    re: /\bwebshop|webwinkel|e-?commerce|online\s+(winkel|shop|store)\b/i,
    primary: "online shopping laptop",
    visual_intent: "person running online shop on laptop",
    scene_type: "office",
    priority_subject: "laptop",
    secondary: "ecommerce packaging boxes",
    fallback: "entrepreneur working laptop",
  },
  {
    re: /\bklant(?:en)?|\bcustomers?\b/i,
    primary: "customer shopping smartphone",
    visual_intent: "customer browsing products on smartphone",
    scene_type: "retail",
    priority_subject: "customer",
    secondary: "online shopping smartphone",
    fallback: "retail customer browsing",
  },
  {
    re: /\bteam\b|\bvergadering\b|\bmeeting\b|\bconference\b|\boverleg\b/i,
    primary: "business meeting team",
    visual_intent: "team discussing results in office meeting room",
    scene_type: "office",
    priority_subject: "team",
    secondary: "office conference table",
    fallback: "corporate meeting room",
  },
  {
    re: /\b(laptop|computer|typing|typen|achter\s+de\s+computer)\b/i,
    primary: "person typing laptop office",
    visual_intent: "person working on laptop at office desk",
    scene_type: "office",
    priority_subject: "laptop",
    secondary: "office worker computer",
    fallback: "modern office desk",
  },
  {
    re: /\b(kantoor|office|werkplek|workspace)\b/i,
    primary: "modern office workspace",
    visual_intent: "modern open office with people working",
    scene_type: "office",
    priority_subject: "office",
    secondary: "coworking space people",
    fallback: "business office interior",
  },
  {
    re: /\b(verkopen|sales|verkoop|omzet|revenue)\b/i,
    primary: "business sales presentation",
    visual_intent: "sales professional presenting to client",
    scene_type: "office",
    priority_subject: "sales",
    secondary: "handshake business deal",
    fallback: "business meeting client",
  },
  {
    re: /\b(marketing|reclame|advertentie|social media)\b/i,
    primary: "social media marketing phone",
    visual_intent: "marketer checking social media on phone",
    scene_type: "office",
    priority_subject: "marketing",
    secondary: "content creator smartphone",
    fallback: "digital marketing workspace",
  },
  {
    re: /\b(winst|profit|verdienen|earning|inkomen|income)\b/i,
    primary: "business success handshake",
    visual_intent: "business partners closing successful deal",
    scene_type: "office",
    priority_subject: "business",
    secondary: "entrepreneur celebrating office",
    fallback: "professional handshake meeting",
  },
  {
    re: /\b(groeien|groei|growth|scaling|schaal)\b/i,
    primary: "growing business team office",
    visual_intent: "busy growing startup team in modern office",
    scene_type: "office",
    priority_subject: "team",
    secondary: "startup office collaboration",
    fallback: "business team meeting",
  },
  {
    re: /\b(strategie|strategy|planning|roadmap)\b/i,
    primary: "business strategy whiteboard",
    visual_intent: "team planning strategy at whiteboard",
    scene_type: "office",
    priority_subject: "whiteboard",
    secondary: "business planning meeting",
    fallback: "office team discussion",
  },
  {
    re: /\b(bedrijf|bedrijven|company|companies|startup|startups)\b/i,
    primary: "startup office team working",
    visual_intent: "startup team working together in office",
    scene_type: "office",
    priority_subject: "startup",
    secondary: "modern office coworkers",
    fallback: "business office workers",
  },
  {
    re: /\b(werk(?:en)?|working|employee|medewerker|personeel)\b/i,
    primary: "office workers desk",
    visual_intent: "employees working at desks in office",
    scene_type: "office",
    priority_subject: "workers",
    secondary: "people working office",
    fallback: "modern workplace broll",
  },

  // ── Transport / public life ──
  {
    re: /\b(trein|treinen|spoor|railway|train|metro|subway|tram|ov\b|openbaar vervoer|public transport)\b/i,
    primary: "train public transport station",
    visual_intent: "commuters and trains at modern transit station",
    scene_type: "transport",
    priority_subject: "train",
    secondary: "metro subway platform",
    fallback: "urban public transport",
  },
  {
    re: /\b(vliegveld|airport|vliegtuig|airplane|aircraft)\b/i,
    primary: "airport terminal passengers",
    visual_intent: "busy airport terminal with travelers",
    scene_type: "transport",
    priority_subject: "airport",
    secondary: "airplane takeoff runway",
    fallback: "air travel terminal",
  },
  {
    re: /\b(haven|harbor|harbour|port|schepen|ships|cargo)\b/i,
    primary: "shipping port containers",
    visual_intent: "industrial shipping port with cranes and containers",
    scene_type: "transport",
    priority_subject: "port",
    secondary: "cargo ship harbor",
    fallback: "logistics port aerial",
  },

  // ── General documentary ──
  {
    re: /\b(stad|city|cities|urban|skyline|downtown)\b/i,
    primary: "city skyline aerial",
    visual_intent: "urban skyline and city streets from above",
    scene_type: "city",
    priority_subject: "city",
    secondary: "downtown street timelapse",
    fallback: "modern urban broll",
  },
  {
    re: /\b(mensen|people|crowd|massa|publiek|public)\b/i,
    primary: "people walking city street",
    visual_intent: "crowd of people walking on busy city street",
    scene_type: "street",
    priority_subject: "people",
    secondary: "pedestrians urban crosswalk",
    fallback: "busy street crowd",
  },
  {
    re: /\b(natuur|nature|bos|forest|zee|ocean|strand|beach)\b/i,
    primary: "nature landscape aerial",
    visual_intent: "scenic natural landscape wide shot",
    scene_type: "nature",
    priority_subject: "landscape",
    secondary: "forest trees sunlight",
    fallback: "nature documentary broll",
  },
  {
    re: /\b(school|university|student|onderwijs|education|college)\b/i,
    primary: "university campus students",
    visual_intent: "students walking on university campus",
    scene_type: "education",
    priority_subject: "students",
    secondary: "classroom lecture hall",
    fallback: "education campus broll",
  },
  {
    re: /\b(ziekenhuis|hospital|arts|doctor|medical|gezondheid|health)\b/i,
    primary: "hospital medical staff",
    visual_intent: "doctors and nurses in modern hospital",
    scene_type: "medical",
    priority_subject: "hospital",
    secondary: "medical examination room",
    fallback: "healthcare professional working",
  },
  {
    re: /\b(fabriek|factory|productie|production|magazijn|warehouse)\b/i,
    primary: "factory production line",
    visual_intent: "industrial factory with workers and machinery",
    scene_type: "factory",
    priority_subject: "factory",
    secondary: "warehouse logistics workers",
    fallback: "manufacturing assembly line",
  },
  {
    re: /\b(restaurant|café|cafe|kitchen|keuken|chef|koken|cooking)\b/i,
    primary: "restaurant kitchen chef cooking",
    visual_intent: "chef preparing food in restaurant kitchen",
    scene_type: "restaurant",
    priority_subject: "chef",
    secondary: "restaurant dining customers",
    fallback: "food preparation kitchen",
  },
  {
    re: /\b(thuis|home|woonkamer|living room|gezin|family)\b/i,
    primary: "family home living room",
    visual_intent: "people relaxing in cozy home living room",
    scene_type: "home",
    priority_subject: "family",
    secondary: "home interior daily life",
    fallback: "domestic home scene",
  },
  {
    re: /\b(sport|sports|voetbal|football|training|athlete|atleet)\b/i,
    primary: "athletes training stadium",
    visual_intent: "athletes training or competing in stadium",
    scene_type: "sports",
    priority_subject: "athletes",
    secondary: "sports team practice",
    fallback: "fitness workout gym",
  },
  {
    re: /\b(technologie|technology|software|app|digital|ai\b|artificial intelligence)\b/i,
    primary: "technology office screens",
    visual_intent: "modern technology workspace with screens and code",
    scene_type: "technology",
    priority_subject: "technology",
    secondary: "programmer coding laptop",
    fallback: "digital workspace broll",
  },
];

/** Dutch → English tokens for last-resort keyword building. */
export const DUTCH_VISUAL_NOUNS: Record<string, string> = {
  ondernemer: "entrepreneur",
  ondernemers: "entrepreneurs",
  ondernemerschap: "entrepreneurship",
  klant: "customer",
  klanten: "customers",
  medewerker: "employee",
  medewerkers: "employees",
  werknemer: "worker",
  werknemers: "workers",
  team: "team",
  vergadering: "meeting",
  kantoor: "office",
  laptop: "laptop",
  computer: "computer",
  webshop: "online shop",
  webwinkel: "online store",
  fiets: "bicycle",
  fietsen: "cycling",
  fietser: "cyclist",
  fietsers: "cyclists",
  auto: "car",
  autos: "cars",
  snelweg: "highway",
  trein: "train",
  treinen: "trains",
  tram: "tram",
  metro: "metro",
  stad: "city",
  steden: "cities",
  nederland: "netherlands",
  holland: "holland",
  amsterdam: "amsterdam",
  amerika: "america",
  infrastructuur: "infrastructure",
  overheid: "government",
  stedenbouw: "urban planning",
  mensen: "people",
  kind: "child",
  kinderen: "children",
  gezin: "family",
  huis: "home",
  fabriek: "factory",
  haven: "port",
  luchthaven: "airport",
  vliegveld: "airport",
  ziekenhuis: "hospital",
  school: "school",
  universiteit: "university",
  student: "student",
  studenten: "students",
  restaurant: "restaurant",
  keuken: "kitchen",
  markt: "market",
  winkel: "shop",
  winkels: "shops",
  straat: "street",
  straten: "streets",
  brug: "bridge",
  bruggen: "bridges",
  rivier: "river",
  kanaal: "canal",
  kanalen: "canals",
  windmolen: "windmill",
  windmolens: "windmills",
  boerderij: "farm",
  veld: "field",
  bos: "forest",
  zee: "ocean",
  strand: "beach",
  berg: "mountain",
  bergen: "mountains",
};

export function matchVisualFallbackHint(sentence: string): VisualFallbackHint | undefined {
  for (const hint of VISUAL_FALLBACK_HINTS) {
    if (hint.re.test(sentence)) return hint;
  }
  return undefined;
}

export function buildIntentFromVisualFallbackHint(
  sentence: string,
  hint: VisualFallbackHint
): {
  visual_intent: string;
  primary_keyword: string;
  secondary_keyword: string;
  fallback_keyword: string;
  scene_type: string;
  priority_subject: string;
} {
  return {
    visual_intent: hint.visual_intent,
    primary_keyword: hint.primary,
    secondary_keyword: hint.secondary ?? hint.primary,
    fallback_keyword: hint.fallback ?? `${hint.scene_type} broll`,
    scene_type: hint.scene_type,
    priority_subject: hint.priority_subject,
  };
}

/** Build English stock keyword from Dutch/ mixed narration tokens. */
export function buildEnglishVisualKeywordFromSentence(sentence: string): string | undefined {
  const lower = sentence.toLowerCase();
  const rawWords = lower.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  const translated: string[] = [];

  for (const word of rawWords) {
    const stem = word.replace(/(en|s|'s)$/i, "");
    const hit = DUTCH_VISUAL_NOUNS[word] ?? DUTCH_VISUAL_NOUNS[stem];
    if (hit) translated.push(hit);
  }

  const unique = [...new Set(translated)].slice(0, 4);
  if (unique.length >= 2) return unique.join(" ");
  if (unique.length === 1) {
    const action =
      /\b(werkt|werk|working|rijden|driving|lopen|walking|bouwen|building)\b/i.test(sentence)
        ? "working"
        : "street";
    return `${unique[0]} ${action}`;
  }
  return undefined;
}
