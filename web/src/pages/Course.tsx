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

  useEffect(() => watchLectures(uid, projectId, setLectures), [uid, projectId]);
  useEffect(() => watchProjects(uid, setProjects), [uid]);

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
        <Accordion multiple defaultValue={modules.map(valueOf)} variant="separated">
          {modules.map((module, index) => (
            <Accordion.Item key={valueOf(module, index)} value={valueOf(module, index)}>
              <Accordion.Control>
                <Group justify="space-between" pr="sm">
                  <Text fw={600} size="sm">
                    {module.name || "Lectures"}
                  </Text>
                  <Badge
                    variant="light"
                    color={module.seenCount === module.lectures.length ? "teal" : "gray"}
                  >
                    {module.seenCount}/{module.lectures.length}
                  </Badge>
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
