/**
 * VIDEO 621 — WHO THE VIDEO IS ABOUT, READ BY SOMETHING THAT KNOWS WHAT A NAME IS.
 *
 * The person lock guessed names from capital letters. A title writes every word with a capital,
 * so "Elon Musk Shocks the World" gave "Elon Musk Shocks", and a sentence's first word gave
 * "Despite Elon Musk". A capital letter does not make a name.
 *
 * The narration is now read by the language model, which names every real person in it by the full
 * name the narration uses, and says which one the video is about. Nothing it says is taken on
 * trust: a name counts only when the narration says it, in full, written as a name; and the person
 * the video is about must also be named by the user's prompt, the title or the topic — the same two
 * rules the lock has always applied. The model reads; the rules decide.
 */
export type PersonNamesDeps = {
  /** The model, asked for JSON. */
  llm: (params: unknown) => Promise<unknown>;
  /** Does the narration say this name, in full, written as a name? */
  spoken: (name: string) => boolean;
  /** Do the prompt, the title or the topic name this person? */
  namedByTopic: (name: string) => boolean;
  log?: (line: string) => void;
};

export type PersonReading = {
  /** Every person the narration names, as it names them — only names the narration really says. */
  people: string[];
  /** The person the video is about, or "" when it is not about one person. */
  mainPerson: string;
};

const SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "people_in_narration",
    strict: true,
    schema: {
      type: "object",
      properties: {
        people: { type: "array", items: { type: "string" } },
        mainPerson: { type: "string" },
      },
      required: ["people", "mainPerson"],
      additionalProperties: false,
    },
  },
};

function text(resp: unknown): string {
  const c = (resp as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p as { text?: string }).text ?? "").join("");
  return "";
}

/** Null when the model could not be asked or gave no usable answer — the caller says so and decides. */
export async function readPeopleInNarration(
  deps: PersonNamesDeps,
  input: { prompt: string; title: string; narration: string }
): Promise<PersonReading | null> {
  const log = deps.log ?? (() => {});
  let resp: unknown;
  try {
    resp = await deps.llm({
      messages: [
        {
          role: "system",
          content:
            "You identify real people named in a documentary narration. A person's name is a proper name of a " +
            "human being — never a company, product, place, event, title, or a word that merely starts a sentence. " +
            "Return JSON only.",
        },
        {
          role: "user",
          content:
            "List every real person named in the NARRATION, each exactly as the narration writes their fullest name. " +
            "Then give mainPerson: the one person this video is about, judged from the USER PROMPT and TITLE; use \"\" " +
            "when the video is about a company, place, event or thing rather than one person.\n\n" +
            `USER PROMPT: ${input.prompt}\nTITLE: ${input.title}\n\nNARRATION:\n${input.narration.slice(0, 12_000)}`,
        },
      ],
      response_format: SCHEMA,
      maxTokens: 400,
    });
  } catch (err) {
    log(`[PersonNames] the model could not be asked: ${(err as Error).message?.slice(0, 120)}`);
    return null;
  }
  let parsed: { people?: unknown; mainPerson?: unknown } | null = null;
  try {
    parsed = JSON.parse(text(resp));
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.people)) {
    log("[PersonNames] the model gave no usable answer");
    return null;
  }
  const said: string[] = [];
  const notSaid: string[] = [];
  for (const raw of parsed.people) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || name.split(/\s+/).length > 5) continue;
    if (deps.spoken(name)) {
      if (!said.includes(name)) said.push(name);
    } else notSaid.push(name);
  }
  const claimed = typeof parsed.mainPerson === "string" ? parsed.mainPerson.trim() : "";
  let mainPerson = "";
  if (claimed) {
    if (!said.includes(claimed) && !deps.spoken(claimed)) {
      log(`[PersonNames] main person refused: "${claimed}" is not said in the narration`);
    } else if (!deps.namedByTopic(claimed)) {
      log(`[PersonNames] main person refused: "${claimed}" is not named by the prompt, the title or the topic`);
    } else {
      mainPerson = claimed;
    }
  }
  log(
    `[PersonNames] people=${JSON.stringify(said)}` +
      (notSaid.length ? ` notSaid=${JSON.stringify(notSaid)}` : "") +
      ` main=${mainPerson ? JSON.stringify(mainPerson) : "none"}`
  );
  return { people: said, mainPerson };
}
