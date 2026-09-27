/* ================= INTERFACE ================= */
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let TAB='gabinete',MODE='rel',world=null,FEATURES=[],HOVER=null,SAMPLE=null,AI_OK=false,AI_BUSY=0,DRAFT=null,CONFIRM=null;
const CHAT={min:'fazenda',turns:[],cit:null,cturns:[]};
const SAVE_KEY='mandato-presidencial-v3';
const TABS=[['gabinete','Gabinete'],['economia','Economia'],['comercio','Comércio'],['precos','Preços'],['leis','Leis'],['mundo','Mundo'],['defesa','Defesa'],['povo','Povo']];
const LADO_N={esq:'esquerda',ctr:'centro',dir:'direita'};

/* ---------- formatação ---------- */
const f1=v=>fmtN(v,1),f2=v=>fmtN(v,2),f0=v=>fmtN(v,0);
const sg=(v,d=1)=>(v>0?'+':v<0?'−':'')+fmtN(Math.abs(v),d);
function toast(t){const el=$('#toast');el.textContent=t;el.hidden=false;clearTimeout(toast.h);toast.h=setTimeout(()=>el.hidden=true,3200)}
function spark(arr,col,opts={}){
  const a=(arr||[]).slice(-(opts.n||13));if(a.length<2)return `<svg viewBox="0 0 100 30"></svg>`;
  let mn=Math.min(...a),mx=Math.max(...a);if(mx-mn<1e-6){mx+=1;mn-=1}
  const X=i=>2+i*(96/(a.length-1)),Y=v=>27-(v-mn)/(mx-mn)*23;
  const pts=a.map((v,i)=>X(i).toFixed(1)+','+Y(v).toFixed(1)).join(' ');
  return `<svg viewBox="0 0 100 30" preserveAspectRatio="none"><polygon points="2,29 ${pts} 98,29" fill="${col}" fill-opacity=".12"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/><circle cx="${X(a.length-1)}" cy="${Y(a[a.length-1])}" r="2.2" fill="${col}"/></svg>`;
}
function avatar(a){const hue=(a.id*47)%360;const ini=a.nome.split(' ').map(x=>x[0]).slice(0,2).join('');return `<div class="av" style="background:hsl(${hue} 32% 64%)">${esc(ini)}</div>`}
function satLbl(s){return s>=60?['aprova','good']:s>=40?['regular','warn']:['reprova','bad']}
function ideoLbl(v){return v<-.35?'esquerda':v>.35?'direita':'centro'}
const pill=(t,c='')=>`<span class="pill ${c}">${t}</span>`;
function relCol(r){const t=(r+100)/200;const a=[184,65,47],b=[52,72,78],c=[63,156,110];const m=t<.5?a.map((x,i)=>x+(b[i]-x)*t*2):b.map((x,i)=>x+(c[i]-x)*(t-.5)*2);return `rgb(${m.map(Math.round).join(',')})`}

/* ---------- topo ---------- */
function renderTop(){
  {const d=dateLbl(S.m);$('#dateLbl').textContent=d.charAt(0).toUpperCase()+d.slice(1)}
  const nx=ELECTIONS.find(x=>x>=S.m);
  $('#electLbl').textContent=nx!=null?(nx===S.m?'Eleição neste mês':`Eleição em ${nx-S.m} ${nx-S.m===1?'mês':'meses'}`):'Fim do mandato';
  $('#presName').textContent=`${S.pres.nome} · governo de ${LADO_N[S.pres.lado]}`;
  const h=S.hist,e=S.e,prev=k=>h[k]&&h[k].length>1?h[k][h[k].length-2]:null;
  const K=[['PIB','cresc',f1(e.cresc)+'%',1],['IPCA','ipca',f1(e.ipca)+'%',-1],['Desemprego','desemp',f1(e.desemp)+'%',-1],['Selic','selic',f2(e.selic)+'%',0],['Dólar','cambio','R$ '+f2(e.cambio),-1],['Dívida/PIB','divida',f1(e.divida)+'%',-1],['Aprovação','ap',f0(S.ap.bom)+'%',1],['Base','base',baseSeats()+'/513',1]];
  $('#kpis').innerHTML=K.map(([l,k,v,good])=>{
    const cur=k==='ap'?S.ap.bom:k==='base'?baseSeats():e[k];const p=prev(k);let d='';
    if(p!=null){const dd=cur-p;const th=k==='base'?1:k==='cambio'?.01:.05;if(Math.abs(dd)>=th){const cls=good===0?'flat':(dd*good>0?'up':'dn');d=`<span class="d ${cls}">${dd>0?'▲':'▼'} ${k==='base'?Math.abs(Math.round(dd)):fmtN(Math.abs(dd),k==='cambio'?2:1)}</span>`}else d='<span class="d flat">—</span>'}
    return `<div class="kpi"><span class="l">${l}</span><span class="v">${v}</span>${d}</div>`}).join('');
  $('#tabs').innerHTML=TABS.map(([k,n])=>`<button role="tab" data-tab="${k}" aria-selected="${k===TAB}">${n}${k==='gabinete'&&S.events.length?'<i class="dot"></i>':''}${k==='defesa'&&S.wars.length?'<i class="dot"></i>':''}</button>`).join('');
}

/* ---------- abas ---------- */
function render(){renderTop();renderTab();renderTicker()}
function renderTab(){
  const b=$('#body');const st=b.scrollTop;
  b.innerHTML=({gabinete:tGabinete,economia:tEconomia,comercio:tComercio,precos:tPrecos,leis:tLeis,mundo:tMundo,defesa:tDefesa,povo:tPovo})[TAB]();
  b.scrollTop=st;
  const ch=$('#chatBox');if(ch)ch.scrollTop=ch.scrollHeight;
}
function aiChip(){return `<span class="ai ${AI_BUSY?'busy':AI_OK&&S.aiOn?'on':''}"><i></i>${AI_BUSY?'IA escrevendo…':AI_OK?(S.aiOn?'IA ativa':'IA desligada'):'IA indisponível'}</span>`}

function tGabinete(){
  const e=S.e;
  const ev=S.events.map((x,i)=>`<div class="box row" style="border-color:var(--gold-d)"><div class="sp"><b>${esc(evTitle(x))}</b><div class="small muted">Aguarda sua decisão</div></div><button class="btn gold" data-act="openEvent" data-arg="${i}">Decidir</button></div>`).join('');
  const stat=(l,v,k,col)=>`<div class="stat"><span class="l">${l}</span><span class="v">${v}</span>${spark(S.hist[k],col)}</div>`;
  const F=S.feed;
  let feed='<p class="muted small">O primeiro noticiário sai quando você encerrar o mês.</p>';
  if(F){
    feed=(F.news||[]).map(n=>`<div class="news ${n.tom}"><small>${esc(n.v)}</small><p>${esc(n.t)}</p></div>`).join('')+
      (F.clima?`<p class="small muted" style="font-style:italic">${esc(F.clima)}</p>`:'')+
      (F.posts||[]).map(p=>{const a=A[p.id];if(!a)return '';return `<div class="post">${avatar(a)}<div><div class="who"><b>${esc(a.nome)}</b> · ${a.idade} anos · ${esc(a.cid)}</div><p>${esc(p.txt)}</p><div class="meta">${esc(a.ocup)} · ${f0(p.likes||0)} curtidas</div></div></div>`}).join('');
  }
  const logs=(S.log||[]).length?`<ul class="small" style="margin:0;padding-left:18px">${S.log.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>`:'<p class="small muted">Nenhuma decisão ainda. Mudanças em impostos, gastos, tarifas e preços valem quando você encerrar o mês.</p>';
  const mins={fazenda:'Fazenda',casa:'Casa Civil',itamaraty:'Relações Exteriores',defesa:'Defesa',social:'Desenvolvimento Social'};
  return `
  <section class="sec"><h2>Gabinete da Presidência</h2>
    <p class="muted">${S.m===0?'Primeiro dia de governo. A economia vem de juros altos e dívida em alta; o Congresso é fragmentado e o Centrão decide votações.':esc((S.summary||[]).join(' ')||'Mês sem grandes mudanças nos indicadores.')}</p></section>
  ${ev?`<section class="sec"><h3>Decisões pendentes</h3>${ev}</section>`:''}
  <section class="sec"><h3>Indicadores <em>últimos 12 meses</em></h3>
   <div class="grid3">${stat('PIB (% a.a.)',f1(e.cresc),'cresc','#E2B54E')}${stat('IPCA 12m',f1(e.ipca)+'%','ipca','#E36C55')}${stat('Desemprego',f1(e.desemp)+'%','desemp','#6FAFD0')}
   ${stat('Primário',sg(e.primario)+'% PIB','primario','#63BA8C')}${stat('Pobreza',f1(e.pobreza)+'%','pobreza','#D98B6A')}${stat('Criminalidade',f0(e.crime),'crime','#A99A74')}
   ${stat('Confiança emp.',f0(e.conf),'conf','#E2B54E')}${stat('Credibilidade',f0(e.cred),'cred','#6FAFD0')}${stat('Exportações','US$ '+f0(e.expUS)+' bi','expIdx','#63BA8C')}</div></section>
  <section class="sec"><h3>Decisões deste mês</h3>${logs}</section>
  <section class="sec"><h3>Imprensa e redes <span class="row" style="gap:8px">${aiChip()}${AI_OK?`<button class="btn" style="padding:2px 8px;font-size:11.5px" data-act="aiToggle">${S.aiOn?'Desligar':'Ligar'}</button>`:''}</span></h3><div class="feed">${feed}</div></section>
  <section class="sec"><h3>Conselho de ministros ${aiChip()}</h3>
    <div class="row"><label for="minSel" class="small muted">Falar com</label><select id="minSel" data-act-change="minSel">${Object.entries(mins).map(([k,n])=>`<option value="${k}" ${CHAT.min===k?'selected':''}>${n}</option>`).join('')}</select></div>
    <div class="chat" id="chatBox">${CHAT.turns.length?CHAT.turns.map(t=>`<div class="msg ${t.role==='user'?'me':'them'}">${esc(t.content)}</div>`).join(''):'<div class="msg sys">Pergunte o que fazer com a inflação, como aprovar uma lei ou como reagir a uma crise.</div>'}</div>
    <form class="row" data-form="minAsk"><input type="text" id="minQ" placeholder="Ex.: como baixo a inflação sem derrubar o emprego?" autocomplete="off"><button class="btn gold" type="submit">Perguntar</button></form>
  </section>`;
}

