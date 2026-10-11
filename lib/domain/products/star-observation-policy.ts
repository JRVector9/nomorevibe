import { normalizeTypedLink } from '@/lib/domain/evidence/contracts';
import { githubOwnerFromRepositoryUrl } from './github-owner';

export type StarObservationPolicy = {
  minStars: number;
  maxStarsExclusive: number;
  minGain: number;
  minIntervalHours: number;
  maxIntervalHours: number;
  maxAgeHours: number;
  collectionWindowHours: number;
  retentionDays: number;
};

export const STAR_OBSERVATION_POLICY_VERSION = 'kst-8h-v1';
export const STAR_OBSERVATION_POLICY: Readonly<StarObservationPolicy> = Object.freeze({
  minStars: 50, maxStarsExclusive: 2000, minGain: 10,
  minIntervalHours: 23, maxIntervalHours: 25, maxAgeHours: 10,
  collectionWindowHours: 1, retentionDays: 7,
});
const HOUR_MS = 60 * 60_000;
const CYCLE_MS = 8 * HOUR_MS;
const KST_OFFSET_MS = 9 * HOUR_MS;

/** The most recent scheduled cutoff, including exactly KST 00/08/16. */
export function latestStarObservationCycleAt(now = new Date()): Date {
  return new Date(Math.floor((now.getTime() + KST_OFFSET_MS) / CYCLE_MS) * CYCLE_MS - KST_OFFSET_MS);
}

export function nextStarObservationCycleAt(now = new Date()): Date {
  return new Date(latestStarObservationCycleAt(now).getTime() + CYCLE_MS);
}

/** Use the existing declared-link identity and the collector's strict URL validation. */
export function observationRepositoryKey(repoUrl: string | null): string | null {
  if (!githubOwnerFromRepositoryUrl(repoUrl)) return null;
  return normalizeTypedLink('repository', repoUrl!)?.normalizedKey ?? null;
}
