/* Wiki knowledge reader. Business calls go through the shared core tool client. */
"use strict";
(function (root) {
  const typeNames = {summary:'资料摘要',entity:'实体',concept:'概念',index:'索引',synthesis:'综合分析',comparison:'对比'};
  const str = value => typeof value === 'string' ? value : '';
  function decode(value) {
    return str(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity) => {
      const names = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
      if (entity[0] !== '#') return names[entity.toLowerCase()] || all;
      const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    });
  }
  function tag(xml, name) {
    const match = str(xml).match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>', 'i'));
    return match ? match[1].trim() : '';
  }
  function linkInfo(text) {
    const match = str(text).match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    return match ? {slug:decode(match[1]).trim(),title:decode(match[2] || match[1]).trim()} : {slug:'',title:''};
  }
  function normalizeIndex(result) {
    const wiki = result && result.wiki || {};
    return {intro:str(wiki.intro),groups:(Array.isArray(wiki.groups) ? wiki.groups : []).map(g => ({
      type:str(g.type), total:Number(g.total) || 0, nextCursor:str(g.next_cursor),
      items:(Array.isArray(g.items) ? g.items : []).filter(p => p && str(p.slug).trim()).map(p => ({
        slug:p.slug.trim(),title:str(p.title) || p.slug,summary:str(p.summary),category:Array.isArray(p.category_path) ? p.category_path.map(String).join(' / ') : '',
      })),
    }))};
  }
  function filterGroups(groups, query, type='') {
    const q = str(query).trim().toLocaleLowerCase();
    return groups.filter(g => !type || g.type === type).map(g => ({...g,items:g.items.filter(p => !q || [p.title,p.slug,p.summary,p.category].join(' ').toLocaleLowerCase().includes(q))})).filter(g => g.items.length);
  }
  function parseSearch(result) {
    const wiki = result && result.results && result.results.wiki;
    const xml = typeof wiki === 'string' ? wiki : str(wiki && wiki.content);
    const items = [...xml.matchAll(/<page(?:\s[^>]*)?>([\s\S]*?)<\/page>/gi)].map(m => {
      const info = linkInfo(tag(m[1],'link'));
      return {...info,type:decode(tag(m[1],'type')),kbId:decode(tag(m[1],'knowledge_base_id')),summary:decode(tag(m[1],'match_snippet') || tag(m[1],'summary'))};
    }).filter(p => p.slug);
    const failures = result && (result.errors || result.failures);
    const failureText = Array.isArray(failures) ? failures.map(e => typeof e === 'string' ? e : str(e.error) || str(e.message)).filter(Boolean).join('；') : '';
    return {items,warning:[decode(tag(xml,'errors')),failureText,result && result.partial ? '部分搜索未完成，请重试。' : ''].filter(Boolean).join('；')};
  }
  function parsePage(result, slug, kbId) {
    const page = result && result.page || {};
    const content = str(page.content);
    const isXml = /<wiki_page(?:\s|>)/i.test(content);
    const info = isXml ? linkInfo(tag(tag(content,'metadata'),'link')) : {};
    const sources = page.source_refs_v2;
    const refs = Array.isArray(sources) ? sources : sources && sources[slug+'|'+kbId];
    const title=info.title || str(page.title) || slug;
    let body=isXml ? tag(content,'content') : content;
    body=stripLeadingTitle(body,title);
    return {slug,title,type:decode(tag(tag(content,'metadata'),'type')) || str(page.page_type),body,refs:Array.isArray(refs) ? refs : []};
  }
  function stripLeadingTitle(body,title) {
    const heading=body.match(/^[\s\uFEFF]*#{1,6}[ \t]+([^\r\n]+)(?:\r?\n|$)/);
    return heading && heading[1].replace(/[ \t]+#+[ \t]*$/,'').trim()===title.trim() ? body.slice(heading[0].length).trimStart() : body;
  }
  function renderWikiMarkdown(body, renderMarkdown, escapeHtml) {
    const links=[];
    const text = str(body).replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_,slug,label) => {
      const index=links.push({slug:slug.trim(),label:label || slug})-1;
      return 'WIKILINKTOKEN'+index+'ENDTOKEN';
    });
    return renderMarkdown(text).replace(/WIKILINKTOKEN(\d+)ENDTOKEN/g,(token,i) => {
      const link=links[Number(i)];
      return link ? '<a class="wiki-internal-link" href="#wiki" data-wiki-slug="'+encodeURIComponent(link.slug)+'">'+escapeHtml(link.label)+'</a>' : token;
    });
  }
  const helpers={normalizeIndex,filterGroups,parseSearch,parsePage,renderWikiMarkdown};
  if (typeof module !== 'undefined' && module.exports) module.exports=helpers;
  if (!root) return;

  const state={section:null,kbId:'',reqSeq:0,readSeq:0,groups:[],query:'',mode:'directory',loaded:false,epoch:null,selected:'',pendingPage:null,manageSeq:0,modal:null};
  const app=()=>root.App;
  const explorer=()=>root.Explorer;
  const el=id=>state.section.querySelector('#wiki-'+id);
  const node=(tagName,className,text)=>{
    const n=document.createElement(tagName);n.className=className || '';if(text !== undefined)n.textContent=text;return n;
  };
  function status(text, error=false) { el('status').textContent=text;el('status').className='wiki-status'+(error?' wiki-error':''); }
  function readerMessage(title, text) {
    const article=el('article');article.innerHTML='';article.append(node('div','wiki-reader-symbol','W'),node('h2','',title),node('p','wiki-reader-hint',text));
    el('sources').innerHTML='';el('sources-panel').hidden=true;
  }
  function clearData() {
    invalidateManagement();
    state.reqSeq++;state.readSeq++;state.groups=[];state.query='';state.mode='directory';state.loaded=false;state.selected='';
    if(!state.section)return;
    el('intro').innerHTML='';el('intro').hidden=false;el('directory').innerHTML='';el('filter').value='';el('search').value='';el('open-slug').value='';el('type').innerHTML='';
    el('summary').textContent='浏览生成的知识页面，沿着关联主题继续阅读。';
    el('directory').setAttribute('aria-busy','false');el('article').setAttribute('aria-busy','false');
    readerMessage('从一个主题开始','在左侧选择页面，阅读整理后的知识与参考来源。');
    updateActions();
  }
  function requestToken(read=false) {
    const key=read?'readSeq':'reqSeq';
    const seq=++state[key], kbId=state.kbId, epoch=app().captureIdentityEpoch();
    return ()=>state[key]===seq && state.kbId===kbId && app().isCurrentIdentityEpoch(epoch);
  }
  function currentKb() { return app().S.kbs.find(kb=>kb.id===state.kbId); }
  function ready() {
    const enabled=!!state.kbId && explorer().capability(currentKb(),'wiki');
    updateActions(enabled);
    el('search-button').disabled=!enabled;el('search').disabled=!enabled;el('refresh').disabled=!enabled;
    return enabled;
  }
  function renderDirectory() {
    const container=el('directory');container.innerHTML='';
    const groups=filterGroups(state.groups,el('filter').value,el('type').value);
    if(!groups.length){container.append(node('p','wiki-list-empty','没有匹配的目录页面。'));return;}
    groups.forEach(g=>{
      const block=node('div','wiki-group');
      block.append(node('h3','wiki-group-title',(typeNames[g.type] || g.type || '页面')+' · '+g.total));
      g.items.forEach(item=>block.append(pageButton(item)));
      if(g.nextCursor || g.total>g.items.length && !el('filter').value)block.append(node('p','wiki-directory-note','仅展示当前目录窗口，搜索可查找更多主题。'));
      container.append(block);
    });
  }
  function pageButton(item) {
    const button=node('button','wiki-page-item'+(state.selected===item.slug?' wiki-page-selected':''));button.type='button';
    button.dataset.slug=item.slug;
    button.append(node('span','wiki-page-title',item.title || item.slug));
    if(item.summary)button.append(node('span','wiki-page-summary',item.summary));
    if(item.category)button.append(node('span','wiki-page-category',item.category));
    button.onclick=()=>readPage(item.slug);return button;
  }
  async function loadDirectory() {
    clearData();
    if(!state.kbId){ready();status('请先连接账号并选择知识库。');return;}
    if(!ready()){status('此知识库尚未启用 Wiki。');readerMessage('Wiki 尚未启用','选择已启用 Wiki 的知识库，查看自动整理的知识。');return;}
    const current=requestToken();const kbId=state.kbId;
    status('正在加载知识目录…');el('directory').setAttribute('aria-busy','true');
    try {
      const response=await explorer().call('read_document',{action:'list',source_type:'wiki',knowledge_base_id:kbId},[kbId]);
      if(!current() || response.stale)return;
      if(!response.ok)throw new Error(errorText(response.error));
      const index=normalizeIndex(response.result);state.groups=index.groups;state.loaded=true;
      el('intro').innerHTML=renderWikiMarkdown(index.intro,app().renderMarkdown,app().escapeHtml);
      const option=node('option','','全部分类');option.value='';el('type').append(option);
      index.groups.forEach(g=>{const option=node('option','',typeNames[g.type] || g.type);option.value=g.type;el('type').append(option);});
      const total=index.groups.reduce((sum,g)=>sum+g.total,0);
      el('summary').textContent=total ? total+' 个知识页面 · '+index.groups.length+' 个分类' : '知识页面尚未生成';
      status(total ? '选择页面开始阅读。' : '目录暂无页面；资料生成 Wiki 后会显示在这里。');
      renderDirectory();
      if(!total && !state.selected)readerMessage('知识正在等待汇集','此库尚无 Wiki 页面。生成后，可在此浏览主题和来源。');
    } catch(error) {if(current()){status('目录加载失败：'+errorText(error),true);if(!state.selected)readerMessage('暂时无法加载目录','请检查连接后点击刷新重试。');}}
    finally {if(current())el('directory').setAttribute('aria-busy','false');}
  }
  function errorText(error) { return typeof error==='string' ? error : error && error.message || '请求未完成，请重试。'; }
  async function search() {
    const query=el('search').value.trim();
    if(!query){loadDirectory();return;}
    if(!ready())return;
    invalidateManagement();
    state.query=query;state.mode='search';state.readSeq++;state.selected='';updateActions();
    el('intro').hidden=true;
    readerMessage('选择搜索结果','打开主题，继续阅读完整知识与参考来源。');
    const current=requestToken(),kbId=state.kbId;status('正在搜索 Wiki…');
    el('directory').innerHTML='';el('directory').setAttribute('aria-busy','true');
    try {
      const response=await explorer().call('search_knowledge',{query,knowledge_base_ids:[kbId],sources:['wiki']},[kbId]);
      if(!current() || response.stale)return;
      if(!response.ok)throw new Error(errorText(response.error));
      const result=parseSearch(response.result);
      const items=result.items.filter(p=>!p.kbId || p.kbId===kbId);
      el('summary').textContent='“'+query+'” · '+items.length+' 条搜索结果';
      status(result.warning || (items.length ? '搜索完成，选择主题阅读。' : '没有找到相关页面，可换个关键词。'),!!result.warning);
      items.forEach(item=>el('directory').append(pageButton(item)));
      if(!items.length)el('directory').append(node('p','wiki-list-empty',result.warning ? '搜索未完整完成，请重试。' : '没有匹配的知识页面。'));
    } catch(error){if(current())status('搜索失败：'+errorText(error),true);}
    finally {if(current())el('directory').setAttribute('aria-busy','false');}
  }
  async function readPage(slug,native=false) {
    if(!ready() || !slug || native && !hasWorkspace())return;
    invalidateManagement();
    const current=requestToken(true),kbId=state.kbId;state.selected=slug;el('open-slug').value=slug;updateActions();
    el('intro').hidden=true;
    state.section.querySelectorAll('.wiki-page-item').forEach(button=>button.classList.toggle('wiki-page-selected',button.dataset.slug===slug));
    readerMessage('正在打开页面…','');el('article').setAttribute('aria-busy','true');
    try {
      const response=native
        ? await explorer().call('wiki_workspace',{action:'get',slug,knowledge_base_id:kbId},[kbId])
        : await explorer().call('read_document',{action:'read',source_type:'wiki',slug,knowledge_base_id:kbId},[kbId]);
      if(!current() || response.stale)return;
      if(!response.ok)throw new Error(errorText(response.error));
      const raw=native?requirePage(response.result):null;
      const page=native?{slug:raw.slug,title:str(raw.title) || raw.slug,type:str(raw.page_type),status:str(raw.status),body:stripLeadingTitle(str(raw.content),str(raw.title) || raw.slug),refs:Array.isArray(raw.source_refs_v2)?raw.source_refs_v2:[]}:parsePage(response.result,slug,kbId);
      const article=el('article');article.innerHTML='';
      const statusLabel={draft:'草稿',published:'已发布',archived:'已归档'}[page.status];
      article.append(node('div','wiki-article-type',(typeNames[page.type] || '知识页面')+(statusLabel?' · '+statusLabel:'')),node('h1','wiki-article-title',page.title));
      const body=node('div','wiki-prose');
      if(page.body)body.innerHTML=renderWikiMarkdown(page.body,app().renderMarkdown,app().escapeHtml);
      else body.textContent='此页面暂无正文。';
      article.append(body);
      el('sources-panel').hidden=false;
      explorer().renderSources(el('sources'),page.refs,kbId);
      if(!page.refs.length)el('sources').textContent='此页面暂无可核对的来源。';
    } catch(error){if(current())readerMessage('页面未能打开',errorText(error));}
    finally {if(current())el('article').setAttribute('aria-busy','false');}
  }
  function hasWorkspace() { return (app().S.tools || []).some(tool=>tool.name==='wiki_workspace'); }
  function updateActions(enabled) {
    if(!state.section)return;
    if(enabled===undefined)enabled=!!state.kbId && explorer().capability(currentKb(),'wiki');
    const writable=enabled && hasWorkspace();
    el('create').disabled=!writable;el('open-slug').disabled=!writable;el('open-button').disabled=!writable;
    ['edit','history','delete'].forEach(action=>el(action).disabled=!writable || !state.selected);
    el('graph').disabled=!enabled || !hasWorkspace() || !state.selected;
    el('workspace-notice').textContent=hasWorkspace() ? '通过 MCP 管理原生 Wiki 页面；服务端按当前账号权限校验写入。' : '当前端点未提供 wiki_workspace，Wiki 以只读模式打开。';
  }
  function modalVisible(modal) {
    const host=document.getElementById('modal-root');
    return modal && modal.box.contains(modal.marker) && (!host || !host.classList.contains('hidden'));
  }
  function invalidateManagement() {
    state.manageSeq++;
    if(state.modal && modalVisible(state.modal))app().closeModal();
    state.modal=null;
  }
  function managementToken() {
    const seq=++state.manageSeq,kbId=state.kbId,epoch=app().captureIdentityEpoch();
    return {kbId,valid:()=>!!state.section && state.manageSeq===seq && state.kbId===kbId && app().isCurrentIdentityEpoch(epoch)};
  }
  function managementModal(token,title) {
    let box,marker;
    app().openModal(container=>{box=container;marker=node('h3','',title);container.append(marker);});
    const modal={box,marker};state.modal=modal;
    return {...token,box,current:()=>token.valid() && modalVisible(modal)};
  }
  function button(text,handler,extra='') { const b=node('button','btn '+extra,text);b.type='button';b.onclick=handler;return b; }
  function modalClose(modal) { if(modal.current()){app().closeModal();state.modal=null;state.manageSeq++;} }
  function afterConfirmation(token,fallbackBox=null) {
    const box=document.getElementById('modal-box') || fallbackBox,marker=box && box.children[0];
    return ()=>token.valid() && (!box || !!marker && box.contains(marker));
  }
  async function workspaceCall(action,args,kbId) {
    const response=await explorer().call('wiki_workspace',{action,knowledge_base_id:kbId,...args},[kbId]);
    if(response.stale)throw new Error('账号或知识库已切换，请重新打开。');
    if(!response.ok)throw new Error(errorText(response.error));
    return response.result || {};
  }
  function requirePage(result) {
    if(!result.page || !str(result.page.slug))throw new Error('服务端未返回有效的原生 Wiki 页面。');
    return result.page;
  }
  function field(form,id,label,value,multiline=false,options=null) {
    const wrapper=node('label','field');wrapper.append(node('span','',label));
    const input=node(options ? 'select' : multiline ? 'textarea' : 'input','input');input.id='wiki-editor-'+id;
    if(options)options.forEach(([key,text])=>{const option=node('option','',text);option.value=key;input.append(option);});
    input.value=value;wrapper.append(input);form.append(wrapper);return input;
  }
  async function editPage(create=false) {
    if(!ready() || !hasWorkspace() || !create && !state.selected)return;
    invalidateManagement();
    const token=managementToken(),slug=state.selected,modal=managementModal(token,create?'新建 Wiki 页面':'编辑 Wiki 页面');
    const hint=node('p','sub',create?'填写原生 Markdown，使用 [[页面标识|名称]] 关联知识页面。':'正在读取原生页面…');modal.box.append(hint);
    let page={slug:'',title:'',content:'',summary:'',page_type:'concept',status:'draft'};
    try {
      if(!create){const result=await workspaceCall('get',{slug},token.kbId);if(!modal.current())return;page=requirePage(result);}
      if(!modal.current())return;
      hint.textContent=create?'草稿和归档页面可能不会出现在阅读目录中。':'页面标识：'+page.slug+' · 当前版本 v'+page.version+'。冲突时请重新打开页面核对后再保存。';
      const form=node('form','wiki-editor-form');form.id='wiki-editor-form';modal.box.append(form);
      let slugInput=null;
      if(create){slugInput=field(form,'slug','页面标识，例如 concept/rag','');slugInput.required=true;}
      const title=field(form,'title','标题',str(page.title));title.required=true;
      const type=field(form,'type','页面类型',str(page.page_type),false,Object.entries(typeNames));
      const pageStatus=field(form,'status','状态',str(page.status),false,[['draft','草稿'],['published','已发布'],['archived','已归档']]);
      const summary=field(form,'summary','摘要',str(page.summary),true);
      const content=field(form,'content','Markdown 正文',str(page.content),true);content.className+=' wiki-markdown-editor';
      const error=node('p','wiki-error');error.id='wiki-editor-error';error.setAttribute('role','alert');form.append(error);
      const actions=node('div','modal-actions'),save=button('保存',null);save.type='submit';save.id='wiki-editor-save';
      actions.append(button('取消',()=>modalClose(modal),'ghost'),save);form.append(actions);
      let busy=false;
      form.onsubmit=async event=>{
        event.preventDefault();if(busy || !modal.current())return;
        const desiredSlug=create?slugInput.value.trim():page.slug;
        if(!desiredSlug || !title.value.trim()){error.textContent='请填写页面标识和标题。';return;}
        if(!create && (!Number.isInteger(page.version) || page.version<1)){error.textContent='页面缺少有效版本，无法安全保存；请重新打开。';return;}
        busy=true;save.disabled=true;error.textContent='正在保存…';
        const args={slug:desiredSlug,title:title.value,content:content.value,summary:summary.value,page_type:type.value,status:pageStatus.value};
        if(!create)args.version=page.version;
        try {
          const result=await workspaceCall(create?'create':'update',args,token.kbId);
          if(!modal.current())return;
          const saved=requirePage(result);modalClose(modal);loadDirectory();readPage(saved.slug,true);
        } catch(e) {if(modal.current())error.textContent='保存失败：'+errorText(e);}
        finally {if(modal.current()){busy=false;save.disabled=false;}}
      };
    } catch(e) {if(modal.current()){hint.textContent='无法读取原生页面：'+errorText(e);hint.className='wiki-error';modal.box.append(button('关闭',()=>modalClose(modal),'ghost'));}}
  }
  async function deletePage() {
    if(!ready() || !hasWorkspace() || !state.selected)return;
    invalidateManagement();const token=managementToken(),slug=state.selected;
    const confirmed=await app().confirmDialog({title:'删除 Wiki 页面',message:'删除“'+slug+'”？此操作将删除原生 Wiki 页面。',confirmText:'删除页面',danger:true});
    if(!confirmed || !token.valid())return;
    const current=afterConfirmation(token);
    try {
      const result=await workspaceCall('delete',{slug},token.kbId);if(!current())return;
      if(result.deleted!==true)throw new Error('服务端未确认页面已删除。');
      loadDirectory();
    } catch(e){if(current())status('删除失败：'+errorText(e),true);}
  }
  async function showHistory(slug=state.selected,notice='') {
    if(!ready() || !hasWorkspace() || !slug)return;
    invalidateManagement();const token=managementToken(),modal=managementModal(token,'Wiki 页面历史');
    const info=node('p','sub',notice || '正在加载修订记录…');info.id='wiki-history-count';info.setAttribute('role','status');modal.box.append(info);
    const list=node('div','wiki-revision-list'),preview=node('div','wiki-revision-preview');
    const more=button('加载更早的修订',()=>loadNext(),'ghost');more.id='wiki-history-more';more.disabled=true;
    const pagination=node('div','wiki-history-pagination');pagination.append(more);modal.box.append(list,pagination,preview);
    modal.box.append(button('关闭',()=>modalClose(modal),'ghost'));
    let previewSeq=0,offset=0,busy=false;const seen=new Set();
    async function loadNext() {
      if(busy || !modal.current())return;
      busy=true;more.disabled=true;more.textContent='正在加载…';
      try {
        const result=await workspaceCall('revisions',{slug,limit:20,offset},token.kbId);if(!modal.current())return;
        const data=result.revisions || {}, revisions=Array.isArray(data.revisions)?data.revisions:[];
        offset+=revisions.length;
        const total=Math.max(0,Number(data.total) || 0);
        info.className='sub';info.textContent=(notice?notice+'；':'')+'页面：'+slug+' · 当前版本 v'+data.current_version+' · 已加载 '+offset+' / '+total+' 条历史修订';
        more.hidden=offset>=total || !revisions.length;
        if(!revisions.length && !offset)list.append(node('p','sub','暂无保留的历史修订。'));
        if(!revisions.length && offset<total)info.textContent+='；修订列表已变化，请重新打开历史记录。';
        revisions.forEach(revision=>{
          if(!Number.isInteger(revision.version) || revision.version<1 || seen.has(revision.version))return;
          seen.add(revision.version);
          const item=button('v'+revision.version+' · '+str(revision.title)+' · '+str(revision.edited_at),async()=>{
            const seq=++previewSeq;preview.innerHTML='';preview.append(node('p','sub','正在读取修订内容…'));
            try {
              const snapshot=await workspaceCall('revisions',{slug,version:revision.version},token.kbId);
              if(!modal.current() || seq!==previewSeq)return;
              if(!snapshot.revision || snapshot.revision.version!==revision.version)throw new Error('修订内容不可用。');
              preview.innerHTML='';preview.append(node('h4','','v'+revision.version+' · '+str(snapshot.revision.title)));
              const raw=node('pre','wiki-revision-content',str(snapshot.revision.content));raw.id='wiki-revision-content';preview.append(raw);
              const restore=button('还原此版本',async()=>{
                if(!modal.current() || seq!==previewSeq)return;
                const confirmed=await app().confirmDialog({title:'还原 Wiki 页面',message:'将“'+slug+'”还原为 v'+revision.version+' 的标题、正文、摘要、类型和状态，并生成新版本。',confirmText:'确认还原',danger:true});
                if(!token.valid())return;
                if(!confirmed){showHistory(slug);return;}
                const current=afterConfirmation(token,modal.box);
                try {
                  const result=await workspaceCall('restore',{slug,version:revision.version},token.kbId);if(!current())return;
                  const saved=requirePage(result);state.modal=null;state.manageSeq++;loadDirectory();readPage(saved.slug,true);
                } catch(e) {if(current())showHistory(slug,'还原失败：'+errorText(e));}
              });restore.id='wiki-revision-restore';preview.append(restore);
            } catch(e){if(modal.current() && seq===previewSeq){preview.innerHTML='';preview.append(node('p','wiki-error',errorText(e)));}}
          },'ghost');item.id='wiki-revision-'+revision.version;list.append(item);
        });
      } catch(e) {if(modal.current()){info.textContent='历史读取失败：'+errorText(e);info.className='wiki-error';more.hidden=false;}}
      finally {if(modal.current()){busy=false;more.disabled=false;more.textContent='加载更早的修订';}}
    }
    await loadNext();
  }
  function mount(section) {
    state.section=section;
    section.innerHTML=`<div class="wiki-topbar"><div><div class="wiki-eyebrow">知识空间 / WIKI</div><h2>让知识连成脉络</h2><p>浏览主题、发现关联，回到资料核对每一处依据。</p></div><label class="field wiki-kb-field"><span>知识库</span><select id="wiki-kb" class="input" aria-label="Wiki 知识库"></select></label></div>
      <form id="wiki-search-form" class="wiki-searchbar"><input id="wiki-search" class="input" type="search" placeholder="搜索 Wiki 中的知识主题…" aria-label="搜索 Wiki"><button id="wiki-search-button" class="btn" type="submit">搜索知识</button><button id="wiki-refresh" class="btn ghost" type="button">返回目录</button></form>
      <p id="wiki-status" class="wiki-status" role="status" aria-live="polite"></p>
      <div class="wiki-workspace-actions"><button id="wiki-create" class="btn" type="button">新建页面</button><button id="wiki-edit" class="btn ghost" type="button">编辑页面</button><button id="wiki-history" class="btn ghost" type="button">版本历史</button><button id="wiki-delete" class="btn ghost" type="button">删除页面</button><button id="wiki-graph" class="btn ghost" type="button">在链接图中查看</button><form id="wiki-open-form" class="wiki-open-form"><input id="wiki-open-slug" class="input" type="text" placeholder="例如 concept/rag" aria-label="Wiki 页面标识" required><button id="wiki-open-button" class="btn ghost" type="submit">按页面标识打开</button></form></div><p id="wiki-workspace-notice" class="wiki-workspace-notice"></p>
      <div class="wiki-layout"><aside class="wiki-sidebar"><div class="wiki-sidebar-heading"><h3>知识目录</h3><p id="wiki-summary"></p></div><div class="wiki-directory-tools"><select id="wiki-type" class="input" aria-label="目录分类"></select><input id="wiki-filter" class="input" type="search" placeholder="过滤当前目录" aria-label="过滤目录"></div><div id="wiki-directory" class="wiki-directory"></div></aside><div class="wiki-reading"><div id="wiki-intro" class="wiki-intro wiki-prose"></div><article id="wiki-article" class="wiki-article"></article><section id="wiki-sources-panel" class="wiki-sources-panel" hidden><h3>参考来源</h3><p class="wiki-source-hint">查看原始资料，核对页面依据。</p><div id="wiki-sources"></div></section></div></div>`;
    el('kb').onchange=()=>{state.kbId=el('kb').value;loadDirectory();};
    el('search-form').onsubmit=event=>{event.preventDefault();search();};
    el('refresh').onclick=()=>loadDirectory();
    el('create').onclick=()=>editPage(true);el('edit').onclick=()=>editPage();el('delete').onclick=deletePage;el('history').onclick=()=>showHistory();
    el('open-form').onsubmit=event=>{event.preventDefault();const slug=el('open-slug').value.trim();if(slug)readPage(slug,true);};
    el('graph').onclick=()=>{if(state.selected && root.KnowledgeViews.graph)root.KnowledgeViews.graph.openWikiGraph(state.kbId,state.selected);};
    el('filter').oninput=()=>{if(state.mode==='directory')renderDirectory();};
    el('type').onchange=()=>{if(state.mode==='directory')renderDirectory();};
    section.onclick=event=>{
      const link=event.target.closest && event.target.closest('[data-wiki-slug]');
      if(link && section.contains(link)){event.preventDefault();try{readPage(decodeURIComponent(link.dataset.wikiSlug));}catch(_){/* Ignore malformed links. */}}
    };
  }
  function syncSelection() {
    if(!state.section || !app() || !explorer())return;
    const previous=state.kbId;
    state.kbId=explorer().fillKbSelect(el('kb'),state.kbId,'wiki');
    updateActions();
    if(previous!==state.kbId || !state.loaded)loadDirectory();
  }
  root.KnowledgeViews=root.KnowledgeViews || {};
  root.KnowledgeViews.wiki={
    show(section){
      if(!app() || !explorer())return;
      if(state.section!==section)mount(section);
      const epoch=app().captureIdentityEpoch();
      if(state.epoch!==epoch){state.kbId='';clearData();state.epoch=epoch;}
      const pending=state.pendingPage;
      state.pendingPage=null;
      if(pending && app().isCurrentIdentityEpoch(pending.epoch)){
        if(state.kbId!==pending.kbId || !pending.slug)clearData();
        state.kbId=pending.kbId;
      }
      syncSelection();
      if(pending && pending.slug && pending.kbId===state.kbId && app().isCurrentIdentityEpoch(pending.epoch))readPage(pending.slug);
    },
    reset(){
      const section=state.section;
      state.section=null;state.kbId='';state.epoch=null;state.pendingPage=null;
      clearData();
      if(section){section.onclick=null;section.innerHTML='';}
    },
    selectionChanged(){
      if(state.section && state.epoch!==app().captureIdentityEpoch()){state.kbId='';clearData();state.epoch=app().captureIdentityEpoch();}
      syncSelection();
    },
    openPage(kbId,slug){
      if(!app() || !app().S.kbs.some(kb=>kb.id===kbId))return;
      state.pendingPage={kbId,slug:str(slug).trim(),epoch:app().captureIdentityEpoch()};
      const alreadyOpen=root.location && root.location.hash==='#/wiki';
      if(root.location)root.location.hash='#/wiki';
      if(alreadyOpen && state.section)this.show(state.section);
    },
  };
})(typeof window !== 'undefined' ? window : null);
