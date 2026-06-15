/** Starter niche archives — empty libraries for sourcing tagged footage. */
export type SampleMediaArchive = {
  name: string;
  description: string;
  nicheTags: string[];
};

export const SAMPLE_MEDIA_ARCHIVES: SampleMediaArchive[] = [
  {
    name: "Titanic & Maritime Disasters",
    description: "Shipwrecks, ocean liners, survival at sea, and maritime history.",
    nicheTags: ["titanic", "maritime", "shipwreck", "ocean liner", "iceberg", "survival at sea"],
  },
  {
    name: "Cold War Espionage",
    description: "Spies, intelligence agencies, covert ops, and geopolitical tension.",
    nicheTags: ["cold war", "espionage", "spy", "cia", "kgb", "berlin wall", "intelligence"],
  },
  {
    name: "Silicon Valley & Tech Titans",
    description: "Startups, big tech, founders, product launches, and innovation culture.",
    nicheTags: ["silicon valley", "startup", "tech", "entrepreneur", "apple", "google", "billionaire"],
  },
  {
    name: "Ancient Egypt & Lost Civilizations",
    description: "Pyramids, pharaohs, archaeology digs, and ancient mysteries.",
    nicheTags: ["ancient egypt", "pyramid", "pharaoh", "archaeology", "mummy", "lost civilization"],
  },
  {
    name: "Formula 1 & Motorsport",
    description: "Grand prix racing, teams, drivers, crashes, and paddock drama.",
    nicheTags: ["formula 1", "f1", "motorsport", "racing", "grand prix", "ferrari", "crash"],
  },
  {
    name: "Arctic & Polar Exploration",
    description: "Expeditions, ice, explorers, survival, and polar wildlife.",
    nicheTags: ["arctic", "antarctic", "polar", "expedition", "explorer", "ice", "survival"],
  },
  {
    name: "True Crime Investigations",
    description: "Murder cases, detectives, forensics, courtrooms, and manhunts.",
    nicheTags: ["true crime", "murder", "investigation", "forensic", "detective", "courtroom"],
  },
  {
    name: "Space Race & NASA",
    description: "Rockets, astronauts, moon missions, and the race to space.",
    nicheTags: ["space race", "nasa", "astronaut", "moon landing", "rocket", "apollo", "orbit"],
  },
];
