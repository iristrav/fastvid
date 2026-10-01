import { describe, expect, it } from "vitest";
import { extractBeatGeoPlaceTags, extractPrimaryGeoSearchTag, extractPrimaryVisualAnchor, extractSceneSearchTags, extractVisualSearchTags, inferVideoVisualTopic, isGeoWelcomeBeat, buildGeoWelcomeVisualQueries, isCyclingBeat, buildCyclingVisualQueries, isGeoStatBeat, extractGeoStatFromBeat, isCarBeat, buildCarVisualQueries, assetShowsCars, isUrbanPlanningBeat, buildUrbanPlanningVisualQueries, assetShowsUrbanPlanning, isInfrastructureBeat, buildInfrastructureVisualQueries, assetShowsInfrastructure, isGovernmentBeat, buildGovernmentVisualQueries, assetShowsGovernment, assetShowsCycling, isWrongGeoForBeat, isWwiiWarArchiveAsset, expandBeatTagsWithSynonyms } from "./visualBeatTags";

describe("visualBeatTags", () => {
  it("maps Duitsland to germany search tags", () => {
    const text = "In Duitsland begon alles te veranderen.";
    expect(extractPrimaryGeoSearchTag(text)).toBe("germany");
    expect(extractVisualSearchTags(text)).toEqual(
      expect.arrayContaining(["germany", "german", "deutschland", "berlin"])
    );
  });

  it("extracts salient tokens for any topic sentence", () => {
    expect(extractPrimaryVisualAnchor("The Titanic struck an iceberg in the Atlantic.")).toContain("titanic");
    expect(extractVisualSearchTags("SpaceX launched Starship from Texas")).toEqual(
      expect.arrayContaining(["spacex", "starship", "texas"])
    );
  });

  it("extracts bunker scene tags for archive search", () => {
    const text = "Hitler zat in zijn bunker en gaf orders.";
    expect(extractSceneSearchTags(text)).toEqual(
      expect.arrayContaining(["bunker", "fuhrerbunker", "hitler bunker"])
    );
    expect(extractPrimaryVisualAnchor(text)).toBe("hitler bunker");
  });

  it("detects geography urban topic from Netherlands vs US title", () => {
    const title = "Why the Netherlands is the Opposite of the U.S.";
    expect(inferVideoVisualTopic(title)).toBe("geography_urban");
    expect(extractBeatGeoPlaceTags("In the Netherlands, cycling is normal.")).toEqual(
      expect.arrayContaining(["netherlands", "amsterdam", "holland"])
    );
    expect(extractBeatGeoPlaceTags("American cities rely on cars.")).toEqual(
      expect.arrayContaining(["america", "usa", "united states"])
    );
  });

  it("flags wrong-country archive clips for geo beats", () => {
    const nlBeatTags = extractBeatGeoPlaceTags("The Netherlands invests in bike lanes.");
    const charlotteClip = {
      title: "Charlotte skyline Bank of America Stadium",
      tags: ["charlotte", "usa", "city skyline", "stadium"],
    };
    const amsterdamClip = {
      title: "Amsterdam canal bikes and trams",
      tags: ["amsterdam", "netherlands", "canal", "cycling"],
    };
    expect(isWrongGeoForBeat(charlotteClip, nlBeatTags)).toBe(true);
    expect(isWrongGeoForBeat(amsterdamClip, nlBeatTags)).toBe(false);
    const torontoMapClip = {
      title: "1966 Toronto transportation expressways system map",
      tags: ["urban planning", "expressway", "1966", "scarborough", "gardiner"],
    };
    expect(isWrongGeoForBeat(torontoMapClip, extractBeatGeoPlaceTags("That's the Netherlands."))).toBe(true);
    const genericMapClip = {
      title: "Urban highway planning map archival",
      tags: ["urban planning", "expressway", "infrastructure"],
    };
    expect(isWrongGeoForBeat(genericMapClip, nlBeatTags)).toBe(true);
    const kansasMapClip = {
      title: "Kansas City metropolitan area map 1970",
      tags: ["kansas city", "map", "urban planning", "missouri"],
    };
    expect(isWrongGeoForBeat(kansasMapClip, nlBeatTags)).toBe(true);
  });

  it("detects geography urban topic from Berlin vs US city title", () => {
    const title = "Why Berlin is the Opposite of Every US City";
    expect(inferVideoVisualTopic(title)).toBe("geography_urban");
    const tags = extractVisualSearchTags("Berlin has excellent public transit.", title);
    expect(tags).toEqual(expect.arrayContaining(["berlin city", "urban berlin", "public transport"]));
    expect(tags.some((t) => t.includes("hitler") || t === "germany")).toBe(false);
  });

  it("flags WWII archive assets for geography filtering", () => {
    expect(
      isWwiiWarArchiveAsset({
        title: "Hitler speech at Nuremberg rally",
        tags: ["hitler", "nazi", "propaganda"],
        mediaType: "video",
      })
    ).toBe(true);
    expect(
      isWwiiWarArchiveAsset({
        title: "Berlin skyline modern architecture",
        tags: ["berlin", "city", "skyline"],
        mediaType: "video",
      })
    ).toBe(false);
  });

  it("detects geo welcome intro beats and builds landscape queries", () => {
    const text = "Welcome to the Netherlands.";
    expect(isGeoWelcomeBeat(text)).toBe(true);
    expect(inferVideoVisualTopic(undefined, text)).toBe("geography_urban");
    expect(buildGeoWelcomeVisualQueries(text)).toEqual(
      expect.arrayContaining(["netherlands aerial drone video", "amsterdam canal timelapse"])
    );
  });

  it("detects cycling beats and builds NL cyclist queries", () => {
    expect(isCyclingBeat("Miljoenen mensen fietsen elke dag.")).toBe(true);
    expect(extractPrimaryVisualAnchor("In Amsterdam fietsen duizenden mensen.")).toBe("amsterdam cyclists");
    expect(
      buildCyclingVisualQueries("Mensen fietsen dagelijks.", "Why the Netherlands works", "Welcome to the Netherlands.")
    ).toEqual(expect.arrayContaining(["amsterdam cyclists street", "netherlands people cycling"]));
    expect(assetShowsCycling({ title: "Amsterdam canal bikes", tags: ["cycling"] })).toBe(true);
    expect(assetShowsCycling({ title: "Charlotte skyline", tags: ["usa"] })).toBe(false);
  });

  it("detects car beats and builds traffic queries", () => {
    const text = "In Amerika rijden bijna alle mensen in auto's.";
    expect(isCarBeat(text)).toBe(true);
    expect(extractPrimaryVisualAnchor(text)).toBe("american highway traffic cars");
    expect(buildCarVisualQueries(text)).toEqual(
      expect.arrayContaining(["american highway traffic cars", "cars city traffic street"])
    );
    expect(assetShowsCars({ title: "Highway traffic jam", tags: ["cars", "highway"] })).toBe(true);
    expect(assetShowsCars({ title: "Amsterdam canal", tags: ["netherlands"] })).toBe(false);
  });

  it("detects government beats and builds parliament/city hall queries", () => {
    const text = "The local government decides how cities are built.";
    expect(isGovernmentBeat(text)).toBe(true);
    expect(extractPrimaryVisualAnchor(text)).toBe("government building city hall");
    expect(buildGovernmentVisualQueries(text)).toEqual(
      expect.arrayContaining(["government building city hall", "parliament building exterior"])
    );
    expect(assetShowsGovernment({ title: "US Capitol building", tags: ["capitol", "government"] })).toBe(true);
    expect(assetShowsGovernment({ title: "Amsterdam canal", tags: ["netherlands"] })).toBe(false);
    expect(isGovernmentBeat("De overheid investeert in stedelijke planning.")).toBe(true);
  });

  it("detects urban planning beats for Netherlands city design", () => {
    const text = "In the Netherlands, urban planning prioritizes bikes and transit.";
    expect(isUrbanPlanningBeat(text)).toBe(true);
    expect(extractPrimaryVisualAnchor(text)).toBe("netherlands urban planning aerial");
    expect(buildUrbanPlanningVisualQueries(text)).toEqual(
      expect.arrayContaining([
        "netherlands urban planning aerial",
        "amsterdam city planning bike lanes",
      ])
    );
    expect(
      assetShowsUrbanPlanning(
        { title: "Amsterdam tram and bike lanes", tags: ["amsterdam", "netherlands", "tram", "cycling"] },
        text
      )
    ).toBe(true);
    expect(assetShowsUrbanPlanning({ title: "Charlotte skyline", tags: ["usa"] }, text)).toBe(false);
    expect(isUrbanPlanningBeat("Stedenbouw in Nederland werkt anders.")).toBe(true);
  });

  it("detects infrastructure beats for Netherlands transport and roads", () => {
    const text = "The infrastructure of the Netherlands is built for bikes and trains.";
    expect(isInfrastructureBeat(text)).toBe(true);
    expect(isUrbanPlanningBeat(text)).toBe(false);
    expect(extractPrimaryVisualAnchor(text)).toBe("netherlands infrastructure aerial");
    expect(buildInfrastructureVisualQueries(text)).toEqual(
      expect.arrayContaining([
        "netherlands infrastructure aerial",
        "amsterdam tram public transport",
        "netherlands cycling infrastructure",
      ])
    );
    expect(
      assetShowsInfrastructure(
        { title: "Amsterdam tram and train station", tags: ["amsterdam", "netherlands", "tram", "train"] },
        text
      )
    ).toBe(true);
    expect(assetShowsInfrastructure({ title: "Charlotte skyline", tags: ["usa"] }, text)).toBe(false);
    expect(isInfrastructureBeat("De infrastructuur van Nederland is uniek.")).toBe(true);
  });

  describe("expandBeatTagsWithSynonyms (Phase 10)", () => {
    it("adds related English terms for common documentary topics outside the WWII/NL tables", () => {
      const expanded = expandBeatTagsWithSynonyms(["technology"]);
      expect(expanded).toContain("technology");
      expect(expanded).toContain("innovation");
      expect(expanded).toContain("digital");
    });

    it("is purely additive — never removes or replaces an input tag", () => {
      const input = ["berlin", "technology", "unrelatedxyz"];
      const expanded = expandBeatTagsWithSynonyms(input);
      for (const tag of input) expect(expanded).toContain(tag);
    });

    it("returns the same array reference-equal-in-content when nothing matches", () => {
      expect(expandBeatTagsWithSynonyms(["berlin", "unrelatedxyz"])).toEqual(["berlin", "unrelatedxyz"]);
    });

    it("deduplicates when a synonym overlaps an already-present tag", () => {
      const expanded = expandBeatTagsWithSynonyms(["economy", "market"]);
      expect(expanded.filter((t) => t === "market").length).toBe(1);
    });
  });
});
