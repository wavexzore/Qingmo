import { createHashRouter, Navigate, type RouteObject } from "react-router-dom";

import { EditorPage } from "../features/editor/EditorPage";
import { WorkspaceLayout } from "../features/workspace/WorkspaceLayout";

export const routes: RouteObject[] = [
  {
    element: <WorkspaceLayout />,
    children: [
      { path: "/", element: <EditorPage /> },
      { path: "/editor", element: <EditorPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];

export function createAppRouter() {
  return createHashRouter(routes);
}
