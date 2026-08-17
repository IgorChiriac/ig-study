import { auth } from "./firebase";
import type { DriveFolder, ScanResult } from "./types";

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
