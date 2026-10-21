"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const file=path.join(__dirname,'../web/assets/agent-view.js');
class El {
  constructor(){this.children=[];this.nodes={};this.value='';this.dataset={};this.hidden=false;this._text='';this._html='';this.classList={contains:()=>false,add(){}};}
  set innerHTML(v){this._html=v;this.children=[];this.nodes={};}get innerHTML(){return this._html;}
  set textContent(v){this._text=String(v);}get textContent(){return this._text;}
  append(...children){this.children.push(...children);}appendChild(child){this.append(child);return child;}
  setAttribute(){}contains(target){return this===target||this.children.some(c=>c.contains&&c.contains(target));}
  querySelector(selector){return this.nodes[selector] ||=new El();}querySelectorAll(){return [];}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
  const section=new El(),modal=new El(),pending=[];let epoch=0,closed=0,hidden=true;
  const find=(parent,id)=>parent.id===id?parent:parent.children.map(c=>find(c,id)).find(Boolean)||null;
  const window={location:{hash:'#/agents'},App:{S:{tools:[{name:'agent_workspace'}],kbs:[{id:'kb-a',name:'Alpha'}]},activeProfile:()=>({user_id:'me'}),captureIdentityEpoch:()=>epoch,isCurrentIdentityEpoch:e=>e===epoch,
    openModal:build=>{modal.innerHTML='';hidden=false;build(modal);},closeModal:()=>{closed++;hidden=true;},confirmDialog:async()=>true},
    Explorer:{call:(name,args,scope)=>new Promise(resolve=>pending.push({name,args,scope,resolve}))}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{window,document:{createElement:()=>new El(),getElementById:id=>id==='modal-root'?{classList:{contains:()=>hidden}}:id==='modal-box'?modal:null},console});
  return {window,view:window.KnowledgeViews.agents,section,pending,find:id=>find(modal,id),switchEpoch:()=>epoch++,get closed(){return closed;}};
}

test('missing agent tool exposes a read-only state without business requests',()=>{
  const t=setup();t.window.App.S.tools=[];t.view.show(t.section);
  assert.equal(t.pending.length,0);assert.equal(t.section.querySelector('#agents-create').disabled,true);
  assert.match(t.section.querySelector('#agents-status').textContent,/只读/);
});

test('native list and detail keep builtins read-only while allowing explicit copy',async()=>{
  const t=setup();t.view.show(t.section);assert.equal(t.pending[0].name,'agent_workspace');assert.equal(t.pending[0].args.action,'list');
  t.pending[0].resolve({ok:true,result:{agents:[{id:'builtin',name:'Built in',is_builtin:true,config:{agent_mode:'quick-answer'}}]}});await tick();
  t.section.querySelector('#agents-list').children[0].onclick();
  const get=t.pending.find(p=>p.args.action==='get');assert.equal(get.args.agent_id,'builtin');
  get.resolve({ok:true,result:{agent:{id:'builtin',name:'Built in',is_builtin:true,config:{agent_mode:'quick-answer'}}}});await tick();
  assert.equal(t.section.querySelector('#agents-edit').disabled,true);assert.equal(t.section.querySelector('#agents-delete').disabled,true);assert.equal(t.section.querySelector('#agents-copy').disabled,false);
  // 选中的列表项要带 on 类，否则列表里看不出当前看的是哪一个。
  const items=t.section.querySelector('#agents-list').children;assert.equal(items.length,1);assert.equal(items[0].className.includes('on'),true);
  t.section.querySelector('#agents-copy').onclick();
  t.find('agent-copy-name').value='Mine';t.find('agent-copy-form').onsubmit({preventDefault(){}});
  const copy=t.pending.find(p=>p.args.action==='copy');assert.ok(copy);assert.equal(copy.args.name,'Mine');assert.equal(copy.args.agent_id,'builtin');
});

test('create uses entered config and selected KBs through MCP; denied writes preserve draft',async()=>{
  const t=setup();t.view.show(t.section);t.section.querySelector('#agents-create').onclick();
  t.find('agent-name').value='Research';t.find('agent-prompt').value='Only cite actual sources.';
  t.find('agent-kb-mode').value='selected';t.find('agent-kb-kb-a').checked=true;
  t.find('agent-form').onsubmit({preventDefault(){}});
  const write=t.pending.find(p=>p.args.action==='create');assert.ok(write);assert.equal(write.name,'agent_workspace');
  assert.equal(write.args.config.agent_mode,'quick-answer');assert.equal(write.args.config.agent_type,'custom');
  assert.deepEqual(Array.from(write.args.config.knowledge_bases),['kb-a']);assert.equal(write.args.config.system_prompt,'Only cite actual sources.');
  assert.equal(write.args.config.model_id,undefined);assert.equal(write.args.token,undefined);
  write.resolve({ok:false,error:'endpoint denied'});await tick();
  assert.match(t.find('agent-error').textContent,/endpoint denied/);assert.equal(t.find('agent-name').value,'Research');assert.equal(t.closed,0);
});

