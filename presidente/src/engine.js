/* ================= MOTOR DE SIMULAÇÃO ================= */
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const rnd=Math.random;
const pick=a=>a[Math.floor(rnd()*a.length)];
const gauss=()=>{let u=0,v=0;while(!u)u=rnd();while(!v)v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)};
const MESES=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const MES3=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const COUNTRIES=C_RAW.map(r=>({iso:r[0],n:r[1],lat:r[2],lng:r[3],pib:r[4],pop:r[5],mil:r[6],reg:r[7],blocos:r[8],rel0:r[9],x:r[10],m:r[11],imp:PROF[r[12]],exp:PROF[r[13]],pers:r[14],nuc:!!r[15],viz:!!r[16],ideo:r[17]}));
const CBY={};COUNTRIES.forEach(c=>CBY[c.iso]=c);
const EXP_TOTAL=337, IMP_TOTAL=263;
const EXP_LISTED=COUNTRIES.reduce((a,c)=>a+c.x,0), IMP_LISTED=COUNTRIES.reduce((a,c)=>a+c.m,0);
const ELECTIONS=[45,93];
let S=null, A=[];

function dateLbl(m){return MESES[m%12]+' de '+(2027+Math.floor(m/12))}
function dateShort(m){return MES3[m%12]+'/'+String(2027+Math.floor(m/12)).slice(2)}

function newGame(nome, lado){
  const ideo={esq:-.6,ctr:0,dir:.6}[lado];
  S={v:3,m:0,over:false,aiOn:true,
    pres:{nome,lado,ideo},
    e:{pibNom:13.6,pibReal:13.6,cresc:2.0,pot:2.2,gap:0,infl:4.3,ipca:4.3,selic:12.25,rEff:11.5,rrEma:7.9,cambio:5.40,divida:80.0,reservas:350,
       conf:50,cred:55,desemp:5.8,pobreza:23.0,gini:.505,crime:100,saude:50,educ:50,corrup:35,desmat:5800,expIdx:1,impIdx:1,defEma:.5,
       sm:1630,smReal:0,pessoalAdj:0,expUS:337,impUS:263,primario:-.5,juros:7.8,nominal:-8.3,receita:19.3,despesa:19.8,shortIdx:0,prevAge:0,subsid:0},
    w:{oil:65,oil12:[],worldG:3.0,chinaG:4.3},
    pol:{tax:{irpf:27.5,isencao:5000,irpj:34,iva:26.5,folha:20},g:Object.fromEntries(GASTOS.map(g=>[g.k,g.v])),sm:1630,selic:12.25,
         imp:Object.fromEntries(SECT.map(s=>[s.k,'padrao'])),exp:Object.fromEntries(SECT.map(s=>[s.k,'livre'])),
         precos:Object.fromEntries(PRECOS.map(p=>[p.k,'livre']))},
    last:null,
    flags:{bcAut:true,ftaUE:false,nuke:false,mercosul:true,brics:true,ocde:0,ocdeOn:false},
    precos:Object.fromEntries(PRECOS.map(p=>[p.k,{rep:0,short:0,pi:4.3,eff:4.3}])),
    pulses:[],moodG:{},lawG:{},moodR:{},moodAll:0,
    leis:{vigor:[],tram:[],hist:[]},
    cn:{rel:{},boost:{},minist:0,lastMeet:-9,emendasM:-9},
    c:{},wars:[],mil:{stock:26,prog:{},mobil:0,glo:0},
    hist:{},log:[],feed:null,feedHist:[],events:[],evUsed:{},sched:[],
    ap:{bom:0,reg:0,ruim:0},voto:0,prot:0,featured:[],selC:'076',summary:[]};
  for(const b of BLOCOS_CN){S.cn.rel[b.k]=clamp(85-55*Math.abs(ideo-b.ideo)+(b.k==='ctr'?5:0),5,90);S.cn.boost[b.k]=0}
  for(const c of COUNTRIES){S.c[c.iso]={rel:clamp(c.rel0-8*Math.abs(ideo-c.ideo)+4,-100,100),mod:0,st:MERCOSUL.includes(c.iso)?'acordo':'normal',retal:0,sancBR:0,alianca:false,visit:-9,announced:false}}
  S.last=JSON.parse(JSON.stringify(S.pol));
  genAgents(2400);
  approval();
  pushHist();
  S.featured=pickFeatured();
}

/* ---------- população (agentes) ---------- */
const DECIL_RENDA=[420,780,1100,1450,1800,2300,3000,4200,6800,19000];
function genAgents(n){
  A=[];
  const regK=Object.keys(REGIOES);
  for(let i=0;i<n;i++){
    let r=rnd(),reg='SE',acc=0;for(const k of regK){acc+=REGIOES[k].p;if(r<acc){reg=k;break}}
    const sexo=rnd()<.52?'F':'M';
    const idade=Math.round(clamp(16+Math.abs(gauss())*22+rnd()*12,16,88));
    const skew={N:-1.2,NE:-1.6,CO:.4,SE:.7,S:.8}[reg];
    const d=clamp(Math.floor(4.5+skew+gauss()*2.6),0,9);
    let st;
    if(idade>=62&&rnd()<.85)st='aposentado';
    else if(idade<22&&rnd()<.45)st='estudante';
    else{const x=rnd();
      const agroP=(reg==='CO'||reg==='S')?.13:.06;
      if(x<.11)st='servidor';else if(x<.11+(d>=6?.12:.04))st='empresario';else if(x<.11+(d>=6?.12:.04)+agroP)st='agro';else if(x<.62)st='formal';else st='informal'}
    const a={id:i,sexo,idade,reg,cid:pick(REGIOES[reg].cid),d,st,
      nome:(sexo==='F'?pick(NOMES_F):pick(NOMES_M))+' '+pick(SOBRENOMES),
      benef:d<=2&&rnd()<.72, evang:rnd()<({N:.36,NE:.26,CO:.34,SE:.28,S:.24}[reg]),
      mil:idade>19&&idade<58&&rnd()<.022, amb:rnd()<(idade<30?.13:.05)+(d>6?.05:0),
      pers:gauss()*6, sat:50, hist:[], w:null, ocup:''};
    a.ideo=clamp(gauss()*.45+({N:0,NE:-.28,CO:.28,SE:.05,S:.22}[reg])+(a.evang?.3:0)+(d>=8?.15:d<=2?-.1:0)+(st==='agro'?.3:0)+(st==='servidor'?-.15:0)+(idade<30?-.12:0)+(a.mil?.35:0)+(a.amb?-.3:0),-1,1);
    a.renda=Math.round(DECIL_RENDA[d]*(.8+rnd()*.45)/10)*10;
    const w={infl:1.2+(d<5?.8:0),emp:1+(d<6?.6:0)+(idade<30?.4:0),crime:1+(d>6?.4:0),saude:1+(idade>50?.6:0)+(d<5?.3:0),educ:.6+(idade<30?.6:0),corrup:.8+(d>5?.5:0),amb:a.amb?2.2:.25,cost:a.evang?1.6:.6,imp:d>=7?1.4:.5};
    for(const k in w)w[k]*=.7+rnd()*.6;
    a.w=w;
    if(st==='aposentado'){a.renda=Math.max(1630,a.renda)}
    setOcup(a);
    a.g=groupsOf(a);
    A.push(a);
  }
  // desemprego inicial
  const lf=A.filter(a=>a.st==='formal'||a.st==='informal');
  const target=Math.round((lf.length)*.058);
  for(let k=0;k<target;k++){const a=pick(lf);if(a.st!=='desempregado'){a.prevSt=a.st;a.st='desempregado';a.ocup='procurando emprego';a.g=groupsOf(a)}}
  const pi=S.pres.ideo;
  for(const a of A)a.sat=clamp(54+a.pers*1.4+30*(.55-Math.abs(a.ideo-pi)),5,95);
}
function setOcup(a){
  if(a.st==='aposentado'){a.ocup=a.d<4?'aposentado pelo INSS':'aposentado';return}
  if(a.st==='estudante'){a.ocup=a.d<5?'estudante de escola pública':'estudante universitário';return}
  if(a.st==='desempregado'){a.ocup='procurando emprego';return}
  const tbl=OCUP[a.st]||OCUP.formal;
  for(const [lo,hi,list] of tbl){if(a.d>=lo&&a.d<hi){a.ocup=pick(list);return}}
  a.ocup=pick(tbl[tbl.length-1][2]);
}
function groupsOf(a){
  const g=[];
  if(a.d<=2)g.push('pobres');else if(a.d>=3&&a.d<=7)g.push('classe_media');if(a.d>=9)g.push('ricos');
  if(a.st==='empresario')g.push('empresarios');if(a.st==='agro')g.push('agro');if(a.st==='servidor')g.push('servidores');
  if(a.st==='formal')g.push('trabalhadores');if(a.evang)g.push('evangelicos');if(a.idade<30)g.push('jovens');
  if(a.st==='aposentado')g.push('aposentados');if(a.mil)g.push('militares');if(a.amb)g.push('ambientalistas');
  return g;
}
function pickFeatured(){
  const want=[a=>a.reg==='NE'&&a.d<=2,a=>a.reg==='SE'&&a.st==='formal',a=>a.st==='agro'&&a.d>=6,a=>a.idade<27&&a.st!=='aposentado',a=>a.st==='aposentado',a=>a.st==='empresario',a=>a.reg==='S'&&a.st==='informal',a=>a.st==='servidor'];
  const out=[];for(const f of want){const c=A.filter(f).filter(a=>!out.includes(a.id));if(c.length)out.push(pick(c).id)}
  return out;
}

