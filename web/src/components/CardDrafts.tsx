import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  NumberInput,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconSparkles, IconTrash } from "@tabler/icons-react";
import { useState } from "react";

import { ApiError, generateCards, saveCards } from "../api";
import type { DraftCard } from "../types";

/**
 * Drafts are shown for approval rather than saved straight away.
 *
 * A card you didn't agree with is one you end up fighting for weeks, and
 * editing it here costs seconds against a scheduler that will otherwise keep
 * asking it.
 */
export function CardDrafts({
  lectureId,
  projectId,
  hasNote,
  onSaved,
}: {
  lectureId: string;
  projectId: string;
  hasNote: boolean;
  onSaved: (count: number) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [count, setCount] = useState<number>(5);
  const [drafts, setDrafts] = useState<DraftCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setDrafts(await generateCards(lectureId, projectId, count));
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!drafts?.length) return;
    setBusy(true);
    try {
      const result = await saveCards(lectureId, projectId, drafts);
      notifications.show({
        title: "Cards saved",
        message: `${result.saved} card${result.saved === 1 ? "" : "s"} added to the queue`,
        color: "teal",
      });
      onSaved(result.saved);
      setDrafts(null);
      setOpened(false);
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  function update(index: number, field: keyof DraftCard, value: string) {
    setDrafts((current) =>
      current
        ? current.map((draft, position) =>
            position === index ? { ...draft, [field]: value } : draft,
          )
        : current,
    );
  }

  return (
    <>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconSparkles size={16} />}
        disabled={!hasNote}
        onClick={() => setOpened(true)}
      >
        Generate cards
      </Button>

      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="Cards from your notes"
        size="lg"
      >
        <Stack>
          {error && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />}>
              {error}
            </Alert>
          )}

          {drafts === null ? (
            <Stack>
              <Text size="sm" c="dimmed">
                Claude reads the note you wrote and drafts questions that test whether you
                understood it — not whether you can repeat the wording. You approve them before
                anything is saved.
              </Text>
              <NumberInput
                label="How many cards"
                value={count}
                onChange={(value) => setCount(Number(value) || 5)}
                min={1}
                max={12}
              />
              <Button
                onClick={() => void generate()}
                loading={busy}
                leftSection={<IconSparkles size={16} />}
              >
                {busy ? "Reading your note…" : "Generate"}
              </Button>
            </Stack>
          ) : busy ? (
            <Group justify="center" py="xl">
              <Loader size="sm" />
            </Group>
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
                      onClick={() =>
                        setDrafts(drafts.filter((_, position) => position !== index))
                      }
                      aria-label="Remove card"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                  <Textarea
                    autosize
                    minRows={1}
                    value={draft.q}
                    onChange={(event) => update(index, "q", event.currentTarget.value)}
                    mb={6}
                  />
                  <Textarea
                    autosize
                    minRows={1}
                    value={draft.a}
                    onChange={(event) => update(index, "a", event.currentTarget.value)}
                    styles={{ input: { fontSize: 13 } }}
                  />
                </Card>
              ))}
              <Group justify="space-between">
                <Button variant="default" size="xs" onClick={() => setDrafts(null)}>
                  Regenerate
                </Button>
                <Button size="xs" onClick={() => void save()} disabled={!drafts.length}>
                  Save {drafts.length} card{drafts.length === 1 ? "" : "s"}
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Modal>
    </>
  );
}
