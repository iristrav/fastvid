import { afterEach, describe, expect, it } from "vitest";
import { envFlagIsOn, envFlagIsNotOff, youtubeSourcingEnabled } from "./sourcingPolicy";

// RONDE 18 follow-up — a Railway variable set to "TRUE" (uppercase) must read the same as "true".
// The worker had ENABLE_YOUTUBE_FAIR_USE=TRUE next to ENABLE_YOUTUBE_RAPID_SEARCH=true; a bare
// `=== "true"` on the sourcing flag would have silently disabled the whole YouTube source on a
// stray capital. These helpers make every YouTube flag case/whitespace-tolerant.

const KEY = "TEST_ENV_FLAG_RONDE18";

afterEach(() => {
  delete process.env[KEY];
  delete process.env.ENABLE_YOUTUBE_SOURCING;
});

describe("envFlagIsOn — opt-in, case/whitespace tolerant", () => {
  it.each(["true", "TRUE", "True", " true ", "\tTRUE\n"])('reads %j as ON', (v) => {
    process.env[KEY] = v;
    expect(envFlagIsOn(KEY)).toBe(true);
  });

  it.each(["false", "FALSE", "0", "", "yes", "1"])('reads %j as OFF', (v) => {
    process.env[KEY] = v;
    expect(envFlagIsOn(KEY)).toBe(false);
  });

  it("reads an unset variable as OFF", () => {
    expect(envFlagIsOn(KEY)).toBe(false);
  });
});

describe("envFlagIsNotOff — opt-out, case/whitespace tolerant", () => {
  it.each(["false", "FALSE", "False", " false ", "\tFALSE\n"])('reads %j as OFF', (v) => {
    process.env[KEY] = v;
    expect(envFlagIsNotOff(KEY)).toBe(false);
  });

  it.each(["true", "TRUE", "", "anything"])('reads %j as ON (default on)', (v) => {
    process.env[KEY] = v;
    expect(envFlagIsNotOff(KEY)).toBe(true);
  });

  it("reads an unset variable as ON", () => {
    expect(envFlagIsNotOff(KEY)).toBe(true);
  });
});

describe("youtubeSourcingEnabled respects the tolerant flag", () => {
  it('turns ON for "TRUE" (the exact worker casing that used to fail)', () => {
    process.env.ENABLE_YOUTUBE_SOURCING = "TRUE";
    expect(youtubeSourcingEnabled()).toBe(true);
  });

  it('stays OFF when unset', () => {
    expect(youtubeSourcingEnabled()).toBe(false);
  });
});