/* ---------- utilidades de estado ---------- */
function pulse(k,amt,months){S.pulses.push({k,amt,left:months})}
function pulseSum(k){return S.pulses.filter(p=>p.k===k).reduce((a,p)=>a+p.amt,0)}
function moodG(o){for(const k in o){if(k==='all')S.moodAll+=o[k];else S.moodG[k]=(S.moodG[k]||0)+o[k]}}
function moodR(r,v){S.moodR[r]=(S.moodR[r]||0)+v}
function oneOff(bi){S.e.divida+=bi/(S.e.pibNom*1000)*100;S.e.oneoffM=(S.e.oneoffM||0)+bi}
function relC(iso,d,perm){if(iso==='UE'){EU.forEach(i=>relC(i,d,perm));return}const st=S.c[iso];if(!st)return;st.rel=clamp(st.rel+d,-100,100);if(perm)st.mod+=d*.6}
function log(t){S.log.push(t)}
function lawSum(k){let s=0;for(const l of S.leis.vigor){if(l.fx&&l.fx[k])s+=l.fx[k]*(l.prog??1)}return s}
function pctPIB(bi){return bi/(S.e.pibReal*1000)*100}
function tariffOf(k){return TARIFF[S.pol.imp[k]]}
function atWar(iso){return S.wars.some(w=>w.iso===iso)}

/* ---------- fiscal ---------- */
function calcFiscal(pol=S.pol){
  const e=S.e,t=pol.tax;
  const rec={
    'IR pessoa física':2.6*Math.pow(t.irpf/27.5,.85)*(1-Math.max(0,t.irpf-35)*.012)-(t.isencao-5000)/1000*.12,
    'IR empresas + CSLL':3.3*Math.pow(t.irpj/34,.8)*(1-Math.max(0,t.irpj-40)*.012),
    'Consumo (CBS/IVA)':4.2*t.iva/26.5,
    'Contribuição sobre a folha':5.6*t.folha/20,
    'Outras receitas':3.6+tradeRevenue(pol)+lawSum('receita')};
  let receita=0;for(const k in rec)receita+=rec[k];
  const disc={};let sd=0;for(const g of GASTOS){disc[g.n]=pctPIB(pol.g[g.k]);sd+=disc[g.n]}
  const prev=8.0+e.prevAge+e.smReal*.05;
  let progCost=0;for(const k in S.mil.prog){const p=S.mil.prog[k];if(p.left>0)progCost+=pctPIB(p.cost/p.total*12)}
  const war=S.wars.length?.8:0;
  const subsid=e.subsid||0;
  const desp={'Previdência (INSS)':prev,'Pessoal civil':2.6+e.pessoalAdj,'Outras obrigatórias':1.7+lawSum('gasto')+(S.mil.mobil?.5:0),'Subsídios de preços':subsid,'Programas de defesa':progCost,'Esforço de guerra':war};
  let despesa=sd;for(const k in desp)despesa+=desp[k];
  const primario=receita-despesa;
  const juros=e.divida*e.rEff/100*.85;
  return {rec,disc,desp,receita,despesa,primario,juros,nominal:primario-juros};
}
function tradeRevenue(pol){
  let r=0;for(const s of SECT){const t=TARIFF[pol.imp[s.k]];if(t>=100)continue;const vol=1-(t-11.5)*.012;r+=s.imp*11.7*(t-11.5)/100*vol*.45}
  for(const s of SECT){if(pol.exp[s.k]==='taxa')r+=s.exp*14.8*.15*.85}
  return r;
}

/* ---------- comércio ---------- */
function tradeCalc(){
  const e=S.e,w=S.w,pol=S.pol;
  const oilF=w.oil/65, commF=1+(w.chinaG-4.3)*.04;
  const expF=s=>{const p=pol.exp[s];return p==='livre'?1:p==='taxa'?.85:0};
  const impVol=(s,extra)=>{const t=tariffOf(s)+(extra||0);return t>=100?0:clamp(1-(t-11.5)*.012,.2,1.2)};
  let x=0,m=0;
  const rows={};
  for(const c of COUNTRIES){
    const st=S.c[c.iso];
    const relF=.9+.2*(st.rel+100)/200;
    let sf=st.st==='acordo'?1.12:st.st==='sancao'?.6:st.st==='embargo'?0:1;
    if(atWar(c.iso))sf=0;
    let ep=0;for(const s in c.exp){ep+=c.exp[s]*expF(s)*(s==='petroleo'?oilF:(s==='agro'||s==='minerio')?commF:1)}
    const dem=c.iso==='156'?1+(w.chinaG-4.3)*.05:1+(w.worldG-3)*.03;
    const xv=c.x*relF*sf*ep*(1-.35*st.retal)*(1-.5*st.sancBR)*dem;
    let ip=0;for(const s in c.imp){ip+=c.imp[s]*(st.st==='acordo'?impVol(s,-tariffOf(s)*.999+(tariffOf(s)>=100?100:0)):impVol(s,st.st==='sancao'?50:0))}
    const mv=c.m*ip*(st.st==='embargo'||atWar(c.iso)?0:1)*(e.cresc>0?1+(e.cresc-2)*.02:1);
    rows[c.iso]={x:xv,m:mv};x+=xv;m+=mv;
  }
  // resto do mundo
  let epR=0,ipR=0;for(const s of SECT){epR+=s.exp*expF(s.k)*(s.k==='petroleo'?oilF:1);ipR+=s.imp*impVol(s.k)}
  x+=(EXP_TOTAL-EXP_LISTED)*epR*(1+(w.worldG-3)*.03);m+=(IMP_TOTAL-IMP_LISTED)*ipR;
  e.expUS=x;e.impUS=m;
  const tgt=x/EXP_TOTAL;e.expIdx+=(tgt-e.expIdx)*.35;e.impIdx+=(m/IMP_TOTAL-e.impIdx)*.35;
  S.tradeRows=rows;
}

/* ---------- reação à mudança de políticas ---------- */
function policyChanges(){
  const L=S.last,P=S.pol;
  // tarifas
  let dPrice=0,dGrow=0;
  for(const s of SECT){
    const a=TARIFF[L.imp[s.k]],b=TARIFF[P.imp[s.k]];
    if(a!==b){
      dPrice+=s.imp*(Math.min(b,60)-Math.min(a,60))/100*.15*.7*100;
      if(b>=100&&s.ind)dGrow-=s.imp*4;
      if(b>=100&&s.k==='quimica')pulse('item:cesta',3,10);
      if(b>=100&&s.k==='petroleo')pulse('item:combustivel',8,8);
      log(`Importação de ${s.n.toLowerCase()}: ${TARIFF_N[L.imp[s.k]]} → ${TARIFF_N[P.imp[s.k]]}`);
      if(b>a&&s.ind)moodG({trabalhadores:2,empresarios:1,classe_media:-1});
      if(b<a&&s.ind)moodG({trabalhadores:-2,classe_media:1});
    }
    const ea=L.exp[s.k],eb=P.exp[s.k];
    if(ea!==eb){
      log(`Exportação de ${s.n.toLowerCase()}: ${EXPPOL_N[ea]} → ${EXPPOL_N[eb]}`);
      const sev={livre:0,taxa:1,proibido:3}[eb]-{livre:0,taxa:1,proibido:3}[ea];
      if(s.k==='agro'){pulse('item:cesta',-2.2*sev,12);moodG({agro:-9*sev,pobres:2*sev})}
      if(s.k==='petroleo')pulse('item:combustivel',-3*sev,12);
      if(s.k==='minerio'||s.k==='petroleo')moodG({empresarios:-3*sev});
      for(const c of COUNTRIES)if(c.exp[s.k])relC(c.iso,-c.exp[s.k]*8*sev);
    }
  }
  if(Math.abs(dPrice)>.01)pulse('infl',dPrice,12);
  if(dGrow)pulse('cresc',dGrow,8);
  // preços
  for(const p of PRECOS){
    const a=L.precos[p.k],b=P.precos[p.k];
    if(a===b)continue;
    const st=S.precos[p.k];
    log(`${p.n}: ${({livre:'preço livre',congelado:'preço congelado',teto:'reajuste limitado (tabelamento)',subsidio:'subsídio do Tesouro'})[b]}`);
    if(b==='livre'&&st.rep>0){pulse('item:'+p.k,st.rep,4*3);st.rep=0}
    if(b==='congelado'){moodG({empresarios:-4});S.e.cred-=3}
    if(b==='congelado'||b==='subsidio')moodG({pobres:3,classe_media:2});
  }
  // impostos, gastos, SM
  const t0=L.tax,t1=P.tax;
  const names={irpf:'Alíquota máxima do IR',isencao:'Faixa de isenção do IR',irpj:'IR das empresas + CSLL',iva:'Imposto sobre consumo',folha:'Contribuição sobre a folha'};
  for(const k in t1)if(t0[k]!==t1[k]){
    log(`${names[k]}: ${fmtN(t0[k],k==='isencao'?0:1)} → ${fmtN(t1[k],k==='isencao'?0:1)}`);
    const d=t1[k]-t0[k];
    if(k==='iva'){pulse('infl',d*.25,12);moodG({pobres:-d*1.2,classe_media:-d*1})}
    if(k==='irpf')moodG({ricos:-d*1.2,classe_media:-d*.4});
    if(k==='isencao')moodG({classe_media:d/1000*2.5,trabalhadores:d/1000*2});
    if(k==='irpj'){moodG({empresarios:-d*1.2});S.e.conf-=d*.5}
    if(k==='folha'){moodG({empresarios:-d*1,trabalhadores:-d*.3});pulse('desemp',d*.03,24)}
  }
  for(const g of GASTOS){const a=L.g[g.k],b=P.g[g.k];if(a!==b){
    log(`${g.n}: R$ ${Math.round(a)} bi → R$ ${Math.round(b)} bi`);
    const r=(b-a)/a;
    const map={saude:{all:3,aposentados:3,pobres:3},educacao:{jovens:5,classe_media:2},social:{pobres:10,classe_media:-1,ricos:-2},seguranca:{militares:5,classe_media:2},defesa:{militares:8},infra:{empresarios:3,trabalhadores:2},ciencia:{jovens:2},ambiente:{ambientalistas:6,agro:-2}}[g.k];
    const o={};for(const q in map)o[q]=map[q]*clamp(r*3,-3,3);moodG(o);
  }}
  if(P.sm!==L.sm){
    const chg=(P.sm/L.sm-1)*100;
    S.e.smReal+=chg;S.e.sm=P.sm;
    log(`Salário mínimo: R$ ${fmtN(L.sm,0)} → R$ ${fmtN(P.sm,0)}`);
    pulse('infl',chg*.035,12);pulse('desemp',chg*.02,18);moodG({pobres:chg*1.2,aposentados:chg*1.3,trabalhadores:chg*.6,empresarios:-chg*.6});
  }
  if(!S.flags.bcAut&&P.selic!==L.selic)log(`Selic definida pelo governo: ${fmtN(L.selic,2)}% → ${fmtN(P.selic,2)}%`);
  S.last=JSON.parse(JSON.stringify(P));
}

