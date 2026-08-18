import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Progress,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { ApiError, analyseGaps } from "../api";
import { watchDocs, watchGapMap, watchProjects } from "../store";
import type { DocLink, GapMap, GapTopic, Project } from "../types";

type Ctx = { uid: string };

const ORDER: GapTopic["coverage"][] = ["missing", "partial", "covered"];

const STYLE: Record<
  GapTopic["coverage"],
  { label: string; colour: string; icon: React.ReactNode; blurb: string }
> = {
  missing: {
    label: "Not in the course",
    colour: "red",
    icon: <IconCircleX size={16} />,
    blurb: "The documentation covers this and no lecture addresses it. Start here.",
  },
  partial: {
    label: "Course stops short",
    colour: "yellow",
    icon: <IconCircleDashed size={16} />,
    blurb:
      "A lecture opens the topic but the documentation carries specifics an exam could reach.",
  },
  covered: {
    label: "Course covers it",
    colour: "teal",
    icon: <IconCircleCheck size={16} />,
    blurb: "Taught by a lecture. Worth confirming, not studying from scratch.",
  },
};

export function Gaps() {
  const { uid } = useOutletContext<Ctx>();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();

  const [map, setMap] = useState<GapMap | null | undefined>(undefined);
  const [docs, setDocs] = useState<DocLink[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => watchGapMap(uid, projectId, setMap), [uid, projectId]);
  useEffect(() => watchDocs(uid, projectId, setDocs), [uid, projectId]);
  useEffect(() => watchProjects(uid, setProjects), [uid]);

  const project = projects.find((entry) => entry.id === projectId);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await analyseGaps(projectId);
      notifications.show({ title: "Analysis complete", message: "", color: "teal" });
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  const counts = ORDER.map((status) => ({
    status,
    n: map?.topics.filter((topic) => topic.coverage === status).length ?? 0,
  }));
  const total = counts.reduce((sum, entry) => sum + entry.n, 0);

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

      <Group justify="space-between" align="flex-end" mb="lg">
        <Stack gap={0}>
          <Title order={3}>Coverage</Title>
          <Text size="sm" c="dimmed">
            What the documentation covers that the course does not
          </Text>
        </Stack>
        <Button
          onClick={() => void run()}
          loading={busy}
          disabled={docs.length === 0}
          variant={map ? "light" : "filled"}
          leftSection={map ? <IconRefresh size={16} /> : <IconSparkles size={16} />}
        >
          {map ? "Re-analyse" : "Analyse"}
        </Button>
      </Group>

      {error && (
        <Alert color="red" mb="lg" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      {docs.length === 0 && (
        <Alert color="yellow" variant="light" mb="lg" icon={<IconAlertTriangle size={16} />}>
          <Text size="sm">
            Nothing to compare against yet. Store some documentation on the{" "}
            <Anchor component={Link} to={`/c/${projectId}/docs`} size="sm">
              Docs
            </Anchor>{" "}
            page first.
          </Text>
        </Alert>
      )}

      {map === undefined ? (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      ) : map === null ? (
        docs.length > 0 && (
          <Card withBorder padding="xl" radius="md">
            <Stack align="center" gap="sm">
              <ThemeIcon size={44} radius="xl" variant="light" color="violet">
                <IconSparkles size={22} />
              </ThemeIcon>
              <Text fw={600}>Not analysed yet</Text>
              <Text size="sm" c="dimmed" ta="center" maw={460}>
                Reads all {docs.length} stored document{docs.length === 1 ? "" : "s"} against
                every lecture title in one pass, and reports what the course never teaches. The
                heaviest call in the app — around a third of a dollar for a handful of chapters.
              </Text>
            </Stack>
          </Card>
        )
      ) : (
        <>
          <Card withBorder padding="lg" radius="md" mb="lg">
            <Text size="sm" mb="md">
              {map.summary}
            </Text>
            <Progress.Root size={18} radius="sm">
              {counts.map(({ status, n }) => (
                <Tooltip key={status} label={`${STYLE[status].label}: ${n}`} withArrow>
                  <Progress.Section
                    value={total ? (n / total) * 100 : 0}
                    color={STYLE[status].colour}
                  >
                    <Progress.Label>{n}</Progress.Label>
                  </Progress.Section>
                </Tooltip>
              ))}
            </Progress.Root>
            <Text size="xs" c="dimmed" mt="xs">
              {map.documentCount} document{map.documentCount === 1 ? "" : "s"} against{" "}
              {map.lectureCount} lectures
            </Text>
          </Card>

          <Accordion multiple defaultValue={["missing", "partial"]} variant="separated">
            {ORDER.map((status) => {
              const rows = map.topics.filter((topic) => topic.coverage === status);
              if (rows.length === 0) return null;
              return (
                <Accordion.Item key={status} value={status}>
                  <Accordion.Control icon={STYLE[status].icon}>
                    <Group justify="space-between" pr="sm">
                      <Text fw={600} size="sm">
                        {STYLE[status].label}
                      </Text>
                      <Badge variant="light" color={STYLE[status].colour}>
                        {rows.length}
                      </Badge>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Text size="xs" c="dimmed" mb="sm">
                      {STYLE[status].blurb}
                    </Text>
                    <Stack gap="sm">
                      {rows.map((topic) => (
                        <Card key={topic.topic} withBorder padding="sm" radius="md">
                          <Group gap={6} mb={4} wrap="nowrap">
                            {topic.importance === "core" && (
                              <Badge size="xs" color="violet">
                                core
                              </Badge>
                            )}
                            <Text fw={600} size="sm">
                              {topic.topic}
                            </Text>
                          </Group>
                          <Text size="sm" c="dimmed">
                            {topic.why}
                          </Text>
                          <Group justify="space-between" mt="xs" wrap="nowrap">
                            <Text size="xs" c="dimmed" truncate>
                              {topic.lectures.length
                                ? `Lectures: ${topic.lectures.join(" · ")}`
                                : topic.sourceSection}
                            </Text>
                            {status !== "covered" && (
                              <Button
                                size="compact-xs"
                                variant="light"
                                leftSection={<IconSparkles size={12} />}
                                onClick={() =>
                                  navigate(
                                    `/c/${projectId}/docs?focus=${encodeURIComponent(topic.topic)}`,
                                  )
                                }
                              >
                                Cards
                              </Button>
                            )}
                          </Group>
                        </Card>
                      ))}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        </>
      )}
    </Container>
  );
}