function tEconomia(){
  const F=calcFiscal();const p=S.pol,e=S.e;
  const sl=(id,lbl,val,min,max,step,out,hint)=>`<div class="sl"><label for="${id}">${lbl}</label><output id="o_${id}">${out}</output><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" data-bind="${id}">${hint?`<span class="hint">${hint}</span>`:''}</div>`;
  const rows=(o)=>Object.entries(o).filter(([k,v])=>Math.abs(v)>.004).map(([k,v])=>`<tr><td>${k}</td><td class="r num">${f2(v)}%</td><td class="r num">R$ ${f0(v*e.pibReal*10)} bi</td></tr>`).join('');
  return `
  <section class="sec"><h2>Economia e orçamento</h2><p class="muted small">Valores em R$ de 2027. As mudanças entram em vigor quando você encerra o mês.</p></section>
  <section class="sec"><h3>Resultado das contas <em>% do PIB ao ano</em></h3>
    <div class="grid3"><div class="stat"><span class="l">Primário</span><span class="v ${F.primario>=0?'up':'dn'}">${sg(F.primario,2)}%</span></div><div class="stat"><span class="l">Juros da dívida</span><span class="v">${f2(F.juros)}%</span></div><div class="stat"><span class="l">Nominal</span><span class="v dn">${sg(F.nominal,2)}%</span></div></div>
    <details><summary class="small muted" style="cursor:pointer">Receitas e despesas detalhadas</summary><div class="tw"><table><tr><th>Receita</th><th class="r">% PIB</th><th class="r">R$</th></tr>${rows(F.rec)}<tr><th>Despesa</th><th></th><th></th></tr>${rows(F.disc)}${rows(F.desp)}</table></div></details>
  </section>
  <section class="sec"><h3>Juros</h3>
    ${S.flags.bcAut?`<div class="box"><div class="row"><div class="sp"><b>Banco Central autônomo</b><div class="small muted">O Copom define a Selic seguindo a meta de inflação de 3%. Selic atual: <span class="num">${f2(e.selic)}%</span>.</div></div></div><div class="btns" style="margin-top:8px"><button class="btn" data-act="pressBC">Criticar os juros em público</button><button class="btn" data-act="preset" data-arg="bc">Enviar lei que revoga a autonomia</button></div></div>`
    :sl('selic','Selic definida pelo governo',p.selic,2,30,.25,f2(p.selic)+'%','Juros baixos aceleram o PIB mas alimentam inflação e dólar.')}
  </section>
  <section class="sec"><h3>Impostos</h3>
    ${sl('irpf','IR pessoa física: alíquota máxima',p.tax.irpf,0,50,.5,f1(p.tax.irpf)+'%')}
    ${sl('isencao','IR: faixa de isenção',p.tax.isencao,2000,12000,500,'R$ '+f0(p.tax.isencao),'Quem ganha até esse valor por mês não paga IR.')}
    ${sl('irpj','IR das empresas + CSLL',p.tax.irpj,15,50,1,f0(p.tax.irpj)+'%')}
    ${sl('iva','Imposto sobre consumo (IVA)',p.tax.iva,15,35,.5,f1(p.tax.iva)+'%','Pesa mais para os pobres e sobe preços.')}
    ${sl('folha','Contribuição sobre a folha',p.tax.folha,5,30,1,f0(p.tax.folha)+'%','Mais alta, mais informalidade e desemprego.')}
  </section>
  <section class="sec"><h3>Gastos federais <em>R$ bi por ano</em></h3>
    ${GASTOS.map(g=>sl('g_'+g.k,g.n,p.g[g.k],g.min,g.max,g.max>200?5:1,'R$ '+f0(p.g[g.k])+' bi')).join('')}
  </section>
  <section class="sec"><h3>Salário mínimo</h3>
    ${sl('sm','Valor mensal',p.sm,Math.round(e.sm),Math.round(e.sm*1.35),10,'R$ '+f0(p.sm),'Não pode ser reduzido. Cada 1% real acima da inflação custa ~0,05% do PIB na Previdência.')}
  </section>`;
}

function tComercio(){
  const e=S.e,p=S.pol;
  const opt=(o,v)=>Object.entries(o).map(([k,n])=>`<option value="${k}" ${k===v?'selected':''}>${n}</option>`).join('');
  const partners=COUNTRIES.map(c=>({c,r:S.tradeRows?S.tradeRows[c.iso]:{x:c.x,m:c.m}})).sort((a,b)=>(b.c.x+b.c.m)-(a.c.x+a.c.m)).slice(0,16);
  const stN={normal:'Normal',acordo:'Livre comércio',sancao:'Sanções',embargo:'Embargo'};
  return `
  <section class="sec"><h2>Comércio exterior</h2><p class="muted small">Tarifas protegem a indústria e geram receita, mas encarecem produtos e provocam retaliação dos parceiros.</p></section>
  <div class="grid3"><div class="stat"><span class="l">Exportações</span><span class="v">US$ ${f0(e.expUS)} bi</span></div><div class="stat"><span class="l">Importações</span><span class="v">US$ ${f0(e.impUS)} bi</span></div><div class="stat"><span class="l">Saldo</span><span class="v ${e.expUS>e.impUS?'up':'dn'}">US$ ${sg(e.expUS-e.impUS,0)} bi</span></div></div>
  <section class="sec"><h3>Política por setor</h3><div class="tw"><table>
   <tr><th>Setor</th><th class="r">Pauta exp./imp.</th><th>Importação</th><th>Exportação</th></tr>
   ${SECT.map(s=>`<tr><td>${s.n}</td><td class="r num">${f0(s.exp*100)}% / ${f0(s.imp*100)}%</td><td><select id="imp_${s.k}" data-bind="imp_${s.k}" aria-label="Importação de ${s.n}">${opt(TARIFF_N,p.imp[s.k])}</select></td><td><select id="exp_${s.k}" data-bind="exp_${s.k}" aria-label="Exportação de ${s.n}">${opt(EXPPOL_N,p.exp[s.k])}</select></td></tr>`).join('')}
  </table></div></section>
  <section class="sec"><h3>Parceiros <em>US$ bi/ano, estimado</em></h3><div class="tw"><table>
   <tr><th>País</th><th class="r">Vendemos</th><th class="r">Compramos</th><th>Situação</th></tr>
   ${partners.map(({c,r})=>{const st=S.c[c.iso];return `<tr class="click" data-act="selC" data-arg="${c.iso}"><td>${c.n}${st.retal>.4?' '+pill('retaliando','bad'):''}${st.sancBR>.4?' '+pill('nos sanciona','bad'):''}</td><td class="r num">${f1(r.x)}</td><td class="r num">${f1(r.m)}</td><td>${pill(stN[st.st],st.st==='acordo'?'gold':st.st==='normal'?'':'bad')}</td></tr>`}).join('')}
  </table></div><p class="small muted">Clique num país para negociar acordos ou aplicar sanções.</p></section>`;
}

function tPrecos(){
  const modes={livre:'Preço livre',teto:'Tabelar (limitar reajuste)',congelado:'Congelar',subsidio:'Subsidiar com o Tesouro'};
  return `
  <section class="sec"><h2>Controle de preços</h2><p class="muted small">Congelar segura a inflação no curto prazo, mas a diferença fica represada: produtores deixam de vender e começa a faltar produto. Subsidiar evita a falta, mas custa caro. Ao liberar, o preço represado aparece de uma vez.</p></section>
  <div class="grid3"><div class="stat"><span class="l">IPCA 12 meses</span><span class="v">${f1(S.e.ipca)}%</span></div><div class="stat"><span class="l">Desabastecimento</span><span class="v ${S.e.shortIdx>20?'dn':''}">${f0(S.e.shortIdx)}/100</span></div><div class="stat"><span class="l">Custo de subsídios</span><span class="v">${f2(S.e.subsid)}% PIB</span></div></div>
  ${PRECOS.map(p=>{const st=S.precos[p.k];const m=S.pol.precos[p.k];return `<div class="box sec" style="gap:6px">
    <div class="row"><b class="sp">${p.n}</b><span class="small muted">peso no IPCA ${f1(p.w*100)}%</span></div>
    <div class="row small"><span class="muted">Pressão de alta:</span><span class="num">${f1(st.pi)}%</span><span class="muted">· repassado:</span><span class="num">${f1(st.eff)}%</span>${st.rep>.05?`<span class="muted">· represado:</span><span class="num" style="color:var(--warn)">${f1(st.rep)}%</span>`:''}</div>
    <div class="row"><select id="pr_${p.k}" data-bind="pr_${p.k}" aria-label="Regime de ${p.n}">${Object.entries(modes).map(([k,n])=>`<option value="${k}" ${k===m?'selected':''}>${n}</option>`).join('')}</select><span class="sp"></span><span class="small muted">Falta nas prateleiras</span><div class="bar" style="width:90px"><i style="width:${st.short}%;background:${st.short>40?'var(--bad)':'var(--warn)'}"></i></div></div>
  </div>`}).join('')}`;
}

