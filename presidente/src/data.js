/* ================= DADOS DE PARTIDA =================
   Valores aproximados de 2024-2026 (FMI WEO, Banco Mundial, IBGE, BCB, SIPRI, MDIC/Comex Stat).
   Comércio = exportações/importações do Brasil com o país, US$ bi/ano. */

const SECT = [
  {k:'agro',       n:'Agro e alimentos',        exp:.40, imp:.06, ind:0},
  {k:'minerio',    n:'Minério e metais',        exp:.15, imp:.07, ind:0},
  {k:'petroleo',   n:'Petróleo e combustíveis', exp:.16, imp:.12, ind:0},
  {k:'quimica',    n:'Fertilizantes e química', exp:.04, imp:.20, ind:1},
  {k:'maquinas',   n:'Máquinas e equipamentos', exp:.13, imp:.20, ind:1},
  {k:'veiculos',   n:'Veículos e peças',        exp:.07, imp:.09, ind:1},
  {k:'eletronicos',n:'Eletrônicos e tecnologia',exp:.03, imp:.17, ind:1},
  {k:'farma',      n:'Medicamentos',            exp:.02, imp:.07, ind:1},
];
const TARIFF = {livre:0, padrao:11.5, alta:35, proibido:100};
const TARIFF_N = {livre:'Livre (0%)', padrao:'TEC padrão (11,5%)', alta:'Protecionista (35%)', proibido:'Proibir importação'};
const EXPPOL_N = {livre:'Livre', taxa:'Imposto de exportação 15%', proibido:'Proibir exportação'};

const PROF = {
  chn:{eletronicos:.38,maquinas:.30,quimica:.17,veiculos:.10,minerio:.05},
  eua:{maquinas:.30,petroleo:.25,quimica:.20,farma:.10,eletronicos:.15},
  ind:{maquinas:.35,eletronicos:.20,veiculos:.20,quimica:.15,farma:.10},
  ene:{petroleo:.75,quimica:.25},
  fert:{quimica:.65,petroleo:.35},
  agr:{agro:.50,veiculos:.25,quimica:.10,petroleo:.15},
  chl:{minerio:.60,agro:.30,quimica:.10},
  mix:{maquinas:.25,quimica:.25,agro:.15,farma:.15,veiculos:.20},
  // o que o Brasil vende
  x_chn:{agro:.50,minerio:.25,petroleo:.25},
  x_eua:{petroleo:.20,maquinas:.30,minerio:.20,agro:.20,veiculos:.10},
  x_lat:{veiculos:.30,maquinas:.30,agro:.15,quimica:.10,petroleo:.10,eletronicos:.05},
  x_eur:{agro:.40,minerio:.20,petroleo:.25,maquinas:.15},
  x_asi:{agro:.45,minerio:.35,petroleo:.20},
  x_mid:{agro:.80,minerio:.20},
};

