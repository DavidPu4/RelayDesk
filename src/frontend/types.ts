export type Behavior = 'healthy' | 'flaky' | 'failing';
export type Status = 'queued' | 'processing' | 'retrying' | 'delivered' | 'dead_letter';
export interface Endpoint { id: string; name: string; behavior: Behavior; enabled: boolean; createdAt: number }
export interface Delivery {
  id: string; eventId: string; eventType: string; endpointId: string; endpointName: string;
  status: Status; attemptCount: number; maxAttempts: number; createdAt: number; updatedAt: number;
  nextAttemptAt: number | null; lastStatusCode: number | null; lastError: string | null; deliveredAt: number | null;
}
export interface Attempt {
  id: string; number: number; startedAt: number; finishedAt: number | null; durationMs: number | null;
  statusCode: number | null; outcome: 'in_progress' | 'delivered' | 'failed' | 'lease_expired';
  error: string | null; responseBody: string | null;
}
export interface Receipt { id: string; endpointId: string; eventId: string; acceptedAt: number; duplicateCount: number }
export interface DeliveryDetail extends Delivery { payload: Record<string, unknown>; attempts: Attempt[]; receipt: Receipt | null }
export interface Overview {
  totalEvents: number; totalDeliveries: number; delivered: number; retrying: number; queued: number;
  processing: number; deadLetter: number; duplicatesPrevented: number; recovered: number;
  successRate: number | null; avgLatencyMs: number | null;
  activity: { hour: number; label: string; delivered: number; failed: number }[];
}
export interface Health { status: string; version: string; workerRunning: boolean }
export type Page = 'deliveries' | 'deadletters' | 'endpoints' | 'guide';
