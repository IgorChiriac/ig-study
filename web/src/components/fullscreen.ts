import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fullscreen for the lecture stage, across two engines that disagree about it.
 *
 * Blink and desktop WebKit implement the Fullscreen API on *any* element, so
 * the player and the note editor can go fullscreen together — which is the
 * whole point, since the note-taking loop is what this app is for.
 *
 * **iPhone has no element fullscreen at all.** Not prefixed, not partial —
 * `Element.requestFullscreen` and `webkitRequestFullscreen` are both undefined
 * there (iPad has them; iPhone does not). The only thing that can go fullscreen
 * on an iPhone is a `<video>`, via the non-standard
 * `HTMLVideoElement.webkitEnterFullscreen()`. So the phone gets the native
 * player and loses the notes pane — there is no way around that, and pretending
 * otherwise gives you a button that silently does nothing.
 *
 * Hence `supported`: callers must branch on it rather than calling `toggle()`
 * and hoping. See `useVideoFullscreen` in DrivePlayer for the iPhone path.
 */

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** Whether this engine can put an arbitrary element fullscreen. False on iPhone. */
export function supportsElementFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement as FullscreenElement;
  return (
    typeof root.requestFullscreen === "function" ||
    typeof root.webkitRequestFullscreen === "function"
  );
}

function currentFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export function useElementFullscreen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const sync = () => setActive(currentFullscreenElement() === ref.current);
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  const toggle = useCallback(() => {
    const doc = document as FullscreenDocument;
    const node = ref.current as FullscreenElement | null;
    if (!node) return;

    if (currentFullscreenElement()) {
      // Firefox rejects exitFullscreen() when nothing is fullscreen; the guard
      // above covers that, and the catch covers a user-gesture race.
      void Promise.resolve(
        doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.(),
      ).catch(() => undefined);
      return;
    }

    // requestFullscreen rejects (rather than throws) when the call is not
    // trusted as a user gesture. Swallowing it leaves the button inert rather
    // than breaking the page.
    void Promise.resolve(
      node.requestFullscreen?.() ?? node.webkitRequestFullscreen?.(),
    ).catch(() => undefined);
  }, []);

  return { ref, active, toggle };
}
