import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS } from "@/lib/domain/accounts/request-auth";
import { receiveGithubWebhook } from "@/lib/domain/github-webhooks/receive";

export async function POST(request: Request) {
  try {
    await receiveGithubWebhook(request, "star");
    return Response.json({ accepted: true }, { status: 202, headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}
