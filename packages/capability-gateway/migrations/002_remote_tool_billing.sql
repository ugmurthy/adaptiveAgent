alter table capability_gateway_billing drop constraint if exists capability_gateway_billing_capability_check;
alter table capability_gateway_billing alter column requested_tier drop not null;
alter table capability_gateway_billing
  add column if not exists units numeric(18, 4) not null default 0;
update capability_gateway_billing
set units = total_tokens
where capability = 'model/generate' and units = 0;
alter table capability_gateway_billing
  add constraint capability_gateway_billing_capability_check
  check (capability in ('model/generate', 'web_search@1', 'read_web_page@1'));
