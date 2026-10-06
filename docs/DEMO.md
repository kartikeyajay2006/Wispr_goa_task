# EraseOps demo and Q&A guide

For whoever presents EraseOps. Read it once end to end, run the demo twice, and make sure everyone on the team can answer the questions in section 5 without notes.

## 1. The 30-second pitch

> When a customer asks to be forgotten, their data is spread across a dozen tables and buckets, some of it must legally be kept, some of it is shared with other customers, and nobody can prove afterwards that it is gone. EraseOps lets you ask in plain words, or out loud, and a team of agents finds everything, rehearses the deletion on a copy, backs it up, and then **stops and waits for a human** to approve the exact plan. After it runs, it rescans every system and issues a certificate. The AI does the legwork; deterministic gates and a person decide what gets deleted.

## 2. Before you present

| Check | How |
|---|---|
| App running | `npm run dev`, then open `http://localhost:5173` |
| Clean data | Sidebar, **Reset demo data** |
| Your name set | Sidebar, **Acting as**. Approval stays disabled without it |
| OpenAI on (recommended) | `OPENAI_API_KEY=...` in `.env`, then `npm run dev`. The Agent page badge should read **OpenAI · gpt-5.5** |
| Warm up | Run one command and one agent goal before presenting. The first call with each answer schema takes OpenAI longer (up to ~30 s); later ones take 2 to 5 s |
| Microphone | Use Chrome or Edge, allow the microphone once on `localhost` |
| Plan B | Without a key, everything still works on the rule-based engine (the badge says so). Record a backup video of the demo in case the network or microphone fails |

## 3. The three-minute demo

1. **Landing page (15 s).** Point at the sphere: every point is a live record, colored by what policy does with it. Click **Open console**.
2. **Voice to agents (60 s).** Open **Agent**, press the microphone, and say *"Can you wipe Mira's data?"*. Narrate the graph on the left as it lights up:
   - **Intake** resolved "Mira" to `CUST-1042` without seeing her email.
   - **Discovery** called read-only MCP tools: 11 tables and 3 buckets.
   - **Risk** found no data shared with other customers, and 4 records the retention policy keeps (orders, payments, audit log).
   - **Planner** rehearsed the deletion on a copy and took a verified backup.
   - **Reporter** briefed us.
3. **Human checkpoint (30 s).** "The agents stop here. They have no tool that can delete anything." Type `CUST-1042`, click **Approve and execute**. The executor runs the guarded path as *you*, rescans, and the final briefing says **erased and verified**.
4. **Proof (30 s).** Click **Open request**, then the **Report** tab: certificate, plan hash, approver, 0 residual records, intact hash chain. Mention **Print or save as PDF**.
5. **Safety (45 s).** Back on **Agent**, ask *"Is it safe to erase Priya?"*. The risk agent flags two other customers who depend on her workspace. Then say *"erase customer 9001"*: the sandbox blocks the plan before any backup or approval, and the graph shows the Planner in red.

Optional if time allows: **Systems** (live row counts dropping), **Audit log** (hash-chained events), or `CONNECTOR_MODE=local` to show the same flow on real PostgreSQL and MinIO in Docker.

## 4. What is AI and what is deterministic

Judges will ask "where is the AI?" and "can the AI delete things?". Both answers are in this table.

| Step | Who does it | Why |
|---|---|---|
| Understanding a typed or spoken command | **OpenAI gpt-5.5** (strict structured output), rule-based fallback | Natural phrasing, spoken IDs, names instead of IDs |
| Choosing which tools to call during investigation | **gpt-5.5** in a LangGraph tool loop, calling tools in parallel | Different goals need different evidence |
| Risk judgement | **gpt-5.5** plus deterministic facts | The model can raise risk, never lower it below the facts, and known blockers always survive |
| Briefing the operator | **gpt-5.5**, rule-based fallback | Plain-language summary of the evidence |
| Classifying data (delete / redact / retain) | Retention policy | Legal decisions must not depend on a model |
| Sandbox rehearsal, backup verification | Deterministic code | Evidence, not opinion |
| Approving the plan | **A human**, typing the customer ID | Irreversible actions need accountable consent |
| Executing and verifying | Guarded code path, as the approving human | Bound to one plan hash, single use, rate-limited |

## 5. Questions judges ask, and how to answer them

**Where is the AI?**
In three places. OpenAI gpt-5.5 reads commands (including voice), drives the discovery agent's tool loop over our MCP tools, and writes the risk judgement and briefings. It runs as a LangGraph state graph with seven nodes, through the Responses API with reasoning. Code: `apps/api/src/agent/graph.ts` and `apps/api/src/agent/openai.ts`. The same graph also runs on Claude with an Anthropic key.

**Can the AI delete data?**
No, by construction. The destructive MCP tools are never declared to the model. If it asks for one anyway, the MCP boundary refuses it because the agent's authorization is `approved: false`, and we have a test where the model tries exactly that. Deletion only happens on the guarded execution route, after a person types the customer ID, using that person's identity.

