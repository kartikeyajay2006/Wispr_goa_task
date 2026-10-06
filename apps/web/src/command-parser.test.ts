import {describe, expect, it} from 'vitest';
import {describeIntent, parseCommand} from './command-parser';

describe('command parser', () => {
  it('routes customer requests without granting destructive authority', () => expect(parseCommand('delete all personal data for cust-1042')).toEqual({kind: 'request', customerId: 'CUST-1042'}));
  it('blocks delete-now language explicitly', () => expect(parseCommand('delete now CUST-1042')).toEqual({kind: 'blocked'}));
  it('recognizes safe report, backup, and verification queries', () => { expect(parseCommand('show blast radius for CUST-1042')).toEqual({kind: 'query', query: 'blast-radius', customerId: 'CUST-1042'}); expect(parseCommand('create backup for CUST-1042')).toEqual({kind: 'query', query: 'backup', customerId: 'CUST-1042'}); expect(parseCommand('verify deletion for CUST-1042')).toEqual({kind: 'query', query: 'verification', customerId: 'CUST-1042'}); });
  it('understands dictated customer IDs', () => { expect(parseCommand('Erase customer 1042.')).toEqual({kind: 'request', customerId: 'CUST-1042'}); expect(parseCommand('dry run for cust 2088')).toEqual({kind: 'request', customerId: 'CUST-2088', dryRun: true}); expect(parseCommand('erase customer 10 42')).toEqual({kind: 'request', customerId: 'CUST-1042'}); expect(parseCommand('customer 104')).toEqual({kind: 'query'}); expect(parseCommand('customer 10421')).toEqual({kind: 'query'}); });
  it('navigates between console pages', () => { expect(parseCommand('go to systems')).toEqual({kind: 'navigate', page: 'systems'}); expect(parseCommand('open the dashboard')).toEqual({kind: 'navigate', page: 'overview'}); expect(parseCommand('show policy')).toEqual({kind: 'navigate', page: 'policies'}); });
  it('maps approvals, rejections, rollbacks and resets', () => { expect(parseCommand('approve this plan')).toEqual({kind: 'approve', customerId: undefined}); expect(parseCommand('reject')).toEqual({kind: 'reject', customerId: undefined}); expect(parseCommand('roll back customer 1042')).toEqual({kind: 'rollback', customerId: 'CUST-1042'}); expect(parseCommand('reset the demo data')).toEqual({kind: 'reset'}); });
});

describe('intent descriptions', () => {
  it('reads commands back in plain language', () => {
    expect(describeIntent(parseCommand('erase customer 9002'))).toBe('Open an erasure request for CUST-9002');
    expect(describeIntent(parseCommand('show the dependency graph for cust-9001'))).toBe('Show the dependency graph for CUST-9001');
    expect(describeIntent(parseCommand('delete now'))).toBe('Not allowed: deletions only run from the guarded Execute button');
    expect(describeIntent(parseCommand('hello'))).toBeUndefined();
  });
});

describe('server intent mapping', () => {
  it('maps Claude or rule readings onto console actions', async () => {
    const {fromServerIntent, isConfident} = await import('./command-parser');
    const base = {customerId: 'CUST-1042', tab: null, page: null};
    expect(fromServerIntent({...base, action: 'erase'})).toEqual({kind: 'request', customerId: 'CUST-1042'});
    expect(fromServerIntent({...base, action: 'dry_run'})).toEqual({kind: 'request', customerId: 'CUST-1042', dryRun: true});
    expect(fromServerIntent({...base, action: 'investigate'})).toEqual({kind: 'investigate', customerId: 'CUST-1042'});
    expect(fromServerIntent({...base, action: 'show', tab: 'dependencies'})).toEqual({kind: 'query', query: 'dependencies', customerId: 'CUST-1042'});
    expect(fromServerIntent({...base, customerId: null, action: 'erase'})).toEqual({kind: 'unknown'});
    expect(isConfident(parseCommand('erase customer 1042'))).toBe(true);
    expect(isConfident(parseCommand("wipe Mira's data"))).toBe(false);
  });
});
