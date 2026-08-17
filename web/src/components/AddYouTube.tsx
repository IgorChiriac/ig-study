import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  NavLink,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconArrowsSort,
  IconBrandYoutube,
  IconSearch,
} from "@tabler/icons-react";
import { useState } from "react";

import { ApiError, previewYouTube, resolveYouTube, scanYouTube } from "../api";
import type { YouTubePlaylist, YouTubePreview } from "../types";

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "course"
  );
}

function duration(seconds: number | null): string {
  if (!seconds) return "";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function AddYouTube({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [playlists, setPlaylists] = useState<YouTubePlaylist[] | null>(null);
  const [preview, setPreview] = useState<YouTubePreview | null>(null);
  const [reverse, setReverse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function fail(exc: unknown) {
    setError(exc instanceof ApiError ? exc.message : String(exc));
  }

  async function resolve() {
    setBusy(true);
    setError(null);
    setPlaylists(null);
    setPreview(null);
    try {
      const result = await resolveYouTube(url);
      if (result.kind === "playlist" && result.playlists[0]) {
        await openPreview(result.playlists[0].playlistId);
      } else {
        setPlaylists(result.playlists);
      }
    } catch (exc) {
      fail(exc);
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(playlistId: string, flip?: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = await previewYouTube(playlistId, flip ?? false);
      setPreview(next);
      setReverse(flip ?? next.looksReversed);
      if (flip === undefined && next.looksReversed) {
        const flipped = await previewYouTube(playlistId, true);
        setPreview(flipped);
      }
    } catch (exc) {
      fail(exc);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await scanYouTube(
        slug(preview.title),
        preview.playlistId,
        preview.title,
        reverse,
      );
      notifications.show({
        title: "Course added",
        message: `${result.lectures} lectures${result.skipped ? ` · ${result.skipped} unavailable, skipped` : ""}`,
        color: "teal",
      });
      onDone();
    } catch (exc) {
      fail(exc);
    } finally {
      setBusy(false);
    }
  }

  const hours = preview ? Math.floor(preview.totalDurationS / 3600) : 0;
  const minutes = preview ? Math.round((preview.totalDurationS % 3600) / 60) : 0;

  return (
    <Stack>
      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      {!preview && (
        <>
          <TextInput
            label="Playlist or channel URL"
            placeholder="https://www.youtube.com/@PBoyle/courses"
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && void resolve()}
            leftSection={<IconBrandYoutube size={16} />}
          />
          <Text size="xs" c="dimmed">
            A course URL, a playlist URL, or a channel — YouTube courses are backed by playlists,
            so pasting a channel lets you pick which one.
          </Text>
          <Button
            onClick={() => void resolve()}
            loading={busy}
            disabled={url.trim().length < 3}
            leftSection={<IconSearch size={16} />}
          >
            Find
          </Button>
        </>
      )}

      {playlists && !preview && (
        <>
          <Text size="sm" fw={600}>
            {playlists.length} playlists
          </Text>
          <ScrollArea h={280} type="auto">
            {playlists.map((entry) => (
              <NavLink
                key={entry.playlistId}
                label={entry.title}
                description={`${entry.itemCount} videos`}
                onClick={() => void openPreview(entry.playlistId)}
              />
            ))}
          </ScrollArea>
        </>
      )}

      {busy && preview === null && playlists === null && (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      )}

      {preview && (
        <Stack gap="sm">
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={600} truncate>
                {preview.title}
              </Text>
              <Text size="xs" c="dimmed">
                {preview.channelTitle} · {preview.videos.length} videos · {hours}h{" "}
                {String(minutes).padStart(2, "0")}m
              </Text>
            </Stack>
            <Badge variant="light">{reverse ? "reversed" : "playlist order"}</Badge>
          </Group>

          {preview.looksReversed && (
            <Alert color="yellow" variant="light" icon={<IconArrowsSort size={16} />}>
              <Text size="sm">
                The lesson numbers in these titles run against the playlist order — the channel
                looks like it appended each upload, leaving the course backwards. Reversed order
                is pre-selected; check the first few titles below before saving.
              </Text>
            </Alert>
          )}

          <Switch
            checked={reverse}
            onChange={(event) =>
              void openPreview(preview.playlistId, event.currentTarget.checked)
            }
            label="Reverse the playlist order"
            disabled={busy}
          />

          <ScrollArea h={220} type="auto">
            <Stack gap={2}>
              {preview.videos.map((video, index) => (
                <Group key={video.videoId} gap="xs" wrap="nowrap" px={4} py={3}>
                  <Text size="xs" c="dimmed" w={22} ta="right">
                    {index + 1}
                  </Text>
                  <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
                    {video.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {duration(video.durationS)}
                  </Text>
                </Group>
              ))}
            </Stack>
          </ScrollArea>

          {preview.skipped > 0 && (
            <Text size="xs" c="dimmed">
              {preview.skipped} entr{preview.skipped === 1 ? "y is" : "ies are"} deleted or
              private and will be skipped.
            </Text>
          )}

          <Group justify="space-between">
            <Anchor
              size="xs"
              onClick={() => {
                setPreview(null);
                setPlaylists(null);
              }}
            >
              Start over
            </Anchor>
            <Button onClick={() => void commit()} loading={busy}>
              Add {preview.videos.length} lectures
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
