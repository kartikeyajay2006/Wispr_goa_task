export type StoredWorkflow = {requestId: string; customerId: string; status: string; planHash: string; createdAt: string; payload?: unknown};
export interface WorkflowRepository { save(workflow: StoredWorkflow): Promise<void>; get(requestId: string): Promise<StoredWorkflow | undefined>; clear?(): Promise<void>; }

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly data = new Map<string, StoredWorkflow>();
  async save(workflow: StoredWorkflow) { this.data.set(workflow.requestId, {...workflow}); }
  async get(id: string) { const workflow = this.data.get(id); return workflow && {...workflow}; }
  async clear() { this.data.clear(); }
}

export type SqlClient = {query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{rows: T[]}>};
export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: SqlClient) {}
  async save(workflow: StoredWorkflow) { await this.db.query('BEGIN'); try { await this.db.query('INSERT INTO eraseops_requests (id,customer_id,status,reason,workflow_payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET status=$3, workflow_payload=$5', [workflow.requestId, workflow.customerId, workflow.status, 'workflow persistence', workflow.payload ?? null]); await this.db.query('INSERT INTO eraseops_plans (id,request_id,version,canonical,plan_hash,status) VALUES ($1,$2,1,$3,$4,$5) ON CONFLICT (request_id,plan_hash) DO UPDATE SET status=$5', [workflow.requestId, workflow.requestId, JSON.stringify({planHash: workflow.planHash}), workflow.planHash, workflow.status]); await this.db.query('COMMIT'); } catch (error) { await this.db.query('ROLLBACK'); throw error; } }
  async get(requestId: string) { const result = await this.db.query<StoredWorkflow>('SELECT r.id AS "requestId", r.customer_id AS "customerId", r.status, p.plan_hash AS "planHash", r.created_at AS "createdAt", r.workflow_payload AS "payload" FROM eraseops_requests r JOIN eraseops_plans p ON p.request_id=r.id WHERE r.id=$1 ORDER BY p.version DESC LIMIT 1', [requestId]); return result.rows[0]; }
  async clear() { await this.db.query('BEGIN'); try { await this.db.query('DELETE FROM eraseops_execution_results'); await this.db.query('DELETE FROM eraseops_approvals'); await this.db.query('DELETE FROM eraseops_plans'); await this.db.query('DELETE FROM eraseops_requests'); await this.db.query('COMMIT'); } catch (error) { await this.db.query('ROLLBACK'); throw error; } }
}
