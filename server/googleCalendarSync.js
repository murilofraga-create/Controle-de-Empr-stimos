const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const { db, uid, addLogEntry, todayStr, shiftForTime } = require('./db');

const CREDENTIALS_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH
  || path.join(__dirname, 'credentials', 'google-service-account.json');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID
  || 'italo.br_aqfig3olpfjmm4fb904ges9t5g@group.calendar.google.com';

let warnedMissingCredentials = false;

// Formato do evento na agenda: "B401 PROF. KERSON 8:50 ás 11:35 MICROFONE"
// sala | professor/funcionário | horário (usamos o início pra achar o turno) | item
// O item vem como texto livre (sem validar contra o catálogo de itens) porque
// professores não escrevem de forma padronizada — diferente do lançamento
// manual, que só aceita itens já cadastrados.
const TIME_RANGE_RE = /(\d{1,2}:\d{2})\s*(?:ás|as|à|a|-|até)\s*(\d{1,2}:\d{2})/i;

function normalizeTime(hhmm) {
  const [h, m] = hhmm.split(':');
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  return `${hh}:${mm}`;
}

function parseEventTitle(title) {
  const text = (title || '').trim();
  if (!text) return null;

  const match = text.match(TIME_RANGE_RE);
  if (!match) return null;

  const beforeTime = text.slice(0, match.index).trim();
  const afterTime = text.slice(match.index + match[0].length).trim();
  const spaceIdx = beforeTime.indexOf(' ');
  if (spaceIdx === -1 || !afterTime) return null;

  const room = beforeTime.slice(0, spaceIdx).trim();
  const person = beforeTime.slice(spaceIdx + 1).trim();
  const startTime = normalizeTime(match[1]);
  if (!room || !person || !startTime) return null;

  return { room, person, item: afterTime, startTime };
}

function getAuthClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  const key = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

async function syncCalendarEvents() {
  const auth = getAuthClient();
  if (!auth) {
    if (!warnedMissingCredentials) {
      console.warn(`[agenda] Chave de conta de serviço não encontrada em ${CREDENTIALS_PATH} — sincronização com a Agenda desativada.`);
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

  for (const event of events) {
    if (!event.id || !event.start) continue;

    const exists = db.prepare('SELECT 1 FROM loans WHERE calendar_event_id = ?').get(event.id);
    if (exists) continue;

    const parsed = parseEventTitle(event.summary);
    if (!parsed) {
      addLogEntry('Sistema (Agenda)', 'Falha ao importar evento da agenda', `Não consegui interpretar o formato: "${event.summary || '(sem título)'}".`);
      continue;
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
      calendar_event_id: event.id,
    };

    db.prepare(`
      INSERT INTO loans (id, date, time, room, person, occurrence_type, item_name, category_name, shift, status, registered_by, registered_at, calendar_event_id)
      VALUES (@id, @date, @time, @room, @person, @occurrence_type, @item_name, @category_name, @shift, @status, @registered_by, @registered_at, @calendar_event_id)
    `).run(loan);

    addLogEntry('Sistema (Agenda)', 'Empréstimo importado da agenda', `${loan.item_name} para ${loan.person} (sala ${loan.room}, turno ${loan.shift}).`);
  }
}

module.exports = { syncCalendarEvents, parseEventTitle, CALENDAR_ID, CREDENTIALS_PATH };