function expVotes(l){let c=0;for(const b of BLOCOS_CN){c+=b.cam*clamp((blocSupport(l,b)-32)/38,.02,.98)}return Math.round(c)}
const FXL={receita:['Receita','% PIB',1],gasto:['Gasto','% PIB',-1],pot:['Crescimento potencial','pp',1],infl:['Inflação','pp',-1],desemp:['Desemprego','pp',-1],conf:['Confiança','',1],cred:['Credibilidade','',1],crime:['Crime','%',-1],desmat:['Desmatamento','%',-1],pobreza:['Pobreza','pp',-1],saude:['Saúde','',1],educ:['Educação','',1],corrup:['Corrupção','',-1],oneoff:['Receita única','% PIB',1],mil:['Poder militar','',1]};
function fxPills(l){
  const out=[];
  for(const k in (l.fx||{})){const v=l.fx[k];if(!v||!FXL[k])continue;const [n,u,g]=FXL[k];out.push(pill(`${n} ${sg(k==='mil'?v*100:v,Math.abs(v)<1?2:0)}${k==='mil'?'%':u?' '+u:''}`,v*g>0?'good':'bad'))}
  for(const k in (l.gr||{})){const v=l.gr[k];if(!v)continue;out.push(pill(`${GROUPS[k]} ${sg(v,0)}`,v>0?'good':'bad'))}
  for(const k in (l.rel||{})){const v=l.rel[k];if(!v)continue;out.push(pill(`${k==='UE'?'União Europeia':CBY[k]?.n||k} ${sg(v,0)}`,v>0?'good':'bad'))}
  return out.join(' ');
}
function tLeis(){
  const tot=513;
  const cn=BLOCOS_CN.map(b=>{const r=clamp(S.cn.rel[b.k]+S.cn.boost[b.k],0,100);return `<div class="hb"><span>${b.n} <span class="muted num">${b.cam}</span></span><div class="bar"><i style="width:${r}%;background:${b.col}"></i></div><span class="num small">${f0(r)}</span></div>`}).join('');
  const seats=BLOCOS_CN.map(b=>`<i style="width:${b.cam/tot*100}%;background:${b.col}" title="${b.n}"></i>`).join('');
  const draft=DRAFT?`<div class="decree">
      <div class="hd"><span>${DRAFT.custom?'Minuta da Casa Civil':'Minuta'}</span><span>${DRAFT.tipo==='PEC'?'Proposta de Emenda à Constituição':DRAFT.tipo==='PLP'?'Projeto de Lei Complementar':'Projeto de Lei'}</span></div>
      <h4>${esc(DRAFT.n)}</h4><p>${esc(DRAFT.txt)}</p>${DRAFT.parecer?`<p style="font-style:italic;font-size:13.5px">Parecer: ${esc(DRAFT.parecer)}</p>`:''}
      <div class="fx">${fxPills(DRAFT)}</div>
      <p style="font-family:var(--ui);font-size:12.5px">Votos estimados na Câmara: <b>${expVotes(DRAFT)}</b> de ${NEED[DRAFT.tipo][0]} necessários${DRAFT.const!=null?` · chance de o STF manter: <b>${f0(DRAFT.const)}%</b>`:''}</p>
      <div class="btns"><button class="btn" data-act="sendDraft">Enviar ao Congresso</button>${DRAFT.mpOk?`<button class="btn alt" data-act="sendDraftMP">Editar como Medida Provisória</button>`:''}<button class="btn alt" data-act="dropDraft">Descartar</button></div></div>`:'';
  const composer=AI_OK&&S.aiOn?`
      <textarea id="leiTxt" placeholder="Escreva a lei do seu jeito. Ex.: “Toda empresa com mais de 100 funcionários terá que distribuir 5% do lucro aos empregados.”"></textarea>
      <div class="row"><button class="btn gold" data-act="analisar" ${AI_BUSY?'disabled':''}>Analisar com a Casa Civil</button><span class="sp"></span>${aiChip()}</div>`
    :`<p class="small muted">Com a IA desligada, monte a lei por área e direção.</p>
      <input type="text" id="bNome" placeholder="Nome da lei">
      <div class="row" style="flex-wrap:wrap"><select id="bArea">${Object.keys(BUILDER).map(k=>`<option>${k}</option>`).join('')}</select><select id="bDir"><option value="1">Mais (aumentar / endurecer / proteger)</option><option value="-1">Menos (reduzir / flexibilizar)</option></select><select id="bInt"><option value="1">Leve</option><option value="2" selected>Moderada</option><option value="3">Radical</option></select></div>
      <button class="btn gold" data-act="build">Redigir minuta</button>`;
  const tram=S.leis.tram.map(l=>`<div class="law"><div class="row"><span class="n sp">${esc(l.n)}</span>${pill(l.tipo)}</div><div class="small muted">${lawStage(l)} · votação em ~${Math.max(1,Math.ceil(l.left/(l.urg?2:1)))} ${l.left>1?'meses':'mês'} · votos estimados: <span class="num">${expVotes(l)}</span>/${NEED[l.tipo][0]}</div>${!l.urg&&l.left>1&&!l.mp&&l.tipo!=='DL'?`<div><button class="btn" data-act="urg" data-arg="${l.uid}">Pedir urgência</button></div>`:''}</div>`).join('')||'<p class="small muted">Nenhum projeto em tramitação.</p>';
  const vig=S.leis.vigor.map(l=>`<div class="law"><div class="row"><span class="n sp">${esc(l.n)}</span>${l.mpPending?pill('MP','warn'):pill(f0((l.prog??1)*100)+'% implantada','gold')}</div>${l.fx?`<div class="fx">${fxPills({fx:l.fx})}</div>`:''}${l.mpPending||String(l.id).startsWith('estatal')?'':`<div><button class="btn" data-act="revogar" data-arg="${l.uid||l.id}">Propor revogação</button></div>`}</div>`).join('')||'<p class="small muted">Nenhuma lei nova aprovada no seu governo.</p>';
  const usedIds=new Set([...S.leis.vigor.map(l=>l.id),...S.leis.tram.map(l=>l.id)]);
  const pauta=LEIS.filter(l=>!usedIds.has(l.id)&&!(l.id==='bc'&&!S.flags.bcAut)&&!(l.id==='bc_on'&&S.flags.bcAut)&&!(l.id==='mercosul_ue'&&S.flags.ftaUE)).map(l=>`<div class="law"><div class="row"><span class="n sp">${esc(l.n)}</span>${pill(l.area)} ${pill(l.tipo)}</div><p class="small">${esc(l.txt)}</p><div class="fx">${fxPills(l)}</div><div class="row small"><span class="muted">Votos estimados: <span class="num">${expVotes(l)}</span>/${NEED[l.tipo][0]}</span><span class="sp"></span><button class="btn" data-act="preset" data-arg="${l.id}">Enviar</button>${l.tipo==='PL'?`<button class="btn" data-act="presetMP" data-arg="${l.id}">Como MP</button>`:''}</div></div>`).join('');
  const hist=S.leis.hist.slice(0,6).map(h=>`<tr><td>${esc(h.n)}</td><td class="num r">${h.cam}</td><td>${pill(h.ok?'aprovada':'rejeitada',h.ok?'good':'bad')}</td></tr>`).join('');
  return `
  <section class="sec"><h2>Leis e Congresso</h2><p class="muted small">PL precisa de ~241 votos, lei complementar de 257 e emenda constitucional de 308 deputados (e 3/5 do Senado). Medidas provisórias valem na hora, mas caem se o Congresso não aprovar em 4 meses.</p></section>
  <section class="sec"><h3>Câmara dos Deputados <em>base do governo: ~${baseSeats()} deputados</em></h3>
    <div class="stack">${seats}</div>${cn}
    <div class="btns"><button class="btn" data-act="emendas">Liberar emendas (R$ 10 bi)</button><button class="btn" data-act="ministerio">Ceder ministério ao Centrão</button><button class="btn" data-act="reuniao">Reunião com líderes</button></div>
    <p class="small muted">Ministérios cedidos: ${S.cn.minist}. Cada um aumenta o risco de escândalo.</p></section>
  <section class="sec"><h3>Nova lei</h3>${draft||composer}</section>
  <section class="sec"><h3>Em tramitação</h3>${tram}</section>
  <section class="sec"><h3>Pauta pronta <em>propostas que circulam no debate</em></h3>${pauta}</section>
  <section class="sec"><h3>Em vigor</h3>${vig}</section>
  ${hist?`<section class="sec"><h3>Votações recentes</h3><div class="tw"><table><tr><th>Projeto</th><th class="r">Sim</th><th></th></tr>${hist}</table></div></section>`:''}`;
}
const BUILDER={
  'Impostos sobre os mais ricos':(d,i)=>({ideo:-.5*d,fx:{receita:.15*d*i,conf:-2*d*i},gr:{ricos:-8*d*i,empresarios:-4*d*i,pobres:3*d*i}}),
  'Impostos sobre o consumo':(d,i)=>({ideo:.1*d,fx:{receita:.25*d*i,infl:.2*d*i},gr:{pobres:-6*d*i,classe_media:-5*d*i}}),
  'Programas sociais':(d,i)=>({ideo:-.6*d,fx:{gasto:.3*d*i,pobreza:-.8*d*i,cred:-3*d*i},gr:{pobres:8*d*i,ricos:-3*d*i}}),
  'Segurança e penas':(d,i)=>({ideo:.6*d,fx:{crime:-3*d*i,gasto:.05*d*i},gr:{militares:6*d*i,classe_media:3*d*i,jovens:-3*d*i}}),
  'Proteção ambiental':(d,i)=>({ideo:-.5*d,fx:{desmat:-12*d*i,pot:-.02*d*i},gr:{ambientalistas:8*d*i,agro:-7*d*i},rel:{UE:4*d*i}}),
  'Direitos trabalhistas':(d,i)=>({ideo:-.6*d,fx:{desemp:.08*d*i,conf:-3*d*i},gr:{trabalhadores:7*d*i,empresarios:-7*d*i}}),
  'Pautas de costumes (progressista)':(d,i)=>({ideo:-.7*d,area:'Costumes',fx:{},gr:{jovens:6*d*i,evangelicos:-9*d*i}}),
  'Estado na economia':(d,i)=>({ideo:-.6*d,fx:{conf:-4*d*i,pot:-.03*d*i},gr:{servidores:5*d*i,empresarios:-6*d*i}}),
  'Saúde e educação':(d,i)=>({ideo:-.3*d,fx:{gasto:.2*d*i,saude:3*d*i,educ:3*d*i},gr:{pobres:3*d*i,classe_media:2*d*i}}),
};

function tMundo(){
  const iso=S.selC;
  let card='';
  if(iso==='076'){
    card=`<div class="box sec"><h2>Brasil</h2><div class="row small" style="flex-wrap:wrap;gap:4px">${pill('Democracia presidencialista')} ${S.flags.mercosul?pill('Mercosul','gold'):''} ${S.flags.brics?pill('BRICS','gold'):''} ${pill('G20','gold')} ${S.flags.ocdeOn?pill('OCDE','gold'):''}</div>
    <div class="grid3"><div class="stat"><span class="l">PIB</span><span class="v">US$ ${f0(S.e.pibNom*1000/S.e.cambio)} bi</span></div><div class="stat"><span class="l">População</span><span class="v">213 mi</span></div><div class="stat"><span class="l">Defesa</span><span class="v">US$ ${f0(S.pol.g.defesa/S.e.cambio)} bi</span></div></div>
    <p class="small muted">Clique em outro país no globo para ver a relação e as opções diplomáticas.</p></div>`;
  }else if(CBY[iso]){
    const c=CBY[iso],st=S.c[iso],r=S.tradeRows?S.tradeRows[iso]:{x:c.x,m:c.m};const war=S.wars.find(w=>w.iso===iso);
    const inTr=S.leis.tram.find(l=>l.iso===iso&&l.tipo==='DL');
    card=`<div class="box sec"><div class="row"><h2 class="sp">${c.n}</h2>${war?pill('EM GUERRA','bad'):st.alianca?pill('aliado','gold'):''}</div>
      <div class="row small" style="flex-wrap:wrap;gap:4px">${pill(c.reg)} ${c.blocos.map(b=>pill(b)).join(' ')} ${c.nuc?pill('potência nuclear','warn'):''} ${c.viz?pill('fronteira com o Brasil'):''}</div>
      <div class="grid3"><div class="stat"><span class="l">PIB</span><span class="v">US$ ${f0(c.pib)} bi</span></div><div class="stat"><span class="l">População</span><span class="v">${f1(c.pop)} mi</span></div><div class="stat"><span class="l">Gasto militar</span><span class="v">US$ ${f1(c.mil)} bi</span></div></div>
      <div class="row small"><span class="muted">Relação com o Brasil</span><span class="sp"></span><b class="num" style="color:${relCol(st.rel)}">${sg(st.rel,0)}</b></div>
      <div class="bar" style="height:8px"><i style="left:50%;width:${Math.abs(st.rel)/2}%;${st.rel<0?`left:${50+st.rel/2}%;`:''}background:${relCol(st.rel)}"></i></div>
      <div class="row small"><span class="muted">Comércio: vendemos</span><b class="num">US$ ${f1(r.x)} bi</b><span class="muted">compramos</span><b class="num">US$ ${f1(r.m)} bi</b></div>
      <div class="row small"><span class="muted">Situação comercial:</span>${pill({normal:'normal',acordo:'livre comércio',sancao:'sanções',embargo:'embargo'}[st.st])}${st.retal>.4?pill('retaliando','bad'):''}${st.sancBR>.4?pill('sanciona o Brasil','bad'):''}</div>
      <h3 style="margin-top:6px">Ações</h3>
      <div class="btns">
        ${war?`<button class="btn gold" data-act="dip" data-arg="paz:${iso}">Propor paz</button>`:`
        <button class="btn" data-act="dip" data-arg="visita:${iso}">Visita de Estado</button>
        ${st.st!=='acordo'?`<button class="btn" data-act="dip" data-arg="acordo:${iso}">Propor livre comércio</button>`:''}
        <button class="btn" data-act="dip" data-arg="ajuda:${iso}">Enviar ajuda (R$ 2 bi)</button>
        ${!st.alianca?`<button class="btn" data-act="dip" data-arg="alianca:${iso}">Propor aliança militar</button>`:''}
        ${st.st==='sancao'||st.st==='embargo'?`<button class="btn" data-act="dip" data-arg="normal:${iso}">Suspender sanções</button>`:`<button class="btn danger" data-act="dip" data-arg="sancao:${iso}">Aplicar sanções</button><button class="btn danger" data-act="dip" data-arg="embargo:${iso}">Embargo total</button>`}
        <button class="btn danger" data-act="dip" data-arg="expulsar:${iso}">Expulsar embaixador</button>
        ${inTr?'':`<button class="btn danger" data-act="dipConfirm" data-arg="guerra:${iso}">${CONFIRM==='guerra:'+iso?'Confirmar: pedir ao Congresso':'Declarar guerra'}</button>`}`}
      </div>${CONFIRM==='guerra:'+iso?'<p class="small" style="color:var(--bad)">A Constituição exige autorização do Congresso. Guerra de agressão gera sanções e mortes. Clique de novo para confirmar.</p>':''}</div>`;
  }else{
    const f=FEATURES.find(x=>x.iso===iso);
    card=`<div class="box"><h2>${esc(f?f.name:'')}</h2><p class="small muted">Este protótipo simula ${COUNTRIES.length} países em detalhe. Os demais aparecem no mapa sem dados.</p></div>`;
  }
  const bl=(k,label,on,desc)=>`<div class="row box" style="padding:9px 12px"><div class="sp"><b>${label}</b><div class="small muted">${desc}</div></div>${on}</div>`;
  const list=[...COUNTRIES].sort((a,b)=>S.c[b.iso].rel-S.c[a.iso].rel).map(c=>`<tr class="click" data-act="selC" data-arg="${c.iso}"><td>${c.n}</td><td class="r num" style="color:${relCol(S.c[c.iso].rel)}">${sg(S.c[c.iso].rel,0)}</td><td>${atWar(c.iso)?pill('guerra','bad'):S.c[c.iso].alianca?pill('aliado','gold'):''}</td></tr>`).join('');
  return `
  <section class="sec">${card}</section>
  <section class="sec"><h3>Blocos</h3>
   ${bl('mercosul','Mercosul',`<button class="btn ${S.flags.mercosul?'danger':''}" data-act="bloc" data-arg="mercosul">${S.flags.mercosul?(CONFIRM==='bloc:mercosul'?'Confirmar saída':'Sair'):'Voltar ao bloco'}</button>`,S.flags.mercosul?'Livre comércio com Argentina, Paraguai, Uruguai e Bolívia.':'Fora do bloco. Tarifas normais com os vizinhos.')}
   ${bl('brics','BRICS',`<button class="btn ${S.flags.brics?'danger':''}" data-act="bloc" data-arg="brics">${S.flags.brics?(CONFIRM==='bloc:brics'?'Confirmar saída':'Sair'):'Voltar ao bloco'}</button>`,S.flags.brics?'Aproxima China, Rússia e Índia; os EUA desconfiam.':'Fora do BRICS.')}
   ${bl('ocde','OCDE',S.flags.ocdeOn?pill('membro','gold'):S.flags.ocde>0?`<span class="small num">${Math.min(12,S.flags.ocde-1)}/12 meses</span>`:`<button class="btn" data-act="bloc" data-arg="ocde">Pedir adesão</button>`,S.flags.ocdeOn?'Selo de boas práticas: mais investimento.':'Adesão exige 12 meses com credibilidade acima de 58.')}
  </section>
  <section class="sec"><h3>Países <em>por relação</em></h3><div class="tw"><table><tr><th>País</th><th class="r">Relação</th><th></th></tr>${list}</table></div></section>`;
}

