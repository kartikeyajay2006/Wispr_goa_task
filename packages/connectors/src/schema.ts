/**
 * Structural description of the demo PostgreSQL schema: how each table links a row to a
 * customer, which columns are foreign keys, and which columns carry personal data.
 * Classification lives in the retention policy, not here.
 */
export type Ownership =
  | {kind: 'self'}
  | {kind: 'column'; column: string}
  | {kind: 'via'; column: string; table: string};
export type ForeignKey = {column: string; references: string};
export type TableSchema = {name: string; ownership: Ownership; foreignKeys: ForeignKey[]; piiColumns: string[]};

export const POSTGRES_SCHEMA: readonly TableSchema[] = [
  {name: 'customers', ownership: {kind: 'self'}, foreignKeys: [], piiColumns: ['name', 'email', 'phone']},
  {name: 'users', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [{column: 'customer_id', references: 'customers'}], piiColumns: ['email', 'name']},
  {name: 'addresses', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [{column: 'customer_id', references: 'customers'}], piiColumns: ['line1', 'city', 'postal_code']},
  {name: 'orders', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [{column: 'customer_id', references: 'customers'}], piiColumns: []},
  {name: 'order_items', ownership: {kind: 'via', column: 'order_id', table: 'orders'}, foreignKeys: [{column: 'order_id', references: 'orders'}], piiColumns: []},
  {name: 'payments', ownership: {kind: 'via', column: 'order_id', table: 'orders'}, foreignKeys: [{column: 'order_id', references: 'orders'}], piiColumns: ['billing_email']},
  {name: 'support_tickets', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [{column: 'customer_id', references: 'customers'}], piiColumns: ['subject']},
  {name: 'support_messages', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [{column: 'customer_id', references: 'customers'}, {column: 'ticket_id', references: 'support_tickets'}], piiColumns: ['body']},
  {name: 'analytics_events', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [{column: 'customer_id', references: 'customers'}], piiColumns: ['payload']},
  {name: 'marketing_profiles', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [{column: 'customer_id', references: 'customers'}], piiColumns: ['email', 'preferences']},
  {name: 'audit_records', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [], piiColumns: []},
  // Children are listed before their parents so executing in schema order never violates a foreign key.
  {name: 'organization_members', ownership: {kind: 'column', column: 'customer_id'}, foreignKeys: [{column: 'customer_id', references: 'customers'}, {column: 'org_id', references: 'organizations'}], piiColumns: []},
  {name: 'organizations', ownership: {kind: 'column', column: 'owner_customer_id'}, foreignKeys: [{column: 'owner_customer_id', references: 'customers'}], piiColumns: ['billing_email']},
];

/** Buckets that hold customer-owned objects. The backup bucket is a system bucket and is never scanned as a footprint. */
export const SOURCE_BUCKETS = ['customer-uploads', 'support-attachments', 'exports'] as const;
export const BACKUP_BUCKET = 'eraseops-backups';
export const REDACTED = '[redacted]';

export const tableSchema = (table: string) => POSTGRES_SCHEMA.find(schema => schema.name === table);
export const objectPrefixFor = (bucket: string, customerId: string) => bucket === 'exports' ? `${customerId}-` : `${customerId}/`;
