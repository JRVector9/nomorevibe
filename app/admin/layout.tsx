import { AdminShell } from "./AdminShell";
import "./admin.css";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // Each page and mutation retains its server-side authorization check.
  return <AdminShell>{children}</AdminShell>;
}
