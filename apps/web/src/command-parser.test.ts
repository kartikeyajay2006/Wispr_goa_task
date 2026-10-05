import {describe, expect, it} from 'vitest';
import {parseCommand} from './command-parser';

describe('command parser', () => {
  it('routes customer requests without granting destructive authority', () => expect(parseCommand('delete all personal data for cust-1042')).toEqual({kind: 'request', customerId: 'CUST-1042'}));
  it('blocks delete-now language explicitly', () => expect(parseCommand('delete now CUST-1042')).toEqual({kind: 'blocked'}));
  it('recognizes safe report, backup, and verification queries', () => { expect(parseCommand('show blast radius for CUST-1042')).toEqual({kind: 'query', query: 'blast-radius', customerId: 'CUST-1042'}); expect(parseCommand('create backup for CUST-1042')).toEqual({kind: 'query', query: 'backup', customerId: 'CUST-1042'}); expect(parseCommand('verify deletion for CUST-1042')).toEqual({kind: 'query', query: 'verification', customerId: 'CUST-1042'}); });
});
