// Service worker mínimo: só existe pra o app poder ser instalado na tela inicial.
// Não guarda cache das telas — as encomendas precisam vir sempre atualizadas do
// servidor, senão um porteiro veria a lista que o outro já mudou.
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(){});
