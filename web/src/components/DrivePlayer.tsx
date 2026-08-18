import { Alert, Group, Loader } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

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

export function DrivePlayer({
  lectureId,
  startAt,
  onPosition,
  onEnded,
}: {
  lectureId: string;
  startAt: number;
  onPosition: (seconds: number) => void;
  onEnded: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resumedRef = useRef(false);
  const startAtRef = useRef(startAt);
  const lastSavedRef = useRef(startAt);

  const positionRef = useRef(onPosition);
  const endedRef = useRef(onEnded);
  positionRef.current = onPosition;
  endedRef.current = onEnded;

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
    <video
      ref={videoRef}
      src={src}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        if (resumedRef.current) return;
        resumedRef.current = true;
        if (startAtRef.current > 3) event.currentTarget.currentTime = startAtRef.current;
      }}
      onPause={() => {
        const seconds = videoRef.current?.currentTime ?? 0;
        if (seconds >= 3) {
          lastSavedRef.current = seconds;
          positionRef.current(seconds);
        }
      }}
      onEnded={() => endedRef.current()}
    />
  );
}
