create table if not exists capability_gateway_billing (
  account_id text not null,
  tenant_id text not null,
  subject_id text not null,
  permit_id text not null,
  capability text not null check (capability = 'model/generate'),
  call_id text not null,
  request_hash text not null,
  requested_tier text not null,
  route_policy_version text not null,
  selected_route_index integer,
  provider text,
  model text,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  cost numeric(18, 8) not null default 0,
  status text not null check (status in ('active', 'completed', 'failed', 'cancelled')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  primary key (account_id, call_id)
);

create index if not exists capability_gateway_billing_account_usage_idx
  on capability_gateway_billing (account_id, updated_at, call_id)
  where status = 'completed';
