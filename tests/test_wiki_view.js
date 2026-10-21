"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const file = path.join(__dirname, '../web/assets/wiki-view.js');
const h = () => require(file);

test('index retains categories, honest totals, and only readable slugs', () => {
  const index = h().normalizeIndex({wiki:{intro:'介绍',groups:[{type:'concept',total:8,next_cursor:'next',items:[{slug:'concept/rag',title:'RAG',category_path:['技术'],summary:'检索'}, {title:'无地址'}]}]}});
  assert.equal(index.intro, '介绍');
  assert.equal(index.groups[0].total, 8);
  assert.equal(index.groups[0].items.length, 1);
  assert.equal(h().filterGroups(index.groups, '技术')[0].items[0].slug, 'concept/rag');
});
test('search XML resolves actual link slugs and retains partial failures', () => {
  const result = h().parseSearch({results:{wiki:{content:'<search_results><page><knowledge_base_id>kb</knowledge_base_id><link>[[concept/rag|RAG &amp; 检索]]</link><type>concept</type><summary>检索知识</summary><match_snippet>命中内容</match_snippet></page></search_results><errors>部分失败</errors>'}}});
  assert.equal(result.items[0].slug, 'concept/rag');
  assert.equal(result.items[0].title, 'RAG & 检索');
  assert.equal(result.items[0].summary, '命中内容');
  assert.match(result.warning, /部分失败/);
});
test('page unwraps XML body and selects only scoped source refs', () => {
  const ref = {knowledge_id:'doc',quote:'来源'};
  const page = h().parsePage({page:{content:'<wiki_page><metadata><link>[[concept/rag|RAG]]</link><type>concept</type></metadata><content>## 内容\n[[concept/other|相关]]</content></wiki_page>',source_refs_v2:{'concept/rag|kb':[ref],'concept/rag|other':[{knowledge_id:'secret'}]}}}, 'concept/rag', 'kb');
  assert.equal(page.title, 'RAG');
  assert.equal(page.body, '## 内容\n[[concept/other|相关]]');
  assert.deepEqual(page.refs, [ref]);
  assert.equal(h().parsePage({page:{content:'# Markdown'}},'slug','kb').body, '# Markdown');
});
test('internal links produce inert encoded links while hostile text stays escaped', () => {
  const escape = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const html = h().renderWikiMarkdown('[[a/" onclick="x|<img src=x>]] <script>x</script>', escape, escape);
  assert.match(html, /data-wiki-slug="a%2F%22%20onclick%3D%22x"/);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes(' onclick='));
});