function tDefesa(){
  const pw=[['076','Brasil'],...['840','156','643','356','250','826','032','862','170','152'].map(i=>[i,CBY[i].n])].map(([i,n])=>({n,v:milPow(i),br:i==='076'}));
  const mx=Math.max(...pw.map(x=>x.v));
  const bars=pw.map(x=>`<div class="hb"><span>${x.n}</span><div class="bar"><i style="width:${x.v/mx*100}%;background:${x.br?'var(--gold)':'var(--info)'}"></i></div><span class="num small">${f1(x.v)}</span></div>`).join('');
  const progs=Object.entries(PROGS).map(([k,p])=>{const r=S.mil.prog[k];return `<div class="law"><div class="row"><span class="n sp">${p.n}</span>${r?(r.left>0?pill(`${r.left} meses`,'warn'):pill('concluído','good')):''}</div><div class="small muted">R$ ${p.cost} bi em ${p.months} meses · +${f0(p.bonus*100)}% de poder militar</div>${r?`<div class="bar"><i style="width:${(1-r.left/p.months)*100}%;background:var(--gold)"></i></div>`:`<div><button class="btn" data-act="prog" data-arg="${k}">Iniciar programa</button></div>`}</div>`}).join('');
  const wars=S.wars.map(w=>{const c=CBY[w.iso];return `<div class="box sec" style="border-color:#743427"><div class="row"><h2 class="sp" style="font-size:18px">Guerra contra ${c.n}</h2>${pill(w.months+' meses','bad')}</div>
    <div class="row small"><span class="muted">Derrota</span><span class="sp"></span><span class="muted">Vitória</span></div><div class="warbar"><b style="left:${(w.score+100)/2}%"></b></div>
    <div class="row small"><span>Placar do front: <b class="num">${sg(w.score,0)}</b></span><span class="sp"></span><span>Mortos brasileiros: <b class="num">${f0(w.mortos)}</b></span></div>
    <div class="row"><label class="small muted" for="stance_${w.iso}">Postura</label><select id="stance_${w.iso}" data-bind="stance_${w.iso}"><option value="normal" ${w.stance==='normal'?'selected':''}>Equilibrada</option><option value="ofensiva" ${w.stance==='ofensiva'?'selected':''}>Ofensiva (mais avanço e mais baixas)</option><option value="defensiva" ${w.stance==='defensiva'?'selected':''}>Defensiva</option></select></div>
    <div class="btns"><button class="btn gold" data-act="dip" data-arg="paz:${w.iso}">Propor paz</button><button class="btn" data-act="mobil">${S.mil.mobil?'Desmobilizar':'Mobilização geral'}</button></div></div>`}).join('');
  return `
  <section class="sec"><h2>Defesa</h2><p class="muted small">O poder militar cresce devagar com o orçamento de defesa. Guerras exigem autorização do Congresso e custam PIB, vidas e relações.</p></section>
  ${wars||'<div class="box small muted">Nenhum conflito em andamento. Para declarar guerra, escolha um país na aba Mundo.</div>'}
  <div class="grid3"><div class="stat"><span class="l">Orçamento</span><span class="v">R$ ${f0(S.pol.g.defesa)} bi</span></div><div class="stat"><span class="l">% do PIB</span><span class="v">${f2(pctPIB(S.pol.g.defesa))}%</span></div><div class="stat"><span class="l">Poder militar</span><span class="v">${f1(milPow('076'))}</span></div></div>
  <section class="sec"><h3>Poder militar comparado <em>índice</em></h3>${bars}</section>
  <section class="sec"><h3>Programas estratégicos</h3>${progs}</section>
  <section class="sec"><h3>Segurança interna</h3><div class="box row"><div class="sp"><b>Operação de Garantia da Lei e da Ordem</b><div class="small muted">Forças Armadas nas capitais por 3 meses. Crime cai; jovens e defensores de direitos humanos reagem.</div></div><button class="btn" data-act="glo" ${S.mil.glo>0?'disabled':''}>${S.mil.glo>0?S.mil.glo+' meses':'Decretar GLO'}</button></div></section>`;
}

function concerns(a){
  const e=S.e;
  const c=[['a inflação',a.w.infl*Math.max(.3,e.ipca-2.5)*(a.d<5?1.3:.8)],['o emprego',a.w.emp*(a.st==='desempregado'?6:Math.max(.3,e.desemp-4))],['a violência',a.w.crime*Math.max(.3,e.crime/40)],['a saúde pública',a.w.saude*Math.max(.3,(60-e.saude)/6)],['a corrupção',a.w.corrup*Math.max(.3,e.corrup/12)],['o meio ambiente',a.w.amb*Math.max(.2,e.desmat/2500)],['os impostos',a.w.imp*1.2],['a falta de produtos',e.shortIdx/8]];
  if(a.w.cost>1.2)c.push(['os valores da família',a.w.cost*1.6]);
  return c.sort((x,y)=>y[1]-x[1]).slice(0,3).map(x=>x[0]);
}
function tPovo(){
  const ap=S.ap;
  const regs=Object.entries(REGIOES).map(([k,r])=>[r.n,apBy(a=>a.reg===k)]);
  const faixas=[['Até 1 salário mínimo',a=>a.d<=2],['1 a 3 salários',a=>a.d>=3&&a.d<=6],['3 a 10 salários',a=>a.d>=7&&a.d<=8],['Mais de 10 salários',a=>a.d>=9]].map(([n,f])=>[n,apBy(f)]);
  const grs=Object.entries(GROUPS).map(([k,n])=>[n,apBy(a=>a.g.includes(k))]).sort((a,b)=>b[1]-a[1]);
  const hb=(rows)=>rows.map(([n,v])=>`<div class="hb"><span>${n}</span><div class="bar"><i style="width:${v}%;background:${v>=40?'var(--good)':v>=25?'var(--warn)':'var(--bad)'}"></i></div><span class="num small">${f0(v)}%</span></div>`).join('');
  const cc={};for(const a of A)for(const c of concerns(a).slice(0,1))cc[c]=(cc[c]||0)+1;
  const topC=Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n,v])=>[n.replace(/^(a|o|os) /,'').replace(/^./,x=>x.toUpperCase()),v/A.length*100]);
  const H=S.hist.ap||[],R=S.hist.ruim||[];const n=H.length;
  const W=300,Hh=110,X=i=>28+i*((W-36)/Math.max(1,n-1)),Y=v=>Hh-16-v/100*(Hh-26);
  const line=(arr,col)=>arr.length>1?`<polyline points="${arr.map((v,i)=>X(i).toFixed(1)+','+Y(v).toFixed(1)).join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`:'';
  const chart=`<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto;display:block">${[0,25,50,75].map(v=>`<line x1="28" x2="${W-8}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="22" y="${Y(v)+3.5}" fill="var(--ink3)" font-size="9" text-anchor="end" font-family="IBM Plex Mono, monospace">${v}</text>`).join('')}${line(R,'#E36C55')}${line(H,'#63BA8C')}<text x="28" y="${Hh-3}" fill="var(--ink3)" font-size="9">${dateShort(0)}</text><text x="${W-8}" y="${Hh-3}" fill="var(--ink3)" font-size="9" text-anchor="end">${dateShort(Math.max(0,S.m))}</text></svg>`;
  const cit=S.featured.map(id=>{const a=A[id];const [l,c]=satLbl(a.sat);return `<div class="cit">${avatar(a)}<div><div class="nm">${esc(a.nome)}, ${a.idade}</div><div class="ds">${esc(a.ocup)} · ${esc(a.cid)} · R$ ${f0(a.renda)}/mês${a.benef?' · Bolsa Família':''}</div><div class="ds">Preocupa-se com ${concerns(a).join(', ')}</div></div><div style="text-align:right;display:flex;flex-direction:column;gap:4px;align-items:flex-end"><span class="mood num ${c==='good'?'up':c==='bad'?'dn':''}">${f0(a.sat)}</span><button class="btn" style="padding:4px 9px" data-act="talk" data-arg="${id}">Conversar</button></div></div>`}).join('');
  return `
  <section class="sec"><h2>O povo</h2><p class="muted small">${f0(A.length)} cidadãos simulados, com renda, região, emprego, religião e opinião próprios. Cada um reage às suas decisões e ao próprio bolso.</p></section>
  <section class="sec"><h3>Avaliação do governo</h3>
    <div class="stack" style="height:20px"><i style="width:${ap.bom}%;background:var(--good)"></i><i style="width:${ap.reg}%;background:#7d8a73"></i><i style="width:${ap.ruim}%;background:var(--bad)"></i></div>
    <div class="grid3"><div class="stat"><span class="l">Ótimo/bom</span><span class="v up">${f0(ap.bom)}%</span></div><div class="stat"><span class="l">Regular</span><span class="v">${f0(ap.reg)}%</span></div><div class="stat"><span class="l">Ruim/péssimo</span><span class="v dn">${f0(ap.ruim)}%</span></div></div>
    <div class="row small"><span>Intenção de voto na reeleição: <b class="num">${f0(S.voto)}%</b></span><span class="sp"></span><span>Protestos: ${S.prot>30?pill('massivos','bad'):S.prot>8?pill('crescentes','warn'):pill('baixos','good')}</span></div>
    ${chart}<div class="row small"><span style="color:var(--good)">— Ótimo/bom</span><span style="color:var(--bad)">— Ruim/péssimo</span></div></section>
  <section class="sec"><h3>Cidadãos <button class="btn" style="padding:2px 9px;font-size:11.5px;text-transform:none;letter-spacing:0" data-act="newCit">Ouvir outras pessoas</button></h3>${cit}</section>
  <section class="sec"><h3>Maior preocupação</h3>${hb(topC)}</section>
  <section class="sec"><h3>Aprovação por região</h3>${hb(regs)}</section>
  <section class="sec"><h3>Aprovação por renda</h3>${hb(faixas)}</section>
  <section class="sec"><h3>Aprovação por grupo</h3>${hb(grs)}</section>`;
}

