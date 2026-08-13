const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const { db, uid, addLogEntry, todayStr, shiftForTime } = require('./db');

const CREDENTIALS_DIR = path.join(__dirname, 'credentials');
const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH
  || path.join(CREDENTIALS_DIR, 'google-service-account.json');
const OAUTH_CLIENT_PATH = process.env.GOOGLE_OAUTH_CLIENT_PATH
  || path.join(CREDENTIALS_DIR, 'google-oauth-client.json');
const OAUTH_TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN_PATH
  || path.join(CREDENTIALS_DIR, 'google-oauth-token.json');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID
  || 'italo.br_aqfig3olpfjmm4fb904ges9t5g@group.calendar.google.com';
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

let warnedMissingCredentials = false;

// A descrição de um evento pode conter VÁRIOS agendamentos (um por linha,
// separados por <br>), em HTML, com variações reais observadas no formato:
//   "A107 - AULA - Prof. LUISA - 8:50 ás 11:35 (NOTE BOOK)"
//   "B104  PROF. KERSON 8:50 ás 11:35 MICROFONE"
//   "B201  Aula profª Laura  15h ás 17hs (CX.SOM e CABO P2P10)"
// sala | (opcional "AULA"/traços de separação, ignorados) | professor/funcionário
// | horário (com ":" ou só "Xh"/"Xhs"; usamos o início pra achar o turno) | item
// (entre parênteses quando presente, senão o texto que sobra). O item vem
// como texto livre (sem validar contra o catálogo) porque quem preenche a
// agenda não escreve de forma padronizada — diferente do lançamento manual,
// que só aceita itens já cadastrados.
const TIME_TOKEN = '\\d{1,2}(?::\\d{2})?\\s*h?s?';
const TIME_RANGE_RE = new RegExp(`(${TIME_TOKEN})\\s*(?:ás|as|à|a|-|até)\\s*(${TIME_TOKEN})`, 'i');

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ');
}

function normalizeTime(raw) {
  const cleaned = raw.trim().toLowerCase();
  const colonMatch = cleaned.match(/^(\d{1,2}):(\d{2})/);
  if (colonMatch) {
    const hh = colonMatch[1].padStart(2, '0');
    const mm = colonMatch[2];
    if (Number(hh) > 23 || Number(mm) > 59) return null;
    return `${hh}:${mm}`;
  }
  const hourMatch = cleaned.match(/^(\d{1,2})\s*h/);
  if (hourMatch) {
    const hh = hourMatch[1].padStart(2, '0');
    if (Number(hh) > 23) return null;
    return `${hh}:00`;
  }
  return null;
}

function parseBookingLine(rawLine) {
  const text = rawLine.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const match = text.match(TIME_RANGE_RE);
  if (!match) return null;

  let beforeTime = text.slice(0, match.index).trim();
  const afterTime = text.slice(match.index + match[0].length).trim();

  // remove ruído comum antes do horário: "AULA" e traços usados como separador
  beforeTime = beforeTime.replace(/\bAULA\b/gi, ' ').replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();

  const spaceIdx = beforeTime.indexOf(' ');
  if (spaceIdx === -1) return null;
  const room = beforeTime.slice(0, spaceIdx).trim();
  const person = beforeTime.slice(spaceIdx + 1).trim();

  const parenMatch = afterTime.match(/\(([^)]+)\)/);
  const item = (parenMatch ? parenMatch[1] : afterTime).trim();

  const startTime = normalizeTime(match[1]);
  if (!room || !person || !item || !startTime) return null;

  return { room, person, item, startTime };
}

// Um evento pode ter mais de um agendamento na descrição — cada linha vira
// um item potencial da lista retornada.
function parseEventDescription(description) {
  return stripHtml(description)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseBookingLine);
}

