# Controle de Empréstimos

Aplicação web para registrar e controlar empréstimos de itens (projetores, etc.)
para professores/colaboradores, com dashboard, lista de empréstimos, log de
atividades e área de administração.

Arquitetura: servidor **Node.js + Express**, banco **SQLite** (`data/app.db`),
front-end estático em `public/`. Todos os dados ficam no servidor — qualquer
pessoa na rede acessa os mesmos dados pelo navegador.

## Rodar localmente (Windows)

1. Instale o [Node.js LTS](https://nodejs.org) (ou `winget install OpenJS.NodeJS.LTS`).
2. Nesta pasta, instale as dependências:
   ```
   npm install
   ```
3. Inicie o servidor:
   ```
   npm start
   ```
4. Abra `http://localhost:3000` no navegador.

Login padrão: usuário `admin`, senha `admin123` — troque assim que entrar
(botão "Trocar senha" no cabeçalho).

## Publicar na VM (acesso pela rede)

O código fica num repositório git privado — a VM clona de lá em vez de
receber a pasta copiada manualmente. Isso também deixa atualizações futuras
simples (ver "Atualizar a VM" abaixo).

1. Na VM, instale o [Git](https://git-scm.com/download/win) e o Node.js LTS
   (mesmo passo de "rodar localmente").
2. Clone o repositório:
   ```
   git clone <URL-do-repositório> C:\ControleEmprestimos
   cd C:\ControleEmprestimos
   ```
3. Instale as dependências (rodando direto na VM garante que qualquer parte
   nativa combine com o SO/arquitetura dela): `npm install`.
4. Defina um IP fixo (ou reserva de DHCP) para a VM, para o endereço não mudar.
5. Rode o servidor como **serviço do Windows**, para ele ficar de pé mesmo
   sem ninguém logado e voltar sozinho se a VM reiniciar. Usando
   [NSSM](https://nssm.cc/download):
   ```
   nssm install ControleEmprestimos
   ```
   Na janela do NSSM: "Path" = caminho completo do `node.exe`, "Arguments" =
   `server\server.js`, "Startup directory" = a pasta do projeto. Depois:
   ```
   nssm start ControleEmprestimos
   ```
6. Libere a porta no Firewall do Windows (padrão 3000):
   ```powershell
   New-NetFirewallRule -DisplayName "Controle Emprestimos" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
   ```
7. Nos computadores da rede, acesse `http://IP-DA-VM:3000` (ou pelo hostname,
   se ele resolver na rede interna).

### Opcional: acessar sem digitar a porta / preparar HTTPS

Coloque um proxy reverso (IIS com URL Rewrite, ou nginx) na frente, ouvindo
na porta 80/443 e repassando para `localhost:3000`. Isso também facilita
adicionar um certificado HTTPS depois, se quiser.

### Variáveis de ambiente (opcionais)

- `PORT` — porta do servidor (padrão `3000`).
- `SESSION_SECRET` — chave fixa para as sessões de login. Sem ela, uma chave
  aleatória é gerada a cada reinício do servidor e todo mundo precisa logar
  de novo; definindo um valor fixo, as sessões sobrevivem a reinícios.
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` — caminho do arquivo `.json` da conta de
  serviço do Google (ver "Sincronização com a Agenda" abaixo). Padrão:
  `server/credentials/google-service-account.json`.
- `GOOGLE_CALENDAR_ID` — ID da agenda do Google a sincronizar. Sem essa
  variável, usa o ID já configurado no código.

## Sincronização com a Agenda do Google

O servidor confere a agenda de salas a cada 15 minutos e importa
automaticamente os agendamentos do dia como empréstimos "Pendente" — sem
etapa de revisão manual. Cada evento é identificado pelo seu ID do Google
Calendar, então reimportações não duplicam o mesmo evento.

**Formato esperado no título do evento**: `SALA PROFESSOR HH:MM às HH:MM ITEM`
(ex.: `B401 PROF. KERSON 8:50 ás 11:35 MICROFONE`). O horário de início
determina o turno (mesma janela usada para calcular atraso); se cair numa
lacuna entre turnos, assume o turno seguinte mais próximo. A ocorrência é
sempre lançada como "Aula". O item entra como texto livre (sem precisar
existir no catálogo) — eventos cujo título não bate com esse formato são
ignorados e ficam registrados no Log de Atividades para conferência manual.

**Autenticação com o Google**: há duas formas, o servidor tenta OAuth primeiro
e cai para conta de serviço se os arquivos de OAuth não existirem.

### Opção A — OAuth com login próprio (recomendado quando não há acesso de
Super Admin do Workspace nem permissão pra compartilhar a agenda com "todos
os detalhes")

1. No Google Cloud Console (mesmo projeto onde a Calendar API foi ativada):
   **APIs e Serviços** → **Credenciais** → **Criar credenciais** →
   **ID do cliente OAuth** → tipo **"App para computador"**.
2. Baixe o JSON gerado e salve em `server/credentials/google-oauth-client.json`.
3. Rode a configuração única (abre o navegador pra você logar com a conta que
   já tem acesso à agenda):
   ```
   npm run setup:google-oauth
   ```
   Isso salva `server/credentials/google-oauth-token.json` — dali pra frente,
   o servidor usa esse token automaticamente (e o renova sozinho).

### Opção B — Conta de serviço (exige poder compartilhar a agenda com "ver
todos os detalhes do evento", ou um Super Admin autorizar Delegação em todo o
domínio no Workspace)

1. Criar uma **conta de serviço** no mesmo projeto e gerar uma chave **JSON**.
2. Compartilhar a agenda com o e-mail da conta de serviço (permissão "ver
   todos os detalhes do evento") **ou** autorizar Delegação em todo o domínio.
3. Salvar o arquivo `.json` da chave em `server/credentials/google-service-account.json`.

Em ambos os casos, `server/credentials/` já está fora do controle de versão
via `.gitignore` — nunca comitar esses arquivos. Sem nenhuma credencial
presente, o servidor apenas registra um aviso no console e segue funcionando
normalmente, com a sincronização desativada até algum dos arquivos ser
colocado no lugar.

## Atualizar a VM

Quando o código do repositório mudar, na VM:
```
cd C:\ControleEmprestimos
git pull
npm install
```
(o `npm install` só faz diferença se as dependências tiverem mudado — não tem
problema rodar sempre por garantia). Depois, reinicie o serviço:
```
nssm restart ControleEmprestimos
```
Os dados (`data/app.db`) não são afetados pelo `git pull` — esse arquivo não
faz parte do repositório (fica de fora via `.gitignore`), então fica intacto
entre atualizações.

## Backup

Os dados ficam em `data/app.db`. Como empréstimos com mais de 4 semanas já
são apagados automaticamente (ver abaixo), normalmente não é necessário
backup — mas se quiser manter histórico além disso, basta copiar esse arquivo
periodicamente enquanto o serviço estiver parado (ou usar `data/app.db` junto
com os arquivos `-wal`/`-shm`, se existirem).

## Limpeza semanal (retenção de 4 semanas)

Todo domingo, o servidor apaga permanentemente apenas os empréstimos que já
completaram 4 semanas — sempre mantendo as últimas 4 semanas de dados. Ex.:
ao começar a semana 4, a semana 1 é apagada; ao começar a semana 5, a semana
2 é apagada; e assim por diante. O log de atividades registra cada limpeza,
incluindo quantos registros foram removidos. Diferente da versão anterior
(só no navegador), isso agora roda de verdade mesmo sem ninguém com o app
aberto, porque o processo do servidor fica no ar continuamente.