test('late native lists and saves cannot alter a new identity or a replaced modal',async()=>{
  const t=setup();t.view.show(t.section);const list=t.pending[0];
  t.switchEpoch();t.view.reset();list.resolve({ok:true,result:{agents:[{id:'private',name:'PRIVATE'}]}});await tick();
  assert.equal(t.section.innerHTML,'');
  t.view.show(t.section);t.section.querySelector('#agents-create').onclick();t.find('agent-name').value='New';t.find('agent-form').onsubmit({preventDefault(){}});
  const write=t.pending.find(p=>p.args.action==='create');const before=t.pending.length;
  t.window.App.openModal(box=>box.append(Object.assign(new El(),{id:'other'})));
  write.resolve({ok:true,result:{agent:{id:'new',name:'New'}}});await tick();
  assert.ok(t.find('other'));assert.equal(t.pending.length,before);assert.equal(t.closed,0);
});

test('editing rereads native config and explicit blank model fields reset runtime defaults',async()=>{
  const t=setup();t.view.show(t.section);t.pending[0].resolve({ok:true,result:{agents:[{id:'mine',name:'Mine',config:{}}]}});await tick();
  t.section.querySelector('#agents-list').children[0].onclick();const first=t.pending.find(p=>p.args.action==='get');
  first.resolve({ok:true,result:{agent:{id:'mine',name:'Mine',config:{agent_mode:'quick-answer',agent_type:'custom'}}}});await tick();
  t.section.querySelector('#agents-edit').onclick();const get=t.pending.filter(p=>p.args.action==='get')[1];assert.ok(get);
  get.resolve({ok:true,result:{agent:{id:'mine',name:'Newest',config:{agent_mode:'smart-reasoning',agent_type:'wiki-qa',model_id:'old-model',rerank_model_id:'old-rerank',kb_selection_mode:'all'}}}});await tick();
  assert.equal(t.find('agent-name').value,'Newest');t.find('agent-model').value='';t.find('agent-rerank-model').value='';
  t.find('agent-form').onsubmit({preventDefault(){}});const update=t.pending.find(p=>p.args.action==='update');
  assert.equal(update.args.agent_id,'mine');assert.equal(update.args.config.agent_mode,'smart-reasoning');assert.equal(update.args.config.model_id,'');assert.equal(update.args.config.rerank_model_id,'');
});

test('agent deletion requires explicit confirmation and preserves server refusal',async()=>{
  const t=setup();t.view.show(t.section);t.pending[0].resolve({ok:true,result:{agents:[{id:'mine',name:'Mine'}]}});await tick();
  t.section.querySelector('#agents-list').children[0].onclick();t.pending.find(p=>p.args.action==='get').resolve({ok:true,result:{agent:{id:'mine',name:'Mine',config:{}}}});await tick();
  t.window.App.confirmDialog=async()=>false;await t.section.querySelector('#agents-delete').onclick();assert.equal(t.pending.some(p=>p.args.action==='delete'),false);
  t.window.App.confirmDialog=async()=>{t.window.App.openModal(box=>box.append(new El()));t.window.App.closeModal();return true;};const deleting=t.section.querySelector('#agents-delete').onclick();await tick();const call=t.pending.find(p=>p.args.action==='delete');assert.ok(call);
  call.resolve({ok:false,error:'only creator may delete'});await deleting;assert.match(t.section.querySelector('#agents-status').textContent,/only creator/);
});

test('agent detail offers a direct QA action using the native agent identity',async()=>{
  const t=setup();let opened='';t.window.Views={openQaForAgent:id=>{opened=id;}};
  t.view.show(t.section);t.pending[0].resolve({ok:true,result:{agents:[{id:'native-id',name:'Native'}]}});await tick();
  t.section.querySelector('#agents-list').children[0].onclick();t.pending.find(p=>p.args.action==='get').resolve({ok:true,result:{agent:{id:'native-id',name:'Native',is_builtin:true,config:{}}}});await tick();
  const action=t.section.querySelector('#agents-detail').children.find(child=>child.id==='agent-use-qa');assert.ok(action);action.onclick();assert.equal(opened,'native-id');
});
