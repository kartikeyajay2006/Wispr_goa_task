import {describe,expect,it} from 'vitest';
import {summarizeVerification} from './verification-service.js';

describe('verification service',()=>{
  it('summarizes verified connector rescans for the report',()=>{
    expect(summarizeVerification([
      {system:'PostgreSQL',remainingMatches:0,verified:true,details:'ok'},
      {system:'MinIO',remainingMatches:0,verified:true,details:'ok'}
    ])).toEqual({postgres:true,minio:true,remainingMatches:0});
  });

  it('refuses to summarize a failed rescan as successful',()=>{
    expect(()=>summarizeVerification([
      {system:'PostgreSQL',remainingMatches:1,verified:false,details:'match remains'},
      {system:'MinIO',remainingMatches:0,verified:true,details:'ok'}
    ])).toThrow('Post-execution verification failed');
  });
});