function setup() {
  class El {
    constructor() { this.children=[]; this.value=''; this._text=''; this.innerHTML=''; this.dataset={}; this.hidden=false; }
    set innerHTML(v) { this._html=v; this.children=[]; this.nodes={}; }
    get innerHTML() { return this._html; }
    set textContent(v) { this._text=String(v); this.children=[]; }
    get textContent() { return this._text; }
    append(...els) { this.children.push(...els); }
    appendChild(el) { this.append(el); return el; }
    contains(target) { return this===target || this.children.some(child=>child===target || child.contains && child.contains(target)); }
    addEventListener() {}
    setAttribute() {}
    querySelector(selector) { if(this.isSection && !this.innerHTML.includes('id="'+selector.slice(1)+'"'))return null; this.nodes ||= {}; return this.nodes[selector] ||= new El(); }
    querySelectorAll() { return []; }
  }
  let epoch=0;
  const pending=[];
  const section=new El();section.isSection=true;
  const window={location:{hash:'#/wiki'},App:{S:{kbs:[{id:'a'},{id:'b'}]}, captureIdentityEpoch:()=>epoch,isCurrentIdentityEpoch:e=>e===epoch,renderMarkdown:x=>x,escapeHtml:x=>x},Explorer:{fillKbSelect:(el,id)=>el.value=id||'a',capability:()=>true,call:(name,args)=>new Promise(resolve=>pending.push({name,args,resolve})),renderSources:()=>{}}};
  const modal=new El();let closed=0;let hidden=true;
  window.App.openModal=build=>{modal.innerHTML='';hidden=false;build(modal);};
  window.App.closeModal=()=>{closed++;hidden=true;};
  window.App.confirmDialog=async()=>true;
  const find=(parent,id)=>parent.id===id ? parent : parent.children.map(child=>find(child,id)).find(Boolean)||null;
  vm.runInNewContext(fs.readFileSync(file,'utf8'), {window,document:{createElement:()=>new El(),getElementById:id=>id==='modal-root'?{classList:{contains:()=>hidden}}:null}, console});
  return {view:window.KnowledgeViews.wiki, section,pending,window,modalFind:id=>find(modal,id),get closed(){return closed;},switchEpoch:()=>epoch++};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('late directory requests cannot overwrite a newly selected library', async()=>{
  const t=setup(); t.view.show(t.section);
  assert.equal(t.pending[0].args.knowledge_base_id,'a');
  t.section.querySelector('#wiki-kb').value='b';
  t.section.querySelector('#wiki-kb').onchange();
  t.pending[1].resolve({ok:true,result:{wiki:{intro:'B',groups:[]}}}); await tick();
  t.pending[0].resolve({ok:true,result:{wiki:{intro:'A',groups:[]}}}); await tick();
  assert.equal(t.section.querySelector('#wiki-intro').innerHTML,'B');
});
test('identity reset clears page and ignores outstanding directory reads',async()=>{
  const t=setup();t.view.show(t.section);t.switchEpoch();t.view.reset();
  t.pending[0].resolve({ok:true,result:{wiki:{intro:'private',groups:[]}}});await tick();
  assert.equal(t.section.innerHTML,'');
  assert.equal(t.section.querySelector('#wiki-kb'),null);
});
test('openPage in the active view reads the requested library and latest page wins', async()=>{
  const t=setup();t.view.show(t.section);
  t.view.openPage('b','concept/first');
  const first=t.pending.find(p=>p.args.slug==='concept/first');
  assert.equal(first.args.knowledge_base_id,'b');
  t.view.openPage('b','concept/second');
  const second=t.pending.find(p=>p.args.slug==='concept/second');
  second.resolve({ok:true,result:{page:{title:'Second',content:'current'}}});await tick();
  first.resolve({ok:true,result:{page:{title:'First',content:'outdated'}}});await tick();
  assert.equal(t.section.querySelector('#wiki-article').children[1].textContent,'Second');
});
test('a newer search suppresses older search results and in-flight page bodies', async()=>{
  const t=setup();t.view.show(t.section);t.view.openPage('a','concept/old');
  const oldRead=t.pending.find(p=>p.args.slug==='concept/old');
  const form=t.section.querySelector('#wiki-search-form');
  t.section.querySelector('#wiki-search').value='first';form.onsubmit({preventDefault(){}});
  const first=t.pending.find(p=>p.args.query==='first');
  t.section.querySelector('#wiki-search').value='second';form.onsubmit({preventDefault(){}});
  const second=t.pending.find(p=>p.args.query==='second');
  second.resolve({ok:true,result:{results:{wiki:{content:'<page><link>[[new|New]]</link></page>'}}}});await tick();
  first.resolve({ok:true,result:{results:{wiki:{content:'<page><link>[[old|Old]]</link></page>'}}}});
  oldRead.resolve({ok:true,result:{page:{title:'Private old page',content:'old'}}});await tick();
  assert.equal(t.section.querySelector('#wiki-directory').children[0].children[0].textContent,'New');
  assert.equal(t.section.querySelector('#wiki-article').children[1].textContent,'选择搜索结果');
});
test('cross-library deep link refreshes directory and late empty directory does not erase reading',async()=>{
  const t=setup();t.view.show(t.section);
  t.pending[0].resolve({ok:true,result:{wiki:{intro:'A',groups:[]}}});await tick();
  t.view.openPage('b','concept/topic');
  const list=t.pending.find(p=>p.args.action==='list' && p.args.knowledge_base_id==='b');
  assert.ok(list,'the new library must load its own directory');
  const read=t.pending.find(p=>p.args.slug==='concept/topic');
  read.resolve({ok:true,result:{page:{title:'Topic',content:'Knowledge'}}});await tick();
  list.resolve({ok:true,result:{wiki:{intro:'B',groups:[]}}});await tick();
  assert.equal(t.section.querySelector('#wiki-article').children[1].textContent,'Topic');
});
test('registration does not need App or access DOM before show',()=>{
  const window={};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{window});
  assert.equal(typeof window.KnowledgeViews.wiki.show,'function');
  window.KnowledgeViews.wiki.show({});
});
test('disabled Wiki makes no tool call and exposes its configuration state',()=>{
  const t=setup();t.window.Explorer.capability=()=>false;t.view.show(t.section);
  assert.equal(t.pending.length,0);
  assert.match(t.section.querySelector('#wiki-status').textContent,/尚未启用/);
  assert.equal(t.section.querySelector('#wiki-search-button').disabled,true);
});
test('directory failure stays an error and never masquerades as an empty Wiki',async()=>{
  const t=setup();t.view.show(t.section);
  t.pending[0].resolve({ok:false,error:{message:'连接已失效'}});await tick();
  assert.match(t.section.querySelector('#wiki-status').textContent,/目录加载失败：连接已失效/);
  assert.equal(t.section.querySelector('#wiki-article').children[1].textContent,'暂时无法加载目录');
});
test('reset safely unmounts across external section clearing and remounts',async()=>{
  const t=setup();t.view.show(t.section);const old=t.pending[0];
  t.view.reset();t.section.innerHTML='';
  assert.doesNotThrow(()=>t.view.reset());
  assert.doesNotThrow(()=>t.view.selectionChanged());
  t.view.show(t.section);
  assert.ok(t.section.querySelector('#wiki-kb'));
  assert.equal(t.pending.length,2);
  old.resolve({ok:true,result:{wiki:{intro:'stale private intro',groups:[]}}});await tick();
  assert.equal(t.section.querySelector('#wiki-intro').innerHTML,'');
});
test('empty slug deep link opens the selected library directory without reading a page',()=>{
  const t=setup();t.window.location.hash='#/library';
  t.view.openPage('b','');
  assert.equal(t.window.location.hash,'#/wiki');
  t.view.show(t.section);
  assert.equal(t.pending.length,1);
  assert.equal(t.pending[0].args.action,'list');
  assert.equal(t.pending[0].args.knowledge_base_id,'b');
});
test('reading hides the long introduction and returning to directory restores it',async()=>{
  const t=setup();t.view.show(t.section);
  t.pending[0].resolve({ok:true,result:{wiki:{intro:'Long library introduction',groups:[]}}});await tick();
  assert.equal(t.section.querySelector('#wiki-intro').hidden,false);
  t.view.openPage('a','concept/topic');
  assert.equal(t.section.querySelector('#wiki-intro').hidden,true);
  t.section.querySelector('#wiki-refresh').onclick();
  assert.equal(t.section.querySelector('#wiki-intro').hidden,false);
});
test('search hides the library introduction so results lead directly to reading',()=>{
  const t=setup();t.view.show(t.section);
  t.section.querySelector('#wiki-search').value='topic';
  t.section.querySelector('#wiki-search-form').onsubmit({preventDefault(){}});
  assert.equal(t.section.querySelector('#wiki-intro').hidden,true);
});
test('page metadata replaces only an identical leading Markdown heading',()=>{
  assert.equal(h().parsePage({page:{title:'RAG',content:'# RAG\n\n正文\n## 其他'}},'rag','kb').body,'正文\n## 其他');
  assert.equal(h().parsePage({page:{title:'RAG',content:'# 不同标题\n\n正文'}},'rag','kb').body,'# 不同标题\n\n正文');
  assert.equal(h().parsePage({page:{content:'<wiki_page><metadata><link>[[rag|RAG]]</link></metadata><content>## RAG\n内容</content></wiki_page>'}},'rag','kb').body,'内容');
});

