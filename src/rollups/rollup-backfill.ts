// Must run before any module reads process.env. Keep this the first import.
import 'dotenv/config';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { RollupGranularity } from '../../generated/prisma/client';
import {
  DAY_MS,
  addBuckets,
  toRollupGranularity,
  truncateToBucket,
} from './bucket';
import { RollupsModule } from './rollups.module';
import { RollupsService } from './rollups.service';

/**
 * Backfill context deliberately omits ScheduleModule: booting this CLI must
 * never start the hourly/daily rollup crons.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), RollupsModule],
})
class RollupBackfillModule {}

interface BackfillArgs {
  granularity: RollupGranularity;
  from: Date;
  to: Date;
}

const USAGE = `Usage: npm run rollup:backfill -- [options]

Options:
  --granularity <hour|day>  Bucket size (default: hour)
  --from <ISO timestamp>    Inclusive start (default: 7 days ago for hour, 90 for day)
  --to <ISO timestamp>      Inclusive end (default: last completed bucket)
`;

export function parseArgs(
  argv: string[],
  now: Date = new Date(),
): BackfillArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument "${argument}"\n\n${USAGE}`);
    }

    const [name, inlineValue] = argument.slice(2).split('=', 2);
    const value = inlineValue ?? argv[index + 1];

    if (inlineValue === undefined) {
      index += 1;
    }

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}\n\n${USAGE}`);
    }
    if (!['granularity', 'from', 'to'].includes(name)) {
      throw new Error(`Unknown option --${name}\n\n${USAGE}`);
    }

    values.set(name, value);
  }

  const granularity = toRollupGranularity(
    (values.get('granularity') ?? 'hour') as 'hour' | 'day',
  );

  if (
    values.has('granularity') &&
    !['hour', 'day'].includes(values.get('granularity')!)
  ) {
    throw new Error(`--granularity must be "hour" or "day"\n\n${USAGE}`);
  }

  const defaultWindowMs =
    granularity === RollupGranularity.DAY ? 90 * DAY_MS : 7 * DAY_MS;
  // The bucket containing `now` is still receiving checks, so the default
  // range stops at the last completed bucket instead of writing a partial one.
  const lastCompletedBucket = addBuckets(
    truncateToBucket(now, granularity),
    granularity,
    -1,
  );
  const from = values.has('from')
    ? new Date(values.get('from')!)
    : new Date(now.getTime() - defaultWindowMs);
  const to = values.has('to')
    ? new Date(values.get('to')!)
    : lastCompletedBucket;

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('--from and --to must be valid ISO timestamps');
  }
  if (from.getTime() > to.getTime()) {
    throw new Error('--from must be before --to');
  }

  return { granularity, from, to };
}

async function bootstrap() {
  const args = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(RollupBackfillModule);

  try {
    const rollups = app.get(RollupsService);
    const result = await rollups.rollupRange(
      args.granularity,
      args.from,
      args.to,
    );

    Logger.log(
      {
        granularity: args.granularity,
        from: args.from.toISOString(),
        to: args.to.toISOString(),
        ...result,
      },
      'Rollup backfill finished',
    );
  } finally {
    await app.close();
  }
}

// Only boot when executed directly; importing this module (e.g. from a spec)
// must not start a Nest application.
if (require.main === module) {
  bootstrap().catch((error) => {
    Logger.error(
      error instanceof Error ? error.message : String(error),
      'Rollup backfill failed',
    );
    process.exitCode = 1;
  });
}
