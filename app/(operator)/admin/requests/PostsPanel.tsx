import { PrototypeRequestWorkspace } from "./PrototypeRequestWorkspace";
export async function PostsPanel(props: { params: Record<string, string | string[] | undefined>; admin: { login: string; exp: number }; secret: string }) {
  return PrototypeRequestWorkspace({ ...props, tab: "posts" });
}