test('missing workspace tool keeps Wiki explicitly read-only',()=>{
  const t=setup();t.view.show(t.section);
  assert.equal(t.section.querySelector('#wiki-create').disabled,true);
  assert.match(t.section.querySelector('#wiki-workspace-notice').textContent,/只读/);
});

test('editor loads native Markdown and saves exact content with optimistic version through MCP',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);
  t.view.openPage('a','concept/topic');
  t.pending.find(p=>p.args.slug==='concept/topic').resolve({ok:true,result:{page:{title:'Reader',content:'<wiki_page><content>rendered</content></wiki_page>'}}});await tick();
  t.section.querySelector('#wiki-edit').onclick();
  const get=t.pending.find(p=>p.name==='wiki_workspace' && p.args.action==='get');assert.ok(get);
  get.resolve({ok:true,result:{page:{slug:'concept/topic',title:'Native',content:'# Native\n\n[[concept/link|Link]]',summary:'summary',page_type:'concept',status:'draft',version:7}}});await tick();
  assert.equal(t.modalFind('wiki-editor-content').value,'# Native\n\n[[concept/link|Link]]');
  t.modalFind('wiki-editor-content').value='# Changed\n\nraw';
  t.modalFind('wiki-editor-form').onsubmit({preventDefault(){}});
  const save=t.pending.find(p=>p.name==='wiki_workspace' && p.args.action==='update');
  assert.equal(save.args.version,7);assert.equal(save.args.content,'# Changed\n\nraw');assert.equal(save.args.status,'draft');
  save.resolve({ok:false,error:{message:'version conflict'}});await tick();
  assert.match(t.modalFind('wiki-editor-error').textContent,/version conflict/);
  assert.equal(t.modalFind('wiki-editor-content').value,'# Changed\n\nraw');assert.equal(t.closed,0);
});

