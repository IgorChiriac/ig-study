import {
  Accordion,
  Anchor,
  Badge,
  Checkbox,
  Container,
  Group,
  Button,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconBook,
  IconChartBar,
  IconCircleCheckFilled,
  IconCircleDashed,
  IconChevronLeft,
  IconPlayerPlayFilled,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { groupByModule, setSeen, watchLectures, watchProjects } from "../store";
import type { Lecture, Module, Project } from "../types";

type Ctx = { uid: string };

/**
 * A stable, non-empty accordion value.
 *
 * Mantine throws on `value=""`, and every YouTube lecture carries an empty
 * module because a playlist is flat — so an unnamed group needs a value of its
 * own rather than the module name.
 */
function valueOf(module: Module, index = 0): string {
  return module.name || `module-${index}`;
}

function isDone(module: Module): boolean {
  return module.lectures.length > 0 && module.seenCount === module.lectures.length;
}

/**
 * The share watched, as a whole number.
 *
 * Rounding alone would report a module of two hundred lectures with one left
 * as 100%, which is the one number here that has to mean exactly what it says.
 * Anything unfinished is held at 99.
 */
function percentOf(module: Module): number {
  if (isDone(module)) return 100;
  if (module.lectures.length === 0) return 0;
  return Math.min(99, Math.round((module.seenCount / module.lectures.length) * 100));
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function Rows({
  lectures,
  uid,
  projectId,
  onOpen,
}: {
  lectures: Lecture[];
  uid: string;
  projectId: string;
  onOpen: (lectureId: string) => void;
}) {
  return (
    <Stack gap={2}>
      {lectures.map((lecture) => (
        <Group
          key={lecture.id}
          className="lecture-row"
          wrap="nowrap"
          gap="sm"
          px="xs"
          py={8}
          style={{ borderRadius: 8, cursor: "pointer" }}
          onClick={() => onOpen(lecture.id)}
        >
          <Checkbox
            checked={lecture.seen}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) =>
              void setSeen(uid, projectId, lecture.id, event.currentTarget.checked)
            }
            aria-label="Mark seen"
          />
          <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
            {lecture.title}
          </Text>
          {lecture.note.trim() && (
            <Badge size="xs" variant="dot" color="violet">
              note
            </Badge>
          )}
          {lecture.positionS > 5 && !lecture.seen && (
            <IconPlayerPlayFilled size={12} opacity={0.5} />
          )}
          <Text size="xs" c="dimmed" w={44} ta="right">
            {formatDuration(lecture.durationS)}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

export function Course() {
  const { uid } = useOutletContext<Ctx>();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [lectures, setLectures] = useState<Lecture[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  // Which sections are open, and the course they were opened for. Finished
  // sections start collapsed, so what is left to watch is what you see.
  //
  // Decided once per course rather than derived from progress on every render:
  // a section that recomputed itself could not be opened to look back at, and
  // ticking the last lecture would fold the list away under the cursor just as
  // the next click landed. Finishing a section leaves it open; coming back to
  // the course is when it is out of the way.
  const [open, setOpen] = useState<{ projectId: string; values: string[] } | null>(null);

  // Cleared before resubscribing, or moving between courses would leave the
  // previous course's lectures on screen until the first snapshot arrives --
  // and would pair them with the new course's id when deciding what to
  // collapse, which is the one part that would not then correct itself.
  useEffect(() => {
    setLectures(null);
    return watchLectures(uid, projectId, setLectures);
  }, [uid, projectId]);
  useEffect(() => watchProjects(uid, setProjects), [uid]);

  useEffect(() => {
    if (lectures === null || open?.projectId === projectId) return;
    setOpen({
      projectId,
      values: groupByModule(lectures)
        // Numbered before filtering — an unnamed section's value is its
        // position, and dropping finished ones first would renumber the rest.
        .map((module, index) => ({ value: valueOf(module, index), done: isDone(module) }))
        .filter((entry) => !entry.done)
        .map((entry) => entry.value),
    });
  }, [lectures, open, projectId]);

  if (lectures === null) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  const modules = groupByModule(lectures);
  const flat = modules.length === 1 && !modules[0].name;
  const seen = lectures.filter((lecture) => lecture.seen).length;
  const pct = lectures.length ? (seen / lectures.length) * 100 : 0;

  return (
    <Container size="md" py="md">
      <Anchor component={Link} to="/" size="sm" mb="xs" style={{ display: "inline-block" }}>
        <Group gap={4}>
          <IconChevronLeft size={14} />
          All courses
        </Group>
      </Anchor>

      <Stack gap="xs" mb="lg">
        <Group justify="space-between" align="flex-end">
          <Title order={3}>
            {projects.find((entry) => entry.id === projectId)?.name ?? projectId}
          </Title>
          <Group gap="sm">
            <Text size="sm" c="dimmed">
              {seen}/{lectures.length}
            </Text>
            <Button
              component={Link}
              to={`/c/${projectId}/docs`}
              size="compact-xs"
              variant="light"
              leftSection={<IconBook size={14} />}
            >
              Docs
            </Button>
            <Button
              component={Link}
              to={`/c/${projectId}/gaps`}
              size="compact-xs"
              variant="light"
              leftSection={<IconCircleDashed size={14} />}
            >
              Coverage
            </Button>
            <Button
              component={Link}
              to={`/c/${projectId}/stats`}
              size="compact-xs"
              variant="light"
              leftSection={<IconChartBar size={14} />}
            >
              Stats
            </Button>
          </Group>
        </Group>
        <Progress value={pct} radius="xl" color={pct === 100 ? "teal" : "violet"} />
      </Stack>

      {flat ? (
        <Paper withBorder radius="md" p="xs">
          <Rows
            lectures={modules[0].lectures}
            uid={uid}
            projectId={projectId}
            onOpen={(id) => navigate(`/c/${projectId}/${id}`)}
          />
        </Paper>
      ) : (
        <Accordion
          multiple
          value={open?.projectId === projectId ? open.values : []}
          onChange={(values) => setOpen({ projectId, values })}
          variant="separated"
        >
          {modules.map((module, index) => (
            <Accordion.Item key={valueOf(module, index)} value={valueOf(module, index)}>
              <Accordion.Control>
                <Group justify="space-between" pr="sm" wrap="nowrap" gap="md">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    {isDone(module) && (
                      <IconCircleCheckFilled
                        size={16}
                        style={{ color: "var(--mantine-color-teal-5)", flexShrink: 0 }}
                      />
                    )}
                    <Text fw={600} size="sm" truncate>
                      {module.name || "Lectures"}
                    </Text>
                  </Group>
                  <Group gap="sm" wrap="nowrap">
                    <Progress
                      value={percentOf(module)}
                      w={64}
                      size="sm"
                      radius="xl"
                      color={isDone(module) ? "teal" : "violet"}
                      visibleFrom="xs"
                    />
                    <Text size="xs" ff="monospace" c="dimmed" w={32} ta="right">
                      {percentOf(module)}%
                    </Text>
                    <Badge variant="light" color={isDone(module) ? "teal" : "gray"} w={52}>
                      {module.seenCount}/{module.lectures.length}
                    </Badge>
                  </Group>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Rows
                  lectures={module.lectures}
                  uid={uid}
                  projectId={projectId}
                  onOpen={(id) => navigate(`/c/${projectId}/${id}`)}
                />
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}
    </Container>
  );
}
