import {
  Alert,
  Anchor,
  Badge,
  Card,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCoin,
  IconInfoCircle,
  IconPlayerPlay,
  IconSparkles,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { ApiError, usage as fetchUsage } from "../api";
import type { Usage } from "../types";

/** The GCP budget alert, which covers Google costs only — not Anthropic. */
const GCP_BUDGET_CHF = 10;
const CHF_PER_USD = 0.8;

function money(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function Stat({
  label,
  value,
  sub,
  icon,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <Card withBorder padding="lg" radius="md">
      <Group wrap="nowrap" align="flex-start">
        <ThemeIcon size={40} radius="md" variant="light" color={color}>
          {icon}
        </ThemeIcon>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            {label}
          </Text>
          <Text fw={700} size="xl">
            {value}
          </Text>
          {sub && (
            <Text size="xs" c="dimmed">
              {sub}
            </Text>
          )}
        </Stack>
      </Group>
    </Card>
  );
}

export function UsagePage() {
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchUsage()
      .then(setData)
      .catch((exc: unknown) => setError(exc instanceof ApiError ? exc.message : String(exc)));
  }, []);

  if (error) {
    return (
      <Container size="md" py="xl">
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      </Container>
    );
  }

  if (!data) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  const gcpUsd = data.stream.usd;
  const gcpChf = gcpUsd * CHF_PER_USD;
  const budgetPct = Math.min(100, (gcpChf / GCP_BUDGET_CHF) * 100);

  return (
    <Container size="lg" py="md">
      <Group justify="space-between" align="flex-end" mb="lg">
        <Stack gap={0}>
          <Title order={3}>Usage</Title>
          <Text size="sm" c="dimmed">
            {data.month} · metered by this app
          </Text>
        </Stack>
        <Badge size="lg" variant="light" color="violet">
          {money(data.totalUsd)} so far
        </Badge>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 3 }} mb="lg">
        <Stat
          label="Claude"
          value={money(data.claudeUsd)}
          sub={`${data.models.reduce((sum, m) => sum + m.calls, 0)} calls`}
          icon={<IconSparkles size={20} />}
          color="violet"
        />
        <Stat
          label="Video egress"
          value={money(data.stream.usd)}
          sub={`${bytes(data.stream.bytes)} over ${data.stream.requests} ranges`}
          icon={<IconPlayerPlay size={20} />}
          color="blue"
        />
        <Stat
          label="Total"
          value={money(data.totalUsd)}
          sub="Everything else is inside free tiers"
          icon={<IconCoin size={20} />}
          color="teal"
        />
      </SimpleGrid>

      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card withBorder padding="lg" radius="md">
            <Title order={5} mb="sm">
              Claude
            </Title>
            {data.models.length === 0 ? (
              <Text size="sm" c="dimmed">
                No calls yet this month. Generate cards from a note to see figures here.
              </Text>
            ) : (
              <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Model</Table.Th>
                    <Table.Th ta="right">Calls</Table.Th>
                    <Table.Th ta="right">In</Table.Th>
                    <Table.Th ta="right">Out</Table.Th>
                    <Table.Th ta="right">Cost</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.models.map((model) => (
                    <Table.Tr key={model.model}>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm" ff="monospace">
                            {model.model}
                          </Text>
                          {model.note && (
                            <Tooltip label={model.note} multiline w={260} withArrow>
                              <ThemeIcon size={16} variant="subtle" color="gray">
                                <IconInfoCircle size={13} />
                              </ThemeIcon>
                            </Tooltip>
                          )}
                        </Group>
                        <Text size="xs" c="dimmed">
                          ${model.inputUsdPerMTok} / ${model.outputUsdPerMTok} per MTok
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{model.calls}</Table.Td>
                      <Table.Td ta="right">{tokens(model.inputTokens)}</Table.Td>
                      <Table.Td ta="right">{tokens(model.outputTokens)}</Table.Td>
                      <Table.Td ta="right" fw={600}>
                        {money(model.totalUsd)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack gap="lg">
            <Card withBorder padding="lg" radius="md">
              <Group justify="space-between" mb={4}>
                <Title order={5}>Google budget</Title>
                <Text size="sm" c="dimmed">
                  {gcpChf.toFixed(2)} / {GCP_BUDGET_CHF} CHF
                </Text>
              </Group>
              <Progress
                value={budgetPct}
                radius="xl"
                color={budgetPct > 90 ? "red" : budgetPct > 50 ? "yellow" : "teal"}
                mb="xs"
              />
              <Text size="xs" c="dimmed">
                Alerts fire at 50, 90 and 100 percent. This covers Google costs only — Anthropic
                bills separately and is not part of that budget.
              </Text>
            </Card>

            <Card withBorder padding="lg" radius="md">
              <Title order={5} mb="xs">
                Inside free tiers
              </Title>
              <Stack gap={6}>
                {[
                  ["Firestore", "50k reads / 20k writes per day"],
                  ["Cloud Run", "2M requests per month, scales to zero"],
                  ["Hosting", "360 MB transfer per day"],
                  ["Drive storage", "15 GB shared with Gmail and Photos"],
                ].map(([name, allowance]) => (
                  <Group key={name} justify="space-between" wrap="nowrap">
                    <Text size="sm">{name}</Text>
                    <Text size="xs" c="dimmed" ta="right">
                      {allowance}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </Card>

            {data.scan.runs > 0 && (
              <Paper withBorder p="md" radius="md">
                <Text size="sm">
                  {data.scan.runs} scan{data.scan.runs === 1 ? "" : "s"} ·{" "}
                  {data.scan.lectures} lectures indexed
                </Text>
                <Text size="xs" c="dimmed">
                  Drive API calls are free at this volume.
                </Text>
              </Paper>
            )}
          </Stack>
        </Grid.Col>
      </Grid>

      {data.anthropic?.available ? (
        <Card withBorder padding="lg" radius="md" mt="lg">
          <Group justify="space-between" mb={4}>
            <Title order={5}>Billed by Anthropic</Title>
            <Badge variant="light" color="teal">
              actual
            </Badge>
          </Group>
          <Group align="baseline" gap="sm">
            <Text fw={700} size="xl">
              {money(data.anthropic.usd ?? 0)}
            </Text>
            <Text size="sm" c="dimmed">
              since {data.anthropic.since} · this app metered {money(data.claudeUsd)}
            </Text>
          </Group>
          <Text size="xs" c="dimmed" mt="xs">
            Organisation-wide, so anything else run under the same Anthropic organisation is
            included here but not in this app&rsquo;s own figure. A gap between the two is
            usually that, or a price change this repo&rsquo;s table has not caught up with.
          </Text>
        </Card>
      ) : (
        <Alert mt="lg" variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
          <Text size="sm">
            <strong>Want the real invoice figure?</strong> Add an Anthropic admin key and this
            shows what Anthropic actually charged, next to what this app calculated.
            {data.anthropic?.reason ? ` (${data.anthropic.reason})` : ""}
          </Text>
        </Alert>
      )}

      <Alert
        mt="lg"
        variant="light"
        color="gray"
        icon={<IconInfoCircle size={16} />}
        title="How these numbers are produced"
      >
        <Text size="sm">
          Token counts come from each Claude response, so they are exact. Egress is counted as
          bytes leave the proxy, so it is close but not identical to what Google bills — request
          overhead is excluded, and a client that drops mid-stream is billed for bytes this
          counter never saw. For the authoritative figure see{" "}
          <Anchor
            href="https://console.cloud.google.com/billing"
            target="_blank"
            rel="noreferrer"
            size="sm"
          >
            Cloud Billing
          </Anchor>{" "}
          and{" "}
          <Anchor
            href="https://console.anthropic.com/settings/usage"
            target="_blank"
            rel="noreferrer"
            size="sm"
          >
            Anthropic usage
          </Anchor>
          .
        </Text>
      </Alert>
    </Container>
  );
}
