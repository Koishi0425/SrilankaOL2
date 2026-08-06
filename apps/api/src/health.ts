import type { DependencyStatus, HealthData } from '@srilanka/contracts';

export interface HealthDependencies {
  checkDatabase: () => Promise<void>;
  checkRedis: () => Promise<void>;
}

async function getStatus(
  check: () => Promise<void>,
): Promise<DependencyStatus> {
  try {
    await check();
    return 'up';
  } catch {
    return 'down';
  }
}

export async function getHealth(
  dependencies: HealthDependencies,
): Promise<HealthData> {
  const [database, redis] = await Promise.all([
    getStatus(dependencies.checkDatabase),
    getStatus(dependencies.checkRedis),
  ]);

  return {
    status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
    service: 'api',
    version: '0.0.0',
    dependencies: { database, redis },
  };
}
