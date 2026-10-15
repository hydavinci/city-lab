import {
  CameraEventType, Cartesian2, Cartesian3, HeadingPitchRange, KeyboardEventModifier,
  Math as CesiumMath, Matrix4, ScreenSpaceEventHandler, ScreenSpaceEventType,
  Transforms, type ScreenSpaceCameraController, type Viewer,
} from 'cesium';

interface DragState {
  target: Cartesian3;
  last: Cartesian2;
  heading: number;
  pitch: number;
  range: number;
}

export class OrbitControls {
  private handler: ScreenSpaceEventHandler;
  private controller: ScreenSpaceCameraController;
  private previousTiltEvents: ScreenSpaceCameraController['tiltEventTypes'];
  private removePostRender: () => void;
  private target: Cartesian3;
  private drag: DragState | undefined;
  private previousInputs = true;

  constructor(private viewer: Viewer) {
    this.controller = viewer.scene.screenSpaceCameraController;
    this.previousTiltEvents = this.controller.tiltEventTypes;
    // Keep native touch gestures and all pan/zoom bindings; replace only mouse orbit.
    this.controller.tiltEventTypes = CameraEventType.PINCH;
    const target = this.pickTarget()
      ?? viewer.scene.globe.ellipsoid.scaleToGeodeticSurface(viewer.camera.positionWC);
    if (!target) throw new Error('相机位置无效，无法确定环绕中心。');
    this.target = target;
    this.handler = new ScreenSpaceEventHandler(viewer.canvas);
    const bindings = [
      { down: ScreenSpaceEventType.MIDDLE_DOWN, modifier: undefined },
      { down: ScreenSpaceEventType.LEFT_DOWN, modifier: KeyboardEventModifier.CTRL },
      { down: ScreenSpaceEventType.RIGHT_DOWN, modifier: KeyboardEventModifier.CTRL },
    ];
    for (const binding of bindings) {
      this.handler.setInputAction(this.start, binding.down, binding.modifier);
    }
    this.handler.setInputAction(this.move, ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction(this.move, ScreenSpaceEventType.MOUSE_MOVE, KeyboardEventModifier.CTRL);
    this.removePostRender = viewer.scene.postRender.addEventListener(() => {
      if (this.drag) return;
      const picked = this.pickTarget();
      if (picked) Cartesian3.clone(picked, this.target);
    });
    // Releases outside the canvas or after changing modifiers must still end the drag.
    window.addEventListener('pointerup', this.cancel, true);
    window.addEventListener('mouseup', this.cancel, true);
    window.addEventListener('blur', this.cancel);
  }

  private pickTarget(): Cartesian3 | undefined {
    const { canvas, camera, scene } = this.viewer;
    return camera.pickEllipsoid(
      new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2), scene.globe.ellipsoid,
    );
  }

  private start = (event: { position: Cartesian2 }) => {
    if (!this.controller.enableInputs || this.drag) return;
    const camera = this.viewer.camera;
    camera.cancelFlight();
    // Rays aimed at the horizon/sky have no ground intersection: retain the last real pivot.
    const target = Cartesian3.clone(this.pickTarget() ?? this.target);
    const frame = Transforms.eastNorthUpToFixedFrame(target, this.viewer.scene.globe.ellipsoid);
    const inverse = Matrix4.inverseTransformation(frame, new Matrix4());
    const offset = Matrix4.multiplyByPoint(inverse, camera.positionWC, new Cartesian3());
    const distance = Cartesian3.magnitude(offset);
    this.drag = {
      target, last: Cartesian2.clone(event.position),
      // At nadir, curvature/numerical offsets do not define a meaningful orbit azimuth.
      heading: camera.pitch <= CesiumMath.toRadians(-89.5) || Math.hypot(offset.x, offset.y) < distance * 1e-5
        ? camera.heading : Math.atan2(-offset.x, -offset.y),
      pitch: -Math.asin(CesiumMath.clamp(offset.z / Math.max(distance, 1), -1, 1)),
      range: CesiumMath.clamp(
        distance, this.controller.minimumZoomDistance + 1, this.controller.maximumZoomDistance,
      ),
    };
    this.previousInputs = this.controller.enableInputs;
    this.controller.enableInputs = false;
  };

  private move = (event: { endPosition: Cartesian2 }) => {
    const drag = this.drag;
    if (!drag) return;
    const { canvas, camera, scene } = this.viewer;
    const dx = (event.endPosition.x - drag.last.x) / Math.max(canvas.clientWidth, 1);
    const dy = (event.endPosition.y - drag.last.y) / Math.max(canvas.clientHeight, 1);
    Cartesian2.clone(event.endPosition, drag.last);
    drag.heading = CesiumMath.zeroToTwoPi(drag.heading + dx * CesiumMath.TWO_PI);
    const minimumDepression = Math.max(
      CesiumMath.toRadians(5),
      Math.asin(CesiumMath.clamp(this.controller.minimumZoomDistance / drag.range, 0, 1)),
    );
    drag.pitch = CesiumMath.clamp(
      drag.pitch - dy * Math.PI, CesiumMath.toRadians(-89.5), -minimumDepression,
    );
    camera.lookAt(drag.target, new HeadingPitchRange(drag.heading, drag.pitch, drag.range));
    // Restore world coordinates so native pan, zoom and subsequent flights keep working.
    camera.lookAtTransform(Matrix4.IDENTITY);
    scene.requestRender();
  };

  cancel = () => {
    if (!this.drag) return;
    this.drag = undefined;
    this.controller.enableInputs = this.previousInputs;
    this.viewer.scene.requestRender();
  };

  destroy() {
    this.cancel();
    window.removeEventListener('pointerup', this.cancel, true);
    window.removeEventListener('mouseup', this.cancel, true);
    window.removeEventListener('blur', this.cancel);
    this.removePostRender();
    this.handler.destroy();
    this.controller.tiltEventTypes = this.previousTiltEvents;
  }
}
