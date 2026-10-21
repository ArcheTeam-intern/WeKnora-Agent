/* Native agent management, shared with the QA picker. Every business call uses MCP. */
(function(root){
  'use strict';
  const app=()=>root.App, str=v=>typeof v==='string'?v:'', error=e=>typeof e==='string'?e:e && e.message || '请求未完成，请重试。';
  const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
  const button=(text,handler,cls='ghost')=>{const n=node('button','btn '+cls,text);n.type='button';n.onclick=handler;return n;};
  const modes=[['quick-answer','快速问答'],['smart-reasoning','智能推理']];
  const types=[['custom','自定义'],['rag-qa','文档问答'],['wiki-qa','Wiki 问答'],['hybrid-rag-wiki','文档与 Wiki 问答']];
  const available=()=>!!app() && (app().S.tools||[]).some(t=>t.name==='agent_workspace');
  let cache=null,cacheEpoch=null,listSeq=0,inflight=null;
  async function call(action,args={}) {
    const response=await root.Explorer.call('agent_workspace',{action,...args},[]);
    if(response.stale)throw Object.assign(new Error('连接已切换，请重新打开。'),{stale:true});
    if(!response.ok)throw new Error(error(response.error));return response.result||{};
  }
  function invalidateCache(){cache=null;cacheEpoch=null;listSeq++;inflight=null;}
  async function list(refresh=false) {
    if(!available())throw new Error('当前端点未提供 agent_workspace，智能体管理只读。');
    const epoch=app().captureIdentityEpoch();
    if(!refresh && cacheEpoch===epoch && cache)return cache;
    if(!refresh && cacheEpoch===epoch && inflight)return inflight;
    if(refresh)cache=null;
    const seq=++listSeq;cacheEpoch=epoch;
    const request=(async()=>{
      const data=await call('list');
      if(seq!==listSeq || !app().isCurrentIdentityEpoch(epoch))throw Object.assign(new Error('列表已过期。'),{stale:true});
      if(!Array.isArray(data.agents))throw new Error('服务端未返回有效的智能体列表。');
      cache=data.agents.filter(a=>a && str(a.id));return cache;
    })();inflight=request;
    try{return await request;}finally{if(seq===listSeq)inflight=null;}
  }
  root.AgentWorkspace={available,list};
  const state={section:null,epoch:null,seq:0,detailSeq:0,modalSeq:0,modal:null,selected:null,loaded:false};
  const itemNodes=new Map();
  // 用 className 赋值而不是 classList.toggle：本文件其余状态切换（如 agents-status）
  // 同样走 className，且测试用的极简 DOM shim 只提供 classList.contains/add。
  function markSelected(id){itemNodes.forEach((item,key)=>{item.className='btn agent-list-item'+(key===id?' on':'');});}
  const el=id=>state.section.querySelector('#agents-'+id);
  function status(message,bad=false){if(!state.section)return;el('status').textContent=message;el('status').className=bad?'agent-status wiki-error':'agent-status';}
  function visible(modal){const host=document.getElementById('modal-root');return modal && modal.box.contains(modal.marker) && (!host || !host.classList.contains('hidden'));}
  function cancelModal(){state.modalSeq++;if(visible(state.modal))app().closeModal();state.modal=null;}
  function token(kind='seq') {const seq=++state[kind],epoch=app().captureIdentityEpoch(),section=state.section;return ()=>state.section===section && !!section && state[kind]===seq && app().isCurrentIdentityEpoch(epoch);}
  function modal(title) {
    cancelModal();const valid=token('modalSeq');let box,marker;
    app().openModal(b=>{box=b;marker=node('h3','',title);box.append(marker);});const m={box,marker,valid};m.current=()=>valid() && visible(m);state.modal=m;return m;
  }
  function close(m){if(m.current()){app().closeModal();state.modal=null;state.modalSeq++;}}
  function controls(){
    if(!state.section)return;const enabled=available() && !!app().activeProfile(),a=state.selected;
    el('create').disabled=!enabled;el('refresh').disabled=!enabled;
    el('edit').disabled=!enabled || !a || !!a.is_builtin;
    el('delete').disabled=!enabled || !a || !!a.is_builtin;el('copy').disabled=!enabled || !a;
  }
  function requireAgent(data){if(!data.agent || !str(data.agent.id))throw new Error('服务端未返回有效的智能体。');return data.agent;}
  function renderDetail(a){
    state.selected=a;markSelected(a.id);const box=el('detail');box.innerHTML='';
    box.append(node('div','agent-kind',a.is_builtin?'内置智能体 · 只读，可复制后编辑':'自定义智能体'),node('h3','',str(a.name)),node('p','',str(a.description)||'暂无说明。'));
    const config=a.config||{},mode=modes.find(x=>x[0]===config.agent_mode),type=types.find(x=>x[0]===config.agent_type);
    box.append(node('p','agent-meta',(mode?mode[1]:'端点默认模式')+' · '+(type?type[1]:'自定义')));
    const use=button('用此智能体问答',()=>{
      if(state.selected && state.selected.id===a.id && available() && app().activeProfile() && root.Views && root.Views.openQaForAgent)root.Views.openQaForAgent(a.id);
    },'');use.id='agent-use-qa';box.append(use);
    const prompt=node('pre','agent-prompt-preview',str(config.system_prompt)||'使用原生默认提示词。');box.append(prompt);
    const kbNames=(Array.isArray(config.knowledge_bases)?config.knowledge_bases:[]).map(id=>(app().S.kbs.find(k=>k.id===id)||{}).name||id);
    box.append(node('p','agent-meta','智能体知识库：'+(config.kb_selection_mode==='selected'?kbNames.join('、')||'未选择':config.kb_selection_mode==='none'?'不检索知识库':'全部可用')));
    controls();
  }
  async function selectAgent(id){
    cancelModal();state.selected=null;controls();const current=token('detailSeq');el('detail').textContent='正在读取智能体…';
    try{const data=await call('get',{agent_id:id});if(!current())return;renderDetail(requireAgent(data));}
    catch(e){if(current()){el('detail').textContent='读取失败：'+error(e);status('智能体读取失败：'+error(e),true);}}
  }
  async function load(refresh=false){
    controls();if(!available()){status('当前端点未提供 agent_workspace，智能体管理为只读状态。');return;}
    if(!app().activeProfile()){status('请先配置有效 Token。');return;}
    const current=token();status('正在加载智能体…');
    try{
      const agents=await list(refresh);if(!current())return;state.loaded=true;el('list').innerHTML='';itemNodes.clear();
      agents.forEach(a=>{const item=button('',()=>selectAgent(a.id),'agent-list-item');item.dataset.agentId=a.id;itemNodes.set(a.id,item);item.append(node('strong','',str(a.name)||a.id),node('span','',a.is_builtin?'内置 · 只读':'自定义'),node('p','',str(a.description)));el('list').append(item);});
      markSelected(state.selected && state.selected.id);
      if(!agents.length)el('list').append(node('p','agent-empty','暂无可用智能体。可新建一个自定义智能体。'));
      status(agents.length+' 个可用智能体 · 修改由 WeKnora 按当前账号权限校验。');
    }catch(e){if(current() && !e.stale)status('智能体加载失败：'+error(e),true);}
  }
  function field(form,id,label,value,options=null,multiline=false){
    const wrap=node('label','field');wrap.append(node('span','',label));const input=node(options?'select':multiline?'textarea':'input','input');input.id='agent-'+id;
    if(options)options.forEach(([v,text])=>{const option=node('option','',text);option.value=v;input.append(option);});input.value=value;wrap.append(input);form.append(wrap);return input;
  }
  async function written(m,a){
    close(m);invalidateCache();state.loaded=false;renderDetail(a);load(true);
    if(root.Views && root.Views.onAgentsChanged)root.Views.onAgentsChanged();
  }
  async function edit(create=false){
    if(!available() || !create && (!state.selected || state.selected.is_builtin))return;
    const selected=state.selected,m=modal(create?'新建智能体':'编辑智能体');let a={name:'',description:'',config:{agent_mode:'quick-answer',agent_type:'custom',kb_selection_mode:'all'}};
    const loading=node('p','sub',create?'未指定模型时使用工作空间默认配置。':'正在读取最新配置…');m.box.append(loading);
    try{
      if(!create){const data=await call('get',{agent_id:selected.id});if(!m.current())return;a=requireAgent(data);if(a.is_builtin)throw new Error('内置智能体只读，请先复制。');}
      if(!m.current())return;loading.textContent='配置在 WeKnora 原生问答中执行；问答页还可独立收窄检索范围。';
      const form=node('form','agent-editor-form');form.id='agent-form';m.box.append(form);const config=a.config||{};
      const name=field(form,'name','名称',str(a.name));name.required=true;
      const description=field(form,'description','说明',str(a.description),null,true);
      const mode=field(form,'mode','问答模式',str(config.agent_mode)||'quick-answer',modes);
      const type=field(form,'type','智能体类型',str(config.agent_type)||'custom',types);
      const prompt=field(form,'prompt','系统提示词',str(config.system_prompt),null,true);prompt.className+=' agent-prompt-editor';
      const kbMode=field(form,'kb-mode','知识库选择',str(config.kb_selection_mode)||'all',[['all','全部可用知识库'],['selected','指定知识库'],['none','不检索知识库']]);
      const kbBox=node('div','agent-kb-options');const selectedIds=Array.isArray(config.knowledge_bases)?config.knowledge_bases:[],checks=[];
      (app().S.kbs||[]).forEach(kb=>{const wrap=node('label','agent-kb-option'),input=node('input');input.type='checkbox';input.id='agent-kb-'+kb.id;input.checked=selectedIds.includes(kb.id);wrap.append(input,node('span','',kb.name||kb.id));checks.push([kb.id,input]);kbBox.append(wrap);});form.append(kbBox);
      const syncKb=()=>{kbBox.hidden=kbMode.value!=='selected';};kbMode.onchange=syncKb;syncKb();
      const mentionWrap=node('label','agent-kb-option'),mention=node('input');mention.type='checkbox';mention.checked=!!config.retrieve_kb_only_when_mentioned;mention.id='agent-mentioned';mentionWrap.append(mention,node('span','','仅在问题提及知识库时检索'));form.append(mentionWrap);
      const model=field(form,'model','对话模型 ID（留空使用工作空间默认）',str(config.model_id));
      const rerank=field(form,'rerank-model','重排模型 ID（留空使用工作空间默认）',str(config.rerank_model_id));
      const err=node('p','wiki-error');err.id='agent-error';err.setAttribute('role','alert');form.append(err);const actions=node('div','modal-actions'),save=button('保存',null,'');save.type='submit';actions.append(button('取消',()=>close(m)),save);form.append(actions);let busy=false;
      form.onsubmit=async event=>{
        event.preventDefault();if(busy || !m.current())return;
        if(!name.value.trim()){err.textContent='请填写名称。';return;}
        const kbIds=checks.filter(([,check])=>check.checked).map(([id])=>id);
        if(kbMode.value==='selected' && !kbIds.length){err.textContent='请选择至少一个知识库。';return;}
        const next={agent_mode:mode.value,agent_type:type.value,system_prompt:prompt.value,kb_selection_mode:kbMode.value,knowledge_bases:kbMode.value==='selected'?kbIds:[],retrieve_kb_only_when_mentioned:mention.checked};
        if(!create || model.value.trim())next.model_id=model.value.trim();if(!create || rerank.value.trim())next.rerank_model_id=rerank.value.trim();
        const args={name:name.value.trim(),description:description.value,config:next};if(!create)args.agent_id=a.id;
        busy=true;save.disabled=true;err.textContent='正在保存…';
        try{const data=await call(create?'create':'update',args);if(!m.current())return;await written(m,requireAgent(data));}
        catch(e){if(m.current())err.textContent='保存失败：'+error(e);}
        finally{if(m.current()){busy=false;save.disabled=false;}}
      };
    }catch(e){if(m.current()){loading.textContent='配置读取失败：'+error(e);m.box.append(button('关闭',()=>close(m)));}}
  }
  function copy(){
    if(!state.selected || !available())return;const a=state.selected,m=modal('复制智能体');
    const form=node('form','agent-editor-form');form.id='agent-copy-form';m.box.append(form);const name=field(form,'copy-name','副本名称',str(a.name)+'（副本）');name.required=true;
    const err=node('p','wiki-error');err.id='agent-error';form.append(err);const save=button('创建副本',null,'');save.type='submit';form.append(button('取消',()=>close(m)),save);let busy=false;
    form.onsubmit=async event=>{event.preventDefault();if(busy || !m.current())return;if(!name.value.trim()){err.textContent='请填写副本名称。';return;}busy=true;save.disabled=true;
      try{const data=await call('copy',{agent_id:a.id,name:name.value.trim()});if(m.current())await written(m,requireAgent(data));}
      catch(e){if(m.current())err.textContent='复制失败：'+error(e);}finally{if(m.current()){busy=false;save.disabled=false;}}};
  }
  async function remove(){
    if(!state.selected || state.selected.is_builtin || !available())return;cancelModal();const a=state.selected,current=token('modalSeq');
    const confirmed=await app().confirmDialog({title:'删除智能体',message:'删除“'+str(a.name)+'”？此后无法在问答中选择该智能体。',confirmText:'删除智能体',danger:true});if(!confirmed || !current())return;
    const box=document.getElementById('modal-box'),marker=box && box.children[0],valid=()=>current() && (!box || box.contains(marker));
    try{const data=await call('delete',{agent_id:a.id});if(!valid())return;if(data.deleted!==true)throw new Error('服务端未确认删除。');state.selected=null;el('detail').textContent='选择一个智能体查看配置。';invalidateCache();load(true);controls();if(root.Views && root.Views.onAgentsChanged)root.Views.onAgentsChanged();}
    catch(e){if(valid())status('删除失败：'+error(e),true);}
  }
  function mount(section){
    state.section=section;section.innerHTML='<div class="agent-topbar"><div><h2>管理你的智能体</h2><p>配置原生问答方式、提示词与知识库范围，再到知识问答中使用。</p></div><div class="agent-actions"><button id="agents-create" class="btn">新建智能体</button><button id="agents-refresh" class="btn ghost">刷新列表</button></div></div><p id="agents-status" class="agent-status" role="status"></p><div class="agent-layout"><aside id="agents-list" class="agent-list"></aside><section class="agent-reading"><div class="agent-actions"><button id="agents-edit" class="btn ghost">编辑</button><button id="agents-copy" class="btn ghost">复制</button><button id="agents-delete" class="btn ghost">删除</button></div><div id="agents-detail" class="agent-detail">选择一个智能体查看配置。</div></section></div>';
    el('create').onclick=()=>edit(true);el('refresh').onclick=()=>load(true);el('edit').onclick=()=>edit();el('copy').onclick=copy;el('delete').onclick=remove;controls();
  }
  root.KnowledgeViews=root.KnowledgeViews||{};
  root.KnowledgeViews.agents={
    show(section){if(!app() || !root.Explorer)return;const epoch=app().captureIdentityEpoch();if(state.epoch!==epoch){if(state.section)this.reset();state.epoch=epoch;}if(state.section!==section)mount(section);if(!state.loaded)load();else controls();},
    reset(){cancelModal();state.seq++;state.detailSeq++;const section=state.section;state.section=null;state.selected=null;state.loaded=false;state.epoch=null;itemNodes.clear();invalidateCache();if(section)section.innerHTML='';},
    selectionChanged(){if(!state.section)return;if(state.epoch!==app().captureIdentityEpoch()){const section=state.section;this.reset();this.show(section);return;}controls();if(!state.loaded)load();}
  };
})(typeof window==='undefined'?{}:window);
