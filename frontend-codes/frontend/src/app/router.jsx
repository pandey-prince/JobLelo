import { createBrowserRouter, Navigate } from "react-router-dom";
import MainLayout from "@/layouts/MainLayout";
import Home from "@/components/Home";
import Login from "@/components/auth/Login";
import Signup from "@/components/auth/Signup";
import Jobs from "@/components/Jobs";
import Profile from "@/components/Profile";
import ProfileSetup from "@/components/ProfileSetup";
import JobDescription from "@/components/JobDescription";
import CompanyJobsPage from "@/components/CompanyJobsPage";
import MonitoredCompaniesPage from "@/components/MonitoredCompaniesPage";
import CompanyLists from "@/components/CompanyLists";
import SavedJobs from "@/components/SavedJobs";
import HiddenJobs from "@/components/HiddenJobs";
import JobAlerts from "@/components/JobAlerts";
import NotFound from "@/components/NotFound";
import AuthRoute from "@/components/shared/AuthRoute";
import AdminLogin from "@/components/admin/AdminLogin";
import AdminLayout from "@/components/admin/AdminLayout";
import AdminDashboard from "@/components/admin/AdminDashboard";
import ScrapeSources from "@/components/admin/ScrapeSources";
import ProtectedRoute from "@/components/admin/ProtectedRoute";

export const appRouter = createBrowserRouter([
  {
    element: <MainLayout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/login", element: <Login /> },
      { path: "/signup", element: <Signup /> },
      { path: "/jobs", element: <Jobs /> },
      { path: "/companies", element: <MonitoredCompaniesPage /> },
      { path: "/companies/:slug", element: <CompanyJobsPage /> },
      { path: "/description/:id", element: <JobDescription /> },
      { path: "/browse", element: <Navigate to="/jobs" replace /> },
      { path: "/profile", element: <AuthRoute roles={["student"]}><Profile /></AuthRoute> },
      {
        path: "/profile/setup",
        element: (
          <AuthRoute roles={["student"]}>
            <ProfileSetup />
          </AuthRoute>
        ),
      },
      { path: "/my-companies", element: <AuthRoute roles={["student"]}><CompanyLists /></AuthRoute> },
      {
        path: "/saved-jobs",
        element: (
          <AuthRoute roles={["student"]}>
            <SavedJobs />
          </AuthRoute>
        ),
      },
      {
        path: "/hidden-jobs",
        element: (
          <AuthRoute roles={["student"]}>
            <HiddenJobs />
          </AuthRoute>
        ),
      },
      {
        path: "/alerts",
        element: (
          <AuthRoute roles={["student"]}>
            <JobAlerts />
          </AuthRoute>
        ),
      },
      // Catch-all: any URL that matches nothing above shows the 404 page.
      { path: "*", element: <NotFound /> },
    ],
  },
  { path: "/admin/login", element: <AdminLogin /> },
  {
    path: "/admin",
    element: (
      <ProtectedRoute>
        <AdminLayout />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <AdminDashboard /> },
      { path: "sources", element: <ScrapeSources /> },
    ],
  },
]);
