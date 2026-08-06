import { describe, expect, it } from "vitest";
import { renderCameraMovement } from "./cameraRenderer";
import type { CameraInstruction } from "./types";

const DIMS_16_9 = { width: 1920, height: 1080 };
const DIMS_9_16 = { width: 1080, height: 1920 };

function instruction(movement: CameraInstruction["movement"], intensity = 0.5): CameraInstruction {
  return { movement, intensity, reason: `test-${movement}` };
}

describe("Camera Renderer (Phase 7)", () => {
  it("camera_hold is a genuine no-op — no filter fragment emitted", () => {
    expect(renderCameraMovement(instruction("camera_hold"), 4, DIMS_16_9)).toEqual([]);
  });

  describe("reused Ken-Burns-family movements", () => {
    it("ken_burns produces a zoompan filter at the target dimensions", () => {
      const [frag] = renderCameraMovement(instruction("ken_burns", 0.5), 4, DIMS_16_9);
      expect(frag.filter).toContain("zoompan=");
      expect(frag.filter).toContain("s=1920x1080");
      expect(frag.reason).toBe("test-ken_burns");
    });

    it("adapts to non-16:9 target dimensions via withDimensions", () => {
      const [frag] = renderCameraMovement(instruction("ken_burns", 0.5), 4, DIMS_9_16);
      expect(frag.filter).toContain("s=1080x1920");
      expect(frag.filter).not.toContain("s=1920x1080");
    });

    it("zoom_in and zoom_out route to opposite Ken-Burns variants", () => {
      const [zoomIn] = renderCameraMovement(instruction("zoom_in", 0), 4, DIMS_16_9);
      const [zoomOut] = renderCameraMovement(instruction("zoom_out", 0), 4, DIMS_16_9);
      // zoom_in: zoomStart=1.0 -> zoomTarget, expressed as min(zoom+step,target)
      expect(zoomIn.filter).toContain("z='min(zoom+");
      // zoom_out: zoomStart=zoomEnd -> 1.0, expressed as max(zoom-step,target)
      expect(zoomOut.filter).toContain("z='max(zoom-");
    });

    it("pan_left and pan_right produce opposite x-pan direction with fixed zoomEnd", () => {
      const [panLeft] = renderCameraMovement(instruction("pan_left", 0.9), 4, DIMS_16_9);
      const [panRight] = renderCameraMovement(instruction("pan_right", 0.9), 4, DIMS_16_9);
      expect(panLeft.filter).toContain("-on*");
      expect(panRight.filter).toContain("+on*");
      // pan_left/pan_right zoomEnd is fixed at 1.02 regardless of intensity
      expect(panLeft.filter).toContain("1.0200");
      expect(panRight.filter).toContain("1.0200");
    });

    it("slow_push and slow_pull use a gentler zoom spread than zoom_in/zoom_out", () => {
      const [slowPush] = renderCameraMovement(instruction("slow_push", 1), 4, DIMS_16_9);
      const [zoomIn] = renderCameraMovement(instruction("zoom_in", 1), 4, DIMS_16_9);
      // slow_push at max intensity -> 1.02 + 0.06 = 1.08; zoom_in at max intensity -> 1.05 + 0.15 = 1.20
      expect(slowPush.filter).toContain("1.0800");
      expect(zoomIn.filter).toContain("1.2000");
    });

    it("intensity is clamped to [0,1] when computing zoomEnd", () => {
      const overMax = renderCameraMovement(instruction("zoom_in", 5), 4, DIMS_16_9)[0];
      const atMax = renderCameraMovement(instruction("zoom_in", 1), 4, DIMS_16_9)[0];
      expect(overMax.filter).toBe(atMax.filter);

      const belowMin = renderCameraMovement(instruction("zoom_in", -5), 4, DIMS_16_9)[0];
      const atMin = renderCameraMovement(instruction("zoom_in", 0), 4, DIMS_16_9)[0];
      expect(belowMin.filter).toBe(atMin.filter);
    });
  });

  describe("genuinely new eased movements", () => {
    it("tilt_up produces a negative y-offset sine ease-out expression", () => {
      const [frag] = renderCameraMovement(instruction("tilt_up", 0.5), 3, DIMS_16_9);
      expect(frag.filter).toBe(
        "zoompan=z='1.015':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)-ih*0.0800*sin(PI/2*min(on/75,1))':d=75:s=1920x1080:fps=25"
      );
    });

    it("tilt_down produces a positive y-offset sine ease-out expression", () => {
      const [frag] = renderCameraMovement(instruction("tilt_down", 0.5), 3, DIMS_16_9);
      expect(frag.filter).toBe(
        "zoompan=z='1.015':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+ih*0.0800*sin(PI/2*min(on/75,1))':d=75:s=1920x1080:fps=25"
      );
    });

    it("camera_drift produces sine/cosine x/y drift expressions", () => {
      const [frag] = renderCameraMovement(instruction("camera_drift", 0.5), 3, DIMS_16_9);
      expect(frag.filter).toBe(
        "zoompan=z='1.02':x='iw/2-(iw/zoom/2)+iw*0.0250*sin(2*PI*on/75)':y='ih/2-(ih/zoom/2)+ih*0.0250*cos(2*PI*on/75)':d=75:s=1920x1080:fps=25"
      );
    });

    it("virtual_dolly produces a quadratic ease-in zoom expression", () => {
      const [frag] = renderCameraMovement(instruction("virtual_dolly", 0.5), 3, DIMS_16_9);
      expect(frag.filter).toBe(
        "zoompan=z='1+0.0900*pow(min(on/75,1),2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=75:s=1920x1080:fps=25"
      );
    });

    it("parallax produces a combined zoom+pan sine ease-out expression", () => {
      const [frag] = renderCameraMovement(instruction("parallax", 0.5), 3, DIMS_16_9);
      expect(frag.filter).toBe(
        "zoompan=z='1+0.0300*min(on/75,1)':x='iw/2-(iw/zoom/2)+iw*0.0350*sin(PI/2*min(on/75,1))':y='ih/2-(ih/zoom/2)':d=75:s=1920x1080:fps=25"
      );
    });

    it("new movements adapt to non-16:9 target dimensions", () => {
      const [frag] = renderCameraMovement(instruction("virtual_dolly", 0.5), 3, DIMS_9_16);
      expect(frag.filter).toContain("s=1080x1920");
    });

    it("higher intensity produces a larger amplitude for tilt", () => {
      const low = renderCameraMovement(instruction("tilt_up", 0), 3, DIMS_16_9)[0];
      const high = renderCameraMovement(instruction("tilt_up", 1), 3, DIMS_16_9)[0];
      expect(low.filter).toContain("ih*0.0500*");
      expect(high.filter).toContain("ih*0.1100*");
    });

    it("each fragment carries the instruction's reason through unchanged", () => {
      const [frag] = renderCameraMovement(instruction("camera_drift", 0.3), 3, DIMS_16_9);
      expect(frag.reason).toBe("test-camera_drift");
    });
  });
});
