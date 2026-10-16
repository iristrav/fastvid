/**
 * VIDEO 661 (D) — A PICTURE WHOSE OWN TITLE NAMES ANOTHER PLACE THAN THE SENTENCE.
 *
 * Render 70 (video 661) put an image search result titled "Port-Oakland.jpg" under a sentence about
 * Rotterdam. A port is a port to a picture model; the title said where it was. So before anyone pays
 * to look at a candidate, the places its provider title names are set against the places the
 * sentence names: a title that names places, none of them the sentence's place or in the sentence's
 * country, is refused.
 *
 * Deliberately narrow, so it cannot refuse on a guess:
 *  - only names on the list below count, matched as whole words; ambiguous names (Georgia, Jordan,
 *    Turkey, Nice, Victoria, Washington as a state, England (New England), Wales (New South Wales),
 *    Santos, Savannah, Alexandria, Valencia…) are left out;
 *  - a sentence or title that names no listed place decides nothing;
 *  - a title naming the sentence's place, or any place in the same country, passes;
 *  - nationality words ("Dutch", "German") count on the sentence side only: a title like "French
 *    fries" says nothing about where a picture was taken.
 */

type Place = { name: string; country: string; aliases: string[] };

/** Countries: the country is itself. Demonyms are read from sentences only (see `DEMONYMS`). */
const COUNTRIES: Array<[string, string[]]> = [
  ["netherlands", ["netherlands", "holland", "the netherlands"]],
  ["belgium", ["belgium"]],
  ["germany", ["germany", "deutschland"]],
  ["france", ["france"]],
  ["united kingdom", ["united kingdom", "britain", "great britain", "scotland"]],
  ["ireland", ["ireland"]],
  ["spain", ["spain"]],
  ["portugal", ["portugal"]],
  ["italy", ["italy"]],
  ["greece", ["greece"]],
  ["poland", ["poland"]],
  ["austria", ["austria"]],
  ["switzerland", ["switzerland"]],
  ["sweden", ["sweden"]],
  ["norway", ["norway"]],
  ["denmark", ["denmark"]],
  ["finland", ["finland"]],
  ["russia", ["russia"]],
  ["ukraine", ["ukraine"]],
  ["united states", ["united states", "usa", "u.s.a."]],
  ["canada", ["canada"]],
  ["mexico", ["mexico"]],
  ["brazil", ["brazil"]],
  ["argentina", ["argentina"]],
  ["china", ["china"]],
  ["japan", ["japan"]],
  ["south korea", ["south korea"]],
  ["india", ["india"]],
  ["australia", ["australia"]],
  ["egypt", ["egypt"]],
  ["south africa", ["south africa"]],
  ["israel", ["israel"]],
  ["iran", ["iran"]],
  ["iraq", ["iraq"]],
  ["saudi arabia", ["saudi arabia"]],
  ["singapore", ["singapore"]],
];

const DEMONYMS: Record<string, string> = {
  dutch: "netherlands", belgian: "belgium", german: "germany", french: "france", british: "united kingdom",
  english: "united kingdom", irish: "ireland", spanish: "spain", portuguese: "portugal", italian: "italy",
  greek: "greece", polish: "poland", austrian: "austria", swiss: "switzerland", swedish: "sweden",
  norwegian: "norway", danish: "denmark", finnish: "finland", russian: "russia", ukrainian: "ukraine",
  american: "united states", canadian: "canada", mexican: "mexico", brazilian: "brazil", chinese: "china",
  japanese: "japan", korean: "south korea", indian: "india", australian: "australia", egyptian: "egypt",
};

