import { describe,expect,it,vi } from 'vitest';
import { PostgresServiceStore, PostgresTransactionStore, type ServicePostgresTransactionClient } from './index.js';
describe('PostgresServiceStore',()=>{
 const mockQuery=()=>vi.fn<(sql:string,params?:unknown[])=>Promise<{rows:any[];rowCount:number}>>(async()=>({rows:[],rowCount:0}));
 it('checks out and commits a transaction',async()=>{const query=mockQuery(); const tx={query,release:vi.fn()} as ServicePostgresTransactionClient; const store=new PostgresServiceStore({query,connect:async()=>tx}); await store.transaction(async()=>42); expect(query.mock.calls.map(x=>x[0])).toEqual(['BEGIN','COMMIT']); expect(tx.release).toHaveBeenCalled();});
 it('rolls back and releases failures',async()=>{const query=mockQuery(); const tx={query,release:vi.fn()} as ServicePostgresTransactionClient; const store=new PostgresServiceStore({query,connect:async()=>tx}); await expect(store.transaction(async()=>{throw new Error('x')})).rejects.toThrow('x'); expect(query.mock.calls.map(x=>x[0])).toEqual(['BEGIN','ROLLBACK']);});
 it('uses exact owner predicates and parameter values',async()=>{const query=mockQuery(); const adapter=new PostgresTransactionStore({query}); await adapter.getOwned({tenantId:'t',userId:'u'},'j'); const [sql,params]=query.mock.calls[0]!; expect(sql).toContain('tenant_id=$2 and owner_user_id=$3'); expect(params).toEqual(['j','t','u']);});
});