test('create sends only entered native fields and refreshes only after confirmed server success',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);
  t.section.querySelector('#wiki-create').onclick();
  t.modalFind('wiki-editor-slug').value='concept/new';t.modalFind('wiki-editor-title').value='New';
  t.modalFind('wiki-editor-content').value='[[concept/other|关联]]';
  t.modalFind('wiki-editor-form').onsubmit({preventDefault(){}});
  const write=t.pending.find(p=>p.args.action==='create');assert.ok(write);assert.equal(write.name,'wiki_workspace');assert.equal(write.args.knowledge_base_id,'a');
  assert.equal(write.args.content,'[[concept/other|关联]]');assert.equal(write.args.source_refs,undefined);
  assert.equal(t.pending.filter(p=>p.args.action==='list').length,1);
  write.resolve({ok:true,result:{page:{slug:'concept/new',title:'New',content:'saved',version:1}}});await tick();
  assert.equal(t.closed,1);assert.equal(t.pending.filter(p=>p.args.action==='list').length,2);
});

test('late native get and save cannot alter a different library or a replaced modal',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);t.view.openPage('a','old');
  t.section.querySelector('#wiki-edit').onclick();
  const get=t.pending.find(p=>p.args.action==='get');assert.ok(get);
  t.section.querySelector('#wiki-kb').value='b';t.section.querySelector('#wiki-kb').onchange();
  get.resolve({ok:true,result:{page:{slug:'old',title:'PRIVATE',content:'PRIVATE',version:1}}});await tick();
  assert.equal(t.modalFind('wiki-editor-title'),null);
  t.section.querySelector('#wiki-create').onclick();t.modalFind('wiki-editor-slug').value='new';t.modalFind('wiki-editor-title').value='New';
  t.modalFind('wiki-editor-form').onsubmit({preventDefault(){}});
  const save=t.pending.find(p=>p.args.action==='create');
  const closedBefore=t.closed,listBefore=t.pending.filter(p=>p.args.action==='list').length;
  t.window.App.openModal(box=>box.append({id:'unrelated',children:[]}));
  save.resolve({ok:true,result:{page:{slug:'new'}}});await tick();
  assert.equal(t.closed,closedBefore);assert.ok(t.modalFind('unrelated'));assert.equal(t.pending.filter(p=>p.args.action==='list').length,listBefore);
});

test('delete and revision restore require explicit confirmation and retain server errors',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);t.view.openPage('a','topic');
  t.window.App.confirmDialog=async()=>false;
  await t.section.querySelector('#wiki-delete').onclick();
  assert.equal(t.pending.some(p=>p.args.action==='delete'),false);
  t.section.querySelector('#wiki-history').onclick();
  const history=t.pending.find(p=>p.args.action==='revisions');assert.ok(history);
  history.resolve({ok:true,result:{revisions:{revisions:[{version:2,title:'Old',edited_at:'2026-10-01'}],total:1,current_version:3}}});await tick();
  t.modalFind('wiki-revision-2').onclick();
  const snapshot=t.pending.find(p=>p.args.action==='revisions' && p.args.version===2);assert.ok(snapshot);
  snapshot.resolve({ok:true,result:{revision:{version:2,title:'Old',content:'raw old'}}});await tick();
  assert.equal(t.modalFind('wiki-revision-content').textContent,'raw old');
  await t.modalFind('wiki-revision-restore').onclick();assert.equal(t.pending.some(p=>p.args.action==='restore'),false);
});

test('discovered workspace tools update controls without reloading a loaded directory',async()=>{
  const t=setup();t.view.show(t.section);t.pending[0].resolve({ok:true,result:{wiki:{groups:[]}}});await tick();
  assert.equal(t.section.querySelector('#wiki-create').disabled,true);
  t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.selectionChanged();
  assert.equal(t.section.querySelector('#wiki-create').disabled,false);
});