// iso, nome, lat, lng, PIB US$bi, pop mi, gasto militar US$bi, regime, blocos, relação inicial, exp BR→, imp BR←, perfil imp, perfil exp, personalidade, nuclear, vizinho, ideologia
const C_RAW = [
 ['840','Estados Unidos',38.9,-77.0,29200,340,997,'Democracia presidencialista',['OTAN','G7','G20'],45,40.3,40.6,'eua','x_eua','potência',1,0,.3],
 ['156','China',39.9,116.4,18700,1409,314,'Partido único',['BRICS','G20'],55,94.4,63.6,'chn','x_chn','potência',1,0,-.3],
 ['032','Argentina',-34.6,-58.4,633,46,2.8,'Democracia presidencialista',['Mercosul','G20'],35,13.8,13.6,'agr','x_lat','comercial',0,1,.6],
 ['276','Alemanha',52.5,13.4,4660,84,88.5,'Democracia parlamentar',['UE','OTAN','G7','G20'],50,5.8,13.1,'ind','x_eur','comercial',0,0,0],
 ['528','Países Baixos',52.4,4.9,1230,18,23,'Monarquia parlamentar',['UE','OTAN'],45,12.0,3.5,'mix','x_eur','comercial',0,0,0],
 ['724','Espanha',40.4,-3.7,1730,48,24.6,'Monarquia parlamentar',['UE','OTAN'],50,9.8,4.9,'mix','x_eur','comercial',0,0,-.1],
 ['250','França',48.9,2.35,3160,68,64.7,'Semipresidencialismo',['UE','OTAN','G7','G20'],45,3.3,7.0,'ind','x_eur','potência',1,1,0],
 ['380','Itália',41.9,12.5,2370,59,38,'Democracia parlamentar',['UE','OTAN','G7','G20'],50,4.5,6.3,'ind','x_eur','comercial',0,0,.3],
 ['620','Portugal',38.7,-9.14,300,10.6,5,'Democracia parlamentar',['UE','OTAN'],65,2.5,1.4,'mix','x_eur','comercial',0,0,0],
 ['826','Reino Unido',51.5,-0.1,3640,69,81.8,'Monarquia parlamentar',['OTAN','G7','G20'],45,3.6,3.5,'mix','x_eur','potência',1,0,-.1],
 ['643','Rússia',55.75,37.6,2160,144,149,'Autocracia',['BRICS','G20'],35,1.5,11.0,'fert','x_eur','expansionista',1,0,.3],
 ['356','Índia',28.6,77.2,3910,1450,86,'Democracia parlamentar',['BRICS','G20'],45,5.3,7.2,'mix','x_asi','comercial',1,0,.3],
 ['392','Japão',35.7,139.7,4030,124,55,'Monarquia parlamentar',['G7','G20'],50,5.1,5.0,'ind','x_asi','comercial',0,0,.2],
 ['410','Coreia do Sul',37.6,127.0,1870,52,47.6,'Democracia presidencialista',['G20'],45,4.0,5.5,'ind','x_asi','comercial',0,0,0],
 ['484','México',19.4,-99.1,1850,130,16.7,'Democracia presidencialista',['G20'],45,7.5,5.8,'mix','x_lat','comercial',0,0,-.3],
 ['124','Canadá',45.4,-75.7,2240,41,29,'Monarquia parlamentar',['OTAN','G7','G20'],45,5.0,3.8,'fert','x_eua','comercial',0,0,-.1],
 ['152','Chile',-33.45,-70.67,330,20,5.6,'Democracia presidencialista',[],55,7.9,5.3,'chl','x_lat','comercial',0,0,.4],
 ['600','Paraguai',-25.3,-57.6,43,6.9,.5,'Democracia presidencialista',['Mercosul'],60,4.2,3.4,'agr','x_lat','aliado',0,1,.5],
 ['858','Uruguai',-34.9,-56.2,80,3.4,1.2,'Democracia presidencialista',['Mercosul'],65,2.2,1.9,'agr','x_lat','aliado',0,1,-.3],
 ['068','Bolívia',-16.5,-68.15,49,12.4,.6,'Democracia presidencialista',['Mercosul'],50,1.6,1.3,'ene','x_lat','aliado',0,1,.2],
 ['862','Venezuela',10.5,-66.9,100,28,.9,'Autocracia',[],5,1.1,.1,'ene','x_lat','hostil',0,1,-.7],
 ['170','Colômbia',4.7,-74.1,418,52.7,15.9,'Democracia presidencialista',[],50,2.3,1.6,'ene','x_lat','comercial',0,1,-.2],
 ['604','Peru',-12.05,-77.04,290,34,3.4,'Democracia presidencialista',[],45,2.4,1.9,'chl','x_lat','comercial',0,1,.2],
 ['218','Equador',-0.18,-78.47,125,18,2.6,'Democracia presidencialista',[],50,1.0,.3,'ene','x_lat','comercial',0,0,.4],
 ['328','Guiana',6.8,-58.15,25,.8,.1,'Democracia',[],50,.3,.1,'ene','x_lat','pequeno',0,1,0],
 ['682','Arábia Saudita',24.7,46.7,1100,33,80,'Monarquia absoluta',['G20'],40,3.2,4.0,'ene','x_mid','comercial',0,0,.5],
 ['784','Emirados Árabes',24.45,54.4,540,10,25,'Monarquia federativa',['BRICS'],45,3.0,2.5,'ene','x_mid','comercial',0,0,.4],
 ['364','Irã',35.7,51.4,400,91,7.9,'Teocracia',['BRICS'],25,3.0,.1,'ene','x_mid','hostil',0,0,.6],
 ['818','Egito',30.05,31.25,390,116,5,'Autocracia',['BRICS'],45,2.3,.3,'fert','x_mid','comercial',0,0,.3],
 ['710','África do Sul',-25.7,28.2,400,64,2.8,'Democracia parlamentar',['BRICS','G20'],55,1.2,.9,'mix','x_mid','aliado',0,0,-.3],
 ['566','Nigéria',9.06,7.5,250,230,1.3,'Democracia presidencialista',[],40,.8,1.6,'ene','x_mid','comercial',0,0,0],
 ['804','Ucrânia',50.45,30.5,190,38,65,'Democracia (em guerra)',[],30,.3,.2,'agr','x_eur','comercial',0,0,0],
 ['376','Israel',31.8,35.2,540,10,46.5,'Democracia parlamentar',[],15,.7,1.0,'ind','x_mid','militarista',1,0,.5],
 ['792','Turquia',39.9,32.85,1320,86,25,'Presidencialismo autoritário',['OTAN','G20'],45,2.0,1.5,'mix','x_mid','comercial',0,0,.4],
 ['036','Austrália',-35.3,149.1,1800,27,33,'Monarquia parlamentar',['G20'],45,1.0,1.5,'chl','x_asi','comercial',0,0,0],
 ['360','Indonésia',-6.2,106.8,1400,280,16,'Democracia presidencialista',['BRICS','G20'],50,3.8,2.0,'mix','x_asi','comercial',0,0,.1],
];
const EU = ['276','528','724','250','380','620'];
const MERCOSUL = ['032','600','858','068'];

