// Service worker do app Vi Atendimento (16/11/2026). Escopo só /whatsapp (o Pages tira o .html do endereço): o painel não
// passa por aqui. Não guarda nada em cache de propósito (conversa velha na tela faria a equipe
// responder em cima de mensagem que já mudou); existe para o celular aceitar instalar o app
// e, na etapa 4, para receber o aviso de mensagem nova com o app fechado.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
