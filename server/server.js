const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const {
  db, uid, seedIfEmpty, addLogEntry, listLog, runWeeklyCleanupIfNeeded,
  isLoanOverdue, todayStr, SHIFTS,
} = require('./db');
const { syncCalendarEvents } = require('./googleCalendarSync');

seedIfEmpty();
runWeeklyCleanupIfNeeded();
setInterval(runWeeklyCleanupIfNeeded, 15 * 60 * 1000); // confere a cada 15 min; só age de fato no domingo

syncCalendarEvents().catch(err => console.error('[agenda]', err));
setInterval(() => syncCalendarEvents().catch(err => console.error('[agenda]', err)), 15 * 60 * 1000);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  // Sem SESSION_SECRET definido, a chave é gerada a cada início do servidor
  // e todo mundo precisa logar de novo após um restart — aceitável para o
  // tamanho desta aplicação. Defina a variável de ambiente para persistir sessões entre reinícios.
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000, // 12h
  },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

function sanitizeUser(user) {
  return { id: user.id, name: user.name, username: user.username, role: user.role };
}

function getSessionUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ message: 'Não autenticado.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Acesso restrito a administradores.' });
  next();
}

// ---------- Autenticação ----------

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(String(username || '').trim());

  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    addLogEntry(user ? user.name : (username || '(desconhecido)'), 'Falha de login', user ? 'Senha incorreta.' : 'Usuário não encontrado.');
    return res.status(401).json({ message: 'Usuário ou senha inválidos.' });
  }

  req.session.userId = user.id;
  addLogEntry(user.name, 'Login', '');
  res.json({ user: sanitizeUser(user) });
});

app.post('/api/logout', (req, res) => {
  const user = getSessionUser(req);
  if (user) addLogEntry(user.name, 'Logout', '');
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.post('/api/me/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!bcrypt.compareSync(String(currentPassword || ''), req.user.password_hash)) {
    return res.status(400).json({ message: 'Senha atual incorreta.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 10), req.user.id);
  addLogEntry(req.user.name, 'Alteração de senha', 'Usuário alterou a própria senha.');
  res.json({ ok: true });
});

// ---------- Colaboradores (admin) ----------

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY name').all().map(sanitizeUser);
  res.json({ users });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password || !['admin', 'colaborador'].includes(role)) {
    return res.status(400).json({ message: 'Dados inválidos.' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  if (exists) return res.status(409).json({ message: 'Já existe um usuário com esse nome de usuário.' });

  const id = uid('user');
  db.prepare('INSERT INTO users (id, name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(id, name.trim(), username.trim(), bcrypt.hashSync(password, 10), role);
  addLogEntry(req.user.name, 'Cadastro de colaborador', `${name.trim()} (${username.trim()}) cadastrado como ${role}.`);
  res.status(201).json({ user: sanitizeUser({ id, name, username, role }) });
});

app.post('/api/users/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ message: 'Usuário não encontrado.' });
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ message: 'Informe a nova senha.' });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), target.id);
  addLogEntry(req.user.name, 'Redefinição de senha', `Senha de ${target.name} redefinida.`);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ message: 'Usuário não encontrado.' });
  if (target.id === req.user.id) return res.status(400).json({ message: 'Você não pode excluir seu próprio usuário.' });
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (adminCount <= 1) return res.status(400).json({ message: 'Não é possível excluir o único administrador restante.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  addLogEntry(req.user.name, 'Exclusão de colaborador', target.name);
  res.json({ ok: true });
});

// ---------- Categorias ----------

app.get('/api/categories', requireAuth, (req, res) => {
  res.json({ categories: db.prepare('SELECT * FROM categories ORDER BY name').all() });
});

app.post('/api/categories', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: 'Informe o nome da categoria.' });
  const exists = db.prepare('SELECT 1 FROM categories WHERE LOWER(name) = LOWER(?)').get(name);
  if (exists) return res.status(409).json({ message: 'Já existe uma categoria com esse nome.' });

  const id = uid('cat');
  db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(id, name);
  addLogEntry(req.user.name, 'Cadastro de categoria', name);
  res.status(201).json({ category: { id, name } });
});

app.delete('/api/categories/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ message: 'Categoria não encontrada.' });
  db.prepare('DELETE FROM categories WHERE id = ?').run(target.id);
  addLogEntry(req.user.name, 'Exclusão de categoria', target.name);
  res.json({ ok: true });
});

// ---------- Itens ----------

app.get('/api/items', requireAuth, (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM items ORDER BY name').all() });
});