const BLOCS = [
  {k:'Mercosul', col:'#E2B54E'},
  {k:'BRICS', col:'#C8553D'},
  {k:'UE', col:'#4F7FC0'},
  {k:'OTAN', col:'#6FAFD0'},
];

// Congresso: cadeiras e ideologia média (-1 esquerda … +1 direita)
const BLOCOS_CN = [
  {k:'esq',  n:'Esquerda',       cam:128, sen:20, ideo:-.8, col:'#C8553D'},
  {k:'cesq', n:'Centro-esquerda',cam:57,  sen:9,  ideo:-.4, col:'#D98B6A'},
  {k:'ctr',  n:'Centrão',        cam:176, sen:28, ideo:.15, col:'#A99A74'},
  {k:'cdir', n:'Centro-direita', cam:62,  sen:12, ideo:.45, col:'#7FA0B8'},
  {k:'dir',  n:'Direita',        cam:90,  sen:12, ideo:.85, col:'#4F7FC0'},
];

const GROUPS = {
  pobres:'Mais pobres', classe_media:'Classe média', ricos:'Mais ricos', empresarios:'Empresários',
  agro:'Agronegócio', servidores:'Servidores públicos', trabalhadores:'Trabalhadores formais',
  evangelicos:'Evangélicos', jovens:'Jovens (até 29)', aposentados:'Aposentados',
  militares:'Militares e policiais', ambientalistas:'Ambientalistas'
};

const PRECOS = [
  {k:'combustivel', n:'Combustíveis', w:.055},
  {k:'energia',     n:'Energia elétrica', w:.04},
  {k:'cesta',       n:'Alimentos (cesta básica)', w:.21},
  {k:'aluguel',     n:'Aluguéis', w:.04},
  {k:'remedios',    n:'Medicamentos', w:.03},
  {k:'transporte',  n:'Transporte público', w:.02},
];

// Orçamento federal (R$ bi/ano em 2027, PIB ≈ R$ 13,6 tri)
const GASTOS = [
  {k:'saude',n:'Saúde', v:250, min:120, max:520},
  {k:'educacao',n:'Educação', v:190, min:90, max:450},
  {k:'social',n:'Programas sociais (Bolsa Família, BPC)', v:300, min:120, max:650},
  {k:'seguranca',n:'Segurança pública', v:20, min:5, max:120},
  {k:'defesa',n:'Defesa', v:140, min:60, max:420},
  {k:'infra',n:'Infraestrutura e obras', v:90, min:20, max:320},
  {k:'ciencia',n:'Ciência e tecnologia', v:25, min:5, max:120},
  {k:'ambiente',n:'Meio ambiente', v:8, min:2, max:60},
];

