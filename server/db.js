const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// node:sqlite é nativo do Node (22.5+, sem flag a partir da v23) — evita
// depender de um módulo com binário compilado (ex.: better-sqlite3), que
// falha para instalar em versões de Node muito recentes sem prebuild pronto.
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'colaborador'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS loans (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    room TEXT NOT NULL,
    person TEXT NOT NULL,
    occurrence_type TEXT NOT NULL,
    item_name TEXT NOT NULL,
    category_name TEXT NOT NULL,
    shift TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Pendente', 'Emprestado', 'Devolvido')),
    registered_by TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    delivered_by TEXT,
    delivered_at TEXT,
    returned_by TEXT,
    returned_at TEXT,
    calendar_event_id TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Marca linhas de descrição de eventos da Agenda já processadas (importadas
  -- com sucesso ou não), pra não reprocessar/relogar a cada ciclo de sync.
  -- Independente da tabela loans, pra não poluir a lista de empréstimos com
  -- registros falsos só de controle.
  CREATE TABLE IF NOT EXISTS calendar_synced_lines (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
`);

// Migração leve para bancos criados antes da sincronização com a Agenda:
// CREATE TABLE IF NOT EXISTS não altera uma tabela já existente.
const loanColumns = db.prepare('PRAGMA table_info(loans)').all().map(c => c.name);
if (!loanColumns.includes('calendar_event_id')) {
  db.exec('ALTER TABLE loans ADD COLUMN calendar_event_id TEXT');
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    db.prepare(`
      INSERT INTO users (id, name, username, password_hash, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(uid('user'), 'Administrador', 'admin', bcrypt.hashSync('admin123', 10), 'admin');
  }
}

// ---------- Turnos e cálculo de atraso ----------
// Um item entra em atraso no instante em que o turno SEGUINTE ao que ele foi
// emprestado começa (não quando o dia muda). Ex.: Madrugada atrasa às 08:30
// (início do Matutino); Noturno atrasa às 05:15 do dia seguinte.
const SHIFTS = ['Madrugada', 'Matutino', 'Vespertino', 'Noturno'];
const SHIFT_TIMES = {
  Madrugada: { start: '05:15', end: '08:30' },
  Matutino: { start: '08:30', end: '11:30' },
  Vespertino: { start: '11:30', end: '18:00' },
  Noturno: { start: '18:30', end: '22:30' },
};

function getOverdueThreshold(dateStr, shift) {
  const idx = SHIFTS.indexOf(shift);
  const nextShift = SHIFTS[(idx + 1) % SHIFTS.length];
  const wrapsToNextDay = idx === SHIFTS.length - 1;
  const threshold = new Date(`${dateStr}T${SHIFT_TIMES[nextShift].start}:00`);
  if (wrapsToNextDay) threshold.setDate(threshold.getDate() + 1);
  return threshold;
}

function isLoanOverdue(loan) {
  if (loan.status === 'Devolvido') return false;
  return new Date() >= getOverdueThreshold(loan.date, loan.shift);
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Turno pelo horário de início de um evento (ex.: importado da agenda). Se o
// horário cair numa lacuna entre dois turnos (ex.: 18:00–18:30), assume o
// turno cujo início está mais próximo em seguida, cronologicamente.
function shiftForTime(hhmm) {
  const minutes = timeToMinutes(hhmm);
  for (const shift of SHIFTS) {
    const start = timeToMinutes(SHIFT_TIMES[shift].start);
    const end = timeToMinutes(SHIFT_TIMES[shift].end);
    if (minutes >= start && minutes < end) return shift;
  }
  let best = SHIFTS[0];
  let bestDiff = Infinity;
  for (const shift of SHIFTS) {
    const start = timeToMinutes(SHIFT_TIMES[shift].start);
    let diff = start - minutes;
    if (diff < 0) diff += 24 * 60;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = shift;
    }
  }
  return best;
}

function todayStr() {
  return dateStrWithOffset(0);
}

function dateStrWithOffset(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Log de atividades ----------

function addLogEntry(user, action, details) {
  db.prepare(`
    INSERT INTO activity_log (id, timestamp, user, action, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(uid('log'), new Date().toISOString(), user, action, details || '');
}

function listLog() {
  return db.prepare('SELECT * FROM activity_log ORDER BY timestamp DESC').all();
}

// ---------- Limpeza semanal (retenção de 4 semanas) ----------
// Roda periodicamente enquanto o servidor estiver de pé (ver server.js).
// Diferente da versão só-no-navegador, isso agora funciona de verdade mesmo
// sem ninguém com o app aberto, porque o processo do servidor fica no ar 24h.
//
// Em vez de apagar tudo, todo domingo remove só os empréstimos que já
// completaram 4 semanas: com semanas numeradas 1,2,3,4,5..., ao começar a
// semana 4 apaga a semana 1; ao começar a semana 5 apaga a semana 2; e assim
// por diante. Isso equivale a apagar tudo que é anterior a "hoje - 14 dias"
// (2 semanas antes do início da semana atual, já que a semana atual conta
// como uma das 4 mantidas junto com as 3 anteriores).
const RETENTION_WEEKS = 4;

function runWeeklyCleanupIfNeeded() {
  const isSunday = new Date().getDay() === 0;
  const today = todayStr();
  const lastCleanup = db.prepare("SELECT value FROM meta WHERE key = 'lastCleanupDate'").get();
  if (isSunday && (!lastCleanup || lastCleanup.value !== today)) {
    const cutoff = dateStrWithOffset(-(RETENTION_WEEKS - 2) * 7);
    const removed = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date < ?').get(cutoff).n;
    db.prepare('DELETE FROM loans WHERE date < ?').run(cutoff);
    db.prepare(`
      INSERT INTO meta (key, value) VALUES ('lastCleanupDate', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(today);
    addLogEntry('Sistema (automático)', 'Limpeza semanal', `${removed} registro(s) de empréstimo anteriores a ${cutoff} removido(s) permanentemente (retenção de ${RETENTION_WEEKS} semanas).`);
  }
}

module.exports = {
  db,
  uid,
  seedIfEmpty,
  addLogEntry,
  listLog,
  runWeeklyCleanupIfNeeded,
  isLoanOverdue,
  getOverdueThreshold,
  shiftForTime,
  todayStr,
  SHIFTS,
  SHIFT_TIMES,
};