**Why LangGraph?**
The workflow is a state machine with a human pause in the middle. LangGraph gives us explicit nodes and routing, typed shared state, and `interrupt()` with a checkpointer, so the run genuinely stops at the human checkpoint and resumes later on the same thread. Each node is testable on its own.

**What does the model see? Is that a privacy problem?**
Metadata only: table names, counts, record IDs and policy outcomes. Customer names are masked to "Mira K.", and emails never leave the connectors. Any customer ID the model returns that is not in the live list is thrown away. OpenAI calls set `store: false`, so OpenAI keeps no stored conversation.

**How does the sandbox work?**
The whole plan is applied to an isolated copy. In the default mode that is a clone of the dataset; with Docker it is a real PostgreSQL transaction that is always rolled back, so PostgreSQL enforces every foreign key itself. We then check three things: no orphaned rows, nothing owned by another customer changed, and no personal data left behind. Any failure blocks the plan before a backup is even taken.

**Why hash the plan?**
The approval has to mean "this exact set of actions". The plan is serialized canonically and SHA-256 hashed. The approval stores that hash, and execution refuses if the request ID, approval ID or hash differ from the server's copy. If anything about the plan changed after approval, the hash changes and the approval no longer works. It is also single-use and expires.

**How do you prove the data is gone?**
After execution every connector rescans for data the policy says must be deleted or redacted. Only zero residual marks the request complete. The certificate records the plan hash, the approver, per-action counts and the rescan result, and the audit trail is a hash chain, so any edit breaks verification.

**What if execution fails halfway?**
The rescan catches it: the request moves to verification failed, and **Roll back from backup** restores every row (parents first) and object from the backup taken before approval. There is a test that simulates a connector lying about a deletion.

**Why keep some data?**
Orders, payments and audit records have legal retention requirements (tax, chargebacks, evidence of consent). The retention policy names the legal basis for every table, and the customer profile is redacted rather than deleted because retained records point at it.

**What happens without an API key, or if OpenAI is down?**
Every agent node has a rule-based twin. The run continues, and the UI and the briefing say which engine answered. The demo never depends on the network.

**How does voice work?**
The browser's Web Speech API turns speech into text. The interpreter maps it to one intent and reads it back ("Open an erasure request for CUST-1042 (Mira K.)") before anything happens. It understands IDs as speech engines write them ("customer 10 42"), and commands like "delete now" are refused.

**Is this production-ready?**
No, and it says so. It refuses to run outside demo mode, has no authentication beyond the operator header, and keeps requests in memory unless PostgreSQL persistence is on. The safety model and the connector boundary are the parts designed to carry over.

**How would you add another system, say Salesforce?**
Implement the `Connector` interface in `packages/connectors`: discover, simulate, back up, verify the backup, execute, rescan, restore. Add its resources to the retention policy, and the agents, sandbox, approval and certificate work unchanged.

**How is it tested?**
TypeScript: unit, contract and HTTP lifecycle tests against a real listening server, including the agent graph with a scripted model. An integration suite runs the same flows on Docker PostgreSQL and MinIO, and Python has its own pytest suite. GitHub Actions runs all of it on every push.

**Who built what?**
Answer this honestly and the same way every time. See "How this was built" in the README.

## 6. Known limitations (say them before a judge does)

- Backups of erased data stay in the `eraseops-backups` bucket so rollback is possible. A production system would expire them after the rollback window.
- The rule-based fallback understands common phrasing; open-ended questions work best with OpenAI on.
- A full agent run with gpt-5.5 takes 20 to 30 seconds. The graph streams every step, so narrate it; `OPENAI_MODEL=gpt-5.4-mini` is faster if you need it.
- The Python backend in `backend/` is a reference implementation with its own LangGraph state graph and tests. The live agents run in the TypeScript API so the demo needs one process.
- Speech recognition depends on the browser: Chrome, Edge and Safari support it, Firefox does not.

## 7. Where things live (for a code walkthrough)

| Topic | File |
|---|---|
| Agent graph (LangGraph) | `apps/api/src/agent/graph.ts` |
| Agent tools (MCP catalog) | `apps/api/src/agent/tools.ts` |
| Command interpreter | `apps/api/src/agent/interpret.ts` |
| Model engine, provider choice and fallbacks | `apps/api/src/agent/claude.ts` |
| OpenAI Responses API adapter | `apps/api/src/agent/openai.ts` |
| Request lifecycle | `apps/api/src/workflow-service.ts` |
| Sandbox simulation (in memory) | `packages/connectors/src/index.ts` (`simulateOnCopy`) |
| Sandbox simulation (PostgreSQL transaction) | `packages/connectors/src/adapters.ts` (`simulate`) |
| Retention policy | `packages/policy-engine/src/retention-policy.ts` |
| Hash-chained audit | `packages/audit/src/index.ts` |
| Agent page | `apps/web/src/console/AgentPage.tsx` |
