export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JobKind = 'run' | 'chat' | 'swarm' | 'orchestration';
export interface Agent { id: string; version: string; allowedWorkloads: string[] }
export interface ServiceJob {
  id: string; tenantId: string; ownerUserId: string; kind: JobKind; state: string;
  sessionId: string; coordinatorRunId?: string; request: Json; profiles: Json[];
  commandVersion: number; processedCommandVersion: number; pendingCommand: Json;
  result?: Json; error?: Json; createdAt: string; updatedAt: string; [key: string]: Json | undefined;
}
export interface EventEnvelope { sequence: number; type?: string; occurredAt?: string; timestamp?: string; data?: Json; [key: string]: Json | undefined }
export interface Artifact { id: string; filename: string; mediaType: string; byteSize: number; status: string; createdAt: string; [key: string]: Json | undefined }
export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

let token = '';
export function setToken(value: string) { token = value; }
function headers(json = false, idempotencyKey?: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) };
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...headers(init.body !== undefined), ...init.headers } });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { const body = await response.json(); message = body.error?.message || body.message || message; } catch { /* non-JSON error */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
const query = (values: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
export const api = {
  agents: () => request<{ items: Agent[] }>('/v1/agents'),
  jobs: (values: { kind?: string; state?: string; tenantId?: string; ownerUserId?: string; limit: number; offset: number }, admin = false) => request<Page<ServiceJob>>(`/v1/${admin ? 'admin/' : ''}jobs?${query(values)}`),
  job: (id: string, admin = false) => request<ServiceJob>(`/v1/${admin ? 'admin/' : ''}jobs/${encodeURIComponent(id)}`),
  submit: (kind: JobKind, body: Json, key?: string) => request<{ jobId: string }>(`/v1/jobs/${kind}`, { method: 'POST', body: JSON.stringify(body), headers: headers(true, key) }),
  events: (id: string, after = 0, admin = false) => request<EventEnvelope[]>(`/v1/${admin ? 'admin/' : ''}jobs/${encodeURIComponent(id)}/events?afterSequence=${after}&limit=500`),
  artifacts: (id: string, admin = false) => request<Artifact[]>(`/v1/${admin ? 'admin/' : ''}jobs/${encodeURIComponent(id)}/artifacts`),
  auxiliary: <T>(id: string, resource: 'run-links' | 'audit') => request<T>(`/v1/admin/jobs/${encodeURIComponent(id)}/${resource}`),
  control: (id: string, action: string, body: Json = {}, admin = false, key?: string) => request<ServiceJob>(`/v1/${admin ? 'admin/' : ''}jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body), headers: headers(true, key) }),
  admin: <T>(resource: 'overview' | 'tenants' | 'users', values: Record<string, string | number | undefined> = {}) => request<T>(`/v1/admin/${resource}?${query(values)}`),
  async download(jobId: string, artifact: Artifact) {
    const response = await fetch(`/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.id)}/download`, { headers: headers() });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = artifact.filename; anchor.click(); URL.revokeObjectURL(url);
  },
};

export function openJobSocket(jwt: string, jobId: string, afterSequence: number, onMessage: (message: Record<string, unknown>) => void, onClose: () => void) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/v1/ws`, ['adaptive-agent', `bearer.${jwt}`]);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ operation: 'subscribe', requestId: crypto.randomUUID(), jobId, afterSequence })));
  socket.addEventListener('message', event => { try { onMessage(JSON.parse(event.data)); } catch { /* ignore malformed frame */ } });
  socket.addEventListener('close', onClose);
  return socket;
}
