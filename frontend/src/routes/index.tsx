import { Navigate, createBrowserRouter } from "react-router-dom";

import { ProtectedRoute } from "../components/auth/ProtectedRoute";
import { AppLayout } from "../layouts/AppLayout";
import { AuthLayout } from "../layouts/AuthLayout";
import { DashboardPage } from "../pages/DashboardPage";
import { LoginPage } from "../pages/LoginPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { AIAgentsPage } from "../pages/AIAgentsPage";
import { AIFAQPage } from "../pages/AIFAQPage";
import { AIKnowledgePage } from "../pages/AIKnowledgePage";
import { AIOverviewPage } from "../pages/AIOverviewPage";
import { AIStyleExamplesPage } from "../pages/AIStyleExamplesPage";
import { AutomationWorkflowsPage } from "../pages/AutomationWorkflowsPage";
import { AIPromptsPage } from "../pages/AIPromptsPage";
import { AuditLogPage } from "../pages/AuditLogPage";
import { BillingPage } from "../pages/BillingPage";
import { BillingHistoryPage } from "../pages/BillingHistoryPage";
import { BillingPlansPage } from "../pages/BillingPlansPage";
import { ConnectionsPage } from "../pages/ConnectionsPage";
import { CommentsModerationPage } from "../pages/CommentsModerationPage";
import { ChangePasswordPage } from "../pages/ChangePasswordPage";
import { FacebookConnectionCallbackPage } from "../pages/FacebookConnectionCallbackPage";
import { FacebookLiveInboxPage } from "../pages/FacebookLiveInboxPage";
import { InboxPage } from "../pages/InboxPage";
import { PostEditorPage } from "../pages/PostEditorPage";
import { PostsPage } from "../pages/PostsPage";
import { ProductsPage } from "../pages/ProductsPage";
import { SetupWizardPage } from "../pages/SetupWizardPage";
import { TeamPage } from "../pages/TeamPage";
import { TokenPackagesPage } from "../pages/TokenPackagesPage";
import { TokenWalletPage } from "../pages/TokenWalletPage";
import { UsageReportPage } from "../pages/UsageReportPage";

export const router = createBrowserRouter([
  {
    element: <ProtectedRoute />,
    children: [
      {
        path: "/",
        element: <AppLayout />,
        children: [
          {
            index: true,
            element: <DashboardPage />,
          },
          {
            path: "team",
            element: <TeamPage />,
          },
          {
            path: "security/password",
            element: <ChangePasswordPage />,
          },
          {
            path: "billing",
            element: <BillingPage />,
          },
          {
            path: "billing/plans",
            element: <BillingPlansPage />,
          },
          {
            path: "billing/history",
            element: <BillingHistoryPage />,
          },
          {
            path: "billing/packages",
            element: <TokenPackagesPage />,
          },
          {
            path: "wallet",
            element: <TokenWalletPage />,
          },
          {
            path: "usage",
            element: <UsageReportPage />,
          },
          {
            path: "audit-logs",
            element: <AuditLogPage />,
          },
          {
            path: "setup",
            element: <SetupWizardPage />,
          },
          {
            path: "connections",
            element: <ConnectionsPage />,
          },
          {
            path: "automation",
            element: <AutomationWorkflowsPage />,
          },
          {
            path: "connections/facebook/callback",
            element: <FacebookConnectionCallbackPage />,
          },
          {
            path: "comments",
            element: <CommentsModerationPage />,
          },
          {
            path: "inbox",
            element: <Navigate to="/inbox/whatsapp" replace />,
          },
          {
            path: "inbox/whatsapp",
            element: (
              <InboxPage
                defaultPlatform="whatsapp"
                eyebrow="WhatsApp Inbox"
                title="WhatsApp conversation inbox"
                description="Review and respond to WhatsApp customer threads in the active workspace."
              />
            ),
          },
          {
            path: "inbox/facebook",
            element: <FacebookLiveInboxPage />,
          },
          {
            path: "posts",
            element: <PostsPage />,
          },
          {
            path: "posts/new",
            element: <PostEditorPage />,
          },
          {
            path: "posts/:postId",
            element: <PostEditorPage />,
          },
          {
            path: "products",
            element: <ProductsPage />,
          },
          {
            path: "ai",
            element: <AIOverviewPage />,
          },
          {
            path: "ai/agents",
            element: <AIAgentsPage />,
          },
          {
            path: "ai/prompts",
            element: <AIPromptsPage />,
          },
          {
            path: "ai/knowledge",
            element: <AIKnowledgePage />,
          },
          {
            path: "ai/style",
            element: <AIStyleExamplesPage />,
          },
          {
            path: "ai/faq",
            element: <AIFAQPage />,
          },
        ],
      },
    ],
  },
  {
    path: "/",
    element: <AuthLayout />,
    children: [
      {
        path: "login",
        element: <LoginPage />,
      },
    ],
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
]);
