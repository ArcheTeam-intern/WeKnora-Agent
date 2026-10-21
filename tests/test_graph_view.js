"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
let graph = {};
try { graph = require('../web/assets/graph-view.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const fixture = () => ({results: {graph: {data: {local_graph: {nodes: [{id:'entity:A',label:'A',type:'entity'}, {id:'entity:B',label:'B',type:'entity'}, {id:'c1',type:'chunk',label:'Chunk 1'}], edges: [{id:'r1',source:'entity:A',target:'entity:B',label:'管理',source_refs_v2:[{knowledge_id:'d1',chunk_ids:['c1'],quote:'A管理B',provenance_status:'verified'}]}, {id:'r2',source:'entity:B',target:'entity:A',label:'依赖'}]}, results:[{chunk_id:'c1',knowledge_id:'d1',knowledge_base_id:'kb1',content:'A管理B'},{chunk_id:'other',knowledge_id:'d2',content:'无关证据'}]}}}});
test('parses core graph envelope without inventing nodes or attaching query evidence to edges', () => {
  assert.equal(typeof graph.parseGraph, 'function');
  const value = graph.parseGraph(fixture());
  assert.equal(value.status,'ready'); assert.equal(value.nodes.length,2); assert.equal(value.edges.length,2);
  assert.equal(value.edges[0].refs[0].quote,'A管理B'); assert.deepEqual(value.edges[1].refs,[]);
  assert.equal(value.evidence[0].refs[0].knowledge_id,'d1'); assert.equal(value.evidence[0].refs[0].chunk_ids[0],'c1');
  assert.equal(value.evidence.length,2);
});
test('supports graph_data and keeps only actual, connected endpoints', () => {
  assert.equal(typeof graph.parseGraph, 'function');
  const data = fixture().results.graph.data; data.graph_data=data.local_graph; delete data.local_graph;
  data.graph_data.edges.push({source:'missing',target:'entity:A',label:'bad'});
  const value = graph.parseGraph({results:{graph:{data}}});
  assert.equal(value.edges.length,2); assert.equal(value.droppedEdges,1);
});
test('distinguishes empty graphs, source failures, unconfigured graph and partial success', () => {
  assert.equal(typeof graph.parseGraph, 'function');
  assert.equal(graph.parseGraph({results:{graph:{data:{results:[],relations:[]}}}}).status,'empty');
  const fail={partial:true,failed_sources:['graph'],failures:[{source:'graph',error:'GRAPH_NOT_CONFIGURED: extraction missing'}],results:{}};
  assert.equal(graph.parseGraph(fail).status,'unconfigured');
  fail.failures[0].error='permission denied'; assert.equal(graph.parseGraph(fail).status,'error');
  const partial=fixture(); partial.partial=true; partial.failed_sources=['document']; partial.failures=[{source:'document',error:'offline'}];
  assert.equal(graph.parseGraph(partial).status,'ready'); assert.equal(graph.parseGraph(partial).warnings.length,1);
  const internal=fixture(); internal.results.graph.data.errors=['store timeout']; assert.equal(graph.parseGraph(internal).warnings.length,1);
  assert.equal(graph.parseGraph({}).status,'error');
});
test('stable layout is independent of input node order', () => {
  assert.equal(typeof graph.layoutGraph, 'function');
  const nodes=fixture().results.graph.data.local_graph.nodes;
  assert.deepEqual(graph.layoutGraph(nodes), graph.layoutGraph([...nodes].reverse()));
});
test('request state rejects old knowledge base, edited query, reset and identity responses', async () => {
  assert.equal(typeof graph.createGraphState, 'function');
  let epoch=1; const requests=[]; const state=graph.createGraphState({call:(...args)=>new Promise(resolve=>requests.push({args,resolve})),captureEpoch:()=>epoch,isCurrentEpoch:e=>e===epoch});
  state.select('kb1'); state.setQuery('A'); const first=state.search();
  assert.deepEqual(requests[0].args,['search_knowledge',{query:'A',sources:['graph'],knowledge_base_ids:['kb1']},['kb1']]);
  state.select('kb2'); state.setQuery('B'); const second=state.search();
  requests[1].resolve({ok:true,result:fixture()}); await second;
  requests[0].resolve({ok:true,result:{}}); await first; assert.equal(state.value.status,'ready'); assert.equal(state.kbId,'kb2');
  const third=state.search(); state.setQuery('C'); requests[2].resolve({ok:true,result:fixture()}); await third; assert.equal(state.value,null);
  const fourth=state.search(); epoch++; requests[3].resolve({ok:true,result:fixture()}); await fourth; assert.equal(state.value,null);
  const fifth=state.search(); state.reset(); requests[4].resolve({ok:true,result:fixture()}); await fifth;
  assert.equal(state.kbId,''); assert.equal(state.query,''); assert.equal(state.value,null); assert.equal(state.busy,false);
});

const fs=require('node:fs');
const vm=require('node:vm');
class Element {
  constructor(tag='div') {this.tagName=tag;this.children=[];this.attributes={};this.value='';this.textContent='';this.className='';this.classList={add:(...names)=>{this.className+=' '+names.join(' ');},remove:name=>{this.className=this.className.split(/\s+/).filter(x=>x!==name).join(' ');}};}
  append(...children) {this.children.push(...children);}
  appendChild(child) {this.children.push(child);return child;}
  replaceChildren(...children) {this.children=children;}
  setAttribute(key,value) {this.attributes[key]=String(value);if(key==='class')this.className=value;}
  set innerHTML(html) {this.children=[];for(const match of html.matchAll(/<(\w+)[^>]*class="([^"]+)"[^>]*>/g)){const child=new Element(match[1]);child.className=match[2];this.children.push(child);}}
  matches(selector) {return selector[0]==='.' ? this.className.split(/\s+/).includes(selector.slice(1)) : this.tagName===selector;}
  querySelectorAll(selector) {const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
}
function browserHarness() {
  const requests=[],sources=[];let epoch=1;
  const root={document:{createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)},location:{hash:'#/graph'},App:{S:{tools:[{name:'wiki_workspace'}],kbs:[{id:'kb1',capabilities:['graph']},{id:'kb2',capabilities:['graph']}]},captureIdentityEpoch:()=>epoch,isCurrentIdentityEpoch:e=>e===epoch},Explorer:{capability:kb=>kb.capabilities.includes('graph'),fillKbSelect:(select,id)=>{select.value=id || 'kb1';return select.value;},call:(...args)=>new Promise(resolve=>requests.push({args,resolve})),renderSources:(container,refs,kb)=>sources.push({container,refs,kb})}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/assets/graph-view.js'),'utf8'),{window:root,document:root.document});
  const section=new Element();root.KnowledgeViews.graph.show(section);
  return {root,section,requests,sources,changeEpoch:()=>epoch++,view:root.KnowledgeViews.graph};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('mounted view explores via core, renders real SVG, and selects per-edge sources',async()=>{
  const h=browserHarness();h.view.explore('kb2','A');assert.equal(h.requests[0].args[0],'search_knowledge');
  h.requests[0].resolve({ok:true,result:fixture()});await tick();
  assert.match(h.section.querySelector('.graph-status').textContent,/2 个实体/);
  assert.equal(h.section.querySelectorAll('.graph-node').length,2);
  const related=h.section.querySelector('.graph-related');
  assert.ok(related); assert.notEqual(related.open,true);
  assert.equal(related.querySelectorAll('.graph-related-item').length,2);
  assert.equal(h.section.querySelector('.graph-svg').querySelectorAll('.graph-chunk').length,0);
  assert.equal(h.section.querySelectorAll('.graph-edge').length,2);
  const previousSources=h.sources.length;
  h.section.querySelectorAll('.graph-edge')[0].onclick();assert.equal(h.sources.at(-1).kb,'kb2');assert.equal(h.sources.at(-1).refs[0].quote,'A管理B');
  h.section.querySelectorAll('.graph-edge')[1].onclick();assert.equal(h.sources.length,previousSources+1);assert.match(h.section.querySelector('.graph-details').children.at(-1).textContent,/未返回独立来源/);
  h.view.reset();assert.equal(h.section.querySelector('.graph-input'),null);assert.equal(h.section.querySelectorAll('.graph-svg').length,0);
});
test('mounted view clears old data on query edit and ignores late old identity response',async()=>{
  const h=browserHarness();h.view.explore('kb1','A');h.changeEpoch();h.view.reset();
  h.requests[0].resolve({ok:true,result:fixture()});await tick();assert.equal(h.section.querySelectorAll('.graph-svg').length,0);
  h.view.show(h.section);h.view.explore('kb1','B');h.requests[1].resolve({ok:true,result:fixture()});await tick();assert.equal(h.section.querySelectorAll('.graph-svg').length,1);
  h.section.querySelector('.graph-input').oninput({target:{value:'new'}});assert.equal(h.section.querySelectorAll('.graph-svg').length,0);
});

test('legacy graph_data sources remain scoped to each relation chunk and document',()=>{
  const payload=fixture(), data=payload.results.graph.data;
  delete data.local_graph.edges[0].source_refs_v2;
  Object.assign(data.local_graph.edges[0],{knowledge_id:'d1',knowledge_base_id:'kb1',chunk_ids:['c1']});
  Object.assign(data.local_graph.edges[1],{knowledge_id:'wrong-document',chunk_ids:['c1']});
  const value=graph.parseGraph(payload);
  assert.equal(value.edges[0].refs[0].quote,'A管理B');
  assert.equal(value.edges[0].refs[0].provenance_status,'verified');
  assert.equal(value.edges[1].refs[0].quote,'');
  assert.equal(value.edges[1].refs[0].provenance_status,'unverified_source');
});

test('reset safely unmounts before router clears section and allows repeated reset and remount',async()=>{
  const h=browserHarness();h.view.explore('kb1','A');
  h.view.reset();h.section.innerHTML='';
  assert.doesNotThrow(()=>h.view.reset());
  assert.doesNotThrow(()=>h.view.selectionChanged());
  h.requests[0].resolve({ok:true,result:fixture()});await tick();
  assert.equal(h.section.children.length,0);
  h.view.show(h.section);assert.ok(h.section.querySelector('.graph-input'));
  h.view.explore('kb1','B');h.requests[1].resolve({ok:true,result:fixture()});await tick();
  assert.equal(h.section.querySelectorAll('.graph-svg').length,1);
});

test('entity layout stays spread out regardless of how many isolated evidence chunks are returned',()=>{
  const entities=['项目A','团队B','组织C'].map(name=>({id:'entity:'+name,type:'entity'}));
  const chunks=Array.from({length:10},(_,i)=>({id:'chunk-'+i,type:'chunk'}));
  const entitiesOnly=graph.layoutGraph(entities),combined=graph.layoutGraph([...entities,...chunks]);
  entities.forEach(node=>assert.deepEqual(combined[node.id],entitiesOnly[node.id]));
  const positions=entities.map(node=>combined[node.id]);
  assert.ok(Math.max(...positions.map(p=>p.x))-Math.min(...positions.map(p=>p.x))>=250);
  assert.ok(Math.max(...positions.map(p=>p.y))-Math.min(...positions.map(p=>p.y))>=200);
  chunks.forEach(node=>assert.equal(combined[node.id],undefined));
});

test('evidence-only response remains readable without inventing a graph or relation provenance',async()=>{
  const payload={results:{graph:{data:{local_graph:{nodes:[{id:'c1',type:'chunk',label:'Chunk 1'}],edges:[]},results:[{chunk_id:'c1',knowledge_id:'d1',knowledge_title:'原始资料.pdf',content:'仅命中文本'}]}}}};
  const value=graph.parseGraph(payload);
  assert.equal(value.status,'empty');assert.equal(value.nodes.length,0);assert.equal(value.evidence.length,1);
  assert.equal(value.evidence[0].label,'原始资料.pdf');
  const h=browserHarness();h.view.explore('kb1','A');h.requests[0].resolve({ok:true,result:payload});await tick();
  assert.equal(h.section.querySelectorAll('.graph-svg').length,0);
  assert.equal(h.section.querySelectorAll('.graph-related-item').length,1);
  assert.match(h.section.querySelector('.graph-status').textContent,/未命中实体或关系/);
});

test('native wiki link graph preserves page slugs and never invents document citations',()=>{
  assert.equal(typeof graph.parseWikiGraph,'function');
  const value=graph.parseWikiGraph({graph:{nodes:[{slug:'entity/a',title:'A',page_type:'entity'},{slug:'concept/b',title:'B',page_type:'concept'}],edges:[{source:'entity/a',target:'concept/b'}],meta:{truncated:true,returned:2,total:50}}});
  assert.equal(value.nodes[0].id,'entity/a');assert.equal(value.nodes[0].slug,'entity/a');
  assert.equal(value.edges[0].source,'entity/a');assert.equal(value.edges[0].label,'链接');
  assert.deepEqual(value.edges[0].refs,[]);assert.match(value.warnings.join(' '),/50/);
});

test('native isolated pages and empty Wiki graphs accept null edge arrays',()=>{
  const isolated=graph.parseWikiGraph({graph:{nodes:[{slug:'concept/alone',title:'孤立页'}],edges:null,meta:{}}});
  assert.equal(isolated.status,'ready');assert.equal(isolated.edges.length,0);
  const empty=graph.parseWikiGraph({graph:{nodes:null,edges:null,meta:{}}});
  assert.equal(empty.status,'empty');assert.equal(empty.nodes.length,0);
  assert.equal(graph.parseWikiGraph({graph:{}}).status,'error');
});

test('wiki graph mode requests native graph independently of extracted-entity graph',async()=>{
  const h=browserHarness();
  assert.equal(typeof h.view.openWikiGraph,'function');
  h.view.openWikiGraph('kb1','entity/a');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].args)),['wiki_workspace',{action:'graph',knowledge_base_id:'kb1',center:'entity/a',depth:1,limit:200},['kb1']]);
  h.requests[0].resolve({ok:true,result:{graph:{nodes:[{slug:'entity/a',title:'A'}],edges:[],meta:{}}}});await tick();
  assert.match(h.section.querySelector('.graph-status').textContent,/1 个页面/);
  assert.equal(h.section.querySelectorAll('.graph-node').length,1);
});

test('old core surfaces without workspace cannot start a Wiki graph request',()=>{
  const h=browserHarness();h.root.App.S.tools=[];
  h.view.openWikiGraph('kb1','entity/a');
  assert.equal(h.requests.length,0);
  assert.equal(h.section.querySelector('.graph-submit').disabled,true);
  assert.match(h.section.querySelector('.graph-status').textContent,/wiki_workspace/);
});

test('pickCapableKb keeps capable selections and falls back only when the requested library lacks the capability',()=>{
  const capability=(kb,name)=>Array.isArray(kb.capabilities)?kb.capabilities.includes(name):!!(kb.capability_flags||{})[name];
  const kbs=[{id:'plain',capability_flags:{wiki:false,graph:false}},{id:'graph-only',capability_flags:{wiki:false,graph:true}},{id:'both',capability_flags:{wiki:true,graph:true}}];
  assert.deepEqual(graph.pickCapableKb(kbs,'both','wiki',capability),{kbId:'both',switched:false});
  assert.deepEqual(graph.pickCapableKb(kbs,'graph-only','graph',capability),{kbId:'graph-only',switched:false});
  assert.deepEqual(graph.pickCapableKb(kbs,'plain','graph',capability),{kbId:'graph-only',switched:true});
  assert.deepEqual(graph.pickCapableKb(kbs,'plain','wiki',capability),{kbId:'both',switched:true});
  assert.deepEqual(graph.pickCapableKb(kbs,'','graph',capability),{kbId:'graph-only',switched:false});
  assert.deepEqual(graph.pickCapableKb(kbs,'unknown','graph',capability),{kbId:'graph-only',switched:true});
  const none=[{id:'plain',capability_flags:{wiki:false,graph:false}}];
  assert.deepEqual(graph.pickCapableKb(none,'plain','graph',capability),{kbId:'plain',switched:false});
});

test('wiki graph entry from a capability-less library reroutes to the first Wiki library with a notice',async()=>{
  const h=browserHarness();
  h.root.App.toasts=[];h.root.App.toast=msg=>h.root.App.toasts.push(msg);
  h.root.App.S.kbs=[{id:'kb-plain',capabilities:[]},{id:'kb-rich',capabilities:['wiki','graph']}];
  h.root.Explorer.capability=(kb,name)=>kb.capabilities.includes(name);
  h.view.openWikiGraph('kb-plain','');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].args)),['wiki_workspace',{action:'graph',knowledge_base_id:'kb-rich',depth:1,limit:200},['kb-rich']]);
  assert.match(h.root.App.toasts.join(' '),/未启用/);
  h.requests[0].resolve({ok:true,result:{graph:{nodes:[{slug:'p1',title:'P1'}],edges:[],meta:{}}}});await tick();
  assert.match(h.section.querySelector('.graph-status').textContent,/1 个页面/);
});

