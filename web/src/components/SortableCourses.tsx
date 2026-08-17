import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon, Card, Group } from "@mantine/core";
import { IconGripVertical } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import type { Project } from "../types";

/**
 * Drag-to-reorder for the course list.
 *
 * A touch sensor alongside the pointer one because this is used on a phone,
 * and a keyboard sensor because a list you can only reorder by dragging is one
 * some people cannot reorder at all. The touch sensor waits 200ms before
 * claiming the gesture, so a tap still opens the course and only a deliberate
 * press-and-hold starts a drag.
 */

function SortableRow({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <Card
      ref={setNodeRef}
      withBorder
      padding="lg"
      radius="md"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
        zIndex: isDragging ? 2 : undefined,
        position: "relative",
      }}
    >
      <Group wrap="nowrap" gap="sm" align="center">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          style={{ cursor: "grab", touchAction: "none" }}
          aria-label="Reorder course"
          {...attributes}
          {...listeners}
        >
          <IconGripVertical size={18} />
        </ActionIcon>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      </Group>
    </Card>
  );
}

export function SortableCourses({
  projects,
  onReorder,
  renderCourse,
}: {
  projects: Project[];
  onReorder: (orderedIds: string[]) => void;
  renderCourse: (project: Project) => ReactNode;
}) {
  const [dragging, setDragging] = useState<Project[] | null>(null);
  const order = dragging ?? projects;

  // Release the optimistic order once Firestore echoes it back. Without this
  // the local copy wins forever and the list stops reflecting anything else
  // that changes -- a course added on another device, say.
  useEffect(() => {
    if (!dragging) return;
    const settled =
      projects.length === dragging.length &&
      projects.every((entry, index) => entry.id === dragging[index].id);
    if (settled) setDragging(null);
  }, [projects, dragging]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      setDragging(null);
      return;
    }
    const from = order.findIndex((entry) => entry.id === active.id);
    const to = order.findIndex((entry) => entry.id === over.id);
    const next = arrayMove(order, from, to);

    // Held locally until Firestore's snapshot echoes back, or the row snaps
    // to its old position for a frame before the write lands.
    setDragging(next);
    onReorder(next.map((entry) => entry.id));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={order.map((entry) => entry.id)}
        strategy={verticalListSortingStrategy}
      >
        {order.map((project) => (
          <SortableRow key={project.id} id={project.id}>
            {renderCourse(project)}
          </SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}
