/**
 * Region configuration for the checker fleet.
 *
 * The API process schedules work for every region in CHECK_REGIONS. Each
 * worker process probes exactly one region (CHECK_REGION) but still needs the
 * full region list to evaluate quorum.
 */

export const DEFAULT_CHECK_REGION = 'local';

export const CHECK_FLEET_CONFIG = Symbol('CHECK_FLEET_CONFIG');

export interface FleetConfig {
  /** Every configured region; used for quorum and per-region evaluation. */
  regions: string[];
  /** Region this process probes, or null in the API process. */
  region: string | null;
  /** Regions this process schedules work for. */
  scheduleRegions: string[];
  /** Minimum number of regions that must agree. */
  quorum: number;
}

export function parseRegionList(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((region) => region.trim())
        .filter((region) => region.length > 0),
    ),
  ];
}

/**
 * Strict majority by default: 1 -> 1, 2 -> 2, 3 -> 2, 4 -> 3. A strict
 * majority makes "down" and "up" mutually exclusive, so a monitor cannot
 * flap between two equally sized camps.
 */
export function resolveQuorum(
  value: string | undefined,
  regionCount: number,
): number {
  if (value === undefined || value.trim() === '') {
    return Math.floor(regionCount / 2) + 1;
  }

  const quorum = Number(value);
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > regionCount) {
    throw new Error(
      `CHECK_QUORUM must be an integer between 1 and ${regionCount} (got "${value}")`,
    );
  }
  return quorum;
}

export function workerRegion(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHECK_REGION?.trim() || DEFAULT_CHECK_REGION;
}

/** API process: schedules every configured region, never probes itself. */
export function loadApiFleetConfig(
  env: NodeJS.ProcessEnv = process.env,
): FleetConfig {
  const configured = parseRegionList(env.CHECK_REGIONS);
  const regions = configured.length > 0 ? configured : [DEFAULT_CHECK_REGION];

  return {
    regions,
    region: null,
    scheduleRegions: regions,
    quorum: resolveQuorum(env.CHECK_QUORUM, regions.length),
  };
}

/** Worker process: probes and schedules only its own region. */
export function loadWorkerFleetConfig(
  env: NodeJS.ProcessEnv = process.env,
): FleetConfig {
  const region = workerRegion(env);
  const configured = parseRegionList(env.CHECK_REGIONS);
  const regions = configured.length > 0 ? configured : [region];

  if (!regions.includes(region)) {
    throw new Error(
      `CHECK_REGION="${region}" is not listed in CHECK_REGIONS="${regions.join(',')}"`,
    );
  }

  return {
    regions,
    region,
    scheduleRegions: [region],
    quorum: resolveQuorum(env.CHECK_QUORUM, regions.length),
  };
}

export function checkQueueName(region: string): string {
  return `monitor-checks-${region}`;
}
