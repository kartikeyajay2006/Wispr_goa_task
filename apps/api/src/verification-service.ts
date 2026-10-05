import {assertRescanVerified} from '../../../packages/execution/src/index.js';
import type {VerificationResult} from '../../../packages/shared/src/index.js';

export type VerificationSummary={postgres:boolean;minio:boolean;remainingMatches:number};

export function summarizeVerification(results:VerificationResult[]):VerificationSummary{
  assertRescanVerified(results);
  return {
    postgres:results.find(result=>result.system.toLowerCase().includes('postgres'))?.verified??false,
    minio:results.find(result=>result.system.toLowerCase().includes('minio'))?.verified??false,
    remainingMatches:results.reduce((total,result)=>total+result.remainingMatches,0)
  };
}