test('delete failure keeps the selected reader and reports the server refusal',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);t.view.openPage('a','topic');
  const deletion=t.section.querySelector('#wiki-delete').onclick();await tick();
  const call=t.pending.find(p=>p.args.action==='delete');assert.ok(call);
  call.resolve({ok:false,error:{message:'endpoint write denied'}});await deletion;
  assert.match(t.section.querySelector('#wiki-status').textContent,/endpoint write denied/);
  assert.equal(t.section.querySelector('#wiki-edit').disabled,false);
});

async function revisionPreview(t) {
  t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);t.view.openPage('a','topic');
  t.section.querySelector('#wiki-history').onclick();
  t.pending.find(p=>p.args.action==='revisions').resolve({ok:true,result:{revisions:{revisions:[{version:2,title:'Old'}],total:1,current_version:3}}});await tick();
  t.modalFind('wiki-revision-2').onclick();
  t.pending.find(p=>p.args.action==='revisions' && p.args.version===2).resolve({ok:true,result:{revision:{version:2,title:'Old',content:'old'}}});await tick();
}

test('restore sends the explicitly selected revision and refreshes after server confirmation',async()=>{
  const t=setup();await revisionPreview(t);
  const restore=t.modalFind('wiki-revision-restore').onclick();await tick();
  const call=t.pending.find(p=>p.args.action==='restore');assert.ok(call);assert.equal(call.args.version,2);assert.equal(call.args.slug,'topic');
  const before=t.pending.length;
  call.resolve({ok:true,result:{page:{slug:'topic',version:4}}});await restore;
  assert.ok(t.pending.length>before);
});

test('restore result from an old modal cannot replace a newer modal or refresh the reader',async()=>{
  const t=setup();await revisionPreview(t);
  const restore=t.modalFind('wiki-revision-restore').onclick();await tick();
  const call=t.pending.find(p=>p.args.action==='restore');assert.ok(call);
  const before=t.pending.length;
  t.window.App.openModal(box=>box.append({id:'different-work',children:[]}));
  call.resolve({ok:true,result:{page:{slug:'topic',version:4}}});await restore;
  assert.equal(t.pending.length,before);assert.ok(t.modalFind('different-work'));
});

test('identity change while saving suppresses the write completion and new reads',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);t.section.querySelector('#wiki-create').onclick();
  t.modalFind('wiki-editor-slug').value='new';t.modalFind('wiki-editor-title').value='New';
  t.modalFind('wiki-editor-form').onsubmit({preventDefault(){}});
  const write=t.pending.find(p=>p.args.action==='create'),before=t.pending.length;
  t.switchEpoch();write.resolve({ok:true,result:{page:{slug:'new'}}});await tick();
  assert.equal(t.pending.length,before);assert.equal(t.closed,0);
});

test('history pagination reaches and restores revisions older than the first server page',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);t.view.openPage('a','topic');
  t.section.querySelector('#wiki-history').onclick();
  const first=t.pending.find(p=>p.args.action==='revisions');
  assert.equal(first.args.limit,20);assert.equal(first.args.offset,0);
  first.resolve({ok:true,result:{revisions:{revisions:Array.from({length:20},(_,i)=>({version:30-i,title:'v'+(30-i)})),total:22,current_version:31}}});await tick();
  assert.equal(t.modalFind('wiki-history-more').hidden,false);
  t.modalFind('wiki-history-more').onclick();
  const second=t.pending.find(p=>p.args.action==='revisions' && p.args.offset===20);assert.ok(second);assert.equal(second.args.limit,20);
  second.resolve({ok:true,result:{revisions:{revisions:[{version:10,title:'Older'},{version:9,title:'Oldest'}],total:22,current_version:31}}});await tick();
  assert.ok(t.modalFind('wiki-revision-30'));assert.ok(t.modalFind('wiki-revision-9'));
  assert.equal(t.modalFind('wiki-history-more').hidden,true);assert.match(t.modalFind('wiki-history-count').textContent,/22.*22/);
  t.modalFind('wiki-revision-9').onclick();
  const snapshot=t.pending.find(p=>p.args.action==='revisions' && p.args.version===9);assert.ok(snapshot);
  snapshot.resolve({ok:true,result:{revision:{version:9,title:'Oldest',content:'oldest raw'}}});await tick();
  assert.equal(t.modalFind('wiki-revision-content').textContent,'oldest raw');
  const restore=t.modalFind('wiki-revision-restore').onclick();await tick();
  const write=t.pending.find(p=>p.args.action==='restore');assert.ok(write);assert.equal(write.args.version,9);
  write.resolve({ok:true,result:{page:{slug:'topic',version:32}}});await restore;
});