/** Cities and ports, with their country. */
const CITIES: Array<[string, string, string[]?]> = [
  ["amsterdam", "netherlands"], ["rotterdam", "netherlands"], ["the hague", "netherlands", ["the hague", "den haag"]],
  ["utrecht", "netherlands"], ["eindhoven", "netherlands"], ["antwerp", "belgium", ["antwerp", "antwerpen"]],
  ["brussels", "belgium", ["brussels", "brussel", "bruxelles"]], ["hamburg", "germany"], ["berlin", "germany"],
  ["frankfurt", "germany"], ["munich", "germany", ["munich", "münchen"]], ["cologne", "germany", ["cologne", "köln"]],
  ["bremen", "germany"], ["paris", "france"], ["marseille", "france"], ["le havre", "france"], ["lyon", "france"],
  ["london", "united kingdom"], ["liverpool", "united kingdom"], ["manchester", "united kingdom"],
  ["southampton", "united kingdom"], ["felixstowe", "united kingdom"], ["glasgow", "united kingdom"],
  ["edinburgh", "united kingdom"], ["dublin", "ireland"], ["madrid", "spain"], ["barcelona", "spain"],
  ["algeciras", "spain"], ["lisbon", "portugal"], ["rome", "italy"], ["milan", "italy"],
  ["genoa", "italy"], ["naples", "italy"], ["venice", "italy"], ["athens", "greece"], ["piraeus", "greece"],
  ["warsaw", "poland"], ["gdansk", "poland", ["gdansk", "gdańsk"]], ["vienna", "austria"], ["zurich", "switzerland", ["zurich", "zürich"]],
  ["geneva", "switzerland"], ["stockholm", "sweden"], ["gothenburg", "sweden"], ["oslo", "norway"],
  ["copenhagen", "denmark"], ["helsinki", "finland"], ["moscow", "russia"], ["st. petersburg", "russia", ["st. petersburg", "saint petersburg"]],
  ["kyiv", "ukraine", ["kyiv", "kiev"]], ["odesa", "ukraine", ["odesa", "odessa"]],
  ["new york", "united states", ["new york", "manhattan"]], ["los angeles", "united states"], ["long beach", "united states"],
  ["oakland", "united states"], ["san francisco", "united states"], ["seattle", "united states"], ["chicago", "united states"],
  ["houston", "united states"], ["miami", "united states"], ["boston", "united states"], ["detroit", "united states"],
  ["baltimore", "united states"], ["new orleans", "united states"],
  ["toronto", "canada"], ["vancouver", "canada"], ["montreal", "canada"], ["mexico city", "mexico"],
  ["sao paulo", "brazil", ["sao paulo", "são paulo"]], ["rio de janeiro", "brazil"], ["buenos aires", "argentina"],
  ["shanghai", "china"], ["beijing", "china"], ["shenzhen", "china"], ["guangzhou", "china"], ["ningbo", "china"],
  ["hong kong", "china"], ["tokyo", "japan"], ["yokohama", "japan"], ["osaka", "japan"], ["kobe", "japan"],
  ["busan", "south korea"], ["seoul", "south korea"], ["mumbai", "india"], ["delhi", "india", ["delhi", "new delhi"]],
  ["sydney", "australia"], ["melbourne", "australia"], ["cairo", "egypt"],
  ["cape town", "south africa"], ["durban", "south africa"], ["johannesburg", "south africa"], ["dubai", "united arab emirates"],
  ["jebel ali", "united arab emirates"], ["tel aviv", "israel"], ["jerusalem", "israel"], ["tehran", "iran"],
  ["baghdad", "iraq"], ["riyadh", "saudi arabia"],
];

const PLACES: Place[] = [
  ...COUNTRIES.map(([country, aliases]) => ({ name: country, country, aliases })),
  ...CITIES.map(([name, country, aliases]) => ({ name, country, aliases: aliases ?? [name] })),
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive; "-" and "_" in file names count as spaces ("Port-Oakland.jpg"). */
function mentions(text: string, alias: string): boolean {
  const hay = ` ${text.toLowerCase().replace(/[-_./]+/g, " ")} `;
  return new RegExp(`[^\\p{L}\\p{N}]${escapeRe(alias.toLowerCase())}[^\\p{L}\\p{N}]`, "u").test(hay);
}

/** The listed places a text names. `withDemonyms` also reads "Dutch" as the Netherlands. */
export function placesIn(text: string | null | undefined, withDemonyms = false): Place[] {
  if (!text) return [];
  const found = PLACES.filter((p) => p.aliases.some((a) => mentions(text, a)));
  if (withDemonyms) {
    for (const [word, country] of Object.entries(DEMONYMS)) {
      if (mentions(text, word) && !found.some((p) => p.name === country)) {
        const c = PLACES.find((p) => p.name === country);
        if (c) found.push(c);
      }
    }
  }
  return found;
}

/**
 * The places a candidate's title names when NONE of them is the sentence's place or in the
 * sentence's country; null when the title passes or either side names no listed place.
 */
export function wrongPlaceInTitle(
  sentence: string | null | undefined,
  title: string | null | undefined
): { said: string[]; titled: string[] } | null {
  const said = placesIn(sentence, true);
  const titled = placesIn(title);
  if (said.length === 0 || titled.length === 0) return null;
  const countries = new Set(said.map((p) => p.country));
  const names = new Set(said.map((p) => p.name));
  const consistent = titled.some((t) => names.has(t.name) || countries.has(t.country));
  return consistent ? null : { said: said.map((p) => p.name), titled: titled.map((p) => p.name) };
}
