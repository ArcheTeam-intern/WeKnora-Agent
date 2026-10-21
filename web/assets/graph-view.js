/* Local graph exploration through the five-tool core MCP surface. */
"use strict";
(function (root) {
  const list = value => Array.isArray(value) ? value : [];
  const str = value => value == null ? '' : String(value);
  const message = error => typeof error === 'string' ? error : error && (error.message || error.error || error.code) ? str(error.message || error.error || error.code) : JSON.stringify(error || '请求失败');
  function failureStatus(text) {
    return /GRAPH_NOT_CONFIGURED|GRAPH_UNAVAILABLE|graph.*not.*configured|no graph|extraction missing/i.test(text) ? 'unconfigured' : 'error';
  }
  function parseWikiGraph(payload) {
    const data=payload && payload.graph;
    const collection=key=>data && Object.prototype.hasOwnProperty.call(data,key) && (data[key]===null || Array.isArray(data[key]));
    if(!collection('nodes') || !collection('edges'))return {status:'error',message:'Wiki 页面链接图响应格式无法识别。',nodes:[],edges:[],warnings:[],evidence:[]};
    const nodes=list(data.nodes).filter(n=>n && n.slug).map(n=>({...n,id:n.slug,label:n.title || n.slug,type:n.page_type || 'page',refs:[]}));
    const ids=new Set(nodes.map(n=>n.id));
    const edges=list(data.edges).filter(e=>ids.has(e.source)&&ids.has(e.target)).map((e,i)=>({...e,id:'wiki-link-'+i,label:'链接',refs:[],wikiLink:true}));
    const meta=data.meta || {},warnings=[];
    if(meta.truncated)warnings.push(`当前显示 ${meta.returned ?? nodes.length} / ${meta.total ?? '未知'} 个页面；可指定中心页面查看邻接链接。`);
    return {status:nodes.length?'ready':'empty',message:nodes.length?'':'当前范围没有 Wiki 页面链接图。',nodes,edges,warnings,evidence:[],wiki:true};
  }
  function parseGraph(payload) {
    payload = payload || {};
    const part = payload.results && payload.results.graph;
    const failures = list(payload.failures).map(f => str(f.source) + ': ' + message(f.error || f));
    if (!part) {
      const text = failures.join('；') || '响应缺少图谱结果，无法确认查询是否成功。';
      return {status:failureStatus(text),message:text,nodes:[],edges:[],warnings:failures,droppedEdges:0};
    }
    const data = part.data || part;
    const warnings = failures.concat(list(data.errors).map(message));
    if (data.truncated) warnings.push('查询结果已截断，仅展示后端返回的局部结果。');
    const view = data.local_graph || data.graph_data;
    if (!view && !Array.isArray(data.results) && !Array.isArray(data.relations)) {
      return {status:'error',message:'图谱响应格式无法识别。',nodes:[],edges:[],warnings,droppedEdges:0};
    }
    const evidence = new Map(list(data.results).filter(x => x && x.chunk_id).map(x => [str(x.chunk_id),x]));
    const seen = new Set();
    const returnedNodes = list(view && view.nodes).filter(n => n && n.id != null && !seen.has(str(n.id)) && seen.add(str(n.id))).map(n => {
      const hit = evidence.get(str(n.id));
      const refs = list(n.source_refs_v2).slice();
      if (!refs.length && hit && hit.knowledge_id) refs.push({knowledge_id:hit.knowledge_id,knowledge_base_id:hit.knowledge_base_id,chunk_ids:[hit.chunk_id],quote:hit.content || '',provenance_status:hit.content ? 'verified':'unverified_source'});
      return {...n,id:str(n.id),label:str(n.label || n.id),refs};
    });
    const nodes = returnedNodes.filter(n=>n.type!=='chunk');
    const entityIds = new Set(nodes.map(n=>n.id));
    // Query matches are related reading, not graph entities or relation proof.
    const related = new Map(returnedNodes.filter(n=>n.type==='chunk').map(n=>[n.id,n]));
    for(const [id,hit] of evidence) {
      const original=related.get(id) || {};
      related.set(id,{...original,id,label:hit.knowledge_title || hit.title || hit.file_name || '相关资料',content:hit.content || original.content || '',
        refs:list(original.refs).length ? original.refs : hit.knowledge_id ? [{knowledge_id:hit.knowledge_id,knowledge_base_id:hit.knowledge_base_id,chunk_ids:[id],quote:hit.content || '',provenance_status:hit.content?'verified':'unverified_source'}] : []});
    }
    const relatedEvidence=Array.from(related.values());
    const rawEdges = list(view && view.edges);
    const edges = rawEdges.filter(e => e && entityIds.has(str(e.source)) && entityIds.has(str(e.target))).map((e,i) => {
      let refs=list(e.source_refs_v2).slice();
      // Older graph_data has only per-relation chunk ids. Resolve those exact
      // chunks and check bindings; never borrow the rest of the query evidence.
      if(!refs.length && e.knowledge_id) refs=list(e.chunk_ids).filter(Boolean).map(cid=>{
        const hit=evidence.get(str(cid));
        const matches=hit && (!hit.knowledge_id || hit.knowledge_id===e.knowledge_id) && (!e.knowledge_base_id || !hit.knowledge_base_id || e.knowledge_base_id===hit.knowledge_base_id);
        const quote=matches ? str(hit.content) : '';
        return {knowledge_id:e.knowledge_id,knowledge_base_id:e.knowledge_base_id || (matches && hit.knowledge_base_id) || '',chunk_ids:[str(cid)],quote,provenance_status:quote?'verified':'unverified_source'};
      });
      return {...e,id:str(e.id || 'relation-' + i),source:str(e.source),target:str(e.target),label:str(e.label || e.type || '关系'),refs};
    });
    const droppedEdges = rawEdges.length - edges.length;
    if (droppedEdges) warnings.push(`${droppedEdges} 条关系缺少实体端点，未绘制。`);
    if (!nodes.length && warnings.length) return {status:'error',message:'查询未返回可展示图谱，且存在来源失败；不能认定为无结果。',nodes,edges,evidence:relatedEvidence,warnings,droppedEdges};
    return {status:nodes.length ? 'ready':'empty',message:nodes.length ? '' : '本次查询未命中实体或关系。可尝试其他实体名称或关键词。',nodes,edges,evidence:relatedEvidence,warnings,droppedEdges};
  }
  // Only entities belong on the graph canvas; query matches live outside it.
  function layoutGraph(nodes) {
    const sorted = nodes.slice().sort((a,b) => str(a.id).localeCompare(str(b.id),'en'));
    const positions = {};
    const entities=sorted.filter(n=>n.type!=='chunk');
    const radius=entities.length<=1 ? 0 : Math.max(170,entities.length*17);
    entities.forEach((n,i) => {
      const angle=i/entities.length*Math.PI*2-Math.PI/2;
      positions[n.id]={x:450+Math.cos(angle)*radius,y:220+Math.sin(angle)*radius};
    });
    return positions;
  }
  // 与原生前端一致的页面类型配色：节点颜色即原生 Wiki 图谱的类型语义。
  const WIKI_TYPE_COLORS={summary:'#0052d9',entity:'#2ba471',concept:'#e37318',synthesis:'#0594fa',comparison:'#d54941'};
  const WIKI_TYPE_LABELS={summary:'摘要',entity:'实体',concept:'概念',synthesis:'综合',comparison:'对比',index:'索引'};
  function wikiTypeColor(type) {return WIKI_TYPE_COLORS[str(type)] || '#8c8c8c';}
  function wikiTypeLabel(type) {return WIKI_TYPE_LABELS[str(type)] || str(type) || '页面';}
  function createGraphState(deps) {
    const state={kbId:'',query:'',mode:'entity',reqSeq:0,busy:false,value:null};
    const notify=()=> { if(deps.changed) deps.changed(state); };
    function clear() { state.reqSeq++; state.busy=false; state.value=null; notify(); }
    state.select=id=> { if(state.kbId!==id) {state.kbId=id;clear();} };
    state.setQuery=query=> {if(state.query!==query) {state.query=query;clear();} };
    state.setMode=mode=>{if(state.mode!==mode){state.mode=mode;state.query='';clear();}};
    state.reset=()=> {state.kbId='';state.query='';state.mode='entity';clear();};
    state.search=async()=> {
      if(!state.kbId || (state.mode==='entity'&&!state.query.trim())) return;
      const seq=++state.reqSeq, epoch=deps.captureEpoch(), kb=state.kbId, query=state.query.trim();
      state.busy=true;state.value=null;notify();
      const current=()=>seq===state.reqSeq && kb===state.kbId && deps.isCurrentEpoch(epoch);
      try {
        const response=state.mode==='wiki' ? await deps.call('wiki_workspace',{action:'graph',knowledge_base_id:kb,...(query?{center:query}:{}),depth:1,limit:200},[kb]) : await deps.call('search_knowledge',{query,sources:['graph'],knowledge_base_ids:[kb]},[kb]);
        if(!current() || response.stale) return;
        state.value=response.ok ? (state.mode==='wiki'?parseWikiGraph(response.result):parseGraph(response.result)) : {status:failureStatus(message(response.error)),message:message(response.error),nodes:[],edges:[],warnings:[]};
      } catch(error) {
        if(current()) state.value={status:'error',message:message(error),nodes:[],edges:[],warnings:[]};
      } finally {if(current()) {state.busy=false;notify();} }
    };
    return state;
  }
  // 图谱入口常从概览页等未选库上下文跳入：目标库未启用所需能力时，
  // 回退到首个支持的库，避免落进按钮禁用的死胡同；没有可用库时维持原选择，
  // 让既有门槛提示向用户解释原因。
  function pickCapableKb(kbs, kbId, preferred, capability) {
    const wanted = str(kbId);
    const requested = list(kbs).find(k => str(k.id) === wanted);
    if (requested && capability(requested, preferred)) return { kbId: wanted, switched: false };
    const fallback = list(kbs).find(k => capability(k, preferred));
    if (!fallback) return { kbId: wanted, switched: false };
    return { kbId: str(fallback.id), switched: !!wanted };
  }
  if(typeof module!=='undefined' && module.exports) module.exports={parseGraph,parseWikiGraph,layoutGraph,createGraphState,pickCapableKb};
  if(!root || !root.document) return;
  const {S,captureIdentityEpoch,isCurrentIdentityEpoch}=root.App;
  let section=null, mounted=false, selected=null, zoom=1, pan={x:0,y:0}, pending=null;
  const state=createGraphState({call:(...args)=>root.Explorer.call(...args),captureEpoch:captureIdentityEpoch,isCurrentEpoch:isCurrentIdentityEpoch,changed:()=>{selected=null;zoom=1;pan={x:0,y:0};if(mounted) render();}});
  const el=(tag,cls,text)=> {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  const $=selector=>section.querySelector(selector);
  function mount(target) {
    section=target; section.innerHTML=`<div class="graph-intro"><div class="eyebrow">KNOWLEDGE GRAPH</div><h2 class="graph-heading">从实体发现知识之间的联系</h2><p class="graph-description">输入实体或关键词，探索查询命中的局部关系图。这里不代表知识库全量拓扑。</p></div>
      <form class="graph-query card"><label class="field"><span>图谱类型</span><select class="input graph-mode" aria-label="图谱类型"><option value="entity">实体关系图</option><option value="wiki">Wiki 页面链接图</option></select></label><label class="field"><span>图谱知识库</span><select class="input graph-kb" aria-label="图谱知识库"></select></label><label class="field graph-query-field"><span class="graph-query-label">实体或关键词</span><input class="input graph-input" maxlength="1000" placeholder="输入人物、组织、概念或关键词" aria-label="图谱查询"></label><button class="btn graph-submit" type="submit">探索关系</button></form>
      <div class="graph-status" role="status" aria-live="polite"></div><div class="graph-results"></div>`;
    mounted=true;
    $('.graph-query').onsubmit=e=>{e.preventDefault();state.search();};
    $('.graph-kb').onchange=e=>{state.select(e.target.value);};
    $('.graph-input').oninput=e=>state.setQuery(e.target.value);
    $('.graph-mode').onchange=e=>{state.setMode(e.target.value==='wiki'?'wiki':'entity');selectionChanged();};
  }
  function hasWorkspace() {return (S.tools || []).some(tool=>tool.name==='wiki_workspace');}
  function available() { const kb=S.kbs.find(k=>str(k.id)===state.kbId); return kb && (state.mode!=='wiki'||hasWorkspace()) && root.Explorer.capability(kb,state.mode==='wiki'?'wiki':'graph'); }
  function render() {
    const input=$('.graph-input'); if(input.value!==state.query)input.value=state.query;
    $('.graph-mode').value=state.mode;
    $('.graph-heading').textContent=state.mode==='wiki'?'沿页面链接浏览知识':'从实体发现知识之间的联系';
    $('.graph-description').textContent=state.mode==='wiki'?'查看原生 Wiki 页面之间的正文链接；可进入源页面编辑内容，维护关联。':'输入实体或关键词，探索查询命中的局部关系图。这里不代表知识库全量拓扑。';
    $('.graph-query-label').textContent=state.mode==='wiki'?'中心页面 Slug（可留空）':'实体或关键词';
    input.placeholder=state.mode==='wiki'?'留空查看概览，或输入 entity/xxx 查看邻接页':'输入人物、组织、概念或关键词';
    const enabled=available(); $('.graph-submit').disabled=state.busy || !enabled || (state.mode==='entity'&&!state.query.trim());
    const status=$('.graph-status'), results=$('.graph-results'); results.replaceChildren();
    status.className='graph-status';
    if(state.busy) {status.textContent='正在查询实体与关系…';return;}
    if(!state.kbId) {status.textContent=S.kbs.length ? '选择一个支持图谱的知识库以开始探索。' : '请先连接身份并加载可见知识库。';return;}
    if(state.mode==='wiki'&&!hasWorkspace()) {status.textContent='当前端点未提供 wiki_workspace，无法读取 Wiki 页面链接图；可继续使用实体关系图。';return;}
    if(!enabled) {status.textContent=state.mode==='wiki'?'所选知识库未配置 Wiki 能力。':'所选知识库未配置图谱能力。';return;}
    const value=state.value;
    if(!value) {status.textContent=state.mode==='wiki'?'查看原生 Wiki 页面链接图；链接来自正文中的 [[页面slug|标题]]，编辑源页面即可维护链接。':'输入关键词后探索实体关系，点击实体或关系核对来源。';return;}
    if(value.status!=='ready') {status.textContent=(value.status==='unconfigured'?'图谱尚未配置或当前不可用：':value.status==='error'?'图谱查询失败：':'')+value.message; if(value.status==='error')status.classList.add('graph-error');}
    else status.textContent=state.mode==='wiki'?`Wiki 页面链接图 · ${value.nodes.length} 个页面 · ${value.edges.length} 条链接`:`局部查询图 · ${value.nodes.length} 个实体 · ${value.edges.length} 条关系`;
    value.warnings.forEach(w=>results.appendChild(el('div','graph-warning',w)));
    if(value.status!=='ready') {renderRelated(results,value.evidence);return;}
    const grid=el('div','graph-grid'), canvas=el('div','graph-canvas card'), details=el('aside','graph-details card');
    const toolbar=el('div','graph-toolbar');
    if(state.mode==='wiki') {
      const legend=el('span','graph-legend');
      Array.from(new Set(value.nodes.map(n=>str(n.type)))).forEach(t=>{const chip=el('span','graph-legend-item',`● ${wikiTypeLabel(t)}`);chip.setAttribute('style',`color:${wikiTypeColor(t)}`);legend.appendChild(chip);});
      legend.appendChild(el('span','graph-legend-item','→ 正文链接'));
      toolbar.appendChild(legend);
    } else toolbar.appendChild(el('span','graph-legend','● 实体　→ 关系'));
    [['−',()=>setZoom(zoom/1.25),'缩小'],['＋',()=>setZoom(zoom*1.25),'放大'],['重置视图',()=>{zoom=1;pan={x:0,y:0};transform();},'重置视图']].forEach(([text,fn,label])=>{const b=el('button','btn ghost small',text);b.type='button';b.setAttribute('aria-label',label);b.onclick=fn;toolbar.appendChild(b);});
    canvas.appendChild(toolbar);grid.append(canvas,details);results.appendChild(grid);
    const ns='http://www.w3.org/2000/svg', svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 900 540');svg.classList.add('graph-svg');svg.setAttribute('aria-label','查询命中的局部关系图');
    const defs=document.createElementNS(ns,'defs'),marker=document.createElementNS(ns,'marker'),arrow=document.createElementNS(ns,'path');
    marker.setAttribute('id','graph-direction');marker.setAttribute('viewBox','0 0 10 10');marker.setAttribute('refX','9');marker.setAttribute('refY','5');marker.setAttribute('markerWidth','6');marker.setAttribute('markerHeight','6');marker.setAttribute('orient','auto');
    arrow.setAttribute('d','M 0 0 L 10 5 L 0 10 Z');arrow.setAttribute('class','graph-arrow');marker.appendChild(arrow);defs.appendChild(marker);svg.appendChild(defs);
    const layer=document.createElementNS(ns,'g');layer.classList.add('graph-layer');svg.appendChild(layer);canvas.appendChild(svg);
    const pos=layoutGraph(value.nodes), labelById=new Map(value.nodes.map(n=>[n.id,n.label]));
    // Include all returned nodes, even when a backend query exceeds the first ring.
    const coordinates=Object.values(pos);
    const minX=Math.min(...coordinates.map(p=>p.x)),maxX=Math.max(...coordinates.map(p=>p.x));
    const minY=Math.min(...coordinates.map(p=>p.y)),maxY=Math.max(...coordinates.map(p=>p.y));
    const width=Math.max(420,maxX-minX+180),height=Math.max(360,maxY-minY+150);
    const left=(minX+maxX-width)/2,top=(minY+maxY-height)/2;
    svg.setAttribute('viewBox',`${left} ${top} ${width} ${height}`);
    function shape(tag,attrs,parent=layer) {const node=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,v));parent.appendChild(node);return node;}
    function interactive(group,kind,item,label) {group.setAttribute('tabindex','0');group.setAttribute('role','button');group.setAttribute('aria-label',label);const choose=()=>{selected={kind,item};layer.querySelectorAll('.graph-selected').forEach(n=>n.classList.remove('graph-selected'));group.classList.add('graph-selected');detail(details,value,labelById);};group.onclick=choose;group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};}
    value.edges.forEach((edge,i)=> {
      const a=pos[edge.source],b=pos[edge.target],g=shape('g',{class:'graph-edge'});
      const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1, offset=((i%3)-1)*18;
      const mx=(a.x+b.x)/2-dy/length*offset, my=(a.y+b.y)/2+dx/length*offset;
      const endLength=Math.hypot(b.x-mx,b.y-my)||1;
      const path=edge.source===edge.target ? `M ${a.x-18} ${a.y-14} C ${a.x-90} ${a.y-100},${a.x+90} ${a.y-100},${a.x+18} ${a.y-14}` : `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x-(b.x-mx)/endLength*26} ${b.y-(b.y-my)/endLength*26}`;
      shape('path',{d:path,class:'graph-edge-hit'},g);shape('path',{d:path,class:'graph-edge-line','marker-end':'url(#graph-direction)'},g);
      const t=shape('text',{x:mx,y:edge.source===edge.target?a.y-65:my-6,'text-anchor':'middle',class:'graph-edge-label'},g);t.textContent=edge.label;
      interactive(g,'edge',edge,`${labelById.get(edge.source)} → ${edge.label} → ${labelById.get(edge.target)}`);
    });
    value.nodes.forEach(node=>{const p=pos[node.id],g=shape('g',{class:'graph-node',transform:`translate(${p.x},${p.y})`});
      const circleAttrs={r:21};
      if(value.wiki)circleAttrs.style=`fill:${wikiTypeColor(node.type)}`;
      shape('circle',circleAttrs,g);
      const title=shape('title',{},g);title.textContent=node.label;
      const label=shape('text',{y:39,'text-anchor':'middle'},g);label.textContent=node.label.length>20?node.label.slice(0,20)+'…':node.label;
      interactive(g,'node',node,(value.wiki?'页面：':'实体：')+node.label);
    });
    let drag=null;
    svg.onpointerdown=e=>{if(e.target.closest('.graph-node,.graph-edge'))return;drag={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};svg.setPointerCapture(e.pointerId);};
    svg.onpointermove=e=>{if(!drag)return;const scale=width/svg.getBoundingClientRect().width;pan={x:drag.px+(e.clientX-drag.x)*scale,y:drag.py+(e.clientY-drag.y)*scale};transform();};
    svg.onpointerup=svg.onpointercancel=()=>{drag=null;};
    detail(details,value,labelById);
    const relations=el('div','graph-relations card');relations.appendChild(el('h3','','关系列表'));
    if(!value.edges.length)relations.appendChild(el('p','graph-help','本次返回实体，没有可展示的实体关系。'));
    value.edges.forEach(edge=>{const b=el('button','graph-relation',`${labelById.get(edge.source)} → ${edge.label} → ${labelById.get(edge.target)}`);b.type='button';b.onclick=()=>{selected={kind:'edge',item:edge};detail(details,value,labelById);};relations.appendChild(b);});results.appendChild(relations);
    renderRelated(results,value.evidence);
  }
  function renderRelated(container,evidence) {
    if(!list(evidence).length)return;
    const related=el('details','graph-related card');
    related.appendChild(el('summary','',`相关资料 · ${evidence.length} 段`));
    related.appendChild(el('p','graph-help','本次查询命中的原文片段，供补充阅读；不一定支持图中的某条关系。关系依据请点击对应关系查看。'));
    const body=el('div','graph-related-list');
    evidence.forEach((item,i)=>{
      const row=el('article','graph-related-item');
      row.appendChild(el('h4','',`${item.label || '相关资料'} · 片段 ${i+1}`));
      if(list(item.refs).length) {const refs=el('div','graph-sources');row.appendChild(refs);root.Explorer.renderSources(refs,item.refs,state.kbId);}
      else row.appendChild(el('p','graph-content',item.content || '未提供可阅读片段及来源。'));
      body.appendChild(row);
    });
    related.appendChild(body);container.appendChild(related);
  }
  function detail(container,value,labels) {
    container.replaceChildren();
    if(!selected) {container.append(el('h3','','选择节点或关系'),el('p','graph-help','点击图中的节点、关系或下方关系列表，查看详情与来源。拖动画布可平移。'));return;}
    const {kind,item}=selected; container.appendChild(el('div','eyebrow',kind==='edge'?'关系详情':'实体详情'));
    container.appendChild(el('h3','',kind==='edge'?`${labels.get(item.source)} → ${item.label} → ${labels.get(item.target)}`:item.label));
    if(value.wiki) {
      const slug=kind==='edge'?item.source:item.slug;
      container.appendChild(el('p','graph-help',kind==='edge'?'该连线表示源 Wiki 页正文链接到目标页。可阅读并编辑源页面中的 [[slug|标题]] 来维护链接。':'该节点代表一篇 Wiki 页面，可进入页面阅读、编辑或查看历史。'));
      const button=el('button','btn ghost small',kind==='edge'?'阅读并管理源页面':'阅读并管理 Wiki 页面');button.type='button';button.onclick=()=>root.KnowledgeViews.wiki.openPage(state.kbId,slug);container.appendChild(button);
      const neighbours=el('button','btn ghost small','查看邻接页面');neighbours.type='button';neighbours.onclick=()=>{state.setQuery(slug);state.search();};container.appendChild(neighbours);
      return;
    }
    if(item.content)container.appendChild(el('p','graph-content',item.content));
    if(kind==='node') {
      const connected=value.edges.filter(e=>e.source===item.id || e.target===item.id);
      container.appendChild(el('p','graph-help',`当前局部图中关联 ${connected.length} 条关系。`));
      connected.forEach(edge=>{const b=el('button','graph-relation',`${labels.get(edge.source)} → ${edge.label} → ${labels.get(edge.target)}`);b.type='button';b.onclick=()=>{selected={kind:'edge',item:edge};detail(container,value,labels);};container.appendChild(b);});
    }
    if(item.quote)container.appendChild(el('blockquote','graph-content',str(item.quote)));
    container.appendChild(el('h4','graph-source-heading','来源核对'));
    if(item.refs.length) {const refs=el('div','graph-sources');container.appendChild(refs);root.Explorer.renderSources(refs,item.refs,state.kbId);}
    else container.appendChild(el('p','graph-help',kind==='edge'?'这条关系未返回独立来源，无法核对。':'该实体未返回直接来源，可选择关联关系核对其独立证据。'));
  }
  function transform() {const layer=$('.graph-layer');if(layer)layer.setAttribute('transform',`translate(${pan.x} ${pan.y}) translate(450 270) scale(${zoom}) translate(-450 -270)`);}
  function setZoom(value) {zoom=Math.max(.25,Math.min(4,value));transform();}
  function selectionChanged() {
    if(!mounted)return;
    const preferred=state.mode==='wiki'?'wiki':'graph';
    const pick=pickCapableKb(S.kbs,state.kbId,preferred,root.Explorer.capability);
    const next=root.Explorer.fillKbSelect($('.graph-kb'),pick.kbId,preferred); state.select(next);render();
  }
  function consumePending() {
    if(!pending || !mounted)return;
    const request=pending;pending=null;
    state.setMode(request.mode || 'entity');
    const preferred=state.mode==='wiki'?'wiki':'graph';
    const pick=pickCapableKb(S.kbs,request.kbId,preferred,root.Explorer.capability);
    if(pick.switched) {
      const from=(list(S.kbs).find(k=>str(k.id)===str(request.kbId))||{}).name || '当前知识库';
      const to=(list(S.kbs).find(k=>str(k.id)===pick.kbId)||{}).name || '';
      if(root.App.toast)root.App.toast(`「${from}」未启用${state.mode==='wiki'?' Wiki':'图谱抽取'}，已切换到「${to}」。`);
    }
    state.select(pick.kbId);root.Explorer.fillKbSelect($('.graph-kb'),pick.kbId,preferred);
    $('.graph-kb').value=pick.kbId;state.setQuery(request.query);render();
    if(available() && (state.mode==='wiki'||request.query.trim()))state.search();
  }
  root.KnowledgeViews=root.KnowledgeViews || {};
  root.KnowledgeViews.graph={show(target){if(!mounted || section!==target)mount(target);selectionChanged();consumePending();},reset(){
      const previous=section;
      // Unmount before reset notifies: the router may already have emptied the
      // old section, and repeated identity resets must not inspect its DOM.
      mounted=false;section=null;pending=null;state.reset();
      if(previous)previous.replaceChildren();
    },selectionChanged,
    explore(kbId,query){pending={kbId:str(kbId),query:str(query),mode:'entity'};if(root.location.hash==='#/graph')consumePending();else root.location.hash='#/graph';},
    openWikiGraph(kbId,slug){pending={kbId:str(kbId),query:str(slug),mode:'wiki'};if(root.location.hash==='#/graph')consumePending();else root.location.hash='#/graph';}};
})(typeof window==='undefined'?null:window);
