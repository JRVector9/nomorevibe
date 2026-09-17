"use client";
import { Home, Catalog, Missions } from "./Discovery";
import { ProductDetail, FeedbackDetail } from "./Product";
import { LaunchForm, Claim, StartTest, FeedbackForm } from "./Participation";
import {
  Dashboard,
  UpdateForm,
  SprintForm,
  SprintResult,
  AgentRuns,
  Credits,
} from "./Maker";
import {
  CreditPolicy,
  Pricing,
  Billing,
  Activity,
  Notifications,
  Trust,
  Appeal,
  AdminReview,
} from "./Account";
import { productBySlug } from "./data";
export function DesignRouter({ path }: { path: string }) {
  const parts = path.split("/");
  const p = productBySlug(parts[1]);
  if (parts[0] === "p" && p) {
    if (parts[2] === "claim") return <Claim product={p} />;
    if (parts[2] === "test") return <StartTest product={p} />;
    return <ProductDetail product={p} />;
  }
  if (parts[0] === "tests" && p) return <FeedbackForm product={p} />;
  if (parts[0] === "feedback") return <FeedbackDetail id={parts[1]} />;
  switch (path) {
    case "":
      return <Home />;
    case "launches":
      return <Catalog />;
    case "radar":
      return <Catalog radar />;
    case "missions":
      return <Missions />;
    case "launch":
      return <LaunchForm />;
    case "dashboard":
      return <Dashboard />;
    case "dashboard/products/frameit/updates/new":
      return <UpdateForm />;
    case "dashboard/agent-runs":
      return <AgentRuns />;
    case "credits":
      return <Credits />;
    case "credits/how-it-works":
      return <CreditPolicy />;
    case "sprints/new":
      return <SprintForm />;
    case "sprints/demo":
      return <SprintResult />;
    case "pricing":
      return <Pricing />;
    case "settings/billing":
      return <Billing />;
    case "me":
      return <Activity />;
    case "notifications":
      return <Notifications />;
    case "trust":
      return <Trust />;
    case "appeals/demo":
      return <Appeal />;
    case "admin/review":
      return <AdminReview />;
    default:
      return null;
  }
}