/* ---------- preços e congelamentos ---------- */
function pricesStep(){
  const e=S.e;
  const oil12=S.w.oil12.length>=12?S.w.oil12[S.w.oil12.length-12]:65;
  let ipca=e.infl*(1-PRECOS.reduce((a,p)=>a+p.w,0)),short=0,sw=0,subsid=0;
  for(const p of PRECOS){
    const st=S.precos[p.k];
    let pi=e.infl+pulseSum('item:'+p.k);
    if(p.k==='combustivel')pi+=(S.w.oil/oil12-1)*100*.35+(e.cambio/(S.hist.cambio?.[Math.max(0,S.hist.cambio.length-12)]||e.cambio)-1)*100*.3;
    if(p.k==='cesta')pi+=(e.cambio/(S.hist.cambio?.[Math.max(0,S.hist.cambio.length-12)]||e.cambio)-1)*100*.2;
    if(p.k==='energia')pi+=.8;
    if(p.k==='remedios')pi+=.3;
    st.pi=pi;
    const mode=S.pol.precos[p.k];
    let eff=pi;
    if(mode==='congelado'){eff=0;st.rep+=Math.max(0,pi)/12;st.short=clamp(st.short+Math.max(0,st.rep-1.5)*1.1+.6,0,100)}
    else if(mode==='teto'){eff=Math.min(pi,pi*.5);st.rep+=Math.max(0,pi-eff)/12;st.short=clamp(st.short+Math.max(0,st.rep-3)*.5,0,100)}
    else if(mode==='subsidio'){eff=Math.min(pi,1);st.rep+=Math.max(0,pi-eff)/12;st.short=Math.max(0,st.short*.7);subsid+=p.w*.65*st.rep}
    else{st.short=Math.max(0,st.short*.72-1)}
    st.eff=eff;
    ipca+=p.w*eff;
    short+=p.w*st.short;sw+=p.w;
  }
  e.shortIdx=short/sw;
  e.subsid=subsid;
  ipca+=pulseSum('infl');
  e.ipca=ipca;
  if(S.pol.precos.combustivel==='congelado'&&S.precos.combustivel.rep>4){e.cred-=.4;e.conf-=.3}
}

/* ---------- macroeconomia ---------- */
function macroStep(){
  const e=S.e,w=S.w;
  const F=calcFiscal();
  e.receita=F.receita;e.despesa=F.despesa;e.primario=F.primario;e.juros=F.juros;e.nominal=F.nominal;
  // impulso fiscal = déficit atual vs média recente
  const def=-F.primario;const imp=def-e.defEma;e.defEma+=(def-e.defEma)*.06;
  // juros
  const expInfl=e.infl*.6+(3+(100-e.cred)*.035)*.4;
  if(S.flags.bcAut){
    const star=4.75+expInfl+1.5*(e.ipca-3)+.35*e.gap;
    const step=clamp(star-e.selic,-.5,.5);
    e.selic=Math.round((e.selic+step)*4)/4;e.selic=clamp(e.selic,2,30);
    S.pol.selic=e.selic;S.last.selic=e.selic;
  }else{e.selic=S.pol.selic}
  e.rEff+=(e.selic-e.rEff)*.05;
  const rr=e.selic-expInfl;e.rrEma+=(rr-e.rrEma)*.12;
  // potencial
  let tarAvg=0;for(const s of SECT)tarAvg+=s.imp*Math.min(tariffOf(s.k),60);
  const fta=Object.values(S.c).filter(c=>c.st==='acordo').length;
  e.pot=2.2+lawSum('pot')+(e.educ-50)*.01+(pctPIB(S.pol.g.infra)-.66)*.6+(pctPIB(S.pol.g.ciencia)-.18)*.8-(tarAvg-11.5)*.012+fta*.02+(S.flags.ocdeOn?.1:0);
  // crescimento
  const exp12=S.hist.expIdx&&S.hist.expIdx.length>=12?S.hist.expIdx[S.hist.expIdx.length-12]:1;
  const tradeT=(e.expIdx-exp12)*15*.8;
  const worldT=(w.worldG-3)*.35+(w.chinaG-4.3)*.15;
  const warT=S.wars.reduce((a,x)=>a+(CBY[x.iso].viz?2.2:1.0),0);
  const taxT=-(S.pol.tax.irpj-34)*.03-(S.pol.tax.iva-26.5)*.05;
  let g=e.pot+.5*imp-.33*(e.rrEma-5)+(e.conf-50)*.04+tradeT+worldT-e.shortIdx*.045-warT+taxT+pulseSum('cresc');
  e.cresc+=(g-e.cresc)*.22;
  e.cresc=clamp(e.cresc,-12,12);
  e.gap+=(e.cresc-e.pot)/12;e.gap*=.985;
  e.pibReal*=1+e.cresc/1200;
  e.pibNom*=1+(e.cresc+e.ipca)/1200;
  // inflação núcleo
  const anchor=3+(100-e.cred)*.035;
  const c12=S.hist.cambio&&S.hist.cambio.length>=12?S.hist.cambio[S.hist.cambio.length-12]:e.cambio;
  const fx=(e.cambio/c12-1)*100*.1;
  const tgt=anchor+.35*e.gap+fx+.12*imp+lawSum('infl')+(S.wars.length?.6:0);
  e.infl+=(tgt-e.infl)*.12;
  e.infl=clamp(e.infl,-3,80);
  // câmbio
  const riskPrem=.015*(55-e.cred)+.008*(e.divida-80)-.03*(rr-7)-.25*(e.expIdx-1)+(S.wars.length?.06:0)+pulseSum('cambio');
  const ct=5.40*Math.exp(riskPrem)*Math.pow((1+e.ipca/100)/(1.025),S.m/12);
  e.cambio+=(ct-e.cambio)*.15;e.cambio*=1+gauss()*.012;e.cambio=clamp(e.cambio,2.5,40);
  // desemprego
  const nat=6.5+lawSum('desemp')+(S.pol.tax.folha-20)*.05;
  e.desemp+=-.045*(e.cresc-1.6)+.012*(nat-e.desemp)+pulseSum('desemp')/12-(S.mil.mobil?.03:0);
  e.desemp=clamp(e.desemp,2,35);
  // dívida
  const ng=e.cresc+e.ipca;
  e.divida+=(F.juros-F.primario)/12-e.divida*(ng/100)/12;
  e.divida=clamp(e.divida,5,300);
  e.reservas=clamp(e.reservas+(e.expUS-e.impUS-40)/12*.25,5,900);
  // credibilidade e confiança
  const credT=55+(F.primario+.5)*6-(e.divida-80)*.45+(S.flags.bcAut?5:-15)+lawSum('cred')-Object.values(S.pol.precos).filter(v=>v==='congelado').length*3-(e.ipca>6?(e.ipca-6)*2:0)+(S.flags.ocdeOn?5:0);
  e.cred+=(clamp(credT,0,100)-e.cred)*.08;e.cred=clamp(e.cred,0,100);
  const confT=50+(e.cred-55)*.5+(e.cresc-2)*3+lawSum('conf')-(S.pol.tax.irpj-34)*.8-(S.wars.length?10:0)-e.shortIdx*.3-S.prot*.1+pulseSum('conf');
  e.conf+=(clamp(confT,0,100)-e.conf)*.15;e.conf=clamp(e.conf,0,100);
  e.prevAge+=.1/12;
  e.oneoffM=0;
}
function socialStep(){
  const e=S.e,g=S.pol.g;
  const pobT=23+(e.desemp-5.8)*1.2-(pctPIB(g.social)-2.2)*6-e.smReal*.35+(e.ipca-4)*.35+lawSum('pobreza')-(e.cresc-2)*.3;
  e.pobreza+=(clamp(pobT,2,70)-e.pobreza)*.06;
  e.gini+=((.505-(pctPIB(g.social)-2.2)*.02+(e.desemp-5.8)*.003-(S.pol.tax.irpf-27.5)*.001+lawSum('pobreza')*.003)-e.gini)*.04;
  const crT=100-(pctPIB(g.seguranca)-.15)*140+(e.desemp-5.8)*3+lawSum('crime')+(S.mil.glo>0?-10:0)+(S.mil.prog.fronteira&&S.mil.prog.fronteira.left===0?-5:0);
  e.crime+=(clamp(crT,30,250)-e.crime)*.04;
  const saT=50+(pctPIB(g.saude)-1.84)*25+lawSum('saude');e.saude+=(clamp(saT,0,100)-e.saude)*.03;
  const edT=50+(pctPIB(g.educacao)-1.4)*25+lawSum('educ');e.educ+=(clamp(edT,0,100)-e.educ)*.015;
  const coT=35+S.cn.minist*3+lawSum('corrup');e.corrup+=(clamp(coT,0,100)-e.corrup)*.03;
  const dmT=5800*(1-(pctPIB(g.ambiente)-.06)*5)*(1+lawSum('desmat')/100);e.desmat+=(clamp(dmT,500,20000)-e.desmat)*.08;
  if(S.mil.glo>0)S.mil.glo--;
}

