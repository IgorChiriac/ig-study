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

export type DraftCard = { q: string; a: string };

export type DueCard = {
  id: string;
  projectId: string;
  lectureId: string;
  module: string;
  q: string;
  a: string;
  due: string;
  isNew: boolean;
  isLeech: boolean;
  lapses: number;
};

export type DueQueue = {
  cards: DueCard[];
  newRemaining: number;
  reviewsRemaining: number;
  newDue: number;
  reviewsDue: number;
};

export type GradeResult = {
  score: number;
  verdict: string;
  missing: string;
  correction: string;
  reference: string;
  nextDue: string;
  intervalDays: number;
  isLeech: boolean;
};

export type ModelUsage = {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  inputUsdPerMTok: number | null;
  outputUsdPerMTok: number | null;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  note: string;
};

export type Usage = {
  month: string;
  models: ModelUsage[];
  claudeUsd: number;
  stream: { bytes: number; requests: number; usdPerGb: number; usd: number };
  scan: { runs: number; lectures: number };
  totalUsd: number;
  freeTier: Record<string, number>;
  prices: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number; note: string }>;
};
