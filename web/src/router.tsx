import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "@/app/RootLayout";
import { Login } from "@/routes/Login";
import { Dashboard } from "@/routes/Dashboard";
import { JobDetail } from "@/routes/JobDetail";
import { Editor } from "@/routes/Editor";
import { Admin } from "@/routes/stubs";

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Dashboard });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: Login });
const jobRoute = createRoute({ getParentRoute: () => rootRoute, path: "/jobs/$id", component: JobDetail });
const editorRoute = createRoute({ getParentRoute: () => rootRoute, path: "/jobs/$id/editor", component: Editor });
const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: Admin });

const routeTree = rootRoute.addChildren([indexRoute, loginRoute, jobRoute, editorRoute, adminRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
