/**
 * Escalation steps live in a jsonb column, which the database cannot
 * constrain. Every read is therefore untrusted: DTOs validate on write and
 * the sweep re-validates before acting.
 */
export interface EscalationStep {
  afterMinutes: number;
  notifyChannelId: string;
}

export const ESCALATION_MIN_STEPS = 1;
export const ESCALATION_MAX_STEPS = 10;
// Zero means "immediately on open": the first alert of a cascade.
export const ESCALATION_MIN_AFTER_MINUTES = 0;
export const ESCALATION_MAX_AFTER_MINUTES = 60 * 24 * 7; // 7 days

// Prisma's uuid() default and ParseUUIDPipe both emit v4.
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidEscalationStepsError extends Error {}

/**
 * Validates and normalizes the jsonb steps payload.
 *
 * `afterMinutes` is an absolute offset from the incident's `startedAt`, so
 * the values must strictly increase: step 2 can never fire before step 1.
 */
export function parseEscalationSteps(value: unknown): EscalationStep[] {
  if (!Array.isArray(value)) {
    throw new InvalidEscalationStepsError('steps must be an array');
  }
  if (
    value.length < ESCALATION_MIN_STEPS ||
    value.length > ESCALATION_MAX_STEPS
  ) {
    throw new InvalidEscalationStepsError(
      `steps must contain between ${ESCALATION_MIN_STEPS} and ${ESCALATION_MAX_STEPS} entries`,
    );
  }

  let previous: number | null = null;
  return value.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new InvalidEscalationStepsError(`step ${index} must be an object`);
    }

    const { afterMinutes, notifyChannelId } = raw as Record<string, unknown>;

    if (
      typeof afterMinutes !== 'number' ||
      !Number.isInteger(afterMinutes) ||
      afterMinutes < ESCALATION_MIN_AFTER_MINUTES ||
      afterMinutes > ESCALATION_MAX_AFTER_MINUTES
    ) {
      throw new InvalidEscalationStepsError(
        `step ${index} afterMinutes must be an integer between ${ESCALATION_MIN_AFTER_MINUTES} and ${ESCALATION_MAX_AFTER_MINUTES}`,
      );
    }
    if (previous !== null && afterMinutes <= previous) {
      throw new InvalidEscalationStepsError(
        `step ${index} afterMinutes must be greater than the previous step`,
      );
    }
    if (
      typeof notifyChannelId !== 'string' ||
      !UUID_V4_PATTERN.test(notifyChannelId)
    ) {
      throw new InvalidEscalationStepsError(
        `step ${index} notifyChannelId must be a UUID`,
      );
    }

    previous = afterMinutes;
    return { afterMinutes, notifyChannelId };
  });
}

/** Returns null instead of throwing, for paths that must not crash a tick. */
export function tryParseEscalationSteps(
  value: unknown,
): EscalationStep[] | null {
  try {
    return parseEscalationSteps(value);
  } catch {
    return null;
  }
}

/** Absolute deadline for the step at `index`, or null when there is no such step. */
export function escalationDeadline(
  startedAt: Date,
  steps: EscalationStep[],
  index: number,
): Date | null {
  const step = steps[index];
  if (!step) return null;
  return new Date(startedAt.getTime() + step.afterMinutes * 60_000);
}
