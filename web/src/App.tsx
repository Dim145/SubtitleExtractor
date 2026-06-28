import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { Dashboard } from "./pages/Dashboard";
import { Editor } from "./pages/Editor";
import { JobDetail } from "./pages/JobDetail";
import { Login } from "./pages/Login";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { Settings } from "./pages/admin/Settings";
import { Users } from "./pages/admin/Users";
import { Workers } from "./pages/admin/Workers";

function Gate() {
  const { user, loading } = useAuth();

  if (loading)
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Spinner size={24} />
      </div>
    );

  if (!user) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/jobs/:id/editor" element={<Editor />} />
        <Route
          path="/admin"
          element={user.isAdmin ? <AdminLayout /> : <Navigate to="/" replace />}
        >
          <Route index element={<Navigate to="/admin/users" replace />} />
          <Route path="users" element={<Users />} />
          <Route path="settings" element={<Settings />} />
          <Route path="workers" element={<Workers />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