/* ---------- mundo e países ---------- */
function worldStep(){
  const w=S.w;
  w.oil12.push(w.oil);if(w.oil12.length>24)w.oil12.shift();
  w.oil=clamp(w.oil*(1+gauss()*.035)+(68-w.oil)*.03,25,180);
  w.worldG+=(3.0-w.worldG)*.08+gauss()*.08;
  w.chinaG+=(4.3-w.chinaG)*.06+gauss()*.08;
  const pi=S.pres.ideo;
  for(const c of COUNTRIES){
    const st=S.c[c.iso];
    const base=c.rel0-8*Math.abs(pi-c.ideo)+4+st.mod;
    st.rel+=(base-st.rel)*.03;
    st.mod*=.99;
    let harm=0;for(const s in c.imp){const t=st.st==='acordo'?0:tariffOf(s);harm+=c.imp[s]*Math.max(0,Math.min(t,100)-11.5)/88.5}
    if(st.st==='sancao')harm+=1;
    let xh=0;for(const s in c.exp){const p=S.pol.exp[s];xh+=c.exp[s]*(p==='proibido'?1:p==='taxa'?.3:0)}
    st.rel=clamp(st.rel-harm*1.6-xh*2.2,-100,100);
    if((harm>.18||xh>.3)&&st.rel<25){st.retal=Math.min(1,st.retal+.15);if(st.retal>=.45&&!st.announced){st.announced=true;news(`${c.n} retalia e sobretaxa produtos brasileiros`,'neg')}}
    else{st.retal=Math.max(0,st.retal-.05);if(st.retal<.1)st.announced=false}
    st.sancBR=Math.max(0,st.sancBR-.01);
    if(c.pers==='hostil'&&c.viz&&st.rel<-65&&!atWar(c.iso)&&rnd()<.02){startWar(c.iso,false)}
  }
  if(S.flags.mercosul)MERCOSUL.forEach(i=>{if(S.c[i].st!=='sancao'&&S.c[i].st!=='embargo')S.c[i].st='acordo'});
  if(S.flags.ftaUE)EU.forEach(i=>{if(S.c[i].st==='normal')S.c[i].st='acordo'});
  // defesa: estoque militar
  const defUS=S.pol.g.defesa/e_cambio();
  S.mil.stock+=(defUS*(1+lawSum('mil'))-S.mil.stock)*.03;
  for(const k in S.mil.prog){const p=S.mil.prog[k];if(p.left>0){p.left--;if(p.left===0){news(p.done,'pos');if(p.bonus)S.mil.stock*=1+p.bonus}}}
}
function e_cambio(){return S.e.cambio}
function milPow(iso){
  if(iso==='076'){let p=Math.sqrt(S.mil.stock)*(S.flags.nuke?1.08:1)*(1+(S.mil.mobil?.45:0));return p}
  return Math.sqrt(CBY[iso].mil);
}
function startWar(iso,aggr){
  const c=CBY[iso];
  S.wars.push({iso,score:0,months:0,mortos:0,aggr,stance:'normal'});
  S.c[iso].st='embargo';S.c[iso].rel=-100;
  if(aggr){
    for(const o of COUNTRIES)if(o.iso!==iso&&!S.c[o.iso].alianca)relC(o.iso,-18,true);
    if(!['hostil'].includes(c.pers)){['840'].concat(EU).forEach(i=>{S.c[i].sancBR=.8});news('EUA e União Europeia impõem sanções ao Brasil','neg')}
  }
  news(aggr?`Brasil declara guerra contra ${c.n}`:`${c.n} ataca o território brasileiro`, 'neg');
  moodG({all:aggr?2:8,militares:10});
  S.events.push({id:'guerra_ini',iso,aggr});
}
function warStep(){
  for(const war of [...S.wars]){
    const c=CBY[war.iso];
    war.months++;
    const d=c.viz?1:.3;
    let ours=milPow('076')*(.75+S.ap.bom/100*.5),theirs=milPow(war.iso);
    for(const o of COUNTRIES)if(S.c[o.iso].alianca&&o.iso!==war.iso)ours+=milPow(o.iso)*.25;
    if(war.aggr)ours*=d;else theirs*=d;
    const st=war.stance==='ofensiva'?3:war.stance==='defensiva'?-1.5:0;
    war.score=clamp(war.score+clamp(10*Math.log(ours/theirs),-12,12)+st+gauss()*4,-100,100);
    const inten=(war.stance==='ofensiva'?1.6:war.stance==='defensiva'?.6:1)*(c.viz?1:.4);
    war.mortos+=Math.round((30+rnd()*70)*inten*Math.max(.3,Math.sqrt(milPow(war.iso)/5)));
    moodG({all:war.months<=3?.8:-1.3,militares:war.months<=6?1:-.5});
    if(c.nuc&&war.score>45&&!war.nukeWarn){war.nukeWarn=true;S.events.push({id:'nuclear',iso:war.iso})}
    if(war.score>=85)endWar(war,'vitoria');
    else if(war.score<=-85)endWar(war,'derrota');
  }
}
function endWar(war,how){
  S.wars=S.wars.filter(w=>w!==war);
  const c=CBY[war.iso];S.c[war.iso].st='normal';
  if(how==='vitoria'){news(`${c.n} capitula; Brasil vence a guerra após ${war.months} meses`,'pos');moodG({all:8,militares:12});S.c[war.iso].rel=-60}
  else if(how==='derrota'){news(`Brasil é derrotado por ${c.n}; governo assina rendição`,'neg');moodG({all:-20,militares:-15});oneOff(80)}
  else{news(`Cessar-fogo entre Brasil e ${c.n} entra em vigor`,'neu');moodG({all:3});S.c[war.iso].rel=-40}
  S.mil.mobil=0;
  for(const i in S.c)S.c[i].sancBR=Math.min(S.c[i].sancBR,.3);
}

