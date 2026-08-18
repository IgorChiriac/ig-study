import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  increment,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";
import type { Card, DocLink, Lecture, Module, Project, Review } from "./types";

/**
 * Notes, seen flags and resume positions go straight from here to Firestore.
 *
 * That is the whole point of the architecture: the API never sees them, so
 * autosave costs nothing server-side, updates are live, and security rules do
 * the authorising without a round trip. The API is only involved in what a
 * browser cannot do -- reaching Drive and streaming bytes.
 */

const lecturesPath = (uid: string, projectId: string) =>
  collection(db, "users", uid, "projects", projectId, "lectures");

/**
 * Courses in the order the user arranged them.
 *
 * A course created by a scan gets an epoch-second `orderIdx`, so new ones
 * append rather than landing arbitrarily. The first drag rewrites everything
 * to 0..n-1; the two schemes coexist because only relative order matters.
 */
export function watchProjects(uid: string, onChange: (projects: Project[]) => void) {
  return onSnapshot(collection(db, "users", uid, "projects"), (snapshot) => {
    const projects = snapshot.docs.map((entry) => ({
      id: entry.id,
      name: (entry.data().name as string) ?? entry.id,
      orderIdx: (entry.data().orderIdx as number | undefined) ?? Number.MAX_SAFE_INTEGER,
      source: ((entry.data().source as string) ?? "drive") as "drive" | "youtube",
      driveFolderId: entry.data().driveFolderId as string | undefined,
      youtubePlaylistId: entry.data().youtubePlaylistId as string | undefined,
      channelTitle: entry.data().channelTitle as string | undefined,
    }));

    projects.sort(
      (left, right) =>
        left.orderIdx - right.orderIdx || left.name.localeCompare(right.name),
    );
    onChange(projects);
  });
}

/** Persist a new course order. One batch, so the list never renders half-sorted. */
export function saveProjectOrder(uid: string, orderedIds: string[]) {
  const batch = writeBatch(db);
  orderedIds.forEach((projectId, index) => {
    batch.set(doc(db, "users", uid, "projects", projectId), { orderIdx: index }, { merge: true });
  });
  return batch.commit();
}

export function watchLectures(
  uid: string,
  projectId: string,
  onChange: (lectures: Lecture[]) => void,
) {
  const ordered = query(lecturesPath(uid, projectId), orderBy("orderIdx"));
  return onSnapshot(ordered, (snapshot) => {
    onChange(
      snapshot.docs.map((entry) => {
        const data = entry.data();
        return {
          id: entry.id,
          source: ((data.source as string) ?? "drive") as "drive" | "youtube",
          driveFileId: (data.driveFileId as string) ?? entry.id,
          youtubeVideoId: (data.youtubeVideoId as string | undefined) ?? null,
          module: (data.module as string) ?? "",
          title: (data.title as string) ?? entry.id,
          orderIdx: (data.orderIdx as number) ?? 0,
          durationS: (data.durationS as number | null) ?? null,
          sizeBytes: (data.sizeBytes as number | null) ?? null,
          seen: Boolean(data.seen),
          note: (data.note as string) ?? "",
          positionS: (data.positionS as number) ?? 0,
        };
      }),
    );
  });
}

export function groupByModule(lectures: Lecture[]): Module[] {
  const modules: Module[] = [];
  for (const lecture of lectures) {
    let bucket = modules.find((entry) => entry.name === lecture.module);
    if (!bucket) {
      bucket = { name: lecture.module, lectures: [], seenCount: 0 };
      modules.push(bucket);
    }
    bucket.lectures.push(lecture);
    if (lecture.seen) bucket.seenCount += 1;
  }
  return modules;
}

export function setSeen(uid: string, projectId: string, lectureId: string, seen: boolean) {
  return updateDoc(doc(lecturesPath(uid, projectId), lectureId), { seen });
}

export function saveNote(uid: string, projectId: string, lectureId: string, note: string) {
  return setDoc(doc(lecturesPath(uid, projectId), lectureId), { note }, { merge: true });
}

export function savePosition(
  uid: string,
  projectId: string,
  lectureId: string,
  positionS: number,
) {
  return setDoc(
    doc(lecturesPath(uid, projectId), lectureId),
    { positionS: Math.floor(positionS) },
    { merge: true },
  );
}


export function watchCards(uid: string, projectId: string, onChange: (cards: Card[]) => void) {
  return onSnapshot(
    collection(db, "users", uid, "projects", projectId, "cards"),
    (snapshot) => {
      onChange(
        snapshot.docs.map((entry) => {
          const data = entry.data();
          return {
            id: entry.id,
            lectureId: (data.lectureId as string) ?? "",
            module: (data.module as string) ?? "",
            due: (data.due as string) ?? "",
            interval: (data.interval as number) ?? 0,
            ease: (data.ease as number) ?? 2.5,
            lapses: (data.lapses as number) ?? 0,
            reps: (data.reps as number) ?? 0,
          };
        }),
      );
    },
  );
}

/**
 * Reviews since a cutoff, filtered to one course in memory.
 *
 * The query is a single-field inequality on `answeredAt` with an `orderBy` on
 * that same field, which Firestore serves from its automatic index. Adding
 * `projectId` to the query would need a composite index declared and deployed
 * for a filter that costs nothing to apply here.
 */
export function watchRecentReviews(
  uid: string,
  projectId: string,
  sinceDays: number,
  onChange: (reviews: Review[]) => void,
) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - sinceDays);
  const recent = query(
    collection(db, "users", uid, "reviews"),
    where("answeredAt", ">=", Timestamp.fromDate(cutoff)),
    orderBy("answeredAt"),
  );
  return onSnapshot(recent, (snapshot) => {
    onChange(
      snapshot.docs
        .map((entry) => {
          const data = entry.data();
          const at = data.answeredAt as Timestamp | null;
          return {
            id: entry.id,
            projectId: (data.projectId as string) ?? "",
            lectureId: (data.lectureId as string) ?? "",
            module: (data.module as string) ?? "",
            grade: (data.grade as number) ?? 0,
            wasNew: Boolean(data.wasNew),
            answeredAt: at ? at.toDate() : new Date(),
          };
        })
        .filter((review) => review.projectId === projectId),
    );
  });
}

export function saveGoal(uid: string, projectId: string, goalDate: string | null) {
  return setDoc(doc(db, "users", uid, "projects", projectId), { goalDate }, { merge: true });
}


/** Reference docs are user data, so they are written straight to Firestore. */
export function watchDocs(uid: string, projectId: string, onChange: (docs: DocLink[]) => void) {
  return onSnapshot(
    collection(db, "users", uid, "projects", projectId, "docs"),
    (snapshot) => {
      onChange(
        snapshot.docs.map((entry) => ({
          id: entry.id,
          url: (entry.data().url as string) ?? "",
          label: (entry.data().label as string) ?? "",
          cardCount: (entry.data().cardCount as number) ?? 0,
          chars: (entry.data().chars as number) ?? 0,
          approxTokens: (entry.data().approxTokens as number) ?? 0,
        })),
      );
    },
  );
}

export function removeDoc(uid: string, projectId: string, docId: string) {
  return deleteDoc(doc(db, "users", uid, "projects", projectId, "docs", docId));
}

export function bumpDocCards(uid: string, projectId: string, docId: string, added: number) {
  return setDoc(
    doc(db, "users", uid, "projects", projectId, "docs", docId),
    { cardCount: increment(added) },
    { merge: true },
  );
}
