import {describe,expect,it} from 'vitest';
import {makeWorkflow} from './server.js';

describe('API workflow safety scenarios',()=>{
  it('blocks a customer with an unsafe shared dependency before approval',async()=>{
    const workflow=await makeWorkflow({customerId:'CUST-9001',reason:'Customer erasure request with dependency review',dryRun:false});
    expect(workflow.status).toBe('blocked');
    expect(workflow.stage).toBe('sandbox');
    expect((workflow as any).sandbox?.status).toBe('failed');
    expect(workflow.approval).toBeUndefined();
    expect(workflow.events.some((item:any)=>item.stage==='sandbox'&&item.details?.failures?.length)).toBe(true);
  });

  it('blocks a customer whose backup manifest cannot be verified',async()=>{
    const workflow=await makeWorkflow({customerId:'CUST-7001',reason:'Customer erasure request requiring backup validation',dryRun:false});
    expect(workflow.status).toBe('blocked');
    expect(workflow.stage).toBe('backup');
    expect((workflow as any).backupVerified).toBe(false);
    expect(workflow.approval).toBeUndefined();
  });
});
