import { auth } from "./firebase";
import type {
  DraftCard,
  DriveFolder,
  DueQueue,
  GradeResult,

  ScanResult,
  Usage,
  YouTubePlaylist,
  YouTubePreview,
} from "./types";

const BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, "Not signed in");

  const token = await user.getIdToken();
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    let detail = body.slice(0, 300);
    try {
      detail = (JSON.parse(body) as { detail?: string }).detail ?? detail;
    } catch {
      // body was not JSON; the raw text is the better message
    }
    throw new ApiError(response.status, detail || response.statusText);
  }
  return (await response.json()) as T;
}

export function listFolders(parent = "root"): Promise<DriveFolder[]> {
  return request<DriveFolder[]>(`/drive/folders?parent=${encodeURIComponent(parent)}`);
}

export function scanProject(
  projectId: string,
  driveFolderId: string,
  name: string,
): Promise<ScanResult> {
  return request<ScanResult>(`/projects/${encodeURIComponent(projectId)}/scan`, {
    method: "POST",
    body: JSON.stringify({ driveFolderId, name }),
  });
}

/**
 * A short-lived URL for the video element.
 *
 * The token rides in the query string because `<video src>` cannot send an
 * Authorization header. It is scoped to this one lecture and expires in an
 * hour, so it is not the Firebase ID token.
 */
export function streamUrl(lectureId: string): Promise<{ url: string; expiresAt: number }> {
  return request<{ url: string; expiresAt: number }>(
    `/lectures/${encodeURIComponent(lectureId)}/stream-url`,
  );
}

export { ApiError };

export function generateCards(
  lectureId: string,
  projectId: string,
  count: number,
): Promise<DraftCard[]> {
  return request<DraftCard[]>(`/lectures/${encodeURIComponent(lectureId)}/cards:generate`, {
    method: "POST",
    body: JSON.stringify({ projectId, count }),
  });
}

export function saveCards(
  lectureId: string,
  projectId: string,
  cards: DraftCard[],
): Promise<{ saved: number }> {
  return request<{ saved: number }>(`/lectures/${encodeURIComponent(lectureId)}/cards`, {
    method: "POST",
    body: JSON.stringify({ projectId, cards }),
  });
}

export function dueCards(): Promise<DueQueue> {
  return request<DueQueue>("/cards/due");
}

export function answerCard(
  cardId: string,
  projectId: string,
  text: string,
): Promise<GradeResult> {
  return request<GradeResult>(`/cards/${encodeURIComponent(cardId)}/answer`, {
    method: "POST",
    body: JSON.stringify({ projectId, text }),
  });
}

export function usage(month?: string): Promise<Usage> {
  return request<Usage>(`/usage${month ? `?month=${encodeURIComponent(month)}` : ""}`);
}

export function resolveYouTube(url: string): Promise<{
  kind: "playlist" | "channel";
  playlists: YouTubePlaylist[];
}> {
  return request(`/youtube/resolve?url=${encodeURIComponent(url)}`);
}

export function previewYouTube(playlistId: string, reverse: boolean): Promise<YouTubePreview> {
  return request<YouTubePreview>(
    `/youtube/preview/${encodeURIComponent(playlistId)}?reverse=${reverse}`,
  );
}

export function scanYouTube(
  projectId: string,
  playlistId: string,
  name: string,
  reverse: boolean,
): Promise<{ lectures: number; added: number; skipped: number }> {
  return request(`/youtube/scan/${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: JSON.stringify({ playlistId, name, reverse }),
  });
}

export function generateDocCards(
  projectId: string,
  urls: string[],
  count: number,
  focus: string,
): Promise<DraftCard[]> {
  return request<DraftCard[]>("/docs/cards:generate", {
    method: "POST",
    body: JSON.stringify({ projectId, urls, count, focus }),
  });
}

export function saveDocCards(
  projectId: string,
  docId: string,
  label: string,
  cards: DraftCard[],
): Promise<{ saved: number }> {
  return request<{ saved: number }>("/docs/cards", {
    method: "POST",
    body: JSON.stringify({ projectId, docId, label, cards }),
  });
}
