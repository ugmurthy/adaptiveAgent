import {
  INFERENCE_TIERS,
  type InferenceMode,
  type InferenceTier,
  type ProfileRef,
  type RunAuthorizeParams,
} from '@adaptive-agent/gateway-protocol';
import type { GatewayPrincipal } from './auth.js';
import { GatewayError } from './errors.js';

export interface RunPermit {
  id: string;
  subject: string;
  accountId: string;
  tenantId: string;
  runId: string;
  inferenceMode: InferenceMode;
  inferenceTier?: InferenceTier;
  profileRefs: ProfileRef[];
  routePolicyVersion: string;
  remoteCapabilities: string[];
  expiresAt: string;
}

export interface PermitServiceOptions {
  ttlMs?: number;
  maxPermits?: number;
  now?: () => number;
}

export class PermitService {
  private readonly permits = new Map<string, RunPermit>();
  private readonly ttlMs: number;
  private readonly maxPermits: number;
  private readonly now: () => number;

  constructor(options: PermitServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxPermits = options.maxPermits ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  authorize(
    principal: GatewayPrincipal,
    request: RunAuthorizeParams,
    routePolicyVersion: string,
  ): RunPermit {
    this.prune();
    if (!principal.permittedModes.includes(request.inferenceMode)) {
      throw new GatewayError('forbidden');
    }

    const inferenceTier = request.inferenceMode === 'gateway'
      ? request.requestedTier ?? highestTier(principal.allowedTiers)
      : request.requestedTier;
    if (
      inferenceTier !== undefined &&
      !principal.allowedTiers.includes(inferenceTier)
    ) {
      throw new GatewayError('tier_not_entitled');
    }
    if (request.inferenceMode === 'gateway' && inferenceTier === undefined) {
      throw new GatewayError('tier_not_entitled');
    }
    if (this.permits.size >= this.maxPermits) {
      throw new GatewayError('rate_limited', { retryAfterMs: 1_000 });
    }

    const permit: RunPermit = {
      id: crypto.randomUUID(),
      subject: principal.subject,
      accountId: principal.accountId,
      tenantId: principal.tenantId,
      runId: request.runId,
      inferenceMode: request.inferenceMode,
      inferenceTier,
      profileRefs: structuredClone(request.profileRefs),
      routePolicyVersion,
      remoteCapabilities: request.inferenceMode === 'gateway' ? ['model/generate'] : [],
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    };
    this.permits.set(permit.id, permit);
    return structuredClone(permit);
  }

  verifyModelPermit(
    permitId: string,
    principal: GatewayPrincipal,
    tier: InferenceTier,
    runId: string,
    routePolicyVersion: string,
  ): RunPermit {
    const permit = this.permits.get(permitId);
    if (
      !permit ||
      permit.subject !== principal.subject ||
      permit.accountId !== principal.accountId ||
      permit.tenantId !== principal.tenantId ||
      permit.runId !== runId ||
      permit.inferenceMode !== 'gateway' ||
      permit.routePolicyVersion !== routePolicyVersion ||
      !permit.remoteCapabilities.includes('model/generate')
    ) {
      throw new GatewayError('forbidden');
    }
    if (Date.parse(permit.expiresAt) <= this.now()) {
      this.permits.delete(permitId);
      throw new GatewayError('forbidden');
    }
    if (permit.inferenceTier !== tier || !principal.allowedTiers.includes(tier)) {
      throw new GatewayError('tier_not_entitled');
    }
    return structuredClone(permit);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, permit] of this.permits) {
      if (Date.parse(permit.expiresAt) <= now) {
        this.permits.delete(id);
      }
    }
  }
}

function highestTier(tiers: InferenceTier[]): InferenceTier | undefined {
  return [...INFERENCE_TIERS].reverse().find((tier) => tiers.includes(tier));
}
