import { createHashRouter, Navigate, type RouteObject } from "react-router-dom";

import { EditorPage } from "./pages/EditorPage";
import { WelcomePage } from "./pages/WelcomePage";

export const routes: RouteObject[] = [
  { path: "/", element: <WelcomePage /> },
  { path: "/editor", element: <EditorPage /> },
  { path: "*", element: <Navigate to="/" replace /> },
];

export function createAppRouter() {
  return createHashRouter(routes);
}