app.post('/api/items', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const categoryName = String(req.body.categoryName || '').trim();
  if (!name || !categoryName) return res.status(400).json({ message: 'Informe nome e categoria do item.' });

  const id = uid('item');
  db.prepare('INSERT INTO items (id, name, category_name) VALUES (?, ?, ?)').run(id, name, categoryName);
  addLogEntry(req.user.name, 'Cadastro de item', `${name} (${categoryName})`);
  res.status(201).json({ item: { id, name, category_name: categoryName } });
});

app.delete('/api/items/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ message: 'Item não encontrado.' });
  db.prepare('DELETE FROM items WHERE id = ?').run(target.id);
  addLogEntry(req.user.name, 'Exclusão de item', target.name);
  res.json({ ok: true });
});

// ---------- Empréstimos ----------

app.get('/api/loans', requireAuth, (req, res) => {
  const loans = db.prepare('SELECT * FROM loans ORDER BY registered_at DESC').all()
    .map(l => ({ ...l, overdue: isLoanOverdue(l) }));
  res.json({ loans });
});

app.post('/api/loans', requireAuth, (req, res) => {
  const { room, person, occurrenceType, itemId, shift } = req.body;
  if (!room || !person || !occurrenceType || !itemId || !SHIFTS.includes(shift)) {
    return res.status(400).json({ message: 'Dados inválidos.' });
  }
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return res.status(400).json({ message: 'Item não encontrado.' });

  const now = new Date();
  const id = uid('loan');
  const loan = {
    id,
    date: todayStr(),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    room: room.trim(),
    person: person.trim(),
    occurrence_type: occurrenceType,
    item_name: item.name,
    category_name: item.category_name,
    shift,
    status: 'Pendente',
    registered_by: req.user.name,
    registered_at: now.toISOString(),
  };
  db.prepare(`
    INSERT INTO loans (id, date, time, room, person, occurrence_type, item_name, category_name, shift, status, registered_by, registered_at)
    VALUES (@id, @date, @time, @room, @person, @occurrence_type, @item_name, @category_name, @shift, @status, @registered_by, @registered_at)
  `).run(loan);
  addLogEntry(req.user.name, 'Cadastro de empréstimo', `${loan.item_name} para ${loan.person} (sala ${loan.room}, turno ${loan.shift}).`);
  res.status(201).json({ loan: { ...loan, overdue: false } });
});

app.post('/api/loans/:id/deliver', requireAuth, (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ message: 'Empréstimo não encontrado.' });
  const now = new Date().toISOString();
  db.prepare('UPDATE loans SET status = ?, delivered_by = ?, delivered_at = ? WHERE id = ?')
    .run('Emprestado', req.user.name, now, loan.id);
  addLogEntry(req.user.name, 'Entrega registrada', `${loan.item_name} entregue a ${loan.person}.`);
  res.json({ ok: true });
});

app.post('/api/loans/:id/return', requireAuth, (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ message: 'Empréstimo não encontrado.' });
  const now = new Date().toISOString();
  db.prepare('UPDATE loans SET status = ?, returned_by = ?, returned_at = ? WHERE id = ?')
    .run('Devolvido', req.user.name, now, loan.id);
  addLogEntry(req.user.name, 'Baixa de empréstimo', `${loan.item_name} recolhido de ${loan.person}.`);
  res.json({ ok: true });
});

app.delete('/api/loans/:id', requireAuth, (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ message: 'Empréstimo não encontrado.' });
  db.prepare('DELETE FROM loans WHERE id = ?').run(loan.id);
  addLogEntry(req.user.name, 'Exclusão de empréstimo', `${loan.item_name} de ${loan.person} removido manualmente.`);
  res.json({ ok: true });
});

// ---------- Dashboard ----------

app.get('/api/dashboard', requireAuth, (req, res) => {
  const loans = db.prepare('SELECT * FROM loans').all();
  const today = todayStr();
  res.json({
    emprestados: loans.filter(l => l.status === 'Emprestado').length,
    atrasados: loans.filter(isLoanOverdue).length,
    pendentesHoje: loans.filter(l => l.status === 'Pendente' && l.date === today).length,
  });
});

// ---------- Log de atividades (admin) ----------

app.get('/api/log', requireAuth, requireAdmin, (req, res) => {
  res.json({ log: listLog() });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Erro interno no servidor.' });
});

app.listen(PORT, () => {
  console.log(`Controle de Empréstimos rodando em http://localhost:${PORT}`);
});
