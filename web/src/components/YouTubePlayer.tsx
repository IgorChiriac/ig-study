import { useEffect, useRef } from "react";

/**
 * A YouTube lecture, played through the IFrame Player API.
 *
 * This is the supported way to embed YouTube, and unlike Drive's iframe player
 * it exposes `getCurrentTime` and `seekTo` — which is the whole reason
 * `decisions.md` §2 rejected an iframe for Drive but embedding is right here.
 * No proxy, no egress, no Range semantics.
 *
 * Position is polled while playing rather than read on unmount, for the same
 * reason the Drive player writes on `pagehide`: locking an iPhone fires no
 * unmount, and a poll that already happened is worth more than a teardown that
 * never runs.
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

const POLL_MS = 5000;
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
  const positionRef = useRef(onPosition);
  const endedRef = useRef(onEnded);
  positionRef.current = onPosition;
  endedRef.current = onEnded;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const flush = () => {
      const seconds = playerRef.current?.getCurrentTime?.() ?? 0;
      if (seconds > 3) positionRef.current(seconds);
    };

    void loadApi().then((YT) => {
      if (cancelled || !mountRef.current) return;
      playerRef.current = new YT.Player(mountRef.current, {
        videoId,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: (event) => {
            if (startAt > 3) event.target.seekTo(startAt, true);
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
  }, [videoId, startAt]);

  return (
    <div style={{ aspectRatio: "16 / 9", background: "#000" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
