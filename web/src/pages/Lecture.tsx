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
  Switch,
  Text,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import {
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconMaximize,
  IconMinimize,
  IconPlayerPlayFilled,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";

import { CardDrafts } from "../components/CardDrafts";
import { DrivePlayer, type DrivePlayerHandle } from "../components/DrivePlayer";
import { supportsElementFullscreen, useElementFullscreen } from "../components/fullscreen";
import { YouTubePlayer } from "../components/YouTubePlayer";
import { savePosition, saveNote, setSeen, watchLectures } from "../store";
import type { Lecture as LectureDoc } from "../types";

type Ctx = { uid: string };

const NOTE_DEBOUNCE_MS = 2000;

/**
 * Seconds between a lecture ending and the next one starting.
 *
 * Long enough to cancel without hurrying, short enough not to feel broken. It
 * is deliberately *not* zero: this app's loop is watch → write the note →
 * generate cards, and auto-advance works against that loop unless there's a
 * moment to stop. Same tension `decisions.md` §2 records about the iframe
 * fallback, which is why the whole feature is opt-in.
 */
const AUTO_ADVANCE_S = 6;

export function Lecture() {
  const { uid } = useOutletContext<Ctx>();
  const { projectId = "", lectureId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [lectures, setLectures] = useState<LectureDoc[] | null>(null);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(true);
  const [countdown, setCountdown] = useState<number | null>(null);

  const [autoAdvance, setAutoAdvance] = useLocalStorage({
    key: "ig-study:auto-advance",
    defaultValue: false,
  });

  const noteLoadedRef = useRef(false);
  const playerRef = useRef<DrivePlayerHandle>(null);
  const stage = useElementFullscreen<HTMLDivElement>();
  // Engine capability, fixed for the life of the tab.
  const [elementFullscreen] = useState(supportsElementFullscreen);

  // Set by auto-advance when it navigates here. Router state survives
  // re-renders, so the player reads it once into a ref of its own.
  const autoPlay = (location.state as { autoplay?: boolean } | null)?.autoplay === true;

  useEffect(() => watchLectures(uid, projectId, setLectures), [uid, projectId]);

  const lecture = lectures?.find((entry) => entry.id === lectureId) ?? null;
  const index = lectures?.findIndex((entry) => entry.id === lectureId) ?? -1;
  const previous = index > 0 ? lectures?.[index - 1] : undefined;
  const next = index >= 0 && lectures ? lectures[index + 1] : undefined;

  // The route element is not keyed, so moving between lectures updates the
  // params without remounting this page. Every latch below has to be released
  // by hand or it carries the previous lecture's state across — for the note
  // that meant the old text staying in the editor and then being autosaved
  // onto the new lecture, which auto-advance would do 36 times a course.
  useEffect(() => {
    noteLoadedRef.current = false;
    setNote("");
    setSaved(true);
    setCountdown(null);
  }, [lectureId]);

  useEffect(() => {
    if (lecture && !noteLoadedRef.current) {
      noteLoadedRef.current = true;
      setNote(lecture.note);
    }
  }, [lecture]);

  // Depends on the note text, not the whole lecture. Watching the document
  // would restart the debounce every time anything else on it changed — a
  // position write, a seen flag — for a value that had not moved.
  const savedNote = lecture?.note;

  useEffect(() => {
    if (!noteLoadedRef.current) return;
    if (note === savedNote) {
      setSaved(true);
      return;
    }
    setSaved(false);
    const timer = setTimeout(() => {
      void saveNote(uid, projectId, lectureId, note).then(() => setSaved(true));
    }, NOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [note, savedNote, uid, projectId, lectureId]);

  const goNext = (autoplay: boolean) => {
    if (!next) return;
    setCountdown(null);
    navigate(`/c/${projectId}/${next.id}`, { state: { autoplay } });
  };

  // One timer per tick rather than one interval, so cancelling is just
  // clearing state and there is nothing left running behind it.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      goNext(true);
      return;
    }
    const timer = setTimeout(() => setCountdown((value) => (value ?? 1) - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  const handleEnded = () => {
    if (lecture && !lecture.seen) void setSeen(uid, projectId, lectureId, true);
    if (autoAdvance && next) setCountdown(AUTO_ADVANCE_S);
  };

  const toggleFullscreen = () => {
    // Blink and desktop WebKit: the whole stage goes fullscreen, notes and all.
    if (elementFullscreen) {
      stage.toggle();
      return;
    }
    // iPhone: only a <video> can. Drive gets the native player; the YouTube
    // iframe is cross-origin, so its own control is the only route in — which
    // is why the button is disabled for it rather than lying.
    playerRef.current?.enterNativeFullscreen();
  };

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

  const isYouTube = lecture.source === "youtube" && lecture.youtubeVideoId;
  const canFullscreen = elementFullscreen || !isYouTube;

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

      <div ref={stage.ref} className="lecture-stage">
        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, md: 7 }}>
            <Stack gap="sm">
              <Paper withBorder radius="md" style={{ overflow: "hidden" }}>
                {isYouTube ? (
                  <YouTubePlayer
                    key={lecture.id}
                    videoId={lecture.youtubeVideoId as string}
                    startAt={lecture.positionS}
                    autoPlay={autoPlay}
                    onPosition={(seconds) =>
                      void savePosition(uid, projectId, lectureId, seconds)
                    }
                    onEnded={handleEnded}
                  />
                ) : (
                  <DrivePlayer
                    key={lecture.id}
                    ref={playerRef}
                    lectureId={lectureId}
                    startAt={lecture.positionS}
                    autoPlay={autoPlay}
                    onPosition={(seconds) =>
                      void savePosition(uid, projectId, lectureId, seconds)
                    }
                    onEnded={handleEnded}
                  />
                )}
              </Paper>

              {countdown !== null && next && (
                <Alert color="violet" p="xs" radius="md">
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Text size="sm" lineClamp={1}>
                      Next in {countdown}s — {next.title}
                    </Text>
                    <Group gap="xs" wrap="nowrap">
                      <Button
                        size="compact-xs"
                        leftSection={<IconPlayerPlayFilled size={12} />}
                        onClick={() => goNext(true)}
                      >
                        Now
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="default"
                        onClick={() => setCountdown(null)}
                      >
                        Stay
                      </Button>
                    </Group>
                  </Group>
                </Alert>
              )}

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
                <Tooltip
                  label="Use the player's own fullscreen control on iPhone"
                  disabled={canFullscreen}
                  events={{ hover: true, focus: true, touch: true }}
                >
                  <Button
                    variant="default"
                    size="xs"
                    disabled={!canFullscreen}
                    leftSection={
                      stage.active ? <IconMinimize size={14} /> : <IconMaximize size={14} />
                    }
                    onClick={toggleFullscreen}
                  >
                    {stage.active ? "Exit" : "Fullscreen"}
                  </Button>
                </Tooltip>
                <Button
                  variant="default"
                  size="xs"
                  disabled={!next}
                  rightSection={<IconChevronRight size={14} />}
                  onClick={() => goNext(false)}
                >
                  Next
                </Button>
              </Group>

              <Group justify="space-between" wrap="nowrap">
                <Title order={4}>{lecture.title}</Title>
                <Switch
                  size="xs"
                  label="Auto-play next"
                  checked={autoAdvance}
                  onChange={(event) => setAutoAdvance(event.currentTarget.checked)}
                  styles={{ label: { whiteSpace: "nowrap" } }}
                />
              </Group>
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
      </div>
    </Container>
  );
}
