import {
  ActionIcon,
  Alert,
  Breadcrumbs,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Modal,
  NavLink,
  RingProgress,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconBrandGoogleDrive,
  IconBrandYoutube,
  IconFolder,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";

import { ApiError, listFolders, scanProject } from "../api";
import { AddYouTube } from "../components/AddYouTube";
import { SortableCourses } from "../components/SortableCourses";
import { saveProjectOrder, watchLectures, watchProjects } from "../store";
import type { DriveFolder, Lecture, Project } from "../types";

type Ctx = { uid: string };

function CourseSummary({ uid, project }: { uid: string; project: Project }) {
  const [lectures, setLectures] = useState<Lecture[]>([]);
  useEffect(() => watchLectures(uid, project.id, setLectures), [uid, project.id]);

  const seen = lectures.filter((lecture) => lecture.seen).length;
  const pct = lectures.length ? Math.round((seen / lectures.length) * 100) : 0;
  const minutes = Math.round(
    lectures.reduce((total, lecture) => total + (lecture.durationS ?? 0), 0) / 60,
  );

  return (
    <Link
      to={`/c/${project.id}`}
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      <Group wrap="nowrap" align="center">
        <RingProgress
          size={72}
          thickness={7}
          roundCaps
          sections={[{ value: pct, color: pct === 100 ? "teal" : "violet" }]}
          label={
            <Text ta="center" size="xs" fw={700}>
              {pct}%
            </Text>
          }
        />
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text fw={600} truncate>
            {project.name}
          </Text>
          <Group gap={6} wrap="nowrap">
            {project.source === "youtube" ? (
              <IconBrandYoutube size={13} opacity={0.6} />
            ) : (
              <IconBrandGoogleDrive size={13} opacity={0.6} />
            )}
            <Text size="sm" c="dimmed">
              {seen} of {lectures.length} watched
            </Text>
          </Group>
          {minutes > 0 && (
            <Text size="xs" c="dimmed">
              {Math.floor(minutes / 60)}h {minutes % 60}m total
            </Text>
          )}
        </Stack>
      </Group>
    </Link>
  );
}

function FolderPicker({ onPick }: { onPick: (folder: DriveFolder) => void }) {
  const [trail, setTrail] = useState<DriveFolder[]>([{ id: "root", name: "My Drive" }]);
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const here = trail[trail.length - 1];

  useEffect(() => {
    let live = true;
    setFolders(null);
    setError(null);
    listFolders(here.id)
      .then((result) => live && setFolders(result))
      .catch((exc: unknown) => live && setError(exc instanceof Error ? exc.message : "failed"));
    return () => {
      live = false;
    };
  }, [here.id]);

  return (
    <Stack gap="sm">
      <Breadcrumbs separator="/">
        {trail.map((folder, index) => (
          <Text
            key={folder.id}
            size="sm"
            c={index === trail.length - 1 ? undefined : "violet"}
            style={{ cursor: "pointer" }}
            onClick={() => setTrail(trail.slice(0, index + 1))}
          >
            {folder.name}
          </Text>
        ))}
      </Breadcrumbs>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      <ScrollArea h={260} type="auto">
        {folders === null && !error ? (
          <Group justify="center" py="xl">
            <Loader size="sm" />
          </Group>
        ) : (
          (folders ?? []).map((folder) => (
            <NavLink
              key={folder.id}
              label={folder.name}
              leftSection={<IconFolder size={16} />}
              onClick={() => setTrail([...trail, folder])}
            />
          ))
        )}
        {folders?.length === 0 && (
          <Text c="dimmed" size="sm" ta="center" py="xl">
            No subfolders here.
          </Text>
        )}
      </ScrollArea>

      <Button
        disabled={here.id === "root"}
        onClick={() => onPick(here)}
        leftSection={<IconRefresh size={16} />}
      >
        Scan “{here.name}”
      </Button>
      {here.id === "root" && (
        <Text size="xs" c="dimmed" ta="center">
          Open the folder that holds the course’s module folders.
        </Text>
      )}
    </Stack>
  );
}

export function Projects() {
  const { uid } = useOutletContext<Ctx>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [opened, { open, close }] = useDisclosure(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => watchProjects(uid, setProjects), [uid]);

  async function handlePick(folder: DriveFolder) {
    const label = name.trim() || folder.name;
    const projectId = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    setBusy(true);
    try {
      const result = await scanProject(projectId || "course", folder.id, label);
      notifications.show({
        title: "Scan complete",
        message: `${result.lectures} lectures across ${result.modules} modules${
          result.missingDuration ? ` · ${result.missingDuration} still processing in Drive` : ""
        }`,
        color: "teal",
      });
      close();
      setName("");
    } catch (exc) {
      notifications.show({
        title: "Scan failed",
        message: exc instanceof ApiError ? exc.message : String(exc),
        color: "red",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container size="md" py="md">
      <Group justify="space-between" mb="lg">
        <Title order={3}>Courses</Title>
        <ActionIcon variant="light" size="lg" onClick={open} aria-label="Add course">
          <IconPlus size={18} />
        </ActionIcon>
      </Group>

      {projects === null ? (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      ) : projects.length === 0 ? (
        <Card withBorder padding="xl" radius="md">
          <Stack align="center" gap="sm">
            <IconFolder size={40} stroke={1.3} />
            <Text fw={600}>No courses yet</Text>
            <Text c="dimmed" size="sm" ta="center">
              Paste a YouTube course or playlist, or point ig-study at a Drive folder whose
              subfolders are the modules.
            </Text>
            <Button onClick={open} leftSection={<IconPlus size={16} />} mt="xs">
              Add a course
            </Button>
          </Stack>
        </Card>
      ) : (
        <Stack gap="sm">
          <SortableCourses
            projects={projects}
            onReorder={(ids) => void saveProjectOrder(uid, ids)}
            renderCourse={(project) => (
              <CourseSummary uid={uid} project={project} />
            )}
          />
          {projects.length > 1 && (
            <Text size="xs" c="dimmed" ta="center">
              Drag the handle to reorder. On a phone, press and hold it first.
            </Text>
          )}
        </Stack>
      )}

      <Modal opened={opened} onClose={close} title="Add a course" centered size="lg">
        <Tabs defaultValue="youtube">
          <Tabs.List mb="md">
            <Tabs.Tab value="youtube" leftSection={<IconBrandYoutube size={16} />}>
              YouTube
            </Tabs.Tab>
            <Tabs.Tab value="drive" leftSection={<IconBrandGoogleDrive size={16} />}>
              Google Drive
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="youtube">
            <AddYouTube onDone={close} />
          </Tabs.Panel>

          <Tabs.Panel value="drive">
            <Stack>
              <TextInput
                label="Course name"
                placeholder="Leave blank to use the folder name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {busy ? (
                <Group justify="center" py="xl">
                  <Loader size="sm" />
                  <Text size="sm" c="dimmed">
                    Walking Drive…
                  </Text>
                </Group>
              ) : (
                <FolderPicker onPick={(folder) => void handlePick(folder)} />
              )}
            </Stack>
          </Tabs.Panel>
        </Tabs>
      </Modal>
    </Container>
  );
}