/* ---------- Congresso e leis ---------- */
function blocSupport(law,b){
  let inc=law.apoio&&law.apoio[b.k]!=null?law.apoio[b.k]:clamp(92-55*Math.abs((law.ideo||0)-b.ideo),5,95);
  if(b.k==='ctr')inc+=8;
  return clamp(.5*inc+.35*(S.cn.rel[b.k]+S.cn.boost[b.k])+.15*S.ap.bom*1.6,0,100);
}
const NEED={PL:[241,38],PLP:[257,41],PEC:[308,49],DL:[257,41]};
function vote(law){
  let cam=0,sen=0;const by={};
  for(const b of BLOCOS_CN){const P=blocSupport(law,b);const f=clamp((P-32)/38+gauss()*.06,.02,.98);by[b.k]=Math.round(b.cam*f);cam+=by[b.k];sen+=Math.round(b.sen*clamp(f+gauss()*.05,0,1))}
  const [nc,ns]=NEED[law.tipo]||NEED.PL;
  return {cam,sen,by,ok:cam>=nc&&sen>=ns,nc,ns};
}
function baseSeats(){let s=0;for(const b of BLOCOS_CN){s+=b.cam*clamp((S.cn.rel[b.k]+S.cn.boost[b.k]-30)/45,0,1)}return Math.round(s)}
function congressStep(){
  for(const b of BLOCOS_CN){
    const base=clamp(85-55*Math.abs(S.pres.ideo-b.ideo)+(b.k==='ctr'?5:0),5,90)+(S.ap.bom-35)*(b.k==='ctr'?.6:.3);
    S.cn.rel[b.k]+=(clamp(base,0,100)-S.cn.rel[b.k])*.05;
    S.cn.boost[b.k]*=.93;
  }
}
function submitLaw(law,opts={}){
  const tipo=law.tipo||'PL';
  const dur={PL:3,PLP:4,PEC:7,DL:1}[tipo]+Math.floor(rnd()*3);
  const item={...law,tipo,uid:Date.now()+Math.floor(rnd()*1e4),left:opts.mp?4:dur,total:opts.mp?4:dur,mp:!!opts.mp,urg:false,since:S.m};
  if(opts.mp){item.prog=0;S.leis.vigor.push({...item,since:S.m,prog:0,mpPending:true});log(`Medida Provisória editada: ${law.n}`);applyLawOnce(item,.5)}
  else log(`Projeto enviado ao Congresso: ${law.n} (${tipo})`);
  S.leis.tram.push(item);
  return item;
}
function lawStage(l){
  if(l.tipo==='DL')return 'Plenário';
  if(l.mp)return 'MP em vigor, aguardando votação';
  const f=1-l.left/l.total;
  return f<.35?'Comissões (CCJ)':f<.7?'Plenário da Câmara':'Senado Federal';
}
function lawsStep(){
  for(const l of [...S.leis.tram]){
    l.left-=l.urg?2:1;
    if(l.left>0)continue;
    const v=vote(l);
    S.leis.tram=S.leis.tram.filter(x=>x!==l);
    const rec={n:l.n,tipo:l.tipo,m:S.m,ok:v.ok,cam:v.cam,sen:v.sen,nc:v.nc,ns:v.ns,by:v.by};
    S.leis.hist.unshift(rec);
    if(l.tipo==='DL'){
      if(v.ok){news(`Congresso autoriza guerra contra ${CBY[l.iso].n} (${v.cam} votos)`,'neg');startWar(l.iso,true)}
      else news(`Congresso nega autorização para guerra (${v.cam} votos a favor)`,'neu');
      continue;
    }
    if(l.revoga){
      if(v.ok){const idx=S.leis.vigor.findIndex(x=>x.id===l.revoga);if(idx>=0){const old=S.leis.vigor[idx];S.leis.vigor.splice(idx,1);undoLaw(old)}news(`Congresso aprova revogação: ${l.n.replace('Revogação: ','')}`,'neu')}
      else news(`Congresso rejeita a revogação de ${l.n.replace('Revogação: ','')}`,'neu');
      continue;
    }
    if(l.mp){
      const inV=S.leis.vigor.find(x=>x.uid===l.uid);
      if(v.ok){if(inV)inV.mpPending=false;news(`Congresso converte a MP “${l.n}” em lei (${v.cam} votos)`,'pos');applyLawOnce(l,.5)}
      else{if(inV){S.leis.vigor=S.leis.vigor.filter(x=>x!==inV);undoLaw(inV,.5)}news(`MP “${l.n}” cai no Congresso e perde a validade`,'neg');moodG({all:-2})}
      continue;
    }
    if(v.ok){
      news(`Aprovada: ${l.n} (${v.cam} votos na Câmara, ${v.sen} no Senado)`,'pos');
      S.leis.vigor.push({...l,since:S.m,prog:0});
      applyLawOnce(l,1);
      if((l.const??85)<60&&rnd()<(100-(l.const??85))/100*.8)S.sched.push({m:S.m+2+Math.floor(rnd()*4),id:'stf',uid:l.uid,n:l.n});
    }else{news(`Câmara rejeita ${l.n}: ${v.cam} votos, precisava de ${v.nc}`,'neg');moodG({all:-1.5})}
  }
  for(const l of S.leis.vigor){l.prog=Math.min(1,(l.prog||0)+1/6)}
}
function applyLawOnce(l,f){
  if(l.gr){const o={};for(const k in l.gr)o[k]=l.gr[k]*.5*f;moodG(o);for(const k in l.gr)S.lawG[k]=(S.lawG[k]||0)+l.gr[k]*.6*f}
  if(l.rel)for(const k in l.rel)relC(k,l.rel[k]*f,true);
  if(f>=.5&&l.flag){
    if(l.flag==='bcOff')S.flags.bcAut=false;
    if(l.flag==='bcOn')S.flags.bcAut=true;
    if(l.flag==='ftaUE')S.flags.ftaUE=true;
    if(l.flag==='nuke')S.flags.nuke=true;
    if(l.flag.startsWith('fta:'))S.c[l.flag.slice(4)].st='acordo';
    if(l.flag.startsWith('ali:'))S.c[l.flag.slice(4)].alianca=true;
  }
  if(l.fx&&l.fx.oneoff&&f>=1)oneOff(-l.fx.oneoff*S.e.pibNom*10);
  if(l.ev)S.sched.push({m:S.m+2,id:l.ev});
  S.lawIdeo=(S.lawIdeo||[]);S.lawIdeo.push({ideo:l.ideo||0,wt:f,cost:l.area==='Costumes'||l.area==='Segurança'?1.5:1});
}
function undoLaw(l,f=1){
  if(l.gr){const o={};for(const k in l.gr)o[k]=-l.gr[k]*.3*f;moodG(o);for(const k in l.gr)S.lawG[k]=(S.lawG[k]||0)-l.gr[k]*.5*f}
  if(l.flag==='bcOff')S.flags.bcAut=true;
  if(l.flag==='bcOn')S.flags.bcAut=false;
  if(l.flag==='ftaUE')S.flags.ftaUE=false;
  if(l.flag==='nuke')S.flags.nuke=false;
}

/* ---------- aprovação ---------- */
function agentsStep(){
  const e=S.e,p=S.pol,pi=S.pres.ideo;
  // mercado de trabalho
  const lf=A.filter(a=>a.st==='formal'||a.st==='informal'||a.st==='desempregado');
  const un=lf.filter(a=>a.st==='desempregado');
  const target=Math.round(lf.length*e.desemp/100);
  let diff=target-un.length;
  const tag=dateShort(S.m);
  const churn=Math.round(lf.length*.006);
  const emp=lf.filter(a=>a.st!=='desempregado');
  for(let k=0;k<Math.max(0,diff)+churn;k++){const a=pick(emp);if(a.st==='desempregado')continue;a.prevSt=a.st;a.st='desempregado';a.ocupPrev=a.ocup;a.ocup='procurando emprego';a.lost=3;a.hist.push('perdeu o emprego em '+tag);a.g=groupsOf(a)}
  const un2=A.filter(a=>a.st==='desempregado');
  for(let k=0;k<Math.max(0,-diff)+churn&&un2.length;k++){const i=Math.floor(rnd()*un2.length);const a=un2.splice(i,1)[0];a.st=rnd()<.45?'formal':'informal';setOcup(a);a.hist.push('arrumou emprego como '+a.ocup+' em '+tag);a.g=groupsOf(a)}
  // termos comuns
  const T={
    infl:-(e.ipca-3.5)*1.6, emp:-(e.desemp-6)*1.3, grow:(e.cresc-1.5), crime:-(e.crime-100)*.2,
    saude:(e.saude-50)*.25, educ:(e.educ-50)*.2, corr:-(e.corrup-35)*.3, amb:-(e.desmat-5800)/260,
    short:-e.shortIdx*.3, honey:8*Math.max(0,1-S.m/9),
    social:(pctPIB(p.g.social)-2.2)*14, sm:clamp(e.smReal*.9,-15,15),
    taxRich:-(p.tax.irpf-27.5)*.6-(p.tax.irpj-34)*.3, taxMid:-(p.tax.iva-26.5)*.7+(p.tax.isencao-5000)/1000*1.2, taxBiz:-(p.tax.irpj-34)*.8-(p.tax.folha-20)*.6,
    selic:-(e.selic-10)*.35
  };
  const laws=(S.lawIdeo||[]);
  for(const a of A){
    let t=50+a.pers*1.4+30*(.55-Math.abs(a.ideo-pi))+T.honey+S.moodAll+(S.moodR[a.reg]||0);
    t+=a.w.infl*T.infl*(a.d<5?1.3:.8);
    t+=a.w.emp*T.emp+(a.st==='desempregado'?-10:0)+(a.lost>0?-6:0);
    t+=(a.st==='empresario'||a.st==='agro'?T.grow*2.2:T.grow*.7);
    t+=a.w.crime*T.crime+a.w.saude*T.saude+a.w.educ*T.educ+a.w.corrup*T.corr+a.w.amb*T.amb+T.short*(a.d<5?1.3:.8);
    t+=a.benef?T.social:T.social*.12;
    if(a.d<3||a.st==='aposentado')t+=T.sm;
    if(a.d>=8)t+=T.taxRich*a.w.imp;
    if(a.d>=3&&a.d<8)t+=T.taxMid*a.w.imp;
    if(a.st==='empresario')t+=T.taxBiz;
    if(a.d>=4&&a.d<9)t+=T.selic;
    for(const g of a.g)t+=((S.moodG[g]||0)+(S.lawG[g]||0))*.8;
    for(const l of laws)t+=l.wt*l.cost*a.w.cost*(.45-Math.abs(a.ideo-l.ideo))*4;
    if(a.lost>0)a.lost--;
    a.sat+=(clamp(t,0,100)-a.sat)*.2+gauss()*1.2;
    a.sat=clamp(a.sat,0,100);
  }
  // decaimento
  for(const k in S.moodG)S.moodG[k]*=.88;
  for(const k in S.lawG)S.lawG[k]*=.985;
  for(const k in S.moodR)S.moodR[k]*=.88;
  S.moodAll*=.88;
  for(const l of laws)l.wt*=.97;
  S.lawIdeo=laws.filter(l=>l.wt>.05);
  approval();
}
function approval(){
  let b=0,r=0,m=0,v=0;
  for(const a of A){if(a.sat>=60)b++;else if(a.sat>=40)r++;else m++;if(a.sat>=51)v++}
  const n=A.length;S.ap={bom:b/n*100,reg:r/n*100,ruim:m/n*100};S.voto=v/n*100;
  S.prot=clamp(S.ap.ruim-45,0,60)*1.6;
}
function apBy(fn){const L=A.filter(fn);if(!L.length)return 0;return L.filter(a=>a.sat>=60).length/L.length*100}

