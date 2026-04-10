#!/usr/bin/env bun

import {
  GATEWAY_CONFIG_PATH,
  loadLocalGatewayJwtAuthConfig,
} from './local-dev.js';
import { mintLocalDevJwt } from './local-dev-jwt.js';

interface MintOptions {
  subject: string;
  tenantId?: string;
  roles: string[];
  expiresIn: string;
  issuer?: string;
  audience?: string | string[];
}

const USAGE = `Usage:
  bun run ./packages/gateway-fastify/src/mint-local-jwt.ts [options]

Options:
  --sub, --subject <value>      JWT subject claim (default: local-dev-user)
  --tenant <value>              Set the tenant claim
  --role <value>                Add a role claim; can be repeated
  --roles <a,b,c>               Add multiple comma-separated roles
  --expires-in <value>          Expiration passed to jose (default: 7d)
  --issuer <value>              Override issuer claim
  --audience <value>            Override audience claim
  --help                        Show this help text

Examples:
  bun run gateway:mint-jwt
  bun run gateway:mint-jwt --sub alice --tenant acme --role admin
  bun run gateway:mint-jwt --audience adaptive-agent-gateway --issuer https://auth.example.com`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const gatewayAuth = await loadLocalGatewayJwtAuthConfig();
  const options = parseArgs(args, gatewayAuth);
  const { token, config } = await mintLocalDevJwt(options);

  console.error(`Minted local dev JWT for sub=${options.subject}`);
  console.error(`- gateway config: ${GATEWAY_CONFIG_PATH}`);
  console.error(`- secret source: ${config.secretSource}`);
  console.error(`- expires in: ${options.expiresIn}`);
  if (options.tenantId) {
    console.error(`- ${config.tenantIdClaim}: ${options.tenantId}`);
  }
  if (options.roles.length > 0) {
    console.error(`- ${config.rolesClaim}: ${options.roles.join(', ')}`);
  }
  if (options.issuer) {
    console.error(`- iss: ${options.issuer}`);
  }
  if (options.audience) {
    console.error(`- aud: ${Array.isArray(options.audience) ? options.audience.join(', ') : options.audience}`);
  }

  process.stdout.write(`${token}\n`);
}

function parseArgs(args: string[], gatewayAuth?: Awaited<ReturnType<typeof loadLocalGatewayJwtAuthConfig>>): MintOptions {
  const options: MintOptions = {
    subject: 'local-dev-user',
    tenantId: undefined,
    roles: [],
    expiresIn: '7d',
    issuer: gatewayAuth?.issuer,
    audience: gatewayAuth?.audience,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case '--sub':
      case '--subject':
        options.subject = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--tenant':
        options.tenantId = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--role':
        options.roles.push(requireValue(arg, args[index + 1]));
        index += 1;
        break;
      case '--roles': {
        const roles = requireValue(arg, args[index + 1])
          .split(',')
          .map((role) => role.trim())
          .filter((role) => role.length > 0);
        options.roles.push(...roles);
        index += 1;
        break;
      }
      case '--expires-in':
        options.expiresIn = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--issuer':
        options.issuer = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--audience':
        options.audience = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  return {
    ...options,
    roles: dedupe(options.roles),
  };
}

function requireValue(flag: string, value: string | undefined): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Missing value for ${flag}.`);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to mint local dev JWT: ${message}`);
  process.exit(1);
});
