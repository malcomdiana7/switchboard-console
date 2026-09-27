export const accountStatuses = [
  'idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired',
] as const;
export type AccountStatus = (typeof accountStatuses)[number];

export const deliveryStatuses = [
  'queued', 'accepted', 'sent', 'failed', 'unknown', 'cancelled',
] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export type Role = 'admin' | 'viewer';
export type GroupRole = 'creator' | 'admin' | 'member';
export type GroupStatus = 'active' | 'unreachable' | 'left';

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; [key: string]: unknown };
}

export interface RealtimeEvent<T = unknown> {
  seq: number;
  type: string;
  payload: T;
}

const transitions: Record<AccountStatus, readonly AccountStatus[]> = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return transitions[from].includes(to);
}

export function isTerminal(status: AccountStatus): boolean {
  return status === 'suspended' || status === 'session_expired';
}