/* ---------- Leis prontas ----------
 efeitos: receita/gasto (%PIB), pot (pp crescimento potencial), infl (pp), desemp (pp), conf, cred, crime (%), desmat (%), pobreza (pp), saude, educ, corrup
 grupos: humor −30…30   rel: relação com países (iso ou 'UE') */
const LEIS = [
 {id:'irpf_ricos', n:'Imposto mínimo sobre altas rendas', tipo:'PL', ideo:-.5, area:'Tributos',
  txt:'Cria alíquota mínima efetiva de 12% para rendas acima de R$ 1,2 milhão/ano, incluindo lucros e dividendos.',
  fx:{receita:.35,conf:-4,pobreza:-.3}, gr:{ricos:-22,empresarios:-12,pobres:6,trabalhadores:4,classe_media:2}},
 {id:'fortunas', n:'Imposto sobre grandes fortunas', tipo:'PLP', ideo:-.8, area:'Tributos',
  txt:'Tributa em 1,5% ao ano patrimônios acima de R$ 10 milhões.',
  fx:{receita:.25,conf:-8,cred:-3,pot:-.1}, gr:{ricos:-30,empresarios:-15,pobres:7,jovens:5}},
 {id:'previdencia', n:'Reforma da Previdência 2.0', tipo:'PEC', ideo:.6, area:'Previdência',
  txt:'Idade mínima de 67 anos para homens e 64 para mulheres, fim de regimes especiais e desvinculação parcial do salário mínimo.',
  fx:{gasto:-.6,cred:12,conf:8,pot:.1}, gr:{aposentados:-18,servidores:-20,trabalhadores:-12,pobres:-6,empresarios:12,ricos:6}},
 {id:'bc', n:'Revogar a autonomia do Banco Central', tipo:'PLP', ideo:-.6, area:'Juros',
  txt:'Devolve ao Presidente o poder de demitir a diretoria do BC. A Selic passa a ser definida pelo governo.',
  fx:{cred:-18,conf:-8}, gr:{empresarios:-12,ricos:-10,trabalhadores:3}, flag:'bcOff'},
 {id:'bc_on', n:'Restaurar a autonomia do Banco Central', tipo:'PLP', ideo:.4, area:'Juros',
  txt:'Mandatos fixos e desalinhados para a diretoria do BC.',
  fx:{cred:14,conf:5}, gr:{empresarios:8,ricos:6}, flag:'bcOn'},
 {id:'privat', n:'Programa Nacional de Privatizações', tipo:'PL', ideo:.8, area:'Estado',
  txt:'Autoriza a venda do controle de Correios, EBC, Serpro e participação em distribuidoras de energia.',
  fx:{cred:8,conf:10,pot:.12,desemp:.15,oneoff:.5}, gr:{servidores:-18,trabalhadores:-8,empresarios:14,ricos:8}},
 {id:'escala', n:'Fim da escala 6×1 (jornada de 36h)', tipo:'PEC', ideo:-.6, area:'Trabalho',
  txt:'Reduz a jornada máxima para 36 horas semanais e garante dois dias de folga.',
  fx:{pot:-.15,desemp:.3,infl:.3,conf:-10}, gr:{trabalhadores:22,jovens:18,pobres:10,empresarios:-25,agro:-10}},
 {id:'armas', n:'Ampliação do porte de armas', tipo:'PL', ideo:.9, area:'Segurança',
  txt:'Facilita a compra e o porte de armas para civis com mais de 25 anos.',
  fx:{crime:4}, gr:{militares:14,agro:12,evangelicos:6,ambientalistas:-6,jovens:-6,classe_media:-3}},
 {id:'desarme', n:'Estatuto do Desarmamento reforçado', tipo:'PL', ideo:-.7, area:'Segurança',
  txt:'Recadastramento obrigatório, restrição a clubes de tiro e recompra de armas.',
  fx:{crime:-4}, gr:{militares:-10,agro:-12,jovens:6,classe_media:3}},
 {id:'cannabis', n:'Regulamentação da cannabis', tipo:'PL', ideo:-.6, area:'Costumes',
  txt:'Permite cultivo e venda regulada de cannabis para uso medicinal e adulto, com imposto específico.',
  fx:{receita:.05,crime:-2}, gr:{jovens:14,evangelicos:-24,militares:-10,aposentados:-6}},
 {id:'desmat', n:'Desmatamento Zero até 2030', tipo:'PL', ideo:-.5, area:'Ambiente',
  txt:'Proíbe supressão de vegetação nativa na Amazônia e no Cerrado, com fiscalização por satélite e embargo de áreas.',
  fx:{desmat:-45,pot:-.05}, gr:{ambientalistas:25,jovens:8,agro:-24}, rel:{UE:14,'840':4}},
 {id:'mercosul_ue', n:'Ratificar o acordo Mercosul–UE', tipo:'PL', ideo:.2, area:'Comércio',
  txt:'Ratifica o acordo de livre comércio entre Mercosul e União Europeia.',
  fx:{pot:.15,conf:6,desemp:.05}, gr:{agro:14,empresarios:4,trabalhadores:-5}, rel:{UE:15}, flag:'ftaUE'},
 {id:'renda_basica', n:'Renda Básica Universal', tipo:'PL', ideo:-.7, area:'Social',
  txt:'Pagamento mensal de R$ 300 a todo adulto com renda familiar abaixo de 3 salários mínimos.',
  fx:{gasto:1.5,pobreza:-4,infl:.4,cred:-10}, gr:{pobres:28,jovens:10,classe_media:-4,ricos:-10,empresarios:-8}},
 {id:'arcabouco', n:'Novo teto de gastos', tipo:'PEC', ideo:.6, area:'Contas públicas',
  txt:'Despesas só podem crescer 70% da inflação nos próximos 10 anos, com gatilhos automáticos de corte.',
  fx:{gasto:-.4,cred:16,conf:8}, gr:{servidores:-14,pobres:-8,empresarios:10,ricos:8}},
 {id:'integral', n:'Escola em tempo integral para todos', tipo:'PL', ideo:-.2, area:'Educação',
  txt:'Universaliza o ensino médio integral até 2030 com complementação federal.',
  fx:{gasto:.3,educ:10}, gr:{jovens:12,classe_media:6,pobres:6}},
 {id:'bigtech', n:'Regulação das plataformas digitais', tipo:'PL', ideo:-.3, area:'Tecnologia',
  txt:'Responsabiliza redes sociais por conteúdo impulsionado e cria taxa digital de 3% sobre receita de big techs.',
  fx:{receita:.04,conf:-2}, gr:{jovens:-6,classe_media:2,evangelicos:-4}, rel:{'840':-18}, ev:'bigtech'},
 {id:'nuclear', n:'Programa de enriquecimento nuclear militar', tipo:'PL', ideo:.5, area:'Defesa',
  txt:'Autoriza a Marinha a enriquecer urânio acima de 20% para propulsão naval e dissuasão.',
  fx:{gasto:.1}, gr:{militares:18,ambientalistas:-15}, rel:{'840':-25,'032':-15,UE:-10,'156':-4,'643':6}, flag:'nuke'},
 {id:'reforma_agraria', n:'Reforma agrária acelerada', tipo:'PL', ideo:-.8, area:'Terra',
  txt:'Desapropria latifúndios improdutivos para assentar 400 mil famílias.',
  fx:{gasto:.15,pobreza:-.6,conf:-6}, gr:{agro:-28,pobres:10,empresarios:-6}},
 {id:'carbono', n:'Mercado regulado de carbono', tipo:'PL', ideo:-.1, area:'Ambiente',
  txt:'Teto de emissões para indústria e venda de créditos de carbono florestal.',
  fx:{receita:.05,desmat:-12,pot:.03}, gr:{ambientalistas:12,agro:-5,empresarios:-3}, rel:{UE:8}},
 {id:'distrital', n:'Voto distrital misto', tipo:'PEC', ideo:.2, area:'Política',
  txt:'Metade da Câmara eleita por distritos e metade por lista partidária a partir de 2030.',
  fx:{corrup:-5}, gr:{classe_media:4}},
 {id:'servico', n:'Serviço militar obrigatório de 18 meses', tipo:'PL', ideo:.7, area:'Defesa',
  txt:'Amplia o alistamento para todos os jovens de 18 anos, com opção de serviço civil.',
  fx:{gasto:.2,desemp:-.3,mil:.15}, gr:{jovens:-22,militares:14,aposentados:4}},
 {id:'dolar', n:'Comércio com moedas locais no BRICS', tipo:'PL', ideo:-.3, area:'Comércio',
  txt:'Autoriza liquidar comércio com parceiros do BRICS sem passar pelo dólar.',
  fx:{conf:-2}, gr:{}, rel:{'156':12,'643':10,'840':-20}},
];