/* ---------- ticker ---------- */
function renderTicker(){
  const items=[...(S.newsShow||[])].slice(0,3);
  $('#ticker').innerHTML=items.map(n=>`<div class="tick ${n.tom}"><small>${esc(n.v||'Agência Brasil Hoje')}</small>${esc(n.t)}</div>`).join('');
}

/* ---------- globo ---------- */
const EXTRA_EU=['040','056','100','191','196','203','208','233','246','300','348','372','428','440','442','616','642','703','705','752'];
const EXTRA_NATO=['008','056','100','191','203','208','233','246','300','348','352','428','440','442','499','807','578','616','642','703','705','752'];
function blocOf(iso){
  if(iso==='076')return S.flags.mercosul?'Mercosul':S.flags.brics?'BRICS':null;
  if(MERCOSUL.includes(iso))return 'Mercosul';
  const c=CBY[iso];
  if(c&&c.blocos.includes('BRICS'))return 'BRICS';
  if(EU.includes(iso)||EXTRA_EU.includes(iso))return 'UE';
  if((c&&c.blocos.includes('OTAN'))||EXTRA_NATO.includes(iso)||iso==='840'||iso==='124')return 'OTAN';
  if(iso==='231')return 'BRICS';
  return null;
}
function capColor(f){
  const iso=f.iso;
  if(atWar(iso))return '#E0452E';
  if(iso==='076')return f===HOVER?'#F2CD73':'#E2B54E';
  const c=CBY[iso];const hi=f===HOVER||iso===S.selC;
  let col='#1C2F35';
  if(MODE==='rel'&&c)col=relCol(S.c[iso].rel);
  if(MODE==='blocos'){const b=blocOf(iso);col=b?BLOCS.find(x=>x.k===b).col:'#1C2F35'}
  if(MODE==='comercio'&&c){const r=S.tradeRows?S.tradeRows[iso]:{x:c.x,m:c.m};const t=clamp(Math.log10(1+r.x+r.m)/2.25,0,1);col=`rgb(${Math.round(40+t*186)},${Math.round(60+t*121)},${Math.round(66+t*12)})`}
  if(MODE==='militar'&&c){const t=clamp(Math.log10(1+c.mil)/3,0,1);col=`rgb(${Math.round(35+t*76)},${Math.round(60+t*115)},${Math.round(72+t*136)})`}
  return hi?shade(col,.25):col;
}
function shade(c,k){const m=c.match(/\d+/g);if(!m||c.startsWith('#')){const h=c.replace('#','');const n=[0,2,4].map(i=>parseInt(h.substr(i,2),16));return `rgb(${n.map(v=>Math.round(v+(255-v)*k)).join(',')})`}return `rgb(${m.slice(0,3).map(v=>Math.round(+v+(255-v)*k)).join(',')})`}
function labelFor(f){
  const c=CBY[f.iso];
  if(f.iso==='076')return `<b>Brasil</b><br>Aprovação do governo: ${f0(S.ap.bom)}%`;
  if(!c)return `<b>${esc(f.name)}</b><br><span style="color:#8fa3a6">sem dados neste protótipo</span>`;
  const st=S.c[f.iso],r=S.tradeRows?S.tradeRows[f.iso]:{x:c.x,m:c.m};
  return `<b>${c.n}</b><br>Relação: ${sg(st.rel,0)}<br>Comércio: US$ ${f1(r.x+r.m)} bi/ano${atWar(f.iso)?'<br><b style="color:#E36C55">Em guerra</b>':''}`;
}
function altFor(f){return f.iso===S.selC?.035:f===HOVER?.025:f.iso==='076'?.016:.007}
function arcs(){
  const out=[];const br=[-15.8,-47.9];
  if(MODE==='comercio'){
    COUNTRIES.map(c=>({c,v:S.tradeRows?S.tradeRows[c.iso].x+S.tradeRows[c.iso].m:c.x+c.m})).sort((a,b)=>b.v-a.v).slice(0,12).forEach(({c,v})=>{
      const st=S.c[c.iso].st;out.push({a:br,b:[c.lat,c.lng],w:clamp(v/40,.25,2.2),col:st==='acordo'?['rgba(226,181,78,.95)','rgba(226,181,78,.35)']:st==='normal'?['rgba(111,175,208,.9)','rgba(111,175,208,.3)']:['rgba(227,108,85,.9)','rgba(227,108,85,.3)'],t:3200})});
  }
  for(const w of S.wars){const c=CBY[w.iso];out.push({a:br,b:[c.lat,c.lng],w:1.6,col:['#E0452E','#FFB199'],t:900})}
  for(const c of COUNTRIES)if(S.c[c.iso].alianca)out.push({a:br,b:[c.lat,c.lng],w:.6,col:['rgba(226,181,78,.8)','rgba(226,181,78,.8)'],t:6000});
  return out;
}
function updateGlobe(){
  if(!world)return;
  world.polygonCapColor(capColor).polygonAltitude(altFor).arcsData(arcs());
  const L=$('#legend');
  if(MODE==='rel')L.innerHTML=`<div>Relação com o Brasil</div><div class="grad"></div><div class="row" style="justify-content:space-between;width:180px"><span>hostil</span><span>neutra</span><span>aliada</span></div>`;
  if(MODE==='blocos')L.innerHTML=BLOCS.map(b=>`<div class="row"><span class="sw" style="background:${b.col}"></span>${b.k}</div>`).join('');
  if(MODE==='comercio')L.innerHTML=`<div>Comércio com o Brasil</div><div class="row"><span class="sw" style="background:#E2B54E"></span>livre comércio</div><div class="row"><span class="sw" style="background:#6FAFD0"></span>tarifas normais</div><div class="row"><span class="sw" style="background:#E36C55"></span>sanções</div>`;
  if(MODE==='militar')L.innerHTML=`<div>Gasto militar (escala log)</div><div class="grad" style="background:linear-gradient(90deg,#233c48,#6FAFD0)"></div>`;
}
function setupGlobe(){
  const el=$('#globe');
  if(typeof Globe!=='function'){el.innerHTML='<p class="muted" style="padding:60px 20px;text-align:center">O globo 3D não carregou. O jogo continua pelo painel.</p>';return}
  world=Globe({animateIn:false})(el)
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true).atmosphereColor('#5fa9c4').atmosphereAltitude(.17)
    .showGraticules(true)
    .polygonsData(FEATURES)
    .polygonCapColor(capColor).polygonSideColor(()=>'rgba(8,16,20,.7)').polygonStrokeColor(()=>'rgba(11,20,24,.85)')
    .polygonAltitude(altFor).polygonsTransitionDuration(250)
    .polygonLabel(labelFor)
    .onPolygonClick(f=>{selectCountry(f.iso,false)})
    .onPolygonHover(f=>{HOVER=f;el.style.cursor=f?'pointer':'grab';world.polygonCapColor(capColor).polygonAltitude(altFor)})
    .arcStartLat(d=>d.a[0]).arcStartLng(d=>d.a[1]).arcEndLat(d=>d.b[0]).arcEndLng(d=>d.b[1])
    .arcColor(d=>d.col).arcStroke(d=>d.w).arcDashLength(.45).arcDashGap(.25).arcDashAnimateTime(d=>d.t).arcAltitudeAutoScale(.4);
  try{const m=world.globeMaterial();m.color.set('#0f232b');if(m.emissive)m.emissive.set('#071217');m.shininess=6}catch(e){}
  world.pointOfView({lat:-12,lng:-48,altitude:2.25},0);
  const ro=new ResizeObserver(()=>world.width(el.clientWidth).height(el.clientHeight));ro.observe(el);
  updateGlobe();
}
function selectCountry(iso,fly){
  S.selC=iso;CONFIRM=null;
  if(TAB!=='mundo'){TAB='mundo'}
  render();updateGlobe();
  if(fly&&world){const c=CBY[iso];if(c)world.pointOfView({lat:c.lat,lng:c.lng,altitude:2.1},900)}
}

