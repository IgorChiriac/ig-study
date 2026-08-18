import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Checkbox,
  Modal,
  NumberInput,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconBook,
  IconChevronLeft,
  IconExternalLink,
  IconListSearch,
  IconPlus,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";

import {
  ApiError,
  discoverChapters,
  generateDocCards,
  ingestDoc,
  saveDocCards,
} from "../api";
import { bumpDocCards, removeDoc, watchDocs, watchProjects } from "../store";
import type { Chapter, DocLink, DraftCard, Project } from "../types";

type Ctx = { uid: string };

export function Docs() {
  const { uid } = useOutletContext<Ctx>();
  const { projectId = "" } = useParams();

  const [docs, setDocs] = useState<DocLink[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [url, setUrl] = useState("");

  const [opened, { open, close }] = useDisclosure(false);
  const [target, setTarget] = useState<DocLink | null>(null);
  const [count, setCount] = useState(10);
  const [focus, setFocus] = useState("");
  const [drafts, setDrafts] = useState<DraftCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => watchDocs(uid, projectId, setDocs), [uid, projectId]);
  useEffect(() => watchProjects(uid, setProjects), [uid]);

  const project = projects.find((entry) => entry.id === projectId);

  const [chapters, setChapters] = useState<Chapter[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState("");

  function validUrl(): string | null {
    const trimmed = url.trim();
    try {
      new URL(trimmed);
      return trimmed;
    } catch {
      setError("That does not look like a URL.");
      return null;
    }
  }

  async function ingestOne() {
    const target = validUrl();
    if (!target) return;
    setError(null);
    setBusy(true);
    try {
      await ingestDoc(projectId, target);
      setUrl("");
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    const target = validUrl();
    if (!target) return;
    setError(null);
    setBusy(true);
    setChapters(null);
    try {
      const found = await discoverChapters(target);
      setChapters(found.chapters);
      setPicked(new Set());
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  async function ingestPicked() {
    if (!chapters) return;
    setBusy(true);
    setError(null);
    const chosen = chapters.filter((chapter) => picked.has(chapter.url));
    let done = 0;
    try {
      for (const chapter of chosen) {
        setWorking(`${done + 1} of ${chosen.length}: ${chapter.title}`);
        await ingestDoc(projectId, chapter.url, chapter.title);
        done += 1;
      }
      notifications.show({
        title: "Ingested",
        message: `${done} page${done === 1 ? "" : "s"} stored. Cards from them cost a fraction of this.`,
        color: "teal",
      });
      setChapters(null);
      setUrl("");
    } catch (exc) {
      setError(
        `${exc instanceof ApiError ? exc.message : String(exc)} (${done} of ${chosen.length} stored)`,
      );
    } finally {
      setWorking("");
      setBusy(false);
    }
  }

  function startGenerate(entry: DocLink) {
    setTarget(entry);
    setDrafts(null);
    setFocus("");
    setError(null);
    open();
  }

  async function generate() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      setDrafts(await generateDocCards(projectId, target.id, count, focus));
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!target || !drafts?.length) return;
    setBusy(true);
    try {
      const result = await saveDocCards(projectId, target.id, target.label, drafts);
      await bumpDocCards(uid, projectId, target.id, result.saved);
      notifications.show({
        title: "Cards saved",
        message: `${result.saved} card${result.saved === 1 ? "" : "s"} added to the queue`,
        color: "teal",
      });
      close();
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

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

      <Title order={3} mb={4}>
        Reference docs
      </Title>
      <Text size="sm" c="dimmed" mb="lg">
        Link the official documentation for this subject and make cards from it. Claude reads
        the page itself, so the cards are grounded in what it actually says rather than in what
        it remembers.
      </Text>

      <Card withBorder padding="md" radius="md" mb="lg">
        <TextInput
          label="Documentation URL"
          placeholder="https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/…"
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
          onKeyDown={(event) => event.key === "Enter" && void ingestOne()}
        />
        <Group gap="sm" mt="sm">
          <Button
            onClick={() => void ingestOne()}
            loading={busy && !chapters}
            leftSection={<IconPlus size={16} />}
          >
            Add this page
          </Button>
          <Button
            variant="light"
            onClick={() => void browse()}
            loading={busy && chapters === null && url.trim().length > 0}
            leftSection={<IconListSearch size={16} />}
          >
            Browse chapters
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          A page is read <strong>once</strong> and stored. Every batch of cards after that works
          from the stored copy — no re-reading, so the cards cost a fraction of the first read.
          <em>Browse chapters</em> reads a contents page and lists what it links to, but it
          costs about as much as storing several pages and works poorly on sites that build
          their contents tree in JavaScript — AWS docs among them. Pasting chapter URLs is
          usually cheaper and more accurate.
        </Text>
        {error && !opened && (
          <Alert color="red" mt="sm" icon={<IconAlertTriangle size={16} />}>
            {error}
          </Alert>
        )}
      </Card>

      {chapters && (
        <Card withBorder padding="md" radius="md" mb="lg">
          <Group justify="space-between" mb="xs">
            <Text fw={600} size="sm">
              {chapters.length} chapters found
            </Text>
            <Group gap="xs">
              <Anchor size="xs" onClick={() => setPicked(new Set(chapters.map((c) => c.url)))}>
                All
              </Anchor>
              <Anchor size="xs" onClick={() => setPicked(new Set())}>
                None
              </Anchor>
            </Group>
          </Group>
          <ScrollArea h={260} type="auto">
            <Stack gap={2}>
              {chapters.map((chapter) => (
                <Checkbox
                  key={chapter.url}
                  label={chapter.title}
                  checked={picked.has(chapter.url)}
                  onChange={(event) => {
                    const next = new Set(picked);
                    if (event.currentTarget.checked) next.add(chapter.url);
                    else next.delete(chapter.url);
                    setPicked(next);
                  }}
                  py={4}
                />
              ))}
            </Stack>
          </ScrollArea>
          <Group justify="space-between" mt="sm">
            <Text size="xs" c="dimmed">
              {working || `${picked.size} selected · each page is read once`}
            </Text>
            <Group gap="xs">
              <Button variant="default" size="xs" onClick={() => setChapters(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                disabled={picked.size === 0}
                loading={busy}
                onClick={() => void ingestPicked()}
              >
                Store {picked.size} page{picked.size === 1 ? "" : "s"}
              </Button>
            </Group>
          </Group>
        </Card>
      )}

      {docs === null ? (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      ) : docs.length === 0 ? (
        <Card withBorder padding="xl" radius="md">
          <Stack align="center" gap="sm">
            <ThemeIcon size={44} radius="xl" variant="light" color="violet">
              <IconBook size={22} />
            </ThemeIcon>
            <Text fw={600}>No docs linked yet</Text>
            <Text size="sm" c="dimmed" ta="center">
              Cards made from documentation join the same queue as the ones from your notes.
            </Text>
          </Stack>
        </Card>
      ) : (
        <Stack gap="sm">
          {docs.map((entry) => (
            <Card key={entry.id} withBorder padding="md" radius="md">
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text fw={600} size="sm" truncate>
                      {entry.label}
                    </Text>
                    {entry.cardCount > 0 && (
                      <Badge size="xs" variant="light">
                        {entry.cardCount} card{entry.cardCount === 1 ? "" : "s"}
                      </Badge>
                    )}
                    {entry.approxTokens > 0 && (
                      <Badge size="xs" variant="default">
                        ~{Math.round(entry.approxTokens / 1000)}k tokens stored
                      </Badge>
                    )}
                  </Group>
                  <Anchor href={entry.url} target="_blank" rel="noreferrer" size="xs" truncate>
                    {entry.url}
                  </Anchor>
                </Stack>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconSparkles size={14} />}
                    onClick={() => startGenerate(entry)}
                  >
                    Cards
                  </Button>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => void removeDoc(uid, projectId, entry.id)}
                    aria-label="Remove link"
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      <Modal opened={opened} onClose={close} title={target?.label ?? "Cards"} size="lg">
        <Stack>
          {error && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />}>
              {error}
            </Alert>
          )}

          {drafts === null ? (
            <>
              <Anchor href={target?.url} target="_blank" rel="noreferrer" size="xs">
                <Group gap={4}>
                  {target?.url}
                  <IconExternalLink size={12} />
                </Group>
              </Anchor>
              <NumberInput
                label="How many cards"
                value={count}
                onChange={(value) => setCount(Number(value) || 10)}
                min={1}
                max={12}
              />
              <Textarea
                label="Focus (optional)"
                placeholder="e.g. capacity modes and their cost tradeoffs"
                value={focus}
                onChange={(event) => setFocus(event.currentTarget.value)}
                autosize
                minRows={2}
              />
              <Button
                onClick={() => void generate()}
                loading={busy}
                leftSection={<IconSparkles size={16} />}
              >
                {busy ? "Writing cards…" : "Generate"}
              </Button>
              <Text size="xs" c="dimmed">
                This page is already stored, so nothing is fetched. Cards you already have from
                it are passed along so this batch covers new ground rather than repeating them.
              </Text>
            </>
          ) : (
            <Stack>
              {drafts.map((draft, index) => (
                <Card key={index} withBorder padding="sm" radius="md">
                  <Group justify="space-between" mb={4}>
                    <Text size="xs" c="dimmed">
                      Card {index + 1}
                    </Text>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      onClick={() => setDrafts(drafts.filter((_, at) => at !== index))}
                      aria-label="Remove card"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                  <Textarea
                    autosize
                    minRows={1}
                    value={draft.q}
                    onChange={(event) =>
                      setDrafts(
                        drafts.map((entry, at) =>
                          at === index ? { ...entry, q: event.currentTarget.value } : entry,
                        ),
                      )
                    }
                    mb={6}
                  />
                  <Textarea
                    autosize
                    minRows={1}
                    value={draft.a}
                    onChange={(event) =>
                      setDrafts(
                        drafts.map((entry, at) =>
                          at === index ? { ...entry, a: event.currentTarget.value } : entry,
                        ),
                      )
                    }
                    styles={{ input: { fontSize: 13 } }}
                  />
                </Card>
              ))}
              <Group justify="space-between">
                <Button variant="default" size="xs" onClick={() => setDrafts(null)}>
                  Regenerate
                </Button>
                <Button size="xs" onClick={() => void commit()} loading={busy}>
                  Save {drafts.length} card{drafts.length === 1 ? "" : "s"}
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Modal>
    </Container>
  );
}
