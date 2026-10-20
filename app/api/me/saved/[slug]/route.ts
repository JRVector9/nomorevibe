import { publicAuthErrorResponse } from "@/lib/domain/accounts/request-auth";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { savedWrite } from "./handler";

type Context = { params: Promise<{ slug: string }> };

export const PUT = webWriteRoute(async (request: Request, context: Context) => savedWrite("put", request, (await context.params).slug), publicAuthErrorResponse);
export const DELETE = webWriteRoute(async (request: Request, context: Context) => savedWrite("delete", request, (await context.params).slug), publicAuthErrorResponse);