/* ---------- histórico ---------- */
const HK=['cresc','ipca','desemp','selic','cambio','divida','primario','expIdx','pobreza','crime','conf','cred'];
function pushHist(){
  for(const k of HK){(S.hist[k]=S.hist[k]||[]).push(+S.e[k].toFixed(3))}
  (S.hist.ap=S.hist.ap||[]).push(+S.ap.bom.toFixed(1));
  (S.hist.ruim=S.hist.ruim||[]).push(+S.ap.ruim.toFixed(1));
  (S.hist.base=S.hist.base||[]).push(baseSeats());
}

/* ---------- eventos ---------- */
function news(t,tom){(S.newsM=S.newsM||[]).push({t,tom:tom||'neu'})}
const EVENTS={
 seca:{w:()=>[7,8,9,10].includes(S.m%12)?.05:.012,t:'Seca histórica no semiárido',d:'Reservatórios abaixo de 15% no Nordeste. Perda de safra e de gado; governadores pedem socorro federal.',
  ops:[{t:'Decretar calamidade e liberar R$ 12 bi',s:'Custo fiscal; alívio no Nordeste',f:()=>{oneOff(12);moodR('NE',9);moodG({pobres:4});pulse('item:cesta',1.2,6)}},
       {t:'Operação Carro-Pipa com o orçamento atual',s:'Sem custo extra; desgaste no Nordeste',f:()=>{moodR('NE',-9);pulse('item:cesta',2.4,6);pulse('cresc',-.25,6)}}]},
 enchente:{w:()=>[3,4,5].includes(S.m%12)?.03:.008,t:'Enchentes devastam o Rio Grande do Sul',d:'Mais de 400 mil desalojados, pontes e fábricas destruídas. O estado pede um plano de reconstrução.',
  ops:[{t:'Plano de reconstrução de R$ 25 bi',s:'Fora da meta fiscal; forte apoio no Sul',f:()=>{oneOff(25);moodR('S',12);pulse('cresc',.3,8)}},
       {t:'Ajuda emergencial de R$ 6 bi',s:'Mais barato; críticas de abandono',f:()=>{oneOff(6);moodR('S',-6);pulse('cresc',-.3,6)}},
       {t:'Enviar as Forças Armadas e a Defesa Civil',s:'Imagem de presença; custo menor',f:()=>{oneOff(3);moodR('S',3);moodG({militares:4})}}]},
 greve:{w:()=>(S.precos.combustivel.pi>7&&S.pol.precos.combustivel==='livre')?.12:.006,t:'Caminhoneiros anunciam greve nacional',d:'O diesel subiu e a categoria ameaça parar as estradas a partir de segunda-feira.',
  ops:[{t:'Subsidiar o diesel com dinheiro do Tesouro',s:'Combustível passa a ser subsidiado',f:()=>{S.pol.precos.combustivel='subsidio';S.last.precos.combustivel='subsidio';log('Diesel subsidiado após ameaça de greve')}},
       {t:'Criar tabela mínima de frete',s:'Agrada os caminhoneiros; irrita o agro e a indústria',f:()=>{pulse('infl',.25,12);moodG({agro:-6,empresarios:-4,trabalhadores:2});S.e.conf-=4}},
       {t:'Não negociar e liberar estradas com a PRF',s:'Risco de paralisação e desabastecimento',f:()=>{if(rnd()<.6){pulse('cresc',-4,1);pulse('item:cesta',4,2);moodG({all:-4});news('Greve dos caminhoneiros para o país por 9 dias','neg')}else{moodG({militares:3,empresarios:3});news('Greve dos caminhoneiros perde força','neu')}}}]},
 escandalo:{w:()=>S.e.corrup/900+S.cn.minist*.006,t:'Escândalo de corrupção em ministério',d:'A Polícia Federal encontra indícios de desvio de R$ 1,3 bi em contratos de um ministério controlado pelo Centrão.',
  ops:[{t:'Demitir o ministro e entregar tudo à PF',s:'Centrão se irrita; corrupção cai',f:()=>{S.cn.boost.ctr-=12;S.e.corrup-=5;moodG({all:2});if(S.cn.minist>0)S.cn.minist--}},
       {t:'Blindar o ministro',s:'Preserva a base; opinião pública reage mal',f:()=>{S.e.corrup+=8;moodG({all:-5,classe_media:-4})}},
       {t:'Apoiar a abertura de uma CPI',s:'Resultado imprevisível',f:()=>{if(rnd()<.5){S.e.corrup-=3;moodG({all:1})}else{moodG({all:-7});news('CPI aponta participação de assessores do Palácio','neg')}}}]},
 cambio:{w:()=>S.e.cred<42&&S.e.divida>85?.12:0,t:'Ataque especulativo contra o real',d:'Investidores estrangeiros fogem, o dólar dispara no dia e os juros futuros explodem.',
  ops:[{t:'Vender US$ 50 bi das reservas',s:'Segura o dólar no curto prazo',f:()=>{S.e.reservas-=50;pulse('cambio',-.08,4)}},
       {t:'Anunciar corte de 8% nos gastos discricionários',s:'Recupera credibilidade; desagrada quem depende de serviços',f:()=>{for(const g of GASTOS)S.pol.g[g.k]=Math.round(S.pol.g[g.k]*.92);S.last.g={...S.pol.g};S.e.cred+=10;moodG({pobres:-5,servidores:-6})}},
       {t:'Culpar o mercado e não fazer nada',s:'Dólar sobe mais',f:()=>{pulse('cambio',.15,6);S.e.cred-=6;moodG({pobres:1,empresarios:-6})}}]},
 pandemia:{w:()=>S.m>6?.0025:0,t:'Nova pandemia respiratória chega ao Brasil',d:'Um vírus de alta transmissão se espalha rapidamente. Hospitais das capitais já registram lotação.',
  ops:[{t:'Quarentena nacional por 3 meses',s:'Grande queda do PIB; menos mortes',f:()=>{pulse('cresc',-7,4);oneOff(120);moodG({empresarios:-10,aposentados:6})}},
       {t:'Medidas locais e vacinação rápida',s:'Equilíbrio',f:()=>{pulse('cresc',-2.5,4);oneOff(40);S.e.saude-=5}},
       {t:'Manter a economia funcionando',s:'Menor impacto econômico; muito mais mortes',f:()=>{pulse('cresc',-1,3);S.e.saude-=15;moodG({all:-9,aposentados:-8})}}]},
 china:{w:()=>.012,t:'Economia chinesa desacelera forte',d:'A demanda chinesa por soja e minério cai. Preços das commodities despencam.',
  ops:[{t:'Missão comercial à Ásia e ao Oriente Médio',s:'Melhora relações com Índia, Indonésia, Golfo',f:()=>{S.w.chinaG-=2;['356','360','392','682','784'].forEach(i=>relC(i,8));oneOff(.3)}},
       {t:'Linha de crédito de R$ 10 bi a exportadores',s:'Custo fiscal; alivia o agro',f:()=>{S.w.chinaG-=2.5;oneOff(10);moodG({agro:8})}},
       {t:'Esperar passar',s:'Nenhum custo imediato',f:()=>{S.w.chinaG-=2.8}}]},
 petroleo:{w:()=>.013,t:'Choque do petróleo',d:'Conflito no Golfo Pérsico fecha rotas marítimas. O barril sobe mais de 40% em uma semana.',
  ops:[{t:'Segurar os preços na estatal de petróleo',s:'Congela combustíveis; a estatal tem prejuízo',f:()=>{S.w.oil*=1.45;S.pol.precos.combustivel='congelado';S.last.precos.combustivel='congelado';S.e.cred-=5;log('Estatal segura preço dos combustíveis')}},
       {t:'Repassar o preço internacional',s:'Inflação sobe; mercado aprova',f:()=>{S.w.oil*=1.45;S.e.cred+=2}},
       {t:'Subsidiar só o diesel',s:'Custo fiscal',f:()=>{S.w.oil*=1.45;S.pol.precos.combustivel='subsidio';S.last.precos.combustivel='subsidio'}}]},
 presal:{w:()=>.008,t:'Descoberta gigante de petróleo na Margem Equatorial',d:'Reservas estimadas em 9 bilhões de barris na costa do Amapá. Há pressão ambiental e disputa sobre quem explora.',
  ops:[{t:'Leilão aberto a petroleiras estrangeiras',s:'Receita de ~R$ 60 bi agora',f:()=>{oneOff(-60);relC('840',5);relC('826',5);moodG({ambientalistas:-10,empresarios:6})}},
       {t:'Exploração exclusiva pela estatal',s:'Mais lento; ganho de longo prazo',f:()=>{S.leis.vigor.push({id:'estatal_pre',n:'Exploração estatal da Margem Equatorial',fx:{pot:.08,conf:-2},prog:0,since:S.m});moodG({trabalhadores:4,militares:4,ambientalistas:-10})}},
       {t:'Não explorar e proteger a área',s:'Apoio ambiental e da UE',f:()=>{relC('UE',8);moodG({ambientalistas:14,agro:-2,empresarios:-4})}}]},
 essequibo:{w:()=>S.m>3?.02:0,once:1,t:'Venezuela mobiliza tropas na fronteira com a Guiana',d:'Caracas reivindica o Essequibo e desloca blindados. A rota mais curta passa por Roraima.',
  ops:[{t:'Reforçar Roraima e negar passagem',s:'Venezuela reage mal; EUA e Guiana aprovam',f:()=>{oneOff(3);relC('862',-20,true);relC('328',15);relC('840',6);moodG({militares:6})}},
       {t:'Oferecer mediação brasileira',s:'Papel de liderança regional',f:()=>{relC('862',4);relC('328',-3);moodG({all:1})}},
       {t:'Declarar neutralidade',s:'Sem custos; Guiana e EUA desconfiam',f:()=>{relC('328',-10);relC('840',-6)}}]},
 refugiados:{w:()=>.015,t:'Nova onda de refugiados em Roraima',d:'Cerca de 2 mil pessoas por dia cruzam a fronteira em Pacaraima. Boa Vista pede ajuda federal.',
  ops:[{t:'Operação Acolhida ampliada (R$ 2 bi)',s:'Interiorização e abrigos',f:()=>{oneOff(2);moodR('N',-3);moodG({jovens:3})}},
       {t:'Fechar a fronteira temporariamente',s:'Popular no Norte; críticas internacionais',f:()=>{moodR('N',5);moodG({jovens:-4});relC('862',-5);relC('UE',-3)}}]},
 protestos:{w:()=>S.ap.ruim>55?.18:0,t:'Protestos em massa nas capitais',d:'Centenas de milhares de pessoas vão às ruas contra o governo em 20 capitais.',
  ops:[{t:'Anunciar pacote social de R$ 30 bi',s:'Acalma os mais pobres; custo fiscal',f:()=>{oneOff(30);moodG({pobres:8,classe_media:2});S.e.cred-=3}},
       {t:'Reforma ministerial e diálogo',s:'Troca de ministros; aproxima o Congresso',f:()=>{S.cn.boost.ctr+=8;S.cn.boost.cdir+=5;moodG({all:3})}},
       {t:'Decretar GLO e reprimir bloqueios',s:'Ordem nas ruas; imagem autoritária',f:()=>{S.mil.glo=3;moodG({militares:6,jovens:-10,all:-3})}}]},
 hacker:{w:()=>.008,t:'Ataque hacker derruba sistemas do governo',d:'O Pix e o sistema do INSS ficaram fora do ar por 14 horas. Dados de 40 milhões de brasileiros vazaram.',
  ops:[{t:'Criar Agência Nacional de Cibersegurança (R$ 3 bi)',s:'Custo; confiança recuperada',f:()=>{oneOff(3);moodG({all:1})}},
       {t:'Culpar um país estrangeiro',s:'Sem custo; tensão diplomática',f:()=>{relC(pick(['643','156','862']),-12);moodG({militares:3})}}]},
 servidores:{w:()=>.018,t:'Servidores federais entram em greve',d:'Professores de universidades, INSS e agências reguladoras pedem 12% de reajuste.',
  ops:[{t:'Dar 9% de reajuste',s:'+0,12% do PIB por ano em gastos',f:()=>{S.e.pessoalAdj+=.12;moodG({servidores:14})}},
       {t:'Dar 4,5% (reposição da inflação)',s:'+0,06% do PIB',f:()=>{S.e.pessoalAdj+=.06;moodG({servidores:3})}},
       {t:'Não dar reajuste',s:'Greve longa; serviços param',f:()=>{moodG({servidores:-14,aposentados:-4});S.e.saude-=2}}]},
 tarifa_eua:{w:()=>S.c['840'].rel<20?.06:0,t:'EUA anunciam tarifa de 50% sobre produtos brasileiros',d:'A Casa Branca cita “práticas comerciais desleais” e mira aço, suco, carne e aviões.',
  ops:[{t:'Aplicar a Lei da Reciprocidade',s:'Sobretaxa produtos americanos',f:()=>{S.c['840'].sancBR=.9;S.c['840'].st='sancao';relC('840',-15);moodG({militares:3,empresarios:-4})}},
       {t:'Negociar e zerar tarifas de tecnologia',s:'Importação de eletrônicos fica livre',f:()=>{S.c['840'].sancBR=.3;S.pol.imp.eletronicos='livre';relC('840',12)}},
       {t:'Recorrer à OMC',s:'Lento; sem retaliação',f:()=>{S.c['840'].sancBR=.7;relC('840',2)}}]},
 safra:{w:()=>[2,3,4].includes(S.m%12)?.05:0,t:'Safra recorde de grãos',d:'A Conab projeta 340 milhões de toneladas. O preço dos alimentos deve cair nos próximos meses.',
  ops:[{t:'Comemorar com o setor em Rio Verde',s:'Boa foto com o agro',f:()=>{pulse('cresc',.4,6);pulse('item:cesta',-1.5,8);moodG({agro:5})}},
       {t:'Anunciar estoques reguladores da Conab (R$ 4 bi)',s:'Protege o preço para o consumidor',f:()=>{oneOff(4);pulse('cresc',.4,6);pulse('item:cesta',-2.5,10);moodG({pobres:3,agro:-2})}}]},
 bigtech:{w:()=>0,t:'Big techs ameaçam suspender serviços no Brasil',d:'Três plataformas dizem que não vão cumprir a nova lei e podem sair do país. O governo americano apoia as empresas.',
  ops:[{t:'Manter a lei e multar quem descumprir',s:'Soberania digital; atrito com os EUA',f:()=>{relC('840',-10);moodG({jovens:-4,classe_media:2})}},
       {t:'Recuar e revogar a taxa digital',s:'Fim da crise; imagem de fraqueza',f:()=>{S.leis.vigor=S.leis.vigor.filter(l=>l.id!=='bigtech');relC('840',8);moodG({all:-2})}}]},
 stf:{w:()=>0,t:'STF suspende lei aprovada',d:'',
  ops:[{t:'Acatar a decisão',s:'Respeito às instituições',f:(ev)=>{S.leis.vigor=S.leis.vigor.filter(l=>l.uid!==ev.uid);moodG({all:1})}},
       {t:'Criticar o STF publicamente',s:'Anima a base; tensão institucional',f:(ev)=>{S.leis.vigor=S.leis.vigor.filter(l=>l.uid!==ev.uid);moodG({all:-2,militares:4});S.e.cred-=3}}]},
 guerra_ini:{w:()=>0,t:'O país está em guerra',d:'',
  ops:[{t:'Mobilização geral',s:'+45% de força; +0,5% do PIB em gastos',f:()=>{S.mil.mobil=1}},
       {t:'Guerra limitada',s:'Menor custo',f:()=>{S.mil.mobil=0}}]},
 nuclear:{w:()=>0,t:'Ameaça nuclear',d:'',
  ops:[{t:'Aceitar cessar-fogo imediato',s:'Encerra a guerra',f:(ev)=>{const w=S.wars.find(x=>x.iso===ev.iso);if(w)endWar(w,'paz')}},
       {t:'Ignorar a ameaça',s:'Risco extremo',f:(ev)=>{if(rnd()<.35){const w=S.wars.find(x=>x.iso===ev.iso);oneOff(400);moodG({all:-30});pulse('cresc',-10,6);news('Explosão nuclear tática atinge base militar brasileira','neg');if(w)endWar(w,'derrota')}}}]},
 impeachment:{w:()=>S.ap.bom<16&&baseSeats()<200&&(S.e.corrup>50||S.e.primario<-3)&&!S.impeach?.3:0,t:'Câmara abre processo de impeachment',d:'O presidente da Câmara aceita pedido de impeachment por crime de responsabilidade. São necessários 342 votos para afastar o Presidente.',
  ops:[{t:'Distribuir ministérios e emendas ao Centrão',s:'Reforça a defesa no plenário',f:()=>{S.cn.boost.ctr+=25;S.cn.minist+=2;oneOff(15);impeachVote()}},
       {t:'Convocar apoiadores às ruas',s:'Aposta na popularidade',f:()=>{moodG({all:3});impeachVote()}}]},
};
function impeachVote(){
  let yes=0;for(const b of BLOCOS_CN){const sup=S.cn.rel[b.k]+S.cn.boost[b.k];yes+=b.cam*clamp(1-(sup-15)/55+gauss()*.05,0,1)}
  yes=Math.round(yes);
  if(yes>=342){S.over={why:'impeachment',txt:`A Câmara aprovou o impeachment por ${yes} votos. O mandato termina em ${dateLbl(S.m)}.`}}
  else{S.impeach=true;news(`Impeachment é barrado na Câmara: ${yes} votos, eram necessários 342`,'pos')}
}
function eventsStep(){
  for(const s of [...S.sched])if(s.m<=S.m){S.sched=S.sched.filter(x=>x!==s);S.events.push({id:s.id,uid:s.uid,n:s.n})}
  let fired=0;
  for(const id in EVENTS){
    if(fired>=1)break;
    const ev=EVENTS[id];
    if(ev.once&&S.evUsed[id]!=null)continue;
    if(S.evUsed[id]!=null&&S.m-S.evUsed[id]<10)continue;
    if(rnd()<ev.w()){S.events.push({id});S.evUsed[id]=S.m;fired++}
  }
}
function resolveEvent(idx,opt){
  const ev=S.events[idx];const def=EVENTS[ev.id];
  def.ops[opt].f(ev);
  log(`Decisão sobre “${evTitle(ev)}”: ${def.ops[opt].t}`);
  S.events.splice(idx,1);
}
function evTitle(ev){if(ev.id==='stf')return `STF suspende “${ev.n}”`;if(ev.id==='guerra_ini')return `Guerra contra ${CBY[ev.iso].n}`;if(ev.id==='nuclear')return `${CBY[ev.iso].n} ameaça usar armas nucleares`;return EVENTS[ev.id].t}
function evDesc(ev){
  if(ev.id==='stf')return `Por 7 a 4, o Supremo considerou inconstitucional a lei “${ev.n}”. Os efeitos ficam suspensos.`;
  if(ev.id==='guerra_ini')return ev.aggr?`O Brasil está em guerra contra ${CBY[ev.iso].n}. Defina o tamanho do esforço de guerra.`:`${CBY[ev.iso].n} atacou posições brasileiras na fronteira. O país está em guerra.`;
  if(ev.id==='nuclear')return `Com suas tropas recuando, ${CBY[ev.iso].n} coloca o arsenal nuclear em alerta máximo e exige cessar-fogo em 48 horas.`;
  return EVENTS[ev.id].d;
}

