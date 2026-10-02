/**
 * OCTOBER 2026 — THE FONTS ARE PART OF THE BUNDLE, NOT OF THE MACHINE.
 *
 * Captions and cards named "DejaVu Sans" or "Noto Sans" and got whatever the render host had
 * installed under that name; a host without them drew a different face, at a different width, and
 * the box measured for one face held the other. Inter (captions, cards) and Oswald (display) now
 * travel inside the webpack bundle — both SIL Open Font License 1.1, see fonts/NOTICE.txt — and are
 * loaded before the first frame is taken.
 *
 * Imported only by the bundle's entry (Root.tsx): a node test that imports a component never
 * touches a font file.
 */
import { continueRender, delayRender } from "remotion";
import interUrl from "./fonts/Inter.ttf";
import oswaldUrl from "./fonts/Oswald.ttf";

let started = false;

/** Load the bundled faces once; the render waits for them. A face that fails falls back to the stack. */
export function loadBundledFonts(): void {
  if (started || typeof document === "undefined" || typeof FontFace === "undefined") return;
  started = true;
  const handle = delayRender("bundled fonts (Inter, Oswald)");
  const faces: Array<[string, string]> = [
    ["Inter", interUrl],
    ["Oswald", oswaldUrl],
  ];
  Promise.all(
    faces.map(async ([family, url]) => {
      const face = new FontFace(family, `url(${url}) format("truetype")`, { weight: "100 900" });
      await face.load();
      document.fonts.add(face);
    })
  ).then(
    () => continueRender(handle),
    (err) => {
      console.warn("[Fonts] a bundled font did not load; the fallback face is used:", (err as Error)?.message);
      continueRender(handle);
    }
  );
}
