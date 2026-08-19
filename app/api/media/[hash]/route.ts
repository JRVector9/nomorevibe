import { createMediaGet } from "@/lib/domain/media/http";
import { postgresMediaStorage } from "@/lib/domain/media/postgres-storage";

export const runtime = "nodejs";

export const GET = createMediaGet(postgresMediaStorage);
