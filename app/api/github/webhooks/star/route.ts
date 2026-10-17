import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS } from "@/lib/domain/accounts/request-auth";
import { receiveGithubWebhook } from "@/lib/domain/github-webhooks/receive";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

export const POST = webWriteRoute(async (request: Request) => {
  try {
    await receiveGithubWebhook(request, "star");
    return Response.json({ accepted: true }, { status: 202, headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}, publicAuthErrorResponse);
