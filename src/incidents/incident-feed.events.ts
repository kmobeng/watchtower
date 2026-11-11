import type { Incident, IncidentStatus } from '../../generated/prisma/client';

/** Redis pub/sub channel shared by the API and every worker process. */
export const DASHBOARD_INCIDENT_CHANNEL = 'dashboard:incident-events';

/**
 * Event names pushed to dashboard clients. They mirror the incident lifecycle:
 * open, acknowledge, escalate, resolve, plus a generic update for escalation
 * step 0 (the first alert does not change the status).
 */
export const IncidentFeedEvent = {
  Opened: 'incident:opened',
  Acknowledged: 'incident:acknowledged',
  Escalated: 'incident:escalated',
  Resolved: 'incident:resolved',
  Updated: 'incident:updated',
} as const;

export type IncidentFeedEventName =
  (typeof IncidentFeedEvent)[keyof typeof IncidentFeedEvent];

const FEED_EVENT_NAMES = new Set<string>(Object.values(IncidentFeedEvent));

/** The incident shape a dashboard needs; dates are serialized for transport. */
export interface FeedIncident {
  id: string;
  monitorId: string;
  userId: string;
  status: IncidentStatus;
  cause: string;
  startedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  downtimeSeconds: number | null;
  escalationStep: number;
  nextEscalationAt: string | null;
}

/** Authoritative open-incident set sent once when a client connects. */
export interface DashboardSnapshot {
  incidents: FeedIncident[];
  serverTime: string;
}

export interface IncidentFeedMessage {
  event: IncidentFeedEventName;
  incident: FeedIncident;
  occurredAt: string;
}

export type IncidentFeedSource = Pick<
  Incident,
  | 'id'
  | 'monitorId'
  | 'status'
  | 'cause'
  | 'startedAt'
  | 'acknowledgedAt'
  | 'resolvedAt'
  | 'downtimeSeconds'
  | 'escalationStep'
  | 'nextEscalationAt'
>;

export function toFeedIncident(
  incident: IncidentFeedSource,
  userId: string,
): FeedIncident {
  return {
    id: incident.id,
    monitorId: incident.monitorId,
    userId,
    status: incident.status,
    cause: incident.cause,
    startedAt: incident.startedAt.toISOString(),
    acknowledgedAt: incident.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    downtimeSeconds: incident.downtimeSeconds ?? null,
    escalationStep: incident.escalationStep,
    nextEscalationAt: incident.nextEscalationAt?.toISOString() ?? null,
  };
}

/**
 * Redis is a trust boundary only in the sense that a malformed or stale
 * message must never crash the subscriber. Unknown events are dropped rather
 * than forwarded to clients.
 */
export function isIncidentFeedMessage(
  value: unknown,
): value is IncidentFeedMessage {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Partial<IncidentFeedMessage>;
  if (
    typeof candidate.event !== 'string' ||
    !FEED_EVENT_NAMES.has(candidate.event) ||
    typeof candidate.occurredAt !== 'string'
  ) {
    return false;
  }

  const incident = candidate.incident as Partial<FeedIncident> | undefined;
  return (
    typeof incident === 'object' &&
    incident !== null &&
    typeof incident.id === 'string' &&
    typeof incident.monitorId === 'string' &&
    typeof incident.userId === 'string' &&
    typeof incident.status === 'string'
  );
}
