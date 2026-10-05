import type {Classification} from '../../../packages/shared/src/index.js';

export type PlanAction = 'delete' | 'redact' | 'retain';
export type RetentionRule = {
  system: 'PostgreSQL' | 'MinIO';
  resource: string;
  label: string;
  classification: Classification;
  basis: string;
  retention?: string;
  risk: 'low' | 'medium' | 'high';
};

/**
 * The erasure policy every connector classifies against. Discovery never decides
 * what happens to a record on its own; it looks the resource up here.
 */
export const RETENTION_POLICY: {version: string; rules: RetentionRule[]} = {
  version: '2026.10',
  rules: [
    {system: 'PostgreSQL', resource: 'customers', label: 'Customer profile', classification: 'anonymize', basis: 'Anchors retained financial records, so identifying fields are redacted instead of deleted', risk: 'high'},
    {system: 'PostgreSQL', resource: 'users', label: 'Login accounts', classification: 'deletable', basis: 'GDPR Art. 17 right to erasure', risk: 'high'},
    {system: 'PostgreSQL', resource: 'addresses', label: 'Saved addresses', classification: 'deletable', basis: 'GDPR Art. 17 right to erasure', risk: 'high'},
    {system: 'PostgreSQL', resource: 'orders', label: 'Order history', classification: 'retain', basis: 'Tax and accounting record-keeping obligation', retention: '7 years', risk: 'medium'},
    {system: 'PostgreSQL', resource: 'order_items', label: 'Order line items', classification: 'retain', basis: 'Part of the retained order record', retention: '7 years', risk: 'low'},
    {system: 'PostgreSQL', resource: 'payments', label: 'Payment records', classification: 'retain', basis: 'Financial regulation and chargeback evidence', retention: '7 years', risk: 'high'},
    {system: 'PostgreSQL', resource: 'support_tickets', label: 'Support tickets', classification: 'anonymize', basis: 'Ticket metrics stay; subject lines are redacted', risk: 'medium'},
    {system: 'PostgreSQL', resource: 'support_messages', label: 'Support messages', classification: 'anonymize', basis: 'Conversation bodies contain free-text personal data', risk: 'medium'},
    {system: 'PostgreSQL', resource: 'analytics_events', label: 'Product analytics', classification: 'deletable', basis: 'No lawful basis once consent is withdrawn', risk: 'medium'},
    {system: 'PostgreSQL', resource: 'marketing_profiles', label: 'Marketing profile', classification: 'deletable', basis: 'Consent-based processing ends on erasure', risk: 'high'},
    {system: 'PostgreSQL', resource: 'audit_records', label: 'Compliance audit log', classification: 'retain', basis: 'Evidence of consent and erasure must be kept', retention: '6 years', risk: 'low'},
    {system: 'PostgreSQL', resource: 'organizations', label: 'Owned workspaces', classification: 'deletable', basis: 'Workspace created and owned by the data subject', risk: 'high'},
    {system: 'PostgreSQL', resource: 'organization_members', label: 'Workspace memberships', classification: 'deletable', basis: 'Membership links the subject to a workspace', risk: 'medium'},
    {system: 'MinIO', resource: 'customer-uploads', label: 'Customer uploads', classification: 'deletable', basis: 'User-provided files with no retention requirement', risk: 'high'},
    {system: 'MinIO', resource: 'support-attachments', label: 'Support attachments', classification: 'deletable', basis: 'Files attached to closed support conversations', risk: 'high'},
    {system: 'MinIO', resource: 'exports', label: 'Data exports', classification: 'deletable', basis: 'Generated copies of personal data', risk: 'high'},
  ],
};

export const actionForClassification = (classification: Classification): PlanAction => classification === 'deletable' ? 'delete' : classification === 'anonymize' ? 'redact' : 'retain';

/** Unknown resources are retained and flagged for review: the safe default is never to delete what the policy does not name. */
export function ruleFor(system: string, resource: string): RetentionRule {
  return RETENTION_POLICY.rules.find(rule => rule.system === system && rule.resource === resource)
    ?? {system: system === 'MinIO' ? 'MinIO' : 'PostgreSQL', resource, label: resource, classification: 'retain', basis: 'No policy rule names this resource; retained pending review', risk: 'high'};
}
