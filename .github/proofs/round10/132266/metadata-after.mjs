import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const imp = name => import(pathToFileURL(path.resolve(name)).href);
const { resolvePluginTools } = await imp('src/plugins/tools.ts');
const { createEmptyPluginRegistry } = await imp('src/plugins/registry-empty.ts');
const { setActivePluginRegistry } = await imp('src/plugins/runtime.ts');
const { setCurrentPluginMetadataSnapshot } = await imp('src/plugins/current-plugin-metadata.test-support.ts');
const { resolveInstalledPluginIndexPolicyHash } = await imp('src/plugins/installed-plugin-index-policy.ts');
const { resolvePluginRuntimeLoadContext } = await imp('src/plugins/runtime/load-context.resolve.ts');
const { setPluginRuntimeLoadContext } = await imp('src/plugins/runtime/load-context.ts');
const { getPluginToolMeta, setPluginToolMeta } = await imp('src/plugins/tool-metadata.ts');
const { normalizeAgentRuntimeTools } = await imp('src/agents/runtime-plan/tools.ts');
const { normalizeOpenAIToolSchemas } = await imp('src/plugin-sdk/provider-tools.ts');
const { createAgentRunEventHandler } = await imp('src/auto-reply/reply/agent-runner-event-handler.ts');
const { agentLoop } = await imp('packages/agent-core/src/agent-loop.ts');
const { createAssistantMessageEventStream } = await imp('packages/agent-core/src/llm.ts');
const mode = process.argv[2];
assert.ok(['baseline', 'candidate'].includes(mode));
const candidate = mode === 'candidate';
const model = {id:'proof-model',name:'Proof',api:'test-api',provider:'test-provider',baseUrl:'https://example.test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1000,maxTokens:1000};
const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const outputSchema = {type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
let executions = 0;
function makeTool(name, hidden) {
  return {name,label:name,description:'Synthetic metadata proof',parameters:{type:'object',properties:{}},outputSchema,
    requiredClientCaps:['proof-cap'],resultContentSource:'network', ...(hidden ? {hideFromChannelProgress:true} : {}),
    async execute(_id,_args,_signal,onUpdate) {
      executions++;
      onUpdate?.({content:[{type:'text',text:'working'}],details:{status:'running'}});
      return {content:[{type:'text',text:'completed'}],details:{ok:true}};
    }};
}
const rows = [];
async function observe(tool, label, hiddenExpected) {
  const progress = [];
  const items = [];
  const handler = createAgentRunEventHandler({
    turn:{sessionCtx:{},toolProgressDetail:'full',typingSignals:{signalToolStart:async()=>{}},opts:{onToolStart:p=>progress.push(p),onItemEvent:p=>items.push(p)}},
    lifecycleBackstop:{note(){}},notifyAgentRunStart(){},sourceRepliesAreToolOnly:false,provider:'test-provider',model:'proof-model',runId:label,
    notifyUserAboutCompaction:false,onCompactionCompleted:()=>0,messageToolDeliveryState:{toolCallIds:new Set(),completed:false},
  });
  let turn = 0;
  const streamFn = () => {
    const content = turn++ === 0 ? [{type:'toolCall',id:'call-'+label,name:tool.name,arguments:{}}] : [{type:'text',text:'final reply'}];
    assert.ok(turn <= 2);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(()=>{
      const stopReason = turn === 1 ? 'toolUse' : 'stop';
      stream.push({type:'done',reason:stopReason,message:{role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason,timestamp:1}});
      stream.end();
    });
    return stream;
  };
  const events=[];
  for await (const event of agentLoop([{role:'user',content:'run synthetic tool',timestamp:1}],{systemPrompt:'',messages:[],tools:[tool]},
    {model,convertToLlm:messages=>messages,toolExecution:'sequential'},undefined,streamFn)) events.push(event);
  const lifecycle=events.filter(e=>e.type.startsWith('tool_execution_'));
  assert.deepEqual(lifecycle.map(e=>e.type),['tool_execution_start','tool_execution_update','tool_execution_end']);
  assert.ok(lifecycle.every(e=>(e.hideFromChannelProgress===true)===hiddenExpected));
  const finalReplies=events.filter(e=>e.type==='message_end' && e.message.role==='assistant' && e.message.content.some(c=>c.type==='text' && c.text==='final reply')).length;
  assert.equal(finalReplies,1);
  for(const event of lifecycle) {
    const phase={tool_execution_start:'start',tool_execution_update:'update',tool_execution_end:'result'}[event.type];
    // Project the actual public agent-loop fact into the channel handler's event contract.
    // This is a boundary proof, not a full Gateway/channel network run.
    await handler({stream:'tool',data:{phase,name:event.toolName,toolCallId:event.toolCallId,args:{},hideFromChannelProgress:event.hideFromChannelProgress}});
  }
  await handler({stream:'item',data:{phase:'end',status:'completed',name:tool.name,toolCallId:'call-'+label,hideFromChannelProgress:lifecycle.at(-1).hideFromChannelProgress}});
  assert.equal(progress.length,hiddenExpected?0:2);
  assert.equal(items.length,hiddenExpected?0:1);
  rows.push({label,marker:tool.hideFromChannelProgress===true,lifecycleEvents:lifecycle.length,progressCallbacks:progress.length,itemCallbacks:items.length,finalReplies});
}

// Use the existing public resolver and lifecycle-owned registry, with synthetic plugin metadata.
// No cache/copy/normalizer/agent-loop implementation is mocked.
const pluginId='metadata-proof';
const workspaceDir=process.argv[3];
assert.ok(path.isAbsolute(workspaceDir));
const config={plugins:{enabled:true,allow:[pluginId],load:{paths:[]},entries:{[pluginId]:{enabled:true}},slots:{memory:'none'}}};
const manifest={id:pluginId,origin:'bundled',enabledByDefault:true,source:'/synthetic/metadata-proof.js',channels:[],providers:[],contracts:{tools:['hidden_lookup','visible_lookup']}};
const plugins=[manifest];
const snapshot={policyHash:resolveInstalledPluginIndexPolicyHash(config),workspaceDir,
  index:{version:1,hostContractVersion:'test',compatRegistryVersion:'test',migrationVersion:1,policyHash:'test',generatedAtMs:0,installRecords:{},plugins:[{pluginId,origin:'bundled',enabled:true,enabledByDefault:true,startup:{sidecar:false,memory:false,agentHarnesses:[]},compat:[]}],diagnostics:[]},
  registryDiagnostics:[],manifestRegistry:{plugins,diagnostics:[]},plugins,diagnostics:[],byPluginId:new Map([[pluginId,manifest]]),normalizePluginId:id=>id,
  owners:{channels:new Map(),channelConfigs:new Map(),providers:new Map(),modelCatalogProviders:new Map(),cliBackends:new Map(),setupProviders:new Map(),commandAliases:new Map(),contracts:new Map(),modelIdNormalizationPolicies:new Map()},
  metrics:{registrySnapshotMs:0,manifestRegistryMs:0,ownerMapsMs:0,totalMs:0,indexPluginCount:1,manifestPluginCount:1}};
setCurrentPluginMetadataSnapshot(snapshot,{config,workspaceDir,env:process.env});
const registry=createEmptyPluginRegistry();
registry.plugins.push({id:pluginId,origin:'bundled',status:'loaded'});
let factories=0;
registry.tools.push({pluginId,optional:false,origin:'bundled',source:manifest.source,names:manifest.contracts.tools,declaredNames:manifest.contracts.tools,
  factory:()=>{factories++;return [makeTool('hidden_lookup',factories===1),makeTool('visible_lookup',false)];}});
const loadContext=resolvePluginRuntimeLoadContext({config,workspaceDir,env:process.env,metadataSnapshot:snapshot});
setPluginRuntimeLoadContext(registry,loadContext);
setActivePluginRegistry(registry,'metadata-proof','gateway-bindable',workspaceDir);
const params={context:{config,workspaceDir},clientCaps:['proof-cap'],toolAllowlist:['*'],allowGatewaySubagentBinding:true,env:process.env,runtimeRegistry:registry,preparedRuntime:{loadContext,metadataSnapshot:snapshot,registry}};
const fresh=resolvePluginTools(params);
const cached=resolvePluginTools(params);
assert.equal(factories,1,'cache hit must not invoke factory');
assert.deepEqual(fresh.map(t=>t.name),['hidden_lookup','visible_lookup']);
assert.deepEqual(cached.map(t=>t.name),['hidden_lookup','visible_lookup']);
for(let i=0;i<2;i++) {
  assert.notEqual(cached[i],fresh[i]);
  assert.deepEqual(cached[i].outputSchema,outputSchema);
  assert.deepEqual(cached[i].requiredClientCaps,['proof-cap']);
  assert.equal(cached[i].resultContentSource,'network');
  assert.equal(getPluginToolMeta(cached[i]).pluginId,pluginId);
}
await observe(fresh[0],'cache-cold-hidden',true);
await observe(cached[0],'cache-hit-hidden',candidate);
assert.equal(factories,2,'cached execution resolves factory after descriptor publication');
await observe(cached[1],'cache-hit-visible',false);
assert.equal(factories,3);

// OpenAI's current spread normalizer keeps enumerable fields already. Exercise
// that unchanged sibling plus a legal non-enumerable producer marker that spread drops.
for(const kind of ['hidden-enumerable','hidden-nonenumerable','visible']) {
  const source=makeTool('normalize_'+kind.replaceAll('-','_'),kind==='hidden-enumerable');
  source.catalogMode='direct-only';
  if(kind==='hidden-nonenumerable') Object.defineProperty(source,'hideFromChannelProgress',{value:true,enumerable:false});
  const metadata={pluginId,optional:false}; setPluginToolMeta(source,metadata);
  const normalized=normalizeAgentRuntimeTools({tools:[source],provider:'openai',modelApi:'openai-responses',
    runtimePlan:{tools:{normalize:tools=>normalizeOpenAIToolSchemas({tools,provider:'openai',modelApi:'openai-responses'}),logDiagnostics(){}}}})[0];
  assert.notEqual(normalized,source);
  assert.deepEqual(normalized.parameters,{type:'object',properties:{},required:[],additionalProperties:false});
  assert.equal(normalized.outputSchema,outputSchema);
  assert.equal(normalized.catalogMode,'direct-only');
  assert.equal(getPluginToolMeta(normalized),metadata);
  await observe(normalized,kind,kind==='hidden-enumerable'||(kind==='hidden-nonenumerable'&&candidate));
}
assert.equal(executions,6);
console.log('METADATA_PROOF '+JSON.stringify({mode,rows,factories,executions,normalizer:'actual OpenAI strict-schema owner',cache:'public resolver/factory/cached reconstruction',channel:'production handler with actual agent-loop metadata; no Gateway or network API exercised',siblingMetadata:['outputSchema','requiredClientCaps','resultContentSource','pluginIdentity','catalogMode']}));
