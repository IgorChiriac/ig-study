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
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { CardDrafts } from "../components/CardDrafts";
import { DrivePlayer } from "../components/DrivePlayer";
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
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(true);

  const noteLoadedRef = useRef(false);

  useEffect(() => watchLectures(uid, projectId, setLectures), [uid, projectId]);

  const lecture = lectures?.find((entry) => entry.id === lectureId) ?? null;
  const index = lectures?.findIndex((entry) => entry.id === lectureId) ?? -1;
  const previous = index > 0 ? lectures?.[index - 1] : undefined;
  const next = index >= 0 && lectures ? lectures[index + 1] : undefined;

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
              {lecture.source === "youtube" && lecture.youtubeVideoId ? (
                <YouTubePlayer
                  key={lecture.id}
                  videoId={lecture.youtubeVideoId}
                  startAt={lecture.positionS}
                  onPosition={(seconds) =>
                    void savePosition(uid, projectId, lectureId, seconds)
                  }
                  onEnded={() => {
                    if (!lecture.seen) void setSeen(uid, projectId, lectureId, true);
                  }}
                />
              ) : (
                <DrivePlayer
                  key={lecture.id}
                  lectureId={lectureId}
                  startAt={lecture.positionS}
                  onPosition={(seconds) =>
                    void savePosition(uid, projectId, lectureId, seconds)
                  }
                  onEnded={() => {
                    if (!lecture.seen) void setSeen(uid, projectId, lectureId, true);
                  }}
                />
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
