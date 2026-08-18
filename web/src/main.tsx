import { MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./global.css";

import { App } from "./App";
import { Course } from "./pages/Course";
import { Docs } from "./pages/Docs";
import { Gaps } from "./pages/Gaps";
import { Lecture } from "./pages/Lecture";
import { Projects } from "./pages/Projects";
import { Quiz } from "./pages/Quiz";
import { Stats } from "./pages/Stats";
import { UsagePage } from "./pages/Usage";

const theme = createTheme({
  primaryColor: "violet",
  defaultRadius: "md",
  fontFamily:
    "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  headings: { fontWeight: "650" },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="top-right" />
      <BrowserRouter>
        <Routes>
          <Route element={<App />}>
            <Route index element={<Projects />} />
            <Route path="quiz" element={<Quiz />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="c/:projectId" element={<Course />} />
            <Route path="c/:projectId/stats" element={<Stats />} />
            <Route path="c/:projectId/docs" element={<Docs />} />
            <Route path="c/:projectId/gaps" element={<Gaps />} />
            <Route path="c/:projectId/:lectureId" element={<Lecture />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>,
);