const NOMES_M = ['José','João','Antônio','Francisco','Carlos','Paulo','Pedro','Lucas','Luiz','Marcos','Gabriel','Rafael','Daniel','Marcelo','Bruno','Eduardo','Felipe','Raimundo','Rodrigo','Anderson','Thiago','Gustavo','Matheus','Diego','Wellington','Edson','Cícero','Sebastião','Jefferson','Kauã','Davi','Arthur'];
const NOMES_F = ['Maria','Ana','Francisca','Antônia','Adriana','Juliana','Márcia','Fernanda','Patrícia','Aline','Sandra','Camila','Amanda','Bruna','Jéssica','Letícia','Júlia','Luciana','Vanessa','Mariana','Gabriela','Raimunda','Tatiane','Beatriz','Larissa','Rosângela','Débora','Kelly','Isabela','Sofia','Valéria','Cláudia'];
const SOBRENOMES = ['Silva','Santos','Oliveira','Souza','Rodrigues','Ferreira','Alves','Pereira','Lima','Gomes','Costa','Ribeiro','Martins','Carvalho','Almeida','Lopes','Soares','Fernandes','Vieira','Barbosa','Rocha','Dias','Nascimento','Andrade','Moreira','Nunes','Marques','Machado','Mendes','Freitas','Cardoso','Teixeira','Araújo','Cavalcanti','Monteiro','Batista'];
const REGIOES = {
  N:{n:'Norte',   p:.086, cid:['Manaus','Belém','Porto Velho','Macapá','Rio Branco','Santarém','Palmas','Boa Vista','Ananindeua']},
  NE:{n:'Nordeste',p:.268, cid:['Salvador','Recife','Fortaleza','São Luís','Teresina','Natal','Maceió','João Pessoa','Caruaru','Feira de Santana','Juazeiro do Norte','Aracaju','Petrolina','Mossoró']},
  CO:{n:'Centro-Oeste',p:.080, cid:['Goiânia','Brasília','Cuiabá','Campo Grande','Rio Verde','Sorriso','Anápolis','Rondonópolis','Dourados']},
  SE:{n:'Sudeste',p:.418, cid:['São Paulo','Rio de Janeiro','Belo Horizonte','Campinas','Guarulhos','Duque de Caxias','São Gonçalo','Uberlândia','Vitória','Ribeirão Preto','Contagem','Osasco','Juiz de Fora','Santos','Sorocaba']},
  S:{n:'Sul',     p:.148, cid:['Porto Alegre','Curitiba','Florianópolis','Joinville','Caxias do Sul','Londrina','Chapecó','Maringá','Pelotas','Blumenau','Cascavel','Passo Fundo']},
};
const OCUP = {
  formal:[[0,4,['operador de caixa','auxiliar de produção','atendente de telemarketing','repositor de supermercado','auxiliar de limpeza','motorista de ônibus','vigilante','cozinheira de restaurante']],[4,8,['técnica de enfermagem','metalúrgico','analista administrativo','vendedor de concessionária','professora da rede privada','eletricista industrial','bancário','supervisor de logística']],[8,10,['engenheira','gerente de banco','médica','advogado corporativo','desenvolvedor de software','diretor comercial']]],
  informal:[[0,5,['ambulante','diarista','entregador de aplicativo','pedreiro','manicure','catador de recicláveis','feirante','motorista de aplicativo']],[5,10,['motorista de aplicativo','cabeleireira','mecânico autônomo','corretor de imóveis','designer freelancer']]],
  servidor:[[0,10,['professora da rede estadual','agente de saúde','técnico do INSS','enfermeira do SUS','auditor fiscal','servidora da prefeitura']]],
  empresario:[[0,10,['dono de mercadinho','dona de salão de beleza','empresário do varejo','dono de transportadora','industrial têxtil','dona de restaurante']]],
  agro:[[0,5,['trabalhador rural','pequeno agricultor','vaqueiro','meeiro']],[5,10,['produtor de soja','pecuarista','cafeicultor','dono de cooperativa']]],
};