/* ---------- mês ---------- */
function stepMonth(){
  S.log=S.log||[];S.newsM=S.newsM||[];
  policyChanges();
  tradeCalc();
  pricesStep();
  macroStep();
  socialStep();
  worldStep();
  warStep();
  lawsStep();
  congressStep();
  agentsStep();
  eventsStep();
  S.pulses.forEach(p=>p.left--);S.pulses=S.pulses.filter(p=>p.left>0);
  if(S.flags.ocde>0&&!S.flags.ocdeOn){if(S.e.cred>58)S.flags.ocde++;if(S.flags.ocde>=13){S.flags.ocdeOn=true;news('Brasil é aceito como membro pleno da OCDE','pos');S.e.conf+=6}}
  const decided=S.log.slice();
  S.summary=buildSummary(decided);
  S.lastLog=decided;
  S.m++;
  pushHist();
  // eleição
  if(ELECTIONS.includes(S.m-1)&&!S.over){
    const voto=clamp(S.voto+gauss()*2,0,100);
    S.election={m:S.m-1,voto};
    if(voto<50)S.over={why:'eleicao',txt:`Você teve ${fmtN(voto,1)}% dos votos válidos no segundo turno e perdeu a reeleição.`};
    else if(S.m-1===93)S.over={why:'fim',txt:`Você terminou dois mandatos com ${fmtN(S.ap.bom,0)}% de aprovação.`};
    else news(`Presidente é reeleito com ${fmtN(voto,1)}% dos votos válidos`,'pos');
  }
  S.log=[];
}
function buildSummary(dec){
  const h=S.hist,e=S.e;const L=[];
  const d=(k)=>h[k]&&h[k].length>1?e[k]-h[k][h[k].length-1]:0;
  if(Math.abs(d('ipca'))>.15)L.push(`Inflação ${d('ipca')>0?'subiu':'caiu'} para ${fmtN(e.ipca,1)}% em 12 meses.`);
  if(Math.abs(d('desemp'))>.1)L.push(`Desemprego ${d('desemp')>0?'subiu':'caiu'} para ${fmtN(e.desemp,1)}%.`);
  if(Math.abs(d('selic'))>=.25)L.push(`${S.flags.bcAut?'O Copom':'O governo'} ${d('selic')>0?'subiu':'cortou'} a Selic para ${fmtN(e.selic,2)}%.`);
  if(Math.abs(d('cambio'))>.12)L.push(`Dólar ${d('cambio')>0?'subiu':'caiu'} para R$ ${fmtN(e.cambio,2)}.`);
  if(e.shortIdx>15)L.push(`Há falta de produtos nas prateleiras (desabastecimento ${fmtN(e.shortIdx,0)}/100).`);
  return L;
}

