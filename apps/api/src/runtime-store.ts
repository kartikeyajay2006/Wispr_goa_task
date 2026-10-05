import {Pool} from 'pg';
import {workflowResponseSchema,type Stage,type Workflow} from '../../../packages/shared/src/index.js';
import {AuditChain} from '../../../packages/audit/src/index.js';
import {InMemoryWorkflowRepository,PostgresWorkflowRepository,type StoredWorkflow,type WorkflowRepository} from '../../../packages/storage/src/index.js';

export const createMetadataRepository=(config:{persistence:'memory'|'postgres';databaseUrl:string}):WorkflowRepository=>config.persistence==='postgres'?new PostgresWorkflowRepository(new Pool({connectionString:config.databaseUrl})):new InMemoryWorkflowRepository();
type PersistenceStatus={status:'pending'|'persisted'|'failed';error?:string};
const storedMetadata=(w:Workflow):StoredWorkflow=>({requestId:w.requestId,customerId:w.customerId,status:w.status,planHash:w.plan.hash,createdAt:w.plan.createdAt,payload:w});

export class InMemoryRuntimeStore{
  private readonly data=new Map<string,Workflow>();
  private readonly chains=new Map<string,AuditChain>();
  private readonly persistence=new Map<string,PersistenceStatus>();
  constructor(private readonly metadata:WorkflowRepository=new InMemoryWorkflowRepository()){}
  set(id:string,w:Workflow){
    workflowResponseSchema.parse(w);
    const chain=new AuditChain();
    w.events=w.events.map(item=>chain.append({requestId:w.requestId,stage:item.stage,message:item.message,actor:item.actor,planHash:item.planHash,details:item.details}));
    this.chains.set(id,chain);this.data.set(id,w);this.persistence.set(id,{status:'pending'});w.persistence={status:'pending'};
    void this.metadata.save(storedMetadata(w)).then(()=>{this.persistence.set(id,{status:'persisted'});w.persistence={status:'persisted'}},error=>{const detail=error instanceof Error?error.message:'Persistence failed';this.persistence.set(id,{status:'failed',error:detail});w.persistence={status:'failed',error:detail}});
  }
  get(id:string){const w=this.data.get(id),chain=this.chains.get(id);if(!w||!chain)return w;const chained=chain.all();for(const item of w.events.slice(chained.length))chain.append({requestId:w.requestId,stage:item.stage,message:item.message,actor:item.actor,planHash:item.planHash,details:item.details});w.events=chain.all();return w;}
  async persist(id:string){const w=this.get(id);if(!w)throw new Error('Workflow not found');this.persistence.set(id,{status:'pending'});w.persistence={status:'pending'};try{await this.metadata.save(storedMetadata(w));this.persistence.set(id,{status:'persisted'});w.persistence={status:'persisted'};}catch(error){const detail=error instanceof Error?error.message:'Persistence failed';this.persistence.set(id,{status:'failed',error:detail});w.persistence={status:'failed',error:detail};throw error;}}
  async clear(){this.data.clear();this.chains.clear();this.persistence.clear();await this.metadata.clear?.();}
  async loadAuthoritative(id:string){const stored=await this.metadata.get(id);return (stored?.payload as Workflow|undefined)??this.data.get(id);}
  persistenceStatus(id:string){return this.persistence.get(id)??{status:'failed' as const,error:'Workflow not found'};}
  verify(id:string){const chain=this.chains.get(id);return chain?chain.verify():{valid:false,reason:'Workflow audit chain unavailable'};}
  append(id:string,input:Omit<Parameters<AuditChain['append']>[0],'requestId'>){const w=this.data.get(id),chain=this.chains.get(id);if(!w||!chain)throw new Error('Workflow audit chain unavailable');w.events.push(chain.append({requestId:w.requestId,...input}));}
}

export class RepositoryBackedRuntimeStore{
  constructor(private readonly repository:WorkflowRepository){}
  async save(workflow:Workflow){workflowResponseSchema.parse(workflow);await this.repository.save(storedMetadata(workflow));return workflow;}
  async load(requestId:string){return this.repository.get(requestId);}
  async loadWorkflow(requestId:string){const stored=await this.repository.get(requestId);return stored?.payload as Workflow|undefined;}
}

export class MirroredRuntimeStore extends InMemoryRuntimeStore{constructor(private readonly repository:WorkflowRepository){super();}override set(id:string,w:Workflow){super.set(id,w);void this.repository.save(storedMetadata(w));}}
