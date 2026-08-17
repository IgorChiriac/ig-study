import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Progress,
  RingProgress,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCards,
  IconChevronLeft,
  IconClock,
  IconFlame,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";

import { ActivityBars, RankedBars } from "../components/charts";
import { saveGoal, watchCards, watchLectures, watchProjects, watchRecentReviews } from "../store";
import type { Card as CardDoc, Lecture, Project, Review } from "../types";

type Ctx = { uid: string };

const WINDOW_DAYS = 30;
const PASS = 3;

function hours(seconds: number): string {
  const total = Math.round(seconds / 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function Tile({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
}) {
  return (
    <Card withBorder padding="md" radius="md">
      <Group wrap="nowrap" gap="sm" align="flex-start">
        <ThemeIcon size={34} radius="md" variant="light" color="violet">
          {icon}
        </ThemeIcon>
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            {label}
          </Text>
          <Text fw={700} size="lg">
            {value}
          </Text>
          {sub && (
            <Text size="xs" c="dimmed">
              {sub}
            </Text>
          )}
        </Stack>
      </Group>
    </Card>
  );
}

export function Stats() {
  const { uid } = useOutletContext<Ctx>();
  const { projectId = "" } = useParams();

  const [lectures, setLectures] = useState<Lecture[] | null>(null);
  const [cards, setCards] = useState<CardDoc[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => watchLectures(uid, projectId, setLectures), [uid, projectId]);
  useEffect(() => watchCards(uid, projectId, setCards), [uid, projectId]);
  useEffect(
    () => watchRecentReviews(uid, projectId, WINDOW_DAYS, setReviews),
    [uid, projectId],
  );
  useEffect(() => watchProjects(uid, setProjects), [uid]);

  const project = projects.find((entry) => entry.id === projectId);

  const activity = useMemo(() => {
    const counts = new Map<string, number>();
    for (const review of reviews) {
      const key = dayKey(review.answeredAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from({ length: WINDOW_DAYS }, (_, offset) => {
      const date = new Date();
      date.setDate(date.getDate() - (WINDOW_DAYS - 1 - offset));
      return { date, count: counts.get(dayKey(date)) ?? 0 };
    });
  }, [reviews]);

  const modules = useMemo(() => {
    const buckets = new Map<string, number[]>();
    for (const review of reviews) {
      const key = review.module || "Lectures";
      buckets.set(key, [...(buckets.get(key) ?? []), review.grade]);
    }
    return Array.from(buckets.entries())
      .map(([label, grades]) => ({
        label,
        value: grades.reduce((sum, grade) => sum + grade, 0) / grades.length,
        hint: `${grades.length} review${grades.length === 1 ? "" : "s"}`,
      }))
      .sort((left, right) => left.value - right.value);
  }, [reviews]);

  if (lectures === null) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  const seen = lectures.filter((lecture) => lecture.seen).length;
  const pct = lectures.length ? Math.round((seen / lectures.length) * 100) : 0;
  const remainingS = lectures
    .filter((lecture) => !lecture.seen)
    .reduce((sum, lecture) => sum + (lecture.durationS ?? 0), 0);
  const withNotes = lectures.filter((lecture) => lecture.note.trim()).length;

  const today = dayKey(new Date());
  const due = cards.filter((card) => card.due <= today).length;
  const leeches = cards.filter((card) => card.lapses >= 8);

  const passed = reviews.filter((review) => review.grade >= PASS).length;
  const retention = reviews.length ? Math.round((passed / reviews.length) * 100) : null;

  const goalDate = project?.goalDate ?? null;
  const daysLeft = goalDate
    ? Math.ceil((new Date(goalDate).getTime() - Date.now()) / 86_400_000)
    : null;
  const remainingLectures = lectures.length - seen;
  const perDay =
    daysLeft && daysLeft > 0 ? Math.ceil(remainingLectures / daysLeft) : remainingLectures;

  return (
    <Container size="md" py="md">
      <Anchor
        component={Link}
        to={`/c/${projectId}`}
        size="sm"
        mb="xs"
        style={{ display: "inline-block" }}
      >
        <Group gap={4}>
          <IconChevronLeft size={14} />
          {project?.name ?? projectId}
        </Group>
      </Anchor>

      <Title order={3} mb="lg">
        Stats
      </Title>

      <Card withBorder padding="lg" radius="md" mb="lg">
        <Group wrap="nowrap" align="center" gap="xl">
          <RingProgress
            size={110}
            thickness={10}
            roundCaps
            sections={[{ value: pct, color: pct === 100 ? "teal" : "violet" }]}
            label={
              <Text ta="center" fw={700} size="lg">
                {pct}%
              </Text>
            }
          />
          <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
            <Text fw={600}>
              {seen} of {lectures.length} lectures watched
            </Text>
            <Text size="sm" c="dimmed">
              {hours(remainingS)} of viewing left · {withNotes} lecture
              {withNotes === 1 ? "" : "s"} with notes
            </Text>
            <Progress
              value={(withNotes / Math.max(1, lectures.length)) * 100}
              size="sm"
              radius="xl"
              color="violet"
              mt={4}
            />
            <Text size="xs" c="dimmed">
              Notes written — cards can only be as good as these
            </Text>
          </Stack>
        </Group>
      </Card>

      <SimpleGrid cols={{ base: 2, sm: 4 }} mb="lg">
        <Tile
          label="Cards"
          value={String(cards.length)}
          sub={`${due} due now`}
          icon={<IconCards size={18} />}
        />
        <Tile
          label="Retention"
          value={retention === null ? "—" : `${retention}%`}
          sub={reviews.length ? `${reviews.length} reviews / ${WINDOW_DAYS}d` : "no reviews yet"}
          icon={<IconTargetArrow size={18} />}
        />
        <Tile
          label="Left to watch"
          value={hours(remainingS)}
          sub={`${remainingLectures} lectures`}
          icon={<IconClock size={18} />}
        />
        <Tile
          label="Leeches"
          value={String(leeches.length)}
          sub={leeches.length ? "8+ lapses" : "none"}
          icon={<IconFlame size={18} />}
        />
      </SimpleGrid>

      <Card withBorder padding="lg" radius="md" mb="lg">
        <Group justify="space-between" mb="xs">
          <Title order={5}>Goal</Title>
          {goalDate && daysLeft !== null && (
            <Badge variant="light" color={daysLeft < 0 ? "red" : "violet"}>
              {daysLeft < 0 ? "past" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
            </Badge>
          )}
        </Group>
        <Group align="flex-end" gap="md" wrap="wrap">
          <TextInput
            type="date"
            label="Finish by"
            value={goalDate ?? ""}
            onChange={(event) =>
              void saveGoal(uid, projectId, event.currentTarget.value || null)
            }
            miw={190}
          />
          {goalDate && (
            <Text size="sm" c="dimmed" pb={6}>
              {remainingLectures === 0
                ? "Course finished — nothing left to watch."
                : daysLeft !== null && daysLeft <= 0
                  ? `${remainingLectures} lectures still to watch, and the date has passed.`
                  : `${perDay} lecture${perDay === 1 ? "" : "s"} a day to finish on time.`}
            </Text>
          )}
        </Group>
        {!goalDate && (
          <Text size="xs" c="dimmed" mt="xs">
            Set a date and this works out the pace it needs.
          </Text>
        )}
      </Card>

      <Card withBorder padding="lg" radius="md" mb="lg">
        <Title order={5} mb={4}>
          Review activity
        </Title>
        <Text size="xs" c="dimmed" mb="md">
          Cards answered per day, last {WINDOW_DAYS} days
        </Text>
        {reviews.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing yet. Answer some cards in the quiz and this fills in.
          </Text>
        ) : (
          <ActivityBars days={activity} />
        )}
      </Card>

      <Card withBorder padding="lg" radius="md">
        <Title order={5} mb={4}>
          Weakest modules
        </Title>
        <Text size="xs" c="dimmed" mb="md">
          Mean grade out of 5, weakest first
        </Text>
        {modules.length === 0 ? (
          <Text size="sm" c="dimmed">
            Needs a few graded answers before this says anything useful.
          </Text>
        ) : (
          <>
            <RankedBars
              rows={modules}
              max={5}
              format={(value) => value.toFixed(1)}
            />
            {modules[0] && modules[0].value < PASS && (
              <Alert
                mt="md"
                color="orange"
                variant="light"
                icon={<IconAlertTriangle size={16} />}
              >
                <Text size="sm">
                  <strong>{modules[0].label}</strong> is averaging below a pass. Worth
                  re-watching and rewriting the notes rather than grinding the cards.
                </Text>
              </Alert>
            )}
          </>
        )}
      </Card>

      {leeches.length > 0 && (
        <Card withBorder padding="lg" radius="md" mt="lg">
          <Group gap="xs" mb="xs">
            <IconFlame size={18} />
            <Title order={5}>Leeches</Title>
          </Group>
          <Text size="sm" c="dimmed">
            {leeches.length} card{leeches.length === 1 ? " has" : "s have"} lapsed eight times
            or more. At that point the card is usually the problem, not you — rewrite it, or
            go back to the lecture it came from.
          </Text>
          <Button component={Link} to="/quiz" variant="light" size="xs" mt="md">
            Open the quiz
          </Button>
        </Card>
      )}
    </Container>
  );
}