/* ---------- IA ---------- */
function ctxText(){
  const e=S.e;
  const frz=PRECOS.filter(p=>S.pol.precos[p.k]!=='livre').map(p=>`${p.n}: ${S.pol.precos[p.k]}`).join('; ')||'nenhum';
  const tar=SECT.filter(s=>S.pol.imp[s.k]!=='padrao').map(s=>`importação de ${s.n}: ${TARIFF_N[S.pol.imp[s.k]]}`).concat(SECT.filter(s=>S.pol.exp[s.k]!=='livre').map(s=>`exportação de ${s.n}: ${EXPPOL_N[S.pol.exp[s.k]]}`)).join('; ')||'padrão';
  const sanc=COUNTRIES.filter(c=>S.c[c.iso].st==='sancao'||S.c[c.iso].st==='embargo').map(c=>c.n).join(', ')||'nenhuma';
  const leis=S.leis.vigor.slice(-8).map(l=>l.n).join('; ')||'nenhuma lei nova';
  const tram=S.leis.tram.map(l=>l.n).join('; ')||'nada';
  const wars=S.wars.map(w=>`contra ${CBY[w.iso].n} há ${w.months} meses (placar ${f0(w.score)}, ${f0(w.mortos)} mortos)`).join('; ')||'nenhuma';
  const top=[...COUNTRIES].sort((a,b)=>S.c[a.iso].rel-S.c[b.iso].rel);
  return `Data: ${dateLbl(S.m)}. Presidente (fictício): ${S.pres.nome}, governo de ${LADO_N[S.pres.lado]}.
Economia: PIB ${f1(e.cresc)}% ao ano; IPCA ${f1(e.ipca)}% em 12 meses; desemprego ${f1(e.desemp)}%; Selic ${f2(e.selic)}% (${S.flags.bcAut?'Banco Central autônomo':'definida pelo governo'}); dólar R$ ${f2(e.cambio)}; dívida ${f1(e.divida)}% do PIB; resultado primário ${sg(e.primario,2)}% do PIB; salário mínimo R$ ${f0(e.sm)}; confiança empresarial ${f0(e.conf)}/100; credibilidade fiscal ${f0(e.cred)}/100.
Impostos: IR máximo ${f1(S.pol.tax.irpf)}%, isenção até R$ ${f0(S.pol.tax.isencao)}, IR empresas ${f0(S.pol.tax.irpj)}%, consumo ${f1(S.pol.tax.iva)}%.
Social: pobreza ${f1(e.pobreza)}%; criminalidade ${f0(e.crime)} (100 = nível de 2026); desmatamento ${f0(e.desmat)} km²/ano; desabastecimento ${f0(e.shortIdx)}/100.
Opinião: ótimo/bom ${f0(S.ap.bom)}%, ruim/péssimo ${f0(S.ap.ruim)}%. Base no Congresso: ~${baseSeats()} de 513 deputados.
Preços controlados: ${frz}. Comércio: ${tar}. Sanções/embargos: ${sanc}.
Leis aprovadas: ${leis}. No Congresso: ${tram}. Guerras: ${wars}.
Melhores relações: ${top.slice(-3).map(c=>c.n).join(', ')}. Piores: ${top.slice(0,3).map(c=>`${c.n} (${f0(S.c[c.iso].rel)})`).join(', ')}.`;
}
function profileText(a){
  const sit={formal:'empregado com carteira',informal:'trabalha por conta/informal',desempregado:'desempregado',aposentado:'aposentado',estudante:'estudante',servidor:'servidor público',empresario:'dono do próprio negócio',agro:'trabalha no campo'}[a.st];
  return `${a.nome}, ${a.idade} anos, ${a.sexo==='F'?'mulher':'homem'}, mora em ${a.cid} (${REGIOES[a.reg].n}). Ocupação: ${a.ocup} (${sit}). Renda mensal ~R$ ${f0(a.renda)}. ${a.benef?'Recebe Bolsa Família. ':''}${a.evang?'Evangélico(a). ':''}Posição política: ${ideoLbl(a.ideo)}. Satisfação com o governo: ${f0(a.sat)}/100 (${satLbl(a.sat)[0]}). Mais preocupado(a) com: ${concerns(a).join(', ')}.${a.hist.length?' Fatos recentes: '+a.hist.slice(-3).join('; ')+'.':''}`;
}
function aiFail(e){
  const hard=['not_granted','sampling_disabled','not_declared','capability_disabled','capability_removed'];
  if(e&&hard.includes(e.code)){AI_OK=false;toast('A IA não está disponível aqui. O jogo segue com textos automáticos.')}
  else if(e&&e.code==='rate_limited')toast('Limite de uso da IA atingido. Tente de novo mais tarde.');
  else if(e&&e.code!=='cancelled')toast('A IA não respondeu desta vez.');
}
async function aiJSON(prompt,tier){AI_BUSY++;render();try{return await SAMPLE.json(prompt,{modelTier:tier,cache:false})}finally{AI_BUSY--}}

