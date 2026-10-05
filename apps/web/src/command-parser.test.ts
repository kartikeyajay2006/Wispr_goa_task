import {describe, expect, it} from 'vitest';
import {parseCommand} from './command-parser';

describe('command parser', () => {
  it('routes customer requests without granting destructive authority', () => expect(parseCommand('delete all personal data for cust-1042')).toEqual({kind: 'request', customerId: 'CUST-1042'}));
  it('blocks delete-now language explicitly', () => expect(parseCommand('delete now CUST-1042')).toEqual({kind: 'blocked'}));
  it('recognizes safe report, backup, and verification queries', () => { expect(parseCommand('show blast radius for CUST-1042')).toEqual({kind: 'query', query: 'blast-radius', customerId: 'CUST-1042'}); expect(parseCommand('create backup for CUST-1042')).toEqual({kind: 'query', query: 'backup', customerId: 'CUST-1042'}); expect(parseCommand('verify deletion for CUST-1042')).toEqual({kind: 'query', query: 'verification', customerId: 'CUST-1042'}); });
  it('understands dictated customer IDs', () => { expect(parseCommand('Erase customer 1042.')).toEqual({kind: 'request', customerId: 'CUST-1042'}); expect(parseCommand('dry run for cust 2088')).toEqual({kind: 'request', customerId: 'CUST-2088', dryRun: true}); });
  it('navigates between console pages', () => { expect(parseCommand('go to systems')).toEqual({kind: 'navigate', page: 'systems'}); expect(parseCommand('open the dashboard')).toEqual({kind: 'navigate', page: 'overview'}); expect(parseCommand('show policy')).toEqual({kind: 'navigate', page: 'policies'}); });
  it('maps approvals, rejections, rollbacks and resets', () => { expect(parseCommand('approve this plan')).toEqual({kind: 'approve', customerId: undefined}); expect(parseCommand('reject')).toEqual({kind: 'reject', customerId: undefined}); expect(parseCommand('roll back customer 1042')).toEqual({kind: 'rollback', customerId: 'CUST-1042'}); expect(parseCommand('reset the demo data')).toEqual({kind: 'reset'}); });
});
