export type Lecture = {
  id: string;
  driveFileId: string;
  module: string;
  title: string;
  orderIdx: number;
  durationS: number | null;
  sizeBytes: number | null;
  seen: boolean;
  note: string;
  positionS: number;
};

export type Project = {
  id: string;
  name: string;
  driveFolderId?: string;
};

export type Module = {
  name: string;
  lectures: Lecture[];
  seenCount: number;
};

export type ScanResult = {
  projectId: string;
  lectures: number;
  modules: number;
  added: number;
  updated: number;
  orphaned: number;
  missingDuration: number;
};

export type DriveFolder = { id: string; name: string };