function offlineFeed(NM){
  const e=S.e,news=[];
  (NM||[]).forEach(n=>news.push({v:pick(['Correio Nacional','Portal Agora','Gazeta Econômica']),t:n.t,tom:n.tom}));
  const h=S.hist,d=k=>h[k].length>1?h[k][h[k].length-1]-h[k][h[k].length-2]:0;
  if(Math.abs(d('ipca'))>.1)news.push({v:'Gazeta Econômica',t:`Inflação ${d('ipca')>0?'acelera':'desacelera'} e chega a ${f1(e.ipca)}% em 12 meses`,tom:d('ipca')>0?'neg':'pos'});
  if(Math.abs(d('desemp'))>.05)news.push({v:'Correio Nacional',t:`Desemprego ${d('desemp')>0?'sobe':'cai'} para ${f1(e.desemp)}%`,tom:d('desemp')>0?'neg':'pos'});
  if(Math.abs(d('selic'))>=.25)news.push({v:'Gazeta Econômica',t:`${S.flags.bcAut?'Copom':'Governo'} ${d('selic')>0?'eleva':'corta'} Selic para ${f2(e.selic)}%`,tom:'neu'});
  if(e.shortIdx>20)news.push({v:'Portal Agora',t:'Consumidores relatam prateleiras vazias em supermercados',tom:'neg'});
  news.push({v:'Instituto Opinião',t:`Pesquisa: ${f0(S.ap.bom)}% aprovam o governo, ${f0(S.ap.ruim)}% reprovam`,tom:S.ap.bom>S.ap.ruim?'pos':'neg'});
  const posts=S.featured.slice(0,5).map(id=>{const a=A[id];return {id,txt:offlinePost(a),likes:Math.round(20+rnd()*900)}});
  return {m:S.m-1,news:news.slice(0,5),posts,clima:''};
}
function offlinePost(a){
  const c=concerns(a)[0],good=a.sat>=60,bad=a.sat<40,e=S.e;
  if(a.st==='desempregado')return pick(['Mais um mês mandando currículo e nada. Tá difícil.','Tô fazendo bico pra pagar o aluguel enquanto não aparece nada fixo.']);
  const T={'a inflação':bad?[`O mercado tá um absurdo. Com ${f1(e.ipca)}% de inflação o dinheiro some antes do dia 20.`,'Cada ida ao mercado é um susto.']:good?['Os preços deram uma segurada, já dá pra respirar.']:['O preço das coisas ainda pesa, mas já foi pior.'],
    'o emprego':bad?['Aqui na firma todo mundo com medo de corte.']:['Tem vaga aparecendo de novo por aqui.'],
    'a violência':['Não dá pra andar tranquilo depois das 8 da noite no meu bairro.','Assaltaram meu vizinho de novo. Cadê a polícia?'],
    'a saúde pública':['Três meses esperando uma consulta no posto.','Fila no hospital desde as 5 da manhã.'],
    'a corrupção':['Mais um escândalo e ninguém vai preso.','Político é tudo igual, só muda o partido.'],
    'o meio ambiente':e.desmat<5000?['Pelo menos o desmatamento caiu, é um começo.']:['Enquanto isso a floresta queimando.'],
    'os impostos':['Trabalho quatro meses por ano só pra pagar imposto.','Imposto de primeiro mundo e serviço de terceiro.'],
    'a falta de produtos':['Rodei três mercados atrás de arroz e nada.','Congelaram o preço e sumiu tudo da prateleira.'],
    'os valores da família':['Governo tinha que cuidar da economia e deixar a família em paz.']};
  return pick(T[c]||['Seguindo a vida por aqui.']);
}
async function genFeed(){
  const NM=S.newsM||[];S.newsM=[];
  S.feed=offlineFeed(NM);
  S.newsShow=S.feed.news.slice(0,3);
  render();
  if(!(AI_OK&&S.aiOn))return;
  const ids=S.featured.slice(0,5);
  const prompt=`Você é o motor narrativo de um jogo de simulação política ambientado no Brasil (ficção). Escreva a repercussão do mês que acabou.
${ctxText()}
Decisões do governo neste mês: ${(S.lastLog||[]).join('; ')||'nenhuma decisão relevante'}.
Fatos do mês: ${NM.map(n=>n.t).join('; ')||'nenhum'}. Resumo: ${(S.summary||[]).join(' ')}
Cidadãos (um post de rede social para cada, em 1ª pessoa, 1 a 2 frases, com o jeito de falar da região e coerente com a situação pessoal e o humor com o governo):
${ids.map(id=>`- id ${id}: ${profileText(A[id])}`).join('\n')}
Regras: português do Brasil; use apenas veículos fictícios (ex.: Correio Nacional, Gazeta Econômica, Portal Agora, Rádio Povo, Folha do Cerrado, Jornal do Litoral); não cite políticos reais; manchetes curtas, jornalísticas e coerentes com os números e decisões.
Responda só com JSON: {"manchetes":[{"veiculo":"...","titulo":"...","tom":"pos|neg|neu"}],"posts":[{"id":0,"texto":"...","curtidas":0}],"clima":"uma frase sobre o humor das ruas"} com 4 manchetes e um post por cidadão.`;
  try{
    const j=await aiJSON(prompt,'quick');
    const news=(j.manchetes||[]).filter(n=>n&&n.titulo).slice(0,5).map(n=>({v:String(n.veiculo||'Correio Nacional').slice(0,40),t:String(n.titulo).slice(0,160),tom:['pos','neg','neu'].includes(n.tom)?n.tom:'neu'}));
    const posts=(j.posts||[]).filter(p=>p&&A[+p.id]&&p.texto).map(p=>({id:+p.id,txt:String(p.texto).slice(0,400),likes:+p.curtidas||Math.round(rnd()*800)}));
    if(news.length){const eng=NM.map(n=>({v:'Agência Brasil Hoje',t:n.t,tom:n.tom}));S.feed={m:S.m-1,news:[...eng.slice(0,2),...news],posts:posts.length?posts:S.feed.posts,clima:String(j.clima||'').slice(0,240),ai:true};S.newsShow=[...eng.slice(0,1),...news].slice(0,3)}
  }catch(e){aiFail(e)}
  render();save();
}
async function analisar(){
  const txt=($('#leiTxt')?.value||'').trim();
  if(txt.length<12)return toast('Escreva a proposta com um pouco mais de detalhe.');
  const names=COUNTRIES.map(c=>c.n).join(', ');
  const prompt=`Você é a Casa Civil em um jogo de simulação do governo brasileiro (ficção). Analise a proposta do Presidente como um técnico realista em economia, direito constitucional e política.
Contexto atual:
${ctxText()}
Proposta do Presidente: """${txt.slice(0,2000)}"""
Devolva só JSON com este formato:
{"titulo":"nome oficial curto","tipo":"PL|PLP|PEC","resumo":"2 frases sobre o que a lei faz na prática","parecer":"2 a 3 frases com prós, contras e riscos","ideologia":0,"constitucionalidade":0,"mp_possivel":false,
"efeitos":{"receita":0,"gasto":0,"pot":0,"infl":0,"desemp":0,"conf":0,"cred":0,"crime":0,"desmat":0,"pobreza":0,"saude":0,"educ":0,"corrup":0},
"grupos":{${Object.keys(GROUPS).map(k=>`"${k}":0`).join(',')}},
"relacoes":{"NomeDoPais":0},
"apoio":{"esq":0,"cesq":0,"ctr":0,"cdir":0,"dir":0}}
Escalas: ideologia de -1 (esquerda) a 1 (direita); constitucionalidade 0-100 (chance de o STF manter); receita e gasto em % do PIB por ano (-2 a 2); pot = pontos percentuais de crescimento potencial (-0.6 a 0.6); infl e desemp em pontos percentuais (-1.5 a 1.5); conf e cred de -20 a 20; crime e desmat em % (-50 a 50); pobreza em pontos percentuais (-5 a 5); saude, educ e corrup de -10 a 10; grupos = mudança de humor de -30 a 30; relacoes: use só países desta lista ou "União Europeia": ${names}; apoio = inclinação de cada bloco do Congresso (esquerda, centro-esquerda, Centrão, centro-direita, direita) de 0 a 100. Medida provisória não pode ser PEC, lei complementar, direito penal ou matéria eleitoral. Seja realista: medidas populistas têm custo fiscal, e propostas absurdas ou inconstitucionais têm constitucionalidade baixa. Omita o que for zero.`;
  try{
    const j=await aiJSON(prompt,'default');
    DRAFT=normLaw(j,txt);
  }catch(e){if(e&&e.code==='invalid_json')toast('A Casa Civil devolveu um parecer confuso. Tente de novo.');else aiFail(e)}
  render();
}
function normAcc(s){return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim()}
function normLaw(j,txt){
  const R={receita:[-2,2],gasto:[-2,2],pot:[-.6,.6],infl:[-1.5,1.5],desemp:[-1.5,1.5],conf:[-20,20],cred:[-20,20],crime:[-50,50],desmat:[-50,50],pobreza:[-5,5],saude:[-10,10],educ:[-10,10],corrup:[-10,10]};
  const fx={};for(const k in R){const v=+(j.efeitos||{})[k];if(isFinite(v)&&v)fx[k]=clamp(v,...R[k])}
  const gr={};for(const k in GROUPS){const v=+(j.grupos||{})[k];if(isFinite(v)&&v)gr[k]=clamp(Math.round(v),-30,30)}
  const rel={};for(const [k,v] of Object.entries(j.relacoes||{})){const n=normAcc(k);let iso=null;if(n.includes('uniao europeia')||n==='ue')iso='UE';else{const c=COUNTRIES.find(c=>normAcc(c.n)===n||n.includes(normAcc(c.n)));if(c)iso=c.iso;if(n==='eua'||n.includes('estados unidos'))iso='840'}if(iso&&isFinite(+v)&&+v)rel[iso]=clamp(Math.round(+v),-30,30)}
  const apoio={};let has=false;for(const b of BLOCOS_CN){const v=+(j.apoio||{})[b.k];if(isFinite(v)){apoio[b.k]=clamp(v,0,100);has=true}}
  const tipo=['PL','PLP','PEC'].includes(j.tipo)?j.tipo:'PL';
  return {id:'custom_'+Date.now(),n:String(j.titulo||'Lei sem título').slice(0,100),tipo,ideo:clamp(+j.ideologia||0,-1,1),area:'Proposta própria',txt:String(j.resumo||txt).slice(0,500),parecer:String(j.parecer||'').slice(0,600),fx,gr,rel,apoio:has?apoio:null,const:clamp(+j.constitucionalidade||70,0,100),mpOk:!!j.mp_possivel&&tipo==='PL',custom:true};
}
function buildOffline(){
  const area=$('#bArea').value,d=+$('#bDir').value,i=+$('#bInt').value;
  const base=BUILDER[area](d,i);
  const nome=($('#bNome').value||'').trim()||`${d>0?'Amplia':'Reduz'}: ${area.toLowerCase()}`;
  DRAFT={id:'custom_'+Date.now(),n:nome,tipo:i===3?'PEC':'PL',area:base.area||'Proposta própria',txt:`Proposta ${['','leve','moderada','radical'][i]} na área de ${area.toLowerCase()}.`,const:i===3?55:85,mpOk:i<3,custom:false,...base};
  render();
}
async function askMinister(q){
  const roles={fazenda:'Ministro(a) da Fazenda (economia, impostos, juros, contas públicas)',casa:'Ministro(a)-chefe da Casa Civil (Congresso, leis, articulação política)',itamaraty:'Chanceler do Itamaraty (relações exteriores, comércio exterior, blocos)',defesa:'Ministro(a) da Defesa (Forças Armadas, fronteiras, guerras)',social:'Ministro(a) do Desenvolvimento Social (pobreza, programas sociais, salário mínimo)'};
  CHAT.turns.push({role:'user',content:q});render();
  if(!(AI_OK&&S.aiOn)){CHAT.turns.push({role:'assistant',content:offlineAdvice()});render();return}
  const rules=`Você é ${roles[CHAT.min]} num jogo de simulação política do Brasil (ficção). Responda ao Presidente com franqueza, em português, em 3 a 5 frases, usando os números do contexto. Recomende ações concretas que existem no jogo: ajustar impostos e gastos, salário mínimo, tarifas de importação por setor, imposto ou proibição de exportação, congelar/subsidiar/tabelar preços, enviar leis ou medidas provisórias, liberar emendas, ceder ministérios, visitas de Estado, acordos de livre comércio, sanções, alianças, programas militares. Aponte riscos e trade-offs. Não invente números fora do contexto.\n\nContexto atual:\n${ctxText()}`;
  try{
    const turns=[{role:'user',content:rules},...CHAT.turns.slice(-8)];
    AI_BUSY++;render();
    const r=await SAMPLE(turns,{modelTier:'default',cache:false});
    CHAT.turns.push({role:'assistant',content:r.text});
  }catch(e){aiFail(e);CHAT.turns.push({role:'assistant',content:offlineAdvice()})}
  finally{AI_BUSY=Math.max(0,AI_BUSY-1)}
  render();
}
function offlineAdvice(){
  const e=S.e,L=[];
  if(CHAT.min==='fazenda'){if(e.ipca>5)L.push(`A inflação está em ${f1(e.ipca)}%. Evite aumentar gastos agora.`);if(e.primario<-1)L.push(`O déficit primário de ${f1(-e.primario)}% do PIB assusta o mercado; corte gastos ou aumente receita.`);if(e.selic>12)L.push('Os juros altos estão freando a economia; com contas melhores o BC terá espaço para cortar.');}
  if(CHAT.min==='casa'){L.push(`Nossa base tem cerca de ${baseSeats()} deputados. Para uma PEC precisamos de 308.`);if(S.cn.rel.ctr<50)L.push('O Centrão está distante: libere emendas ou ceda um ministério antes de votar algo difícil.')}
  if(CHAT.min==='itamaraty'){const w=[...COUNTRIES].sort((a,b)=>S.c[a.iso].rel-S.c[b.iso].rel)[0];L.push(`A pior relação é com ${w.n}. Uma visita de Estado ajuda.`);L.push('Acordos de livre comércio aumentam exportações, mas a indústria reclama.')}
  if(CHAT.min==='defesa')L.push(`Nosso índice de poder militar é ${f1(milPow('076'))}. Programas estratégicos levam anos para render.`);
  if(CHAT.min==='social')L.push(`A pobreza está em ${f1(e.pobreza)}%. Programas sociais e salário mínimo reduzem, mas pesam no orçamento.`);
  return (L.join(' ')||'Sigo acompanhando, Presidente.')+' (Resposta automática: a IA está desligada.)';
}
function openTalk(id){
  CHAT.cit=id;CHAT.cturns=[];
  const a=A[id];
  renderTalk();
}
function renderTalk(){
  const a=A[CHAT.cit];
  openModal(`<div class="row">${avatar(a)}<div class="sp"><div class="kick">Conversa com o povo</div><h2 style="font-size:21px">${esc(a.nome)}, ${a.idade}</h2></div><button class="btn" data-act="closeModal">Fechar</button></div>
  <p class="small muted">${esc(a.ocup)} · ${esc(a.cid)} · R$ ${f0(a.renda)}/mês · humor com o governo ${f0(a.sat)}/100${a.hist.length?' · '+esc(a.hist.slice(-2).join('; ')):''}</p>
  <div class="chat" id="talkBox">${CHAT.cturns.length?CHAT.cturns.map(t=>`<div class="msg ${t.role==='user'?'me':'them'}">${esc(t.content)}</div>`).join(''):'<div class="msg sys">Você chega de surpresa. Pergunte como está a vida, o que acha do governo, em quem vai votar.</div>'}${AI_BUSY?'<div class="msg sys">…</div>':''}</div>
  <form class="row" data-form="talk"><input type="text" id="talkQ" placeholder="Pergunte algo" autocomplete="off"><button class="btn gold" type="submit">Enviar</button></form>
  ${AI_OK&&S.aiOn?'':'<p class="small muted">A IA está desligada: as respostas são automáticas.</p>'}`);
  const tb=$('#talkBox');if(tb)tb.scrollTop=tb.scrollHeight;
  setTimeout(()=>$('#talkQ')?.focus(),30);
}
async function talk(q){
  const a=A[CHAT.cit];
  CHAT.cturns.push({role:'user',content:q});renderTalk();
  if(!(AI_OK&&S.aiOn)){CHAT.cturns.push({role:'assistant',content:offlinePost(a)});renderTalk();return}
  const rules=`Interprete um cidadão brasileiro fictício num jogo de simulação política. Fale em primeira pessoa, com o jeito de falar da sua região, frases curtas e naturais, sem caricatura. Nunca saia do personagem nem diga que é IA. No máximo 4 frases. Seja coerente com sua renda, sua situação e seu humor com o governo: se está insatisfeito, reclame com educação mas com firmeza.
Quem você é: ${profileText(a)}
Como está o país: ${ctxText()}
Decisões recentes do governo: ${(S.lastLog||[]).slice(0,8).join('; ')||'nada de especial'}.
Quem fala com você agora é o próprio Presidente da República, em visita sem aviso.`;
  try{AI_BUSY++;renderTalk();const r=await SAMPLE([{role:'user',content:rules},...CHAT.cturns.slice(-10)],{modelTier:'quick',cache:false});CHAT.cturns.push({role:'assistant',content:r.text});a.hist.push('conversou com o Presidente em '+dateShort(S.m));a.sat=clamp(a.sat+2,0,100)}
  catch(e){aiFail(e);CHAT.cturns.push({role:'assistant',content:offlinePost(a)})}
  finally{AI_BUSY=Math.max(0,AI_BUSY-1)}
  if(!$('#modal').hidden)renderTalk();
}

/* ---------- modal ---------- */
function openModal(html){$('#modalCard').innerHTML=html;$('#modal').hidden=false}
function closeModal(){$('#modal').hidden=true;$('#modalCard').innerHTML='';CHAT.cit=null}
function showEvent(i){
  const ev=S.events[i];if(!ev)return closeModal();
  const def=EVENTS[ev.id];
  openModal(`<div class="kick">Decisão presidencial · ${dateLbl(S.m)}</div><h2>${esc(evTitle(ev))}</h2><p class="lead">${esc(evDesc(ev))}</p>
   <div class="sec">${def.ops.map((o,k)=>`<button class="opt" data-act="evOpt" data-arg="${i}:${k}"><b>${esc(o.t)}</b><span>${esc(o.s)}</span></button>`).join('')}</div>
   <button class="btn" data-act="closeModal" style="align-self:flex-start">Decidir depois</button>`);
}
function showOver(){
  const o=S.over;
  openModal(`<div class="kick">${o.why==='impeachment'?'Impeachment':o.why==='eleicao'?'Eleição de '+(2027+Math.floor(S.election.m/12)):'Fim de governo'}</div><h2>${o.why==='fim'?'Missão cumprida':'Fim do mandato'}</h2><p class="lead">${esc(o.txt)}</p>
   <div class="grid3"><div class="stat"><span class="l">PIB</span><span class="v">${f1(S.e.cresc)}%</span></div><div class="stat"><span class="l">Inflação</span><span class="v">${f1(S.e.ipca)}%</span></div><div class="stat"><span class="l">Desemprego</span><span class="v">${f1(S.e.desemp)}%</span></div><div class="stat"><span class="l">Dívida</span><span class="v">${f1(S.e.divida)}%</span></div><div class="stat"><span class="l">Pobreza</span><span class="v">${f1(S.e.pobreza)}%</span></div><div class="stat"><span class="l">Leis aprovadas</span><span class="v">${S.leis.vigor.length}</span></div></div>
   <div class="btns"><button class="primary" data-act="restart">Novo governo</button><button class="btn" data-act="freeplay">Continuar governando mesmo assim</button></div>`);
}
function showStart(){
  let has=null;try{const raw=localStorage.getItem(SAVE_KEY);if(raw){const j=JSON.parse(raw);if(j&&j.S&&j.S.v===3)has=j}}catch(e){}
  let lado='ctr';
  openModal(`<div class="kick">Posse presidencial · 1º de janeiro de 2027</div><h2>Assuma a Presidência da República</h2>
   <p class="lead">Você governa o Brasil a partir de dados reais de partida: PIB de R$ 13,6 tri, Selic de 12,25%, dívida de 80% do PIB, um Congresso de 513 deputados e 2.400 cidadãos simulados que reagem a cada decisão. A eleição é em outubro de 2030.</p>
   <label class="small muted" for="presNome">Nome do seu presidente (fictício)</label><input type="text" id="presNome" value="Helena Duarte" maxlength="40">
   <div class="small muted">Orientação do governo</div>
   <div class="seg" id="ladoSeg"><button data-lado="esq" aria-pressed="false"><b>Esquerda</b><span>Base na esquerda; Centrão desconfiado</span></button><button data-lado="ctr" aria-pressed="true"><b>Centro</b><span>Negocia com todos; ninguém é fiel</span></button><button data-lado="dir" aria-pressed="false"><b>Direita</b><span>Base na direita; esquerda na oposição</span></button></div>
   <div class="btns"><button class="primary" data-act="start">Tomar posse</button>${has?`<button class="btn" data-act="continue">Continuar mandato salvo (${dateLbl(has.S.m)})</button>`:''}</div>
   <p class="small muted">Dados de partida aproximados de 2025–2026 (FMI, Banco Mundial, IBGE, BCB, SIPRI, Comex Stat). Pessoas, veículos de imprensa e políticos do jogo são fictícios.</p>`);
  $('#ladoSeg').onclick=e=>{const b=e.target.closest('button');if(!b)return;lado=b.dataset.lado;[...$('#ladoSeg').children].forEach(x=>x.setAttribute('aria-pressed',x===b))};
  showStart.getLado=()=>lado;
}

