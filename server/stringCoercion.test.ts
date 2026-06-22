import { describe, expect, it } from "vitest";
import {
  asVideoTitleString,
  coercePersonName,
  coerceVisionString,
  filterQueryStrings,
  toQueryString,
} from "./stringCoercion";

describe("stringCoercion", () => {
  it("coerces objects with title/name fields", () => {
    expect(asVideoTitleString({ title: "Netherlands doc" })).toBe("Netherlands doc");
    expect(coercePersonName({ name: "Elon Musk" })).toBe("Elon Musk");
  });

  it("never throws on wrong types for string ops", () => {
    expect(() => asVideoTitleString(42).toLowerCase()).not.toThrow();
    expect(() => asVideoTitleString({ foo: "bar" }).split(" ")).not.toThrow();
    expect(asVideoTitleString(42)).toBe("42");
    expect(asVideoTitleString({ foo: "bar" })).toBe("");
  });

  it("flattens string arrays into one query", () => {
    expect(coerceVisionString(["dutch", "cycling"])).toBe("dutch cycling");
  });

  it("filters mixed query lists safely", () => {
    const mixed: unknown[] = [" valid ", 42, { title: "archival" }, null, ["nested"]];
    expect(filterQueryStrings(mixed, 2)).toEqual(["valid", "42", "archival", "nested"]);
    expect(toQueryString({ query: "bike lane" })).toBe("bike lane");
  });
});
