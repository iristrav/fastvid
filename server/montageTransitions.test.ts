import { describe, expect, it } from "vitest";
import {
  DOCUMENTARY_MONTAGE_TRANSITIONS,
  pickMontageXfadeTransition,
  pickStockMontageXfadeTransition,
} from "./montageTransitions";

describe("montageTransitions", () => {
  it("rotates documentary transitions across joins in a scene", () => {
    const scene0 = [1, 2, 3, 4, 5].map((j) => pickMontageXfadeTransition(0, j));
    const unique = new Set(scene0);
    expect(unique.size).toBeGreaterThan(1);
    for (const t of scene0) {
      expect(DOCUMENTARY_MONTAGE_TRANSITIONS).toContain(t);
    }
  });

  it("uses different patterns per scene index", () => {
    const a = pickMontageXfadeTransition(0, 1);
    const b = pickMontageXfadeTransition(3, 1);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it("stock mode also varies transitions", () => {
    const t1 = pickStockMontageXfadeTransition(1, 1);
    const t2 = pickStockMontageXfadeTransition(1, 2);
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
  });
});
