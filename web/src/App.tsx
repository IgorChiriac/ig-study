import {
  AppShell,
  Avatar,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { IconBrandGoogleFilled, IconCards, IconLogout, IconSchool } from "@tabler/icons-react";
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from "firebase/auth";
import type { User } from "firebase/auth";
import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";

import { dueCards } from "./api";
import { auth, googleProvider } from "./firebase";

export function useUser(): { user: User | null; ready: boolean } {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => onAuthStateChanged(auth, (next) => {
    setUser(next);
    setReady(true);
  }), []);
  return { user, ready };
}

async function signIn() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch {
    // iOS blocks popups often enough that redirect is the reliable fallback.
    await signInWithRedirect(auth, googleProvider);
  }
}

function SignIn() {
  return (
    <Center h="100dvh" px="md">
      <Stack align="center" gap="lg" maw={380}>
        <IconSchool size={52} stroke={1.4} />
        <Stack align="center" gap={4}>
          <Title order={2}>ig-study</Title>
          <Text c="dimmed" ta="center" size="sm">
            Watch a lecture, write what you understood, get quizzed on it later.
          </Text>
        </Stack>
        <Button
          size="md"
          fullWidth
          leftSection={<IconBrandGoogleFilled size={18} />}
          onClick={() => void signIn()}
        >
          Sign in with Google
        </Button>
      </Stack>
    </Center>
  );
}

export function App() {
  const { user, ready } = useUser();
  const [due, setDue] = useState(0);

  useEffect(() => {
    if (!user) return;
    let live = true;
    dueCards()
      .then((queue) => live && setDue(queue.cards.length))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [user]);

  if (!ready) {
    return (
      <Center h="100dvh">
        <Loader />
      </Center>
    );
  }

  if (!user) return <SignIn />;

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <UnstyledButton component={Link} to="/">
            <Group gap={8} wrap="nowrap">
              <IconSchool size={22} stroke={1.6} />
              <Text fw={650}>ig-study</Text>
            </Group>
          </UnstyledButton>

          <Group gap="xs" wrap="nowrap">
            <Button
              component={Link}
              to="/quiz"
              size="xs"
              variant={due > 0 ? "filled" : "subtle"}
              color={due > 0 ? "violet" : "gray"}
              leftSection={<IconCards size={16} />}
            >
              {due > 0 ? `${due} due` : "Quiz"}
            </Button>

            <Menu position="bottom-end" withArrow>
              <Menu.Target>
                <UnstyledButton>
                  <Avatar src={user.photoURL} radius="xl" size={32}>
                    {user.displayName?.[0] ?? "?"}
                  </Avatar>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user.email}</Menu.Label>
                <Menu.Item
                  leftSection={<IconLogout size={16} />}
                  onClick={() => void signOut(auth)}
                >
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Outlet context={{ uid: user.uid }} />
      </AppShell.Main>
    </AppShell>
  );
}
