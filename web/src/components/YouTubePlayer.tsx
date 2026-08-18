import { useEffect, useRef } from "react";

/**
 * A YouTube lecture, played through the IFrame Player API.
 *
 * This is the supported way to embed YouTube, and unlike Drive's iframe player
 * it exposes `getCurrentTime` and `seekTo` — which is why `decisions.md` §2
 * rejected an iframe for Drive but embedding is right here.
 *
 * The resume point is read **once**, when the player is built. It must not be
 * an effect dependency: saving a position makes Firestore echo a new
 * `positionS` back, and if that rebuilt the player then pausing, seeking or
 * even switching tabs would tear the video down and start it again. Mount this
 * with `key={lecture.id}` so a different lecture gets a fresh component, and
 * therefore a fresh resume point, without the effect ever watching the value.
 */

type YTPlayer = {
  getCurrentTime: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  destroy: () => void;
};

type YTPlayerEvent = { target: YTPlayer; data?: number };

type YTNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: YTPlayerEvent) => void;
        onStateChange?: (event: YTPlayerEvent) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number };
};

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const POLL_MS = 10_000;
const MIN_MOVE_S = 5;
let apiReady: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  if (apiReady) return apiReady;
  apiReady = new Promise<YTNamespace>((resolve) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    window.onYouTubeIframeAPIReady = () => resolve(window.YT as YTNamespace);
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return apiReady;
}

export function YouTubePlayer({
  videoId,
  startAt,
  onPosition,
  onEnded,
}: {
  videoId: string;
  startAt: number;
  onPosition: (seconds: number) => void;
  onEnded: () => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);

  // Initial values only. These deliberately do not track their props.
  const startAtRef = useRef(startAt);
  const lastSavedRef = useRef(startAt);

  const positionRef = useRef(onPosition);
  const endedRef = useRef(onEnded);
  positionRef.current = onPosition;
  endedRef.current = onEnded;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    // Skip writes that would not move the resume point. Each one costs a
    // Firestore round trip and a re-render for no gain.
    const flush = () => {
      const seconds = playerRef.current?.getCurrentTime?.() ?? 0;
      if (seconds < 3) return;
      if (Math.abs(seconds - lastSavedRef.current) < MIN_MOVE_S) return;
      lastSavedRef.current = seconds;
      positionRef.current(seconds);
    };

    void loadApi().then((YT) => {
      if (cancelled || !mountRef.current) return;
      playerRef.current = new YT.Player(mountRef.current, {
        videoId,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: (event) => {
            if (startAtRef.current > 3) event.target.seekTo(startAtRef.current, true);
          },
          onStateChange: (event) => {
            if (event.data === YT.PlayerState.PLAYING) {
              window.clearInterval(timer);
              timer = window.setInterval(flush, POLL_MS);
            } else {
              window.clearInterval(timer);
              flush();
              if (event.data === YT.PlayerState.ENDED) endedRef.current();
            }
          },
        },
      });
    });

    const onHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
      playerRef.current?.destroy?.();
      playerRef.current = null;
    };
  }, [videoId]);

  return (
    <div style={{ aspectRatio: "16 / 9", background: "#000" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
