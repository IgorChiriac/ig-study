import {
  Accordion,
  Anchor,
  Badge,
  Checkbox,
  Container,
  Group,
  Loader,
  Progress,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconChevronLeft, IconPlayerPlayFilled } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { groupByModule, setSeen, watchLectures } from "../store";
import type { Lecture } from "../types";

type Ctx = { uid: string };

export function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function Course() {
  const { uid } = useOutletContext<Ctx>();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [lectures, setLectures] = useState<Lecture[] | null>(null);

  useEffect(() => watchLectures(uid, projectId, setLectures), [uid, projectId]);

  if (lectures === null) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  const modules = groupByModule(lectures);
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
          <Title order={3}>{projectId}</Title>
          <Text size="sm" c="dimmed">
            {seen}/{lectures.length}
          </Text>
        </Group>
        <Progress value={pct} radius="xl" color={pct === 100 ? "teal" : "violet"} />
      </Stack>

      <Accordion
        multiple
        defaultValue={modules.map((module) => module.name)}
        variant="separated"
      >
        {modules.map((module) => (
          <Accordion.Item key={module.name} value={module.name}>
            <Accordion.Control>
              <Group justify="space-between" pr="sm">
                <Text fw={600} size="sm">
                  {module.name || "Course root"}
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
              <Stack gap={2}>
                {module.lectures.map((lecture) => (
                  <Group
                    key={lecture.id}
                    className="lecture-row"
                    wrap="nowrap"
                    gap="sm"
                    px="xs"
                    py={8}
                    style={{ borderRadius: 8, cursor: "pointer" }}
                    onClick={() => navigate(`/c/${projectId}/${lecture.id}`)}
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
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Container>
  );
}
