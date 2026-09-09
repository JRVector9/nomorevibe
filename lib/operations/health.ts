import { serviceInstanceId } from './instance';

type HealthEnvironment = Readonly<Record<string, string | undefined>>;

export function healthIdentity(env: HealthEnvironment = process.env) {
  return {
    instanceId: serviceInstanceId(env) ?? 'legacy',
    release: env.RELEASE_TAG ?? env.NEXT_DEPLOYMENT_ID ?? 'unknown',
  };
}