test('entity explore from a graph-less library reroutes to the first graph library with a notice',async()=>{
  const h=browserHarness();
  h.root.App.toasts=[];h.root.App.toast=msg=>h.root.App.toasts.push(msg);
  h.root.App.S.kbs=[{id:'kb-plain',capabilities:[]},{id:'kb-graph',capabilities:['graph']}];
  h.root.Explorer.capability=(kb,name)=>kb.capabilities.includes(name);
  h.view.explore('kb-plain','A');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].args)),['search_knowledge',{query:'A',sources:['graph'],knowledge_base_ids:['kb-graph']},['kb-graph']]);
  assert.match(h.root.App.toasts.join(' '),/未启用/);
});

test('wiki graph keeps page types and renders native type colors with a legend',async()=>{
  const payload={graph:{nodes:[{slug:'summary/a',title:'A',page_type:'summary'},{slug:'entity/b',title:'B',page_type:'entity'},{slug:'concept/c',title:'C',page_type:'concept'}],edges:[{source:'summary/a',target:'entity/b'}],meta:{}}};
  const parsed=graph.parseWikiGraph(payload);
  assert.deepEqual(parsed.nodes.map(n=>n.type),['summary','entity','concept']);
  const h=browserHarness();
  h.view.openWikiGraph('kb1','');h.requests[0].resolve({ok:true,result:payload});await tick();
  const circles=h.section.querySelectorAll('.graph-node').map(n=>n.querySelectorAll('circle')[0]);
  assert.equal(circles.length,3);
  const fills=circles.map(c=>c.attributes.style).join(' ');
  assert.match(fills,/#0052d9/);assert.match(fills,/#2ba471/);assert.match(fills,/#e37318/);
  const legend=h.section.querySelector('.graph-legend');
  assert.ok(legend);
  const legendText=legend.children.map(c=>c.textContent).join(' ');
  assert.match(legendText,/摘要/);assert.match(legendText,/实体/);assert.match(legendText,/概念/);
  assert.match(legendText,/正文链接/);
});
