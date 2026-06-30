export interface ZpeerStatusComparable {
  status?: string;
  kind?: string;
  at?: string;
}

const ZPEER_TERMINAL_STATUSES = new Set([
  "reply",
  "completed",
  "response_sent",
  "blocked",
  "error",
  "timeout",
  "expired",
  "required_response_expired",
]);

const ZPEER_STATUS_RANKS: Record<string, number> = {
  status: 0,
  attempt: 5,
  heartbeat: 5,
  sent: 10,
  delivered: 20,
  urgent_delivered: 25,
  force_accepted: 25,
  force_downgraded: 25,
  required_response_reinject: 30,
  inbound: 35,
  prompt_received: 35,
  waiting: 40,
  response_sent: 90,
  reply: 100,
  completed: 100,
  blocked: 100,
  force_blocked: 100,
  error: 100,
  timeout: 100,
  expired: 100,
  required_response_expired: 100,
};

function zpeerStatusKey(input: ZpeerStatusComparable): string | undefined {
  return input.status ?? input.kind;
}

function parsedTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isZpeerTerminalStatus(status: string | undefined, kind?: string): boolean {
  const primary = status ?? kind;
  return Boolean((primary && ZPEER_TERMINAL_STATUSES.has(primary)) || (kind && ZPEER_TERMINAL_STATUSES.has(kind)));
}

export function zpeerStatusRank(status: string | undefined, kind?: string): number {
  const primary = status ?? kind;
  if (primary && ZPEER_STATUS_RANKS[primary] !== undefined) return ZPEER_STATUS_RANKS[primary];
  if (kind && ZPEER_STATUS_RANKS[kind] !== undefined) return ZPEER_STATUS_RANKS[kind];
  return 0;
}

export function shouldAcceptZpeerStatusUpdate(current: ZpeerStatusComparable | undefined, incoming: ZpeerStatusComparable): boolean {
  if (!current) return true;

  const currentTerminal = isZpeerTerminalStatus(current.status, current.kind);
  const incomingTerminal = isZpeerTerminalStatus(incoming.status, incoming.kind);
  if (currentTerminal && !incomingTerminal) return false;
  if (!currentTerminal && incomingTerminal) return true;

  const currentRank = zpeerStatusRank(current.status, current.kind);
  const incomingRank = zpeerStatusRank(incoming.status, incoming.kind);
  if (incomingRank > currentRank) return true;
  if (incomingRank < currentRank) return false;

  const currentAt = parsedTime(current.at);
  const incomingAt = parsedTime(incoming.at);
  if (currentAt !== undefined && incomingAt !== undefined) return incomingAt >= currentAt;

  const currentKey = zpeerStatusKey(current);
  const incomingKey = zpeerStatusKey(incoming);
  return currentKey === incomingKey;
}

export function annotateZpeerStatus<T extends ZpeerStatusComparable>(event: T): T & { terminal: boolean; statusRank: number } {
  return {
    ...event,
    terminal: isZpeerTerminalStatus(event.status, event.kind),
    statusRank: zpeerStatusRank(event.status, event.kind),
  };
}
