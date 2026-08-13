// Script de configuração única do OAuth com o Google Calendar.
// Roda localmente (precisa abrir um navegador): node server/scripts/setup-google-oauth.js
//
// Pré-requisito: baixar o JSON da credencial OAuth (tipo "App para computador")
// no Google Cloud Console e salvar em server/credentials/google-oauth-client.json.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');

const CREDENTIALS_DIR = path.join(__dirname, '..', 'credentials');
const CLIENT_PATH = path.join(CREDENTIALS_DIR, 'google-oauth-client.json');
const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'google-oauth-token.json');
const PORT = 53682;
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

if (!fs.existsSync(CLIENT_PATH)) {
  console.error(`Não encontrei ${CLIENT_PATH}.`);
  console.error('Baixe o JSON da credencial OAuth (tipo "App para computador") no Google Cloud Console → Credenciais, e salve nesse caminho.');
  process.exit(1);
}

const clientConfig = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
const config = clientConfig.installed || clientConfig.web;
if (!config) {
  console.error('Formato de credencial OAuth não reconhecido (esperava "installed" ou "web").');
  process.exit(1);
}

const redirectUri = `http://localhost:${PORT}`;
const oAuth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, redirectUri);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\nAbra esta URL no navegador e faça login com a conta que já tem acesso à agenda:\n');
console.log(authUrl);
console.log('\nAguardando autorização...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('Nenhum código recebido. Pode fechar esta aba.');
    return;
  }
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.end('Autorizado! Pode fechar esta aba e voltar ao terminal.');
    console.log(`Token salvo em ${TOKEN_PATH}.`);
    console.log('Pronto — reinicie o servidor (ou aguarde o próximo ciclo de 15 min) para a sincronização começar.');
  } catch (err) {
    res.end('Erro ao trocar o código por token: ' + err.message);
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(PORT);