/* ---------- salvar ---------- */
function save(){try{localStorage.setItem(SAVE_KEY,JSON.stringify({S,A}))}catch(e){}}
function load(){try{const j=JSON.parse(localStorage.getItem(SAVE_KEY));S=j.S;A=j.A;return true}catch(e){return false}}

/* ---------- ações ---------- */
const ACT={
  start(){const nome=($('#presNome').value||'').trim()||'Helena Duarte';newGame(nome,showStart.getLado());CHAT.turns=[];closeModal();TAB='gabinete';S.newsShow=[{v:'Correio Nacional',t:`${nome} toma posse e promete “governar para todos”`,tom:'neu'}];render();updateGlobe();save()},
  continue(){load();closeModal();render();updateGlobe()},
  restart(){closeModal();showStart()},
  freeplay(){S.over=false;S.free=true;closeModal();render()},
  closeModal(){closeModal();render()},
  openEvent(i){showEvent(+i)},
  evOpt(arg){const [i,k]=arg.split(':').map(Number);resolveEvent(i,k);closeModal();if(S.events.length)showEvent(0);if(S.over)showOver();render();updateGlobe();save()},
  aiToggle(){S.aiOn=!S.aiOn;render()},
  minSel(v){CHAT.min=v;CHAT.turns=[];render()},
  pressBC(){S.e.cred-=4;if(rnd()<.5){S.e.selic=Math.max(2,S.e.selic-.25);toast('O Copom cedeu e cortou 0,25 ponto. O mercado não gostou.')}else toast('O BC manteve a Selic e a credibilidade caiu.');log('Presidente critica os juros do Banco Central');render()},
  preset(id,mp){const l=LEIS.find(x=>x.id===id);if(!l)return;if(S.leis.tram.some(x=>x.id===id))return toast('Esse projeto já está tramitando.');if(mp&&l.tipo!=='PL')return toast('Esse tipo de proposta não pode ser feito por MP.');submitLaw(JSON.parse(JSON.stringify(l)),{mp});toast(mp?'Medida Provisória publicada no Diário Oficial.':'Projeto enviado ao Congresso.');render()},
  presetMP(id){ACT.preset(id,true)},
  analisar(){analisar()},
  build(){buildOffline()},
  sendDraft(){submitLaw(DRAFT);DRAFT=null;toast('Projeto enviado ao Congresso.');render()},
  sendDraftMP(){submitLaw(DRAFT,{mp:true});DRAFT=null;toast('Medida Provisória publicada no Diário Oficial.');render()},
  dropDraft(){DRAFT=null;render()},
  urg(uid){const l=S.leis.tram.find(x=>String(x.uid)===uid);if(l){l.urg=true;S.cn.boost.ctr-=3;log(`Pedido de urgência: ${l.n}`)}render()},
  revogar(id){const l=S.leis.vigor.find(x=>String(x.uid||x.id)===id);if(!l)return;if(S.leis.tram.some(x=>x.revoga===l.id))return toast('A revogação já está no Congresso.');submitLaw({id:'rev_'+l.id,revoga:l.id,n:'Revogação: '+l.n,tipo:l.tipo==='PEC'?'PEC':'PL',ideo:-(l.ideo||0),area:l.area});toast('Revogação enviada ao Congresso.');render()},
  emendas(){if(S.m-S.cn.emendasM<1)return toast('As emendas deste mês já foram liberadas.');S.cn.emendasM=S.m;oneOff(10);for(const b of BLOCOS_CN)S.cn.boost[b.k]+=b.k==='ctr'?10:5;log('R$ 10 bi em emendas parlamentares liberados');render()},
  ministerio(){if(S.cn.minist>=6)return toast('Não há mais ministérios para ceder.');S.cn.minist++;S.cn.boost.ctr+=18;S.cn.boost.cdir+=5;S.cn.boost.esq-=S.pres.lado==='esq'?4:0;log('Ministério cedido ao Centrão');render()},
  reuniao(){if(S.m-S.cn.lastMeet<2)return toast('Você se reuniu com os líderes há pouco.');S.cn.lastMeet=S.m;for(const b of BLOCOS_CN)S.cn.boost[b.k]+=3;log('Reunião com líderes partidários');render()},
  selC(iso){selectCountry(iso,true)},
  dip(arg){const [a,iso]=arg.split(':');DIPLO[a](iso);CONFIRM=null;render();updateGlobe()},
  dipConfirm(arg){if(CONFIRM===arg){ACT.dip(arg)}else{CONFIRM=arg;render()}},
  bloc(k){
    if(k==='ocde'){S.flags.ocde=1;log('Pedido de adesão à OCDE');S.c['840'].rel+=4;render();return}
    const on=S.flags[k];
    if(on&&CONFIRM!=='bloc:'+k){CONFIRM='bloc:'+k;render();return}
    CONFIRM=null;S.flags[k]=!on;
    if(k==='mercosul'){if(on){MERCOSUL.forEach(i=>{S.c[i].st='normal';relC(i,-22,true)});moodG({agro:-4,empresarios:-3});news('Brasil deixa o Mercosul','neg')}else{MERCOSUL.forEach(i=>relC(i,12,true));news('Brasil volta ao Mercosul','pos')}}
    if(k==='brics'){if(on){['156','643','356','710','364','818','784','360'].forEach(i=>relC(i,-15,true));relC('840',10,true);news('Brasil anuncia saída do BRICS','neg')}else{['156','643','356','710'].forEach(i=>relC(i,10,true));relC('840',-8,true);news('Brasil retorna ao BRICS','neu')}}
    log(`${on?'Saída do':'Retorno ao'} ${k==='mercosul'?'Mercosul':'BRICS'}`);render();updateGlobe()},
  prog(k){const p=PROGS[k];S.mil.prog[k]={left:p.months,total:p.months,cost:p.cost,bonus:p.bonus,done:p.done};log(`Programa iniciado: ${p.n}`);moodG({militares:4});render()},
  glo(){S.mil.glo=3;oneOff(2);moodG({militares:5,jovens:-6,classe_media:2});log('Decreto de GLO nas capitais');render()},
  mobil(){S.mil.mobil=S.mil.mobil?0:1;log(S.mil.mobil?'Mobilização geral':'Desmobilização');render()},
  talk(id){openTalk(+id)},
  newCit(){S.featured=pickFeatured();render()},
};
function bind(id,v){
  const P=S.pol;
  const num=+v;
  if(['irpf','isencao','irpj','iva','folha'].includes(id))P.tax[id]=num;
  else if(id.startsWith('g_'))P.g[id.slice(2)]=num;
  else if(id==='sm')P.sm=num;
  else if(id==='selic')P.selic=num;
  else if(id.startsWith('imp_'))P.imp[id.slice(4)]=v;
  else if(id.startsWith('exp_'))P.exp[id.slice(4)]=v;
  else if(id.startsWith('pr_'))P.precos[id.slice(3)]=v;
  else if(id.startsWith('stance_')){const w=S.wars.find(x=>x.iso===id.slice(7));if(w)w.stance=v}
}
function outLabel(id,v){
  const n=+v;
  if(id==='isencao'||id==='sm')return 'R$ '+f0(n);
  if(id.startsWith('g_'))return 'R$ '+f0(n)+' bi';
  if(id==='selic')return f2(n)+'%';
  if(id==='irpj'||id==='folha')return f0(n)+'%';
  return f1(n)+'%';
}

async function nextMonth(){
  if(S.over)return showOver();
  if(S.events.length){showEvent(0);return toast('Decida as questões pendentes antes de encerrar o mês.')}
  const btn=$('#nextBtn');btn.disabled=true;
  stepMonth();
  render();updateGlobe();save();
  btn.disabled=false;
  if(S.over){showOver();return}
  if(S.events.length)showEvent(0);
  genFeed();
}

/* ---------- inicialização ---------- */
function init(){
  FEATURES=GEO.map(g=>({iso:g.i,name:g.n,geometry:{type:g.t==='P'?'Polygon':'MultiPolygon',coordinates:g.c}}));
  document.addEventListener('click',e=>{
    const t=e.target.closest('[data-act]');
    if(t&&t.tagName!=='SELECT'){e.preventDefault();const f=ACT[t.dataset.act];if(f)f(t.dataset.arg);return}
    const tab=e.target.closest('[data-tab]');if(tab){TAB=tab.dataset.tab;CONFIRM=null;$('#body').scrollTop=0;render()}
    const md=e.target.closest('[data-mode]');if(md){MODE=md.dataset.mode;[...$('#mapmodes').children].forEach(x=>x.setAttribute('aria-pressed',x===md));updateGlobe()}
  });
  document.addEventListener('input',e=>{const b=e.target.dataset&&e.target.dataset.bind;if(!b||e.target.tagName==='SELECT')return;bind(b,e.target.value);const o=$('#o_'+b);if(o)o.textContent=outLabel(b,e.target.value)});
  document.addEventListener('change',e=>{const t=e.target;if(t.dataset.bind){bind(t.dataset.bind,t.value);render();updateGlobe()}if(t.dataset.actChange)ACT[t.dataset.actChange](t.value)});
  document.addEventListener('submit',e=>{e.preventDefault();const f=e.target.dataset.form;if(f==='minAsk'){const q=$('#minQ').value.trim();if(q)askMinister(q)}if(f==='talk'){const q=$('#talkQ').value.trim();if(q)talk(q)}});
  $('#nextBtn').onclick=nextMonth;
  $('#modal').addEventListener('click',e=>{if(e.target.id==='modal'&&S&&!S.over&&CHAT.cit!=null){closeModal()}});
  // estado inicial de demonstração por trás da tela de posse
  newGame('Helena Duarte','ctr');
  setupGlobe();
  render();
  showStart();
  if(window.claude&&typeof claude.use==='function'){claude.use('sample').then(s=>{SAMPLE=s;AI_OK=!!s;if(S)render()}).catch(()=>{})}
}
init();
