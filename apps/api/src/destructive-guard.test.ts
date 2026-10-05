import {describe,expect,it} from 'vitest';
import {DestructiveRequestGuard} from './destructive-guard.js';

const input=(identity='operator')=>({identity,requestId:'00000000-0000-4000-8000-000000000001',approvalId:'00000000-0000-4000-8000-000000000002',planHash:'a'.repeat(64),authoritativeRequestId:'00000000-0000-4000-8000-000000000001',authoritativeApprovalId:'00000000-0000-4000-8000-000000000002',authoritativePlanHash:'a'.repeat(64)});
describe('destructive API guard',()=>{
  it('requires exact authoritative identities',()=>{const guard=new DestructiveRequestGuard();expect(guard.authorize(input())).toBe(true);expect(()=>guard.authorize({...input(),planHash:'b'.repeat(64)})).toThrow('plan hash mismatch')});
  it('rate limits repeated destructive attempts per identity',()=>{const guard=new DestructiveRequestGuard(2,1000);guard.authorize(input(),100);guard.authorize(input(),200);expect(()=>guard.authorize(input(),300)).toThrow('rate limit');expect(guard.authorize(input(),1200)).toBe(true);});
});