// Preferimos OAuth (login da própria pessoa que já enxerga a agenda) porque
// nem sempre é possível compartilhar a agenda com a conta de serviço no nível
// "todos os detalhes", nem autorizar delegação em todo o domínio (exige
// Super Admin do Workspace). Se os arquivos de OAuth não existirem, cai para
// conta de serviço como alternativa.
function getAuthClient() {
  if (fs.existsSync(OAUTH_CLIENT_PATH) && fs.existsSync(OAUTH_TOKEN_PATH)) {
    const clientConfig = JSON.parse(fs.readFileSync(OAUTH_CLIENT_PATH, 'utf8'));
    const { client_id, client_secret, redirect_uris } = clientConfig.installed || clientConfig.web || {};
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris && redirect_uris[0]);
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH, 'utf8')));
    return oAuth2Client;
  }
  if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    const key = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    return new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES });
  }
  return null;
}

async function syncCalendarEvents() {
  const auth = getAuthClient();
  if (!auth) {
    if (!warnedMissingCredentials) {
      console.warn(`[agenda] Nenhuma credencial encontrada (OAuth em ${OAUTH_TOKEN_PATH} ou conta de serviço em ${SERVICE_ACCOUNT_PATH}) — sincronização com a Agenda desativada.`);
      warnedMissingCredentials = true;
    }
    return;
  }

  const calendar = google.calendar({ version: 'v3', auth });
  const today = todayStr();
  const timeMin = new Date(`${today}T00:00:00`).toISOString();
  const timeMax = new Date(`${today}T23:59:59`).toISOString();

  let events;
  try {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });
    events = res.data.items || [];
  } catch (err) {
    addLogEntry('Sistema (Agenda)', 'Falha na sincronização com a Agenda', err.message);
    return;
  }

  const markLineSeen = (eventLineId) => {
    db.prepare('INSERT OR IGNORE INTO calendar_synced_lines (id, created_at) VALUES (?, ?)').run(eventLineId, new Date().toISOString());
  };
  const lineAlreadySeen = (eventLineId) => Boolean(db.prepare('SELECT 1 FROM calendar_synced_lines WHERE id = ?').get(eventLineId));

  for (const event of events) {
    if (!event.id || !event.start) continue;

    const parsedLines = parseEventDescription(event.description);
    if (parsedLines.length === 0) {
      const eventLineId = `${event.id}#0`;
      if (!lineAlreadySeen(eventLineId)) {
        markLineSeen(eventLineId);
        addLogEntry('Sistema (Agenda)', 'Falha ao importar evento da agenda', `Não consegui interpretar o formato: "${event.summary || '(sem descrição)'}".`);
      }
      continue;
    }

    parsedLines.forEach((parsed, index) => {
      const eventLineId = `${event.id}#${index}`;
      if (lineAlreadySeen(eventLineId)) return;
      markLineSeen(eventLineId);

      if (!parsed) {
        addLogEntry('Sistema (Agenda)', 'Falha ao importar evento da agenda', `Não consegui interpretar o formato: "${event.summary || '(sem título)'}" (linha ${index + 1} da descrição).`);
        return;
      }

      const shift = shiftForTime(parsed.startTime);
      const loan = {
        id: uid('loan'),
        date: today,
        time: parsed.startTime,
        room: parsed.room,
        person: parsed.person,
        occurrence_type: 'Aula',
        item_name: parsed.item,
        category_name: '',
        shift,
        status: 'Pendente',
        registered_by: 'Sistema (Agenda)',
        registered_at: new Date().toISOString(),
        calendar_event_id: eventLineId,
      };

      db.prepare(`
        INSERT INTO loans (id, date, time, room, person, occurrence_type, item_name, category_name, shift, status, registered_by, registered_at, calendar_event_id)
        VALUES (@id, @date, @time, @room, @person, @occurrence_type, @item_name, @category_name, @shift, @status, @registered_by, @registered_at, @calendar_event_id)
      `).run(loan);

      addLogEntry('Sistema (Agenda)', 'Empréstimo importado da agenda', `${loan.item_name} para ${loan.person} (sala ${loan.room}, turno ${loan.shift}).`);
    });
  }
}

module.exports = { syncCalendarEvents, parseEventDescription, parseBookingLine, CALENDAR_ID, SERVICE_ACCOUNT_PATH, OAUTH_CLIENT_PATH, OAUTH_TOKEN_PATH };
