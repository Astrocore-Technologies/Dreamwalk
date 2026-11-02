/** Rendering policy only; authoritative state and input are never suspended. */
export function intersectsViewport(
  rect: { top: number; bottom: number; left: number; right: number },
  width: number,
  height: number,
) {
  return (
    width > 0 &&
    height > 0 &&
    rect.right > rect.left &&
    rect.bottom > rect.top &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < height &&
    rect.left < width
  );
}

export function rendererActivity(callbacks: { resume: () => void; pause: () => void }) {
  let ready = false,
    visible = true,
    hidden = false,
    active = false,
    disposed = false;
  function sync() {
    const next = !disposed && ready && visible && !hidden;
    if (next === active) return;
    active = next;
    if (active) callbacks.resume();
    else callbacks.pause();
  }
  return {
    ready() {
      if (!disposed) {
        ready = true;
        sync();
      }
    },
    visibility(inViewport: boolean, documentHidden: boolean) {
      if (disposed) return;
      visible = inViewport;
      hidden = documentHidden;
      sync();
    },
    isActive: () => active,
    dispose() {
      disposed = true;
      sync();
    },
  };
}
