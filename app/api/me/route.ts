import { getPublicSession, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";

export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    return Response.json(session ?? { user: null, csrfToken: null }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}