/* ---------- ações de diplomacia e defesa ---------- */
const DIPLO={
  visita(iso){const st=S.c[iso];if(S.m-st.visit<3)return toast('Você visitou esse país recentemente.');st.visit=S.m;relC(iso,6+rnd()*5);oneOff(.2);log(`Visita de Estado: ${CBY[iso].n}`);toast(`Visita marcada a ${CBY[iso].n}. Relação melhora.`)},
  acordo(iso){const c=CBY[iso],st=S.c[iso];
    if(EU.includes(iso))return toast('Acordos com países da UE são negociados em bloco: use a lei “Ratificar o acordo Mercosul–UE”.');
    if(MERCOSUL.includes(iso)&&S.flags.mercosul)return toast('Já existe livre comércio pelo Mercosul.');
    if(S.leis.tram.some(l=>l.flag==='fta:'+iso))return toast('O acordo já está no Congresso.');
    const p=clamp((st.rel-15)/60,0,.95);
    if(rnd()>p){relC(iso,-2);log(`${c.n} recusou proposta de livre comércio`);return toast(`${c.n} recusou a proposta. Melhore a relação e tente de novo.`)}
    const indust=c.imp.maquinas>=.25||c.imp.eletronicos>=.2;
    submitLaw({id:'fta_'+iso,n:`Acordo de livre comércio Brasil–${c.n}`,tipo:'PL',ideo:.35,area:'Comércio',txt:`Zera tarifas entre Brasil e ${c.n} em 10 anos.`,fx:{pot:.05+c.pib/200000},gr:indust?{agro:8,trabalhadores:-6,empresarios:-3,classe_media:3}:{agro:4,empresarios:3},flag:'fta:'+iso});
    toast(`${c.n} aceitou. O acordo foi enviado ao Congresso.`)},
  normal(iso){const st=S.c[iso];if(atWar(iso))return toast('Estamos em guerra com esse país.');const was=st.st;st.st=MERCOSUL.includes(iso)&&S.flags.mercosul?'acordo':'normal';if(was==='sancao'||was==='embargo'){relC(iso,10);log(`Sanções contra ${CBY[iso].n} suspensas`)}},
  sancao(iso){S.c[iso].st='sancao';S.c[iso].retal=Math.max(S.c[iso].retal,.6);relC(iso,-30,true);log(`Sanções comerciais contra ${CBY[iso].n}`);moodG({empresarios:-2})},
  embargo(iso){S.c[iso].st='embargo';S.c[iso].retal=1;relC(iso,-50,true);log(`Embargo total contra ${CBY[iso].n}`);moodG({empresarios:-4})},
  ajuda(iso){relC(iso,10);oneOff(2);log(`Ajuda de R$ 2 bi a ${CBY[iso].n}`);toast(`R$ 2 bi em ajuda enviados a ${CBY[iso].n}.`)},
  expulsar(iso){relC(iso,-28,true);moodG({militares:2});log(`Embaixador de ${CBY[iso].n} expulso`);news(`Brasil expulsa embaixador de ${CBY[iso].n}`,'neg')},
  alianca(iso){const c=CBY[iso],st=S.c[iso];if(st.rel<55)return toast(`${c.n} só aceita aliança militar com relação acima de 55.`);if(S.leis.tram.some(l=>l.flag==='ali:'+iso))return toast('O tratado já está no Congresso.');
    const r={};if(['156','643','364'].includes(iso))r['840']=-18;if(iso==='840'){r['156']=-10;r['643']=-12}
    submitLaw({id:'ali_'+iso,n:`Tratado de defesa mútua com ${c.n}`,tipo:'PL',ideo:iso==='840'?.5:['156','643','364'].includes(iso)?-.5:0,area:'Defesa',txt:'Compromisso de defesa mútua em caso de agressão.',fx:{},gr:{militares:5},rel:r,flag:'ali:'+iso});toast('Tratado enviado ao Congresso.')},
  guerra(iso){if(atWar(iso))return;if(S.leis.tram.some(l=>l.tipo==='DL'&&l.iso===iso))return toast('O pedido já está no Congresso.');
    const c=CBY[iso],st=S.c[iso];
    const inc=clamp(15+(st.rel<-50?30:0)+(c.pers==='hostil'?15:0),5,90);
    submitLaw({id:'war_'+iso,iso,n:`Autorização para declarar guerra contra ${c.n}`,tipo:'DL',ideo:.5,apoio:{esq:inc-12,cesq:inc-6,ctr:inc,cdir:inc+6,dir:inc+10}});
    toast('Pedido de autorização enviado ao Congresso. A votação sai no próximo mês.')},
  paz(iso){const w=S.wars.find(x=>x.iso===iso);if(!w)return;const p=clamp(.15+w.score/180+w.months*.03,.02,.95);
    if(rnd()<p){if(w.score<0){oneOff(40);news(`Brasil aceita pagar indenização para encerrar a guerra`,'neg')}endWar(w,'paz')}else{toast(`${CBY[iso].n} recusou a proposta de paz.`);log('Proposta de paz recusada')}},
};
const PROGS={
  gripen:{n:'Mais 36 caças Gripen',cost:30,months:24,bonus:.08,done:'Força Aérea recebe o último lote de caças Gripen'},
  prosub:{n:'Submarino nuclear Álvaro Alberto',cost:22,months:36,bonus:.1,done:'Marinha lança o primeiro submarino de propulsão nuclear'},
  fronteira:{n:'Sisfron: vigilância das fronteiras',cost:10,months:24,bonus:.03,done:'Sisfron concluído: fronteiras sob monitoramento total'},
  drones:{n:'Esquadrão de drones de combate',cost:8,months:12,bonus:.05,done:'Exército recebe drones de combate nacionais'},
};

function fmtN(v,d=1){return Number(v).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d})}
