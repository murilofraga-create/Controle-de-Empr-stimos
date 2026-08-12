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
