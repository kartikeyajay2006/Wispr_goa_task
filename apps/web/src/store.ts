import {create} from 'zustand';
type WorkflowState={workflow:any;setWorkflow:(workflow:any)=>void;clear:()=>void};
export const useWorkflowStore=create<WorkflowState>((set)=>({workflow:undefined,setWorkflow:(workflow)=>set({workflow}),clear:()=>set({workflow:undefined})}));
