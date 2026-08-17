import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Grid,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
} from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { ApiError, streamUrl } from "../api";
import { CardDrafts } from "../components/CardDrafts";
import { YouTubePlayer } from "../components/YouTubePlayer";
import { savePosition, saveNote, setSeen, watchLectures } from "../store";
import type { Lecture as LectureDoc } from "../types";

type Ctx = { uid: string };

const NOTE_DEBOUNCE_MS = 2000;

export function Lecture() {
  const { uid } = useOutletContext<Ctx>();
  const { projectId = "", lectureId = "" } = useParams();
  const navigate = useNavigate();

  const [lectures, setLectures] = useState<LectureDoc[] | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(true);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resumedRef = useRef(false);
  const noteLoadedRef = useRef(false);

  useEffect(() => watchLectures(uid, projectId, setLectures), [uid, projectId]);

  const lecture = lectures?.find((entry) => entry.id === lectureId) ?? null;
  const index = lectures?.findIndex((entry) => entry.id === lectureId) ?? -1;
  const previous = index > 0 ? lectures?.[index - 1] : undefined;
  const next = index >= 0 && lectures ? lectures[index + 1] : undefined;

  const isYouTube = lecture?.source === "youtube";

  useEffect(() => {
    resumedRef.current = false;
    noteLoadedRef.current = false;
    setSrc(null);
    setError(null);
    if (lectures === null || isYouTube) return;

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
  }, [lectureId, lectures, isYouTube]);

  useEffect(() => {
    if (lecture && !noteLoadedRef.current) {
      noteLoadedRef.current = true;
      setNote(lecture.note);
    }
  }, [lecture]);

  useEffect(() => {
    if (!noteLoadedRef.current) return;
    if (lecture && note === lecture.note) {
      setSaved(true);
      return;
    }
    setSaved(false);
    const timer = setTimeout(() => {
      void saveNote(uid, projectId, lectureId, note).then(() => setSaved(true));
    }, NOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [note, lecture, uid, projectId, lectureId]);

  const flushPosition = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.currentTime < 3) return;
    void savePosition(uid, projectId, lectureId, video.currentTime);
  }, [uid, projectId, lectureId]);

  /**
   * Resume is what makes phone-then-laptop actually work, so it has to survive
   * the ways a mobile session really ends. On iOS, switching apps or locking
   * the screen fires neither `unload` nor a React unmount -- `pagehide` and
   * `visibilitychange` are the events that do fire.
   */
  useEffect(() => {
    const onHide = () => flushPosition();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushPosition();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flushPosition();
    };
  }, [flushPosition]);

  if (lectures === null) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  if (!lecture) {
    return (
      <Container size="md" py="md">
        <Alert color="red">That lecture is not in this course.</Alert>
      </Container>
    );
  }

  return (
    <Container size="xl" py="md">
      <Anchor
        component={Link}
        to={`/c/${projectId}`}
        size="sm"
        mb="xs"
        style={{ display: "inline-block" }}
      >
        <Group gap={4}>
          <IconChevronLeft size={14} />
          {lecture.module || "Course"}
        </Group>
      </Anchor>

      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap="sm">
            <Paper withBorder radius="md" style={{ overflow: "hidden" }}>
              {error ? (
                <Alert color="red" icon={<IconAlertTriangle size={16} />} radius={0}>
                  {error}
                </Alert>
              ) : lecture.source === "youtube" && lecture.youtubeVideoId ? (
                <YouTubePlayer
                  videoId={lecture.youtubeVideoId}
                  startAt={lecture.positionS}
                  onPosition={(seconds) =>
                    void savePosition(uid, projectId, lectureId, seconds)
                  }
                  onEnded={() => {
                    if (!lecture.seen) void setSeen(uid, projectId, lectureId, true);
                  }}
                />
              ) : src ? (
                <video
                  ref={videoRef}
                  src={src}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    if (resumedRef.current) return;
                    resumedRef.current = true;
                    if (lecture.positionS > 3) {
                      event.currentTarget.currentTime = lecture.positionS;
                    }
                  }}
                  onPause={flushPosition}
                  onEnded={() => {
                    if (!lecture.seen) void setSeen(uid, projectId, lectureId, true);
                  }}
                />
              ) : (
                <Group justify="center" py="xl">
                  <Loader size="sm" />
                </Group>
              )}
            </Paper>

            <Group justify="space-between" wrap="nowrap">
              <Button
                variant="default"
                size="xs"
                disabled={!previous}
                leftSection={<IconChevronLeft size={14} />}
                onClick={() => previous && navigate(`/c/${projectId}/${previous.id}`)}
              >
                Prev
              </Button>
              <Button
                size="xs"
                variant={lecture.seen ? "light" : "filled"}
                color={lecture.seen ? "teal" : "violet"}
                leftSection={<IconCircleCheck size={16} />}
                onClick={() => void setSeen(uid, projectId, lectureId, !lecture.seen)}
              >
                {lecture.seen ? "Seen" : "Mark seen"}
              </Button>
              <Button
                variant="default"
                size="xs"
                disabled={!next}
                rightSection={<IconChevronRight size={14} />}
                onClick={() => next && navigate(`/c/${projectId}/${next.id}`)}
              >
                Next
              </Button>
            </Group>

            <Title order={4}>{lecture.title}</Title>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack gap="xs">
            <Group justify="space-between">
              <Group gap="xs">
                <Text fw={600} size="sm">
                  Your notes
                </Text>
                <CardDrafts
                  lectureId={lectureId}
                  projectId={projectId}
                  hasNote={note.trim().length > 20}
                  onSaved={() => undefined}
                />
              </Group>
              <Badge size="xs" variant="light" color={saved ? "teal" : "yellow"}>
                {saved ? "saved" : "saving…"}
              </Badge>
            </Group>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
              placeholder="What did you actually understand? Write it in your own words — this is what the cards get made from."
              autosize
              minRows={14}
              maxRows={30}
            />
            <Text size="xs" c="dimmed">
              Saves automatically, straight to Firestore. Write at least a couple of sentences
              before generating cards — they can only be as good as the note.
            </Text>
          </Stack>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
