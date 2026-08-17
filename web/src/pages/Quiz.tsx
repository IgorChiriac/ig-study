import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Container,
  Group,
  Kbd,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconFlame,
  IconMoodCheck,
  IconSparkles,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError, answerCard, dueCards } from "../api";
import type { DueCard, DueQueue, GradeResult } from "../types";

const SCORE_COLOR = ["red", "red", "orange", "yellow", "lime", "teal"] as const;
const SCORE_LABEL = [
  "Wrong or blank",
  "Mostly wrong, on topic",
  "Core misunderstanding",
  "Right idea, real gap",
  "Correct, minor imprecision",
  "Complete and precise",
] as const;

function Feedback({ grade, onNext }: { grade: GradeResult; onNext: () => void }) {
  const color = SCORE_COLOR[grade.score];
  return (
    <Stack gap="md">
      <Group gap="sm">
        <ThemeIcon color={color} size={44} radius="xl">
          <Text fw={700} size="lg">
            {grade.score}
          </Text>
        </ThemeIcon>
        <Stack gap={0}>
          <Text fw={600}>{SCORE_LABEL[grade.score]}</Text>
          <Text size="xs" c="dimmed">
            Back in {grade.intervalDays} day{grade.intervalDays === 1 ? "" : "s"} · {grade.nextDue}
          </Text>
        </Stack>
      </Group>

      <Text size="sm">{grade.verdict}</Text>

      {grade.missing.trim() && (
        <Alert color="yellow" variant="light" title="What was missing">
          <Text size="sm">{grade.missing}</Text>
        </Alert>
      )}
      {grade.correction.trim() && (
        <Alert color="blue" variant="light" title="Correction">
          <Text size="sm">{grade.correction}</Text>
        </Alert>
      )}

      <Paper withBorder p="sm" radius="md" bg="dark.7">
        <Text size="xs" c="dimmed" mb={4}>
          Reference answer
        </Text>
        <Text size="sm">{grade.reference}</Text>
      </Paper>

      {grade.isLeech && (
        <Alert color="orange" variant="light" icon={<IconFlame size={16} />} title="Leech">
          <Text size="sm">
            This card has lapsed repeatedly. At this point the card is usually the problem, not
            you — consider rewriting it or re-watching that part of the lecture.
          </Text>
        </Alert>
      )}

      <Button
        onClick={onNext}
        rightSection={<IconArrowRight size={16} />}
        size="md"
        autoFocus
      >
        Next
      </Button>
    </Stack>
  );
}

export function Quiz() {
  const [queue, setQueue] = useState<DueQueue | null>(null);
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    dueCards()
      .then(setQueue)
      .catch((exc: unknown) =>
        setError(exc instanceof ApiError ? exc.message : String(exc)),
      );
  }, []);

  const card: DueCard | undefined = queue?.cards[index];

  async function submit() {
    if (!card || busy) return;
    setBusy(true);
    setError(null);
    try {
      setGrade(await answerCard(card.id, card.projectId, text));
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  function next() {
    setGrade(null);
    setText("");
    setIndex((current) => current + 1);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  if (error && !queue) {
    return (
      <Container size="sm" py="xl">
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      </Container>
    );
  }

  if (!queue) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  if (queue.cards.length === 0 || !card) {
    const finished = queue.cards.length > 0;
    return (
      <Container size="sm" py="xl">
        <Card withBorder padding="xl" radius="md">
          <Stack align="center" gap="sm">
            <ThemeIcon size={52} radius="xl" color="teal" variant="light">
              <IconMoodCheck size={28} />
            </ThemeIcon>
            <Text fw={600}>{finished ? "Done for today" : "Nothing due"}</Text>
            <Text c="dimmed" size="sm" ta="center">
              {finished
                ? `${queue.cards.length} card${queue.cards.length === 1 ? "" : "s"} reviewed. The next batch unlocks as they come due.`
                : "Write notes on a lecture and generate cards from them to start."}
            </Text>
            <Button component={Link} to="/" variant="light" mt="xs">
              Back to courses
            </Button>
          </Stack>
        </Card>
      </Container>
    );
  }

  return (
    <Container size="sm" py="md">
      <Stack gap="xs" mb="lg">
        <Group justify="space-between">
          <Group gap="xs">
            <Badge variant="light" color={card.isNew ? "violet" : "blue"}>
              {card.isNew ? "new" : "review"}
            </Badge>
            {card.module && (
              <Text size="xs" c="dimmed" lineClamp={1}>
                {card.module}
              </Text>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {index + 1} / {queue.cards.length}
          </Text>
        </Group>
        <Progress value={((index + (grade ? 1 : 0)) / queue.cards.length) * 100} radius="xl" />
      </Stack>

      <Card withBorder padding="lg" radius="md">
        <Stack gap="md">
          <Title order={4} style={{ lineHeight: 1.35 }}>
            {card.q}
          </Title>

          {grade ? (
            <Feedback grade={grade} onNext={next} />
          ) : (
            <>
              <Textarea
                ref={inputRef}
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
                placeholder="Answer in your own words. You're graded on understanding, not wording."
                autosize
                minRows={5}
                maxRows={14}
                disabled={busy}
                autoFocus
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
              {error && (
                <Alert color="red" icon={<IconAlertTriangle size={16} />}>
                  {error}
                </Alert>
              )}
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  <Kbd>⌘</Kbd> + <Kbd>↵</Kbd> to submit
                </Text>
                <Button
                  onClick={() => void submit()}
                  loading={busy}
                  leftSection={<IconCheck size={16} />}
                >
                  {busy ? "Grading…" : "Submit"}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Card>

      <Group justify="center" mt="md" gap="xs">
        <IconSparkles size={13} opacity={0.5} />
        <Text size="xs" c="dimmed">
          {queue.reviewsDue} review{queue.reviewsDue === 1 ? "" : "s"} · {queue.newDue} new due
          today
        </Text>
      </Group>
    </Container>
  );
}
