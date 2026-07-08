/**
 * Cinematic image card treatment:
 *   - blurred & darkened background (full frame)
 *   - foreground image at 78% width, centred
 *   - Ken Burns / pop-in / pan animation on foreground
 *   - subtle vignette on background
 *
 * Always enabled for stills; replaces the documentaryStyle gate.
 */
import type { ImageAnimation } from "./types";

const W = 1920;
const H = 1080;
const FG_SCALE = 0.80; // foreground card width ratio

/**
 * Build FFmpeg filter_complex for a still image → video clip with card treatment.
 * Input: single image [0:v]
 * Output label: [vout]
 */
export function buildImageCardFilterComplex(
  durationSec: number,
  animation: ImageAnimation,
  fps = 25
): string {
  const frames = Math.ceil(durationSec * fps);
  const blurFilter = "gblur=sigma=40";
  const darken = "colorchannelmixer=rr=0.45:gg=0.45:bb=0.45";
  const vignette = "vignette=PI/5";

  // Background: scale up slightly, blur, darken, vignette
  const bg =
    `[0:v]loop=loop=${frames}:size=1:start=0,` +
    `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `${blurFilter},${darken},${vignette}[bg]`;

  // Foreground: scale to 80% width, apply chosen animation
  const fgBaseScale =
    `[0:v]loop=loop=${frames}:size=1:start=0,` +
    `scale='min(${W}*${FG_SCALE}/iw\\,${H}*${FG_SCALE}/ih)*iw':-2[fgraw]`;

  const fgAnim = buildForegroundAnimation("[fgraw]", animation, durationSec, fps);

  // Overlay foreground centred on background
  const compose =
    `[bg][fganim]overlay=(W-w)/2:(H-h)/2[composed]`;

  // Final: fps + format
  const finalise = `[composed]fps=${fps},format=yuv420p[vout]`;

  return [bg, fgBaseScale, fgAnim, compose, finalise].join(";");
}

function buildForegroundAnimation(
  inputLabel: string,
  animation: ImageAnimation,
  durationSec: number,
  fps: number
): string {
  const frames = Math.ceil(durationSec * fps);
  const d = durationSec;

  switch (animation) {
    case "pop_in":
      // Scale 0.85→1.05→1.0 over first 0.4s using zoompan trick
      return (
        `${inputLabel}zoompan=z='if(lt(on,${Math.ceil(fps*0.2)}),0.85+on*${(0.2/Math.ceil(fps*0.2)).toFixed(5)},` +
        `if(lt(on,${Math.ceil(fps*0.4)}),1.05-(on-${Math.ceil(fps*0.2)})*${(0.05/Math.ceil(fps*0.2)).toFixed(5)},1.0))':` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps}[fganim]`
      );

    case "ken_burns_in": {
      const zoomEnd = Math.min(1.0 + d * 0.008, 1.35);
      return (
        `${inputLabel}zoompan=z='min(zoom+${((zoomEnd - 1.0) / frames).toFixed(7)},${zoomEnd})':` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps}[fganim]`
      );
    }

    case "ken_burns_out": {
      const zoomStart = Math.min(1.0 + d * 0.008, 1.3);
      const zoomStep = ((zoomStart - 1.0) / frames).toFixed(7);
      return (
        `${inputLabel}zoompan=z='max(${zoomStart}-on*${zoomStep},1.0)':` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps}[fganim]`
      );
    }

    case "pan_left":
      return (
        `${inputLabel}zoompan=z='1.12':` +
        `x='iw/2-(iw/zoom/2)+on*${(0.12 * W / frames).toFixed(4)}':` +
        `y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps}[fganim]`
      );

    case "pan_right":
      return (
        `${inputLabel}zoompan=z='1.12':` +
        `x='iw/2-(iw/zoom/2)-on*${(0.12 * W / frames).toFixed(4)}':` +
        `y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps}[fganim]`
      );

    case "slow_zoom":
    default: {
      const zoomEnd2 = Math.min(1.0 + d * 0.005, 1.2);
      return (
        `${inputLabel}zoompan=z='min(zoom+${((zoomEnd2 - 1.0) / frames).toFixed(7)},${zoomEnd2})':` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps}[fganim]`
      );
    }

    case "fade":
      return `${inputLabel}scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black[fganim]`;
  }
}
