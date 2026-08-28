import { Alert, Box, Button, Group, Loader } from "@mantine/core";
import { IconAlertTriangle, IconPlayerPlayFilled } from "@tabler/icons-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { ApiError, streamUrl } from "../api";

/**
 * A Drive lecture, played through the API's Range proxy.
 *
 * The stream URL is fetched **once per lecture**. It used to be re-fetched
 * whenever the lecture list changed, and since Firestore hands back a new array
 * on every snapshot, a note autosave or a position write swapped `<video src>`
 * and reloaded the video from the beginning. Same defect as the YouTube player
 * had, arriving through a different door.
 *
 * The resume point is likewise read once, on mount. Mount with
 * `key={lecture.id}` so a different lecture remounts and picks up its own.
 */

const MIN_MOVE_S = 5;

export type DrivePlayerHandle = {
  /**
   * Put the video element itself fullscreen, the only kind of fullscreen an
   * iPhone has. Returns false when the engine doesn't offer it, so the caller
   * can fall back to element fullscreen instead of leaving a dead button.
   */
  enterNativeFullscreen: () => boolean;
};

type WebKitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
};

export function DrivePlayer({
  lectureId,
  startAt,
  autoPlay = false,
  onPosition,
  onEnded,
  ref,
}: {
  lectureId: string;
  startAt: number;
  autoPlay?: boolean;
  onPosition: (seconds: number) => void;
  onEnded: () => void;
  ref?: Ref<DrivePlayerHandle>;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resumedRef = useRef(false);
  const startAtRef = useRef(startAt);
  const lastSavedRef = useRef(startAt);
  // Read once. Auto-advance sets it via router state, and that state survives
  // a re-render — tracking the prop would re-arm autoplay on every snapshot.
  const autoPlayRef = useRef(autoPlay);

  const positionRef = useRef(onPosition);
  const endedRef = useRef(onEnded);
  positionRef.current = onPosition;
  endedRef.current = onEnded;

  useImperativeHandle(ref, () => ({
    enterNativeFullscreen: () => {
      const video = videoRef.current as WebKitVideo | null;
      if (!video?.webkitEnterFullscreen) return false;
      // webkitEnterFullscreen is a no-op before metadata has loaded, which is
      // exactly when someone taps the button on a cold page.
      if (video.readyState >= 1) {
        video.webkitEnterFullscreen();
      } else {
        video.addEventListener(
          "loadedmetadata",
          () => (video as WebKitVideo).webkitEnterFullscreen?.(),
          { once: true },
        );
      }
      return true;
    },
  }), []);

  useEffect(() => {
    let live = true;
    streamUrl(lectureId)
      .then((result) => live && setSrc(result.url))
      .catch(
        (exc: unknown) =>
          live && setError(exc instanceof ApiError ? exc.message : String(exc)),
      );
    return () => {
      live = false;
    };
  }, [lectureId]);

  useEffect(() => {
    const flush = () => {
      const seconds = videoRef.current?.currentTime ?? 0;
      if (seconds < 3) return;
      if (Math.abs(seconds - lastSavedRef.current) < MIN_MOVE_S) return;
      lastSavedRef.current = seconds;
      positionRef.current(seconds);
    };

    // Locking an iPhone or switching apps fires neither `unload` nor a React
    // unmount. These two do fire, and resume is what makes phone-then-laptop
    // work at all.
    const onHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);

  if (error) {
    return (
      <Alert color="red" icon={<IconAlertTriangle size={16} />} radius={0}>
        {error}
      </Alert>
    );
  }

  if (!src) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  return (
    <Box pos="relative">
      <video
        ref={videoRef}
        src={src}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (resumedRef.current) return;
          resumedRef.current = true;
          if (startAtRef.current > 3) video.currentTime = startAtRef.current;
          if (!autoPlayRef.current) return;
          // Auto-advance crosses a route change and an async stream-URL fetch,
          // which breaks the user-gesture chain. Blink usually allows it
          // anyway; WebKit usually doesn't. A rejected promise is the normal
          // outcome, not an error — offer the tap instead of dying silently.
          void video.play().catch(() => setAutoplayBlocked(true));
        }}
        onPlay={() => setAutoplayBlocked(false)}
        onPause={() => {
          const seconds = videoRef.current?.currentTime ?? 0;
          if (seconds >= 3) {
            lastSavedRef.current = seconds;
            positionRef.current(seconds);
          }
        }}
        onEnded={() => endedRef.current()}
      />

      {autoplayBlocked && (
        <Group
          justify="center"
          pos="absolute"
          inset={0}
          style={{ background: "rgba(0,0,0,.45)", pointerEvents: "none" }}
        >
          <Button
            size="md"
            leftSection={<IconPlayerPlayFilled size={18} />}
            style={{ pointerEvents: "auto" }}
            onClick={() => void videoRef.current?.play().catch(() => undefined)}
          >
            Play
          </Button>
        </Group>
      )}
    </Box>
  );
}
