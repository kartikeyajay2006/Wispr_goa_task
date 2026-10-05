import {assertDestructiveExecutionRequest} from '../../../packages/policy-engine/src/index.js';

export type DestructiveGuardInput={identity:string;requestId:string;approvalId:string;planHash:string;authoritativeRequestId:string;authoritativeApprovalId:string;authoritativePlanHash:string};

export class DestructiveRequestGuard{
  private readonly attempts=new Map<string,{count:number;resetAt:number}>();
  constructor(private readonly maxAttempts=3,private readonly windowMs=60_000){}
  authorize(input:DestructiveGuardInput,now=Date.now()){
    const current=this.attempts.get(input.identity);
    if(!current||current.resetAt<=now)this.attempts.set(input.identity,{count:1,resetAt:now+this.windowMs});
    else{if(current.count>=this.maxAttempts)throw new Error('Destructive operation rate limit exceeded');current.count+=1;}
    return assertDestructiveExecutionRequest(input);
  }
}