test('history pagination ignores late old modal pages and allows retry after a page failure',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);t.view.openPage('a','topic');
  t.section.querySelector('#wiki-history').onclick();
  const first=t.pending.find(p=>p.args.action==='revisions');
  first.resolve({ok:true,result:{revisions:{revisions:[{version:3,title:'Recent'}],total:2,current_version:4}}});await tick();
  t.modalFind('wiki-history-more').onclick();
  const second=t.pending.find(p=>p.args.action==='revisions' && p.args.offset===1);assert.ok(second);
  second.resolve({ok:false,error:{message:'retry page'}});await tick();
  assert.equal(t.modalFind('wiki-history-more').disabled,false);assert.match(t.modalFind('wiki-history-count').textContent,/retry page/);
  assert.ok(t.modalFind('wiki-revision-3'));
  t.modalFind('wiki-history-more').onclick();
  const retry=t.pending.filter(p=>p.args.action==='revisions' && p.args.offset===1)[1];assert.ok(retry);
  t.window.App.openModal(box=>box.append({id:'new-modal',children:[]}));
  retry.resolve({ok:true,result:{revisions:{revisions:[{version:2,title:'Older private'}],total:2,current_version:4}}});await tick();
  assert.ok(t.modalFind('new-modal'));assert.equal(t.modalFind('wiki-revision-2'),null);
});

test('known archived slug opens its native page and can be edited back to published',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);
  t.pending[0].resolve({ok:true,result:{wiki:{groups:[]}}});await tick();
  t.section.querySelector('#wiki-open-slug').value=' concept/archived ';
  t.section.querySelector('#wiki-open-form').onsubmit({preventDefault(){}});
  const get=t.pending.find(p=>p.name==='wiki_workspace' && p.args.action==='get');assert.ok(get);assert.equal(get.args.slug,'concept/archived');
  get.resolve({ok:true,result:{page:{slug:'concept/archived',title:'Archived',content:'# Archived\n\narchived raw',summary:'summary',page_type:'concept',status:'archived',version:5}}});await tick();
  assert.equal(t.section.querySelector('#wiki-article').children[1].textContent,'Archived');
  assert.match(t.section.querySelector('#wiki-article').children[0].textContent,/归档/);
  assert.equal(t.section.querySelector('#wiki-article').children[2].innerHTML,'archived raw');
  assert.equal(t.section.querySelector('#wiki-edit').disabled,false);
  t.section.querySelector('#wiki-edit').onclick();
  const edit=t.pending.filter(p=>p.name==='wiki_workspace' && p.args.action==='get')[1];assert.equal(edit.args.slug,'concept/archived');
  edit.resolve({ok:true,result:{page:{slug:'concept/archived',title:'Archived',content:'archived raw',page_type:'concept',status:'archived',version:5}}});await tick();
  assert.equal(t.modalFind('wiki-editor-status').value,'archived');
  t.modalFind('wiki-editor-status').value='published';t.modalFind('wiki-editor-form').onsubmit({preventDefault(){}});
  const update=t.pending.find(p=>p.args.action==='update');assert.equal(update.args.status,'published');assert.equal(update.args.version,5);
});

test('known slug native reads retain the latest selection and ignore identity changes',async()=>{
  const t=setup();t.window.App.S.tools=[{name:'wiki_workspace'}];t.view.show(t.section);
  const form=t.section.querySelector('#wiki-open-form'),input=t.section.querySelector('#wiki-open-slug');
  input.value='first';form.onsubmit({preventDefault(){}});
  input.value='second';form.onsubmit({preventDefault(){}});
  const reads=t.pending.filter(p=>p.name==='wiki_workspace' && p.args.action==='get');assert.equal(reads.length,2);
  reads[1].resolve({ok:true,result:{page:{slug:'second',title:'Current',content:'Current',status:'archived'}}});await tick();
  reads[0].resolve({ok:true,result:{page:{slug:'first',title:'Old',content:'Old',status:'archived'}}});await tick();
  assert.equal(t.section.querySelector('#wiki-article').children[1].textContent,'Current');
  input.value='private';form.onsubmit({preventDefault(){}});const last=t.pending[t.pending.length-1];
  t.switchEpoch();last.resolve({ok:true,result:{page:{slug:'private',title:'PRIVATE'}}});await tick();
  assert.notEqual(t.section.querySelector('#wiki-article').children[1].textContent,'PRIVATE');
});
