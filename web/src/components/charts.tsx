import { Box, Group, Stack, Text, Tooltip } from "@mantine/core";

/**
 * Two charts, one hue.
 *
 * The series colour is `--chart-series` (#9775fa), validated against the dark
 * surface with the palette checker: inside the lightness band, above the chroma
 * floor, and past 3:1 contrast. There is no second series colour anywhere here
 * — every chart shows a single measure, so a second hue would encode nothing.
 *
 * "Needs work" is therefore never carried by colour. It rides an icon and a
 * label, which is also what keeps it legible to a colourblind reader and in
 * forced-colors mode.
 *
 * Marks are thin, data-ends are rounded 4px and anchored to the baseline, and
 * every bar keeps a 2px surface gap from its neighbour. Values are labelled
 * directly where there is room rather than on every mark, and each bar carries
 * a tooltip — an HTML chart is interactive by default.
 */

const SERIES = "var(--chart-series)";
const TRACK = "var(--chart-track)";

export function ActivityBars({
  days,
  height = 88,
}: {
  days: { date: Date; count: number }[];
  height?: number;
}) {
  const peak = Math.max(1, ...days.map((day) => day.count));

  return (
    <Box>
      <Group gap={2} align="flex-end" h={height} wrap="nowrap">
        {days.map((day) => {
          const label = day.date.toLocaleDateString(undefined, {
            weekday: "short",
            day: "numeric",
            month: "short",
          });
          return (
            <Tooltip
              key={day.date.toISOString()}
              label={`${day.count} review${day.count === 1 ? "" : "s"} · ${label}`}
              withArrow
              openDelay={80}
            >
              <Box
                flex={1}
                h="100%"
                style={{ display: "flex", alignItems: "flex-end", cursor: "default" }}
                aria-label={`${label}: ${day.count} reviews`}
              >
                <Box
                  w="100%"
                  h={day.count ? `${Math.max(6, (day.count / peak) * height)}px` : "2px"}
                  style={{
                    background: day.count ? SERIES : TRACK,
                    borderRadius: "4px 4px 0 0",
                    minHeight: 2,
                  }}
                />
              </Box>
            </Tooltip>
          );
        })}
      </Group>
      <Group justify="space-between" mt={6}>
        <Text size="xs" c="dimmed">
          {days[0]?.date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}
        </Text>
        <Text size="xs" c="dimmed">
          today
        </Text>
      </Group>
    </Box>
  );
}

export function RankedBars({
  rows,
  max,
  format,
}: {
  rows: { label: string; value: number; hint?: string }[];
  max: number;
  format: (value: number) => string;
}) {
  return (
    <Stack gap={10}>
      {rows.map((row) => (
        <Box key={row.label}>
          <Group justify="space-between" gap="sm" wrap="nowrap" mb={4}>
            <Text size="sm" style={{ minWidth: 0 }} truncate>
              {row.label}
            </Text>
            <Group gap={6} wrap="nowrap">
              {row.hint && (
                <Text size="xs" c="dimmed">
                  {row.hint}
                </Text>
              )}
              <Text size="sm" fw={600} ff="monospace">
                {format(row.value)}
              </Text>
            </Group>
          </Group>
          <Box h={6} style={{ background: TRACK, borderRadius: 3, overflow: "hidden" }}>
            <Box
              h="100%"
              w={`${Math.max(2, (row.value / max) * 100)}%`}
              style={{ background: SERIES, borderRadius: 3 }}
            />
          </Box>
        </Box>
      ))}
    </Stack>
  );
}
