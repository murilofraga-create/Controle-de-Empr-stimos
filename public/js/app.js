let currentUser = null;
let currentTab = 'cadastro';
let loansCache = [];
let logCache = [];
let usersCache = [];
let categoriesCache = [];
let itemsCache = [];
let comboFilterShift, comboFilterCategory, comboFilterStatus, comboLogUser, comboLogAction;

document.addEventListener('DOMContentLoaded', async () => {
  bindLoginForm();
  bindHeader();
  bindLoanForm();
  bindFilters();
  bindPrintButtons();
  bindAdminForms();
  bindPasswordDialog();
  bindThemeToggle();
  bindLogFilters();

  try {
    const { user } = await api('GET', '/api/me');
    currentUser = user;
    showApp(user);
  } catch {
    showLogin();
  }
});

// ---------- Cliente da API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo de resposta */ }
  if (!res.ok) {
    throw new Error((data && data.message) || 'Erro na requisição.');
  }
  return data;
}

// ---------- Combo (filtro com busca) ----------
// Input de texto + lista de sugestões sobre um <input type="hidden"> que guarda
// o valor real usado pelos filtros. Ao perder o foco, só aceita o texto se ele
// bater exatamente (sem diferenciar maiúsculas) com uma das opções válidas —
// caso contrário volta pro último valor válido, sem deixar "finalizar" um
// filtro com um valor que não existe na lista.
function createCombo(rootId) {
  const root = document.getElementById(rootId);
  const input = root.querySelector('.combo-input');
  const hidden = root.querySelector('input[type="hidden"]');
  const menu = root.querySelector('.combo-menu');
  let options = [];
  let highlighted = -1;

  function currentLabel() {
    const opt = options.find(o => o.value === hidden.value);
    return opt ? opt.label : '';
  }

  function renderMenu() {
    const query = input.value.trim().toLowerCase();
    const matches = options.filter(o => o.label.toLowerCase().includes(query));
    menu.innerHTML = matches.length
      ? matches.map((o, i) => `<div class="combo-option${i === highlighted ? ' highlighted' : ''}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</div>`).join('')
      : '<div class="combo-empty">Nenhum resultado</div>';
    menu.hidden = false;
  }

  function closeMenu() {
    menu.hidden = true;
    highlighted = -1;
  }

  function commit(value) {
    const changed = hidden.value !== value;
    hidden.value = value;
    input.value = currentLabel();
    closeMenu();
    if (changed) hidden.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function revert() {
    input.value = currentLabel();
    closeMenu();
  }

  input.addEventListener('focus', () => { input.select(); renderMenu(); });
  input.addEventListener('input', () => { highlighted = -1; renderMenu(); });
  input.addEventListener('blur', () => {
    const query = input.value.trim().toLowerCase();
    const exact = options.find(o => o.label.toLowerCase() === query);
    if (exact) commit(exact.value);
    else revert();
  });
  input.addEventListener('keydown', (e) => {
    if (menu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      renderMenu();
      return;
    }
    const visible = [...menu.querySelectorAll('.combo-option')];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, visible.length - 1);
      renderMenu();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      renderMenu();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const query = input.value.trim().toLowerCase();
      const byHighlight = visible[highlighted] ? visible[highlighted].dataset.value : undefined;
      const byExactText = options.find(o => o.label.toLowerCase() === query);
      const target = byHighlight !== undefined ? byHighlight : (byExactText ? byExactText.value : undefined);
      if (target !== undefined) commit(target);
      else revert();
    } else if (e.key === 'Escape') {
      revert();
      input.blur();
    }
  });
  menu.addEventListener('mousedown', (e) => {
    e.preventDefault(); // evita que o input perca o foco antes do clique registrar
    const item = e.target.closest('.combo-option');
    if (item) commit(item.dataset.value);
  });

  return {
    setOptions(newOptions) {
      options = newOptions;
      if (!options.some(o => o.value === hidden.value)) {
        hidden.value = options[0] ? options[0].value : '';
      }
      input.value = currentLabel();
    },
    selectValue(value, { silent } = {}) {
      hidden.value = value;
      input.value = currentLabel();
      if (!silent) hidden.dispatchEvent(new Event('input', { bubbles: true }));
    },
  };
}

// ---------- Tema claro/escuro ----------

function bindThemeToggle() {
  const btn = document.getElementById('theme-toggle-btn');
  updateThemeIcon();
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('loanapp_theme', next);
    updateThemeIcon();
  });
}

function updateThemeIcon() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.getElementById('theme-toggle-btn').textContent = isDark ? '☀️' : '🌙';
}

// O botão fica fixo no canto (tela de login, sem header) ou dentro do
// header, junto de "Trocar senha"/"Sair" (tela do app) — evita que ele
// fique sobreposto ao botão "Sair" quando os dois disputam o canto superior direito.
function moveThemeToggleToHeader() {
  const btn = document.getElementById('theme-toggle-btn');
  btn.classList.remove('theme-toggle');
  btn.classList.add('btn', 'small', 'ghost');
  document.getElementById('theme-toggle-slot').appendChild(btn);
}

function moveThemeToggleToCorner() {
  const btn = document.getElementById('theme-toggle-btn');
  btn.classList.remove('btn', 'small', 'ghost');
  btn.classList.add('theme-toggle');
  document.body.insertBefore(btn, document.body.firstChild);
}

// ---------- Login / sessão ----------

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
  moveThemeToggleToCorner();
}

function showApp(user) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  document.getElementById('current-user-name').textContent = `${user.name} (${user.role === 'admin' ? 'Admin' : 'Colaborador'})`;
  document.getElementById('nav-admin').style.display = user.role === 'admin' ? '' : 'none';
  document.getElementById('nav-log').style.display = user.role === 'admin' ? '' : 'none';
  moveThemeToggleToHeader();
  goToTab('cadastro');
}

function bindLoginForm() {
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = '';
    try {
      const { user } = await api('POST', '/api/login', { username, password });
      currentUser = user;
      form.reset();
      showApp(user);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

function bindHeader() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => goToTab(btn.dataset.tab));
  });
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    currentUser = null;
    showLogin();
  });
  document.getElementById('change-pwd-btn').addEventListener('click', () => {
    document.getElementById('pwd-dialog-error').textContent = '';
    document.getElementById('pwd-form').reset();
    document.getElementById('pwd-dialog').showModal();
  });
}

async function goToTab(tab) {
  if ((tab === 'admin' || tab === 'log') && currentUser.role !== 'admin') {
    tab = 'cadastro';
  }
  currentTab = tab;
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  if (tab === 'cadastro') await renderCadastro();
  if (tab === 'emprestimos') await renderLoansList();
  if (tab === 'log') await renderLog();
  if (tab === 'admin') await renderAdmin();
}

// ---------- Trocar senha ----------

function bindPasswordDialog() {
  document.getElementById('pwd-cancel-btn').addEventListener('click', () => document.getElementById('pwd-dialog').close());
  document.getElementById('pwd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('pwd-current').value;
    const newPassword = document.getElementById('pwd-new').value;
    const errorEl = document.getElementById('pwd-dialog-error');
    try {
      await api('POST', '/api/me/change-password', { currentPassword, newPassword });
      document.getElementById('pwd-dialog').close();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

// ---------- Cadastro (dashboard + formulário de empréstimo) ----------

async function renderCadastro() {
  const [dashboard, itemsResp] = await Promise.all([
    api('GET', '/api/dashboard'),
    api('GET', '/api/items'),
  ]);
  itemsCache = itemsResp.items;

  document.getElementById('stat-emprestados').textContent = dashboard.emprestados;
  document.getElementById('stat-atrasados').textContent = dashboard.atrasados;
  document.getElementById('stat-pendentes-hoje').textContent = dashboard.pendentesHoje;
  document.getElementById('form-today-date').textContent = new Date().toLocaleDateString('pt-BR');

  const itemSelect = document.getElementById('loan-item');
  itemSelect.innerHTML = '<option value="">Selecione um item...</option>' +
    itemsCache.map(i => `<option value="${i.id}">${escapeHtml(i.name)} (${escapeHtml(i.category_name)})</option>`).join('');

  document.getElementById('loan-form-hint').textContent = itemsCache.length === 0
    ? 'Nenhum item cadastrado ainda. Peça a um administrador para cadastrar itens na aba Administração.'
    : '';
}

function bindLoanForm() {
  const form = document.getElementById('loan-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const itemId = document.getElementById('loan-item').value;
    if (!itemId) return;

    try {
      await api('POST', '/api/loans', {
        room: document.getElementById('loan-room').value,
        person: document.getElementById('loan-person').value,
        occurrenceType: document.getElementById('loan-occurrence').value,
        itemId,
        shift: document.getElementById('loan-shift').value,
      });
      form.reset();
      await renderCadastro();
      alert('Empréstimo lançado com sucesso! Ele já aparece na aba "Empréstimos".');
    } catch (err) {
      alert(err.message);
    }
  });
}

// ---------- Lista de empréstimos ----------

function getFilteredLoans(loans) {
  const shift = document.getElementById('filter-shift').value;
  const category = document.getElementById('filter-category').value;
  const status = document.getElementById('filter-status').value;
  const date = document.getElementById('filter-date').value;
  const search = document.getElementById('filter-search').value.trim().toLowerCase();

  return loans.filter(l => {
    if (shift && l.shift !== shift) return false;
    if (category && l.category_name !== category) return false;
    if (status && l.status !== status) return false;
    if (date && l.date !== date) return false;
    if (search && !`${l.room} ${l.person}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

const SHIFT_ORDER = { Madrugada: 0, Matutino: 1, Vespertino: 2, Noturno: 3 };

// Itens trazidos pelo agente da Agenda sempre no topo, ordenados por turno
// (Madrugada/Matutino/Vespertino/Noturno); os demais mantêm a ordem que já
// vinham (mais recentes primeiro), abaixo do bloco da agenda.
function sortLoansForDisplay(loans) {
  return [...loans].sort((a, b) => {
    const aFromAgenda = a.calendar_event_id ? 0 : 1;
    const bFromAgenda = b.calendar_event_id ? 0 : 1;
    if (aFromAgenda !== bFromAgenda) return aFromAgenda - bFromAgenda;
    if (aFromAgenda === 0) {
      const shiftDiff = (SHIFT_ORDER[a.shift] ?? 99) - (SHIFT_ORDER[b.shift] ?? 99);
      if (shiftDiff !== 0) return shiftDiff;
      return (a.time || '').localeCompare(b.time || '');
    }
    return 0;
  });
}

async function renderLoansList() {
  const [loansResp, categoriesResp] = await Promise.all([
    api('GET', '/api/loans'),
    api('GET', '/api/categories'),
  ]);
  loansCache = loansResp.loans;
  categoriesCache = categoriesResp.categories;

  comboFilterCategory.setOptions([
    { label: 'Todas as categorias', value: '' },
    ...categoriesCache.map(c => ({ label: c.name, value: c.name })),
  ]);

  renderLoansTable();
}

const CALENDAR_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex-shrink:0" aria-hidden="true">' +
  '<rect x="3" y="4" width="18" height="17" rx="3" fill="#4285F4" fill-opacity="0.18" stroke="#4285F4" stroke-width="1.6"/>' +
  '<rect x="3" y="4" width="18" height="5" rx="2" fill="#4285F4"/>' +
  '<line x1="7" y1="2.5" x2="7" y2="6" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>' +
  '<line x1="17" y1="2.5" x2="17" y2="6" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>' +
  '<circle cx="8" cy="14" r="1.3" fill="#4285F4"/>' +
  '<circle cx="12" cy="14" r="1.3" fill="#4285F4"/>' +
  '<circle cx="16" cy="14" r="1.3" fill="#4285F4"/>' +
  '</svg>';

function renderLoansTable() {
  const loans = sortLoansForDisplay(getFilteredLoans(loansCache));
  const tbody = document.getElementById('loans-tbody');

  if (loans.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-msg">Nenhum empréstimo encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = loans.map(l => {
    let actionBtn = '';
    if (l.status === 'Pendente') {
      actionBtn = `<button class="btn small" data-action="deliver" data-id="${l.id}">Marcar entregue</button>`;
    } else if (l.status === 'Emprestado') {
      actionBtn = `<button class="btn small" data-action="return" data-id="${l.id}">Dar baixa</button>`;
    }
    const deleteBtn = `<button class="btn small danger" data-action="delete" data-id="${l.id}">Excluir</button>`;

    const fromAgenda = Boolean(l.calendar_event_id);
    const rowClasses = [l.overdue ? 'row-overdue' : '', fromAgenda ? 'row-agenda' : ''].filter(Boolean).join(' ');
    const dateCell = fromAgenda
      ? `<span style="display:inline-flex; align-items:center; gap:6px;" title="Adicionado pela Agenda">${CALENDAR_ICON_SVG}<span>${l.date}</span></span><br><span class="muted">${l.time}</span>`
      : `${l.date}<br><span class="muted">${l.time}</span>`;

    return `
      <tr class="${rowClasses}">
        <td>${dateCell}</td>
        <td>${escapeHtml(l.room)}</td>
        <td>${l.person ? escapeHtml(l.person) : '—'}</td>
        <td>${l.occurrence_type}</td>
        <td>${escapeHtml(l.item_name)}</td>
        <td>${l.category_name ? escapeHtml(l.category_name) : '—'}</td>
        <td>${l.shift}</td>
        <td><span class="badge badge-${l.status.toLowerCase()}">${l.status}${l.overdue ? ' (atrasado)' : ''}</span></td>
        <td>${escapeHtml(l.registered_by)}</td>
        <td class="actions">${actionBtn} ${deleteBtn}</td>
      </tr>
    `;
  }).join('');
}

function bindFilters() {
  comboFilterShift = createCombo('combo-filter-shift');
  comboFilterShift.setOptions([
    { label: 'Todos', value: '' },
    { label: 'Madrugada', value: 'Madrugada' },
    { label: 'Matutino', value: 'Matutino' },
    { label: 'Vespertino', value: 'Vespertino' },
    { label: 'Noturno', value: 'Noturno' },
  ]);

  comboFilterStatus = createCombo('combo-filter-status');
  comboFilterStatus.setOptions([
    { label: 'Todos', value: '' },
    { label: 'Pendente', value: 'Pendente' },
    { label: 'Emprestado', value: 'Emprestado' },
    { label: 'Devolvido', value: 'Devolvido' },
  ]);

  comboFilterCategory = createCombo('combo-filter-category');
  comboFilterCategory.setOptions([{ label: 'Todas as categorias', value: '' }]);

  ['filter-shift', 'filter-category', 'filter-status', 'filter-date', 'filter-search'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderLoansTable);
  });
  document.getElementById('filter-clear').addEventListener('click', () => {
    comboFilterShift.selectValue('', { silent: true });
    comboFilterCategory.selectValue('', { silent: true });
    comboFilterStatus.selectValue('', { silent: true });
    document.getElementById('filter-date').value = '';
    document.getElementById('filter-search').value = '';
    renderLoansTable();
  });

  document.getElementById('loans-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    try {
      if (action === 'deliver') {
        await api('POST', `/api/loans/${id}/deliver`);
      } else if (action === 'return') {
        await api('POST', `/api/loans/${id}/return`);
      } else if (action === 'delete') {
        if (!confirm('Excluir este registro de empréstimo? Esta ação não pode ser desfeita.')) return;
        await api('DELETE', `/api/loans/${id}`);
      }
      await renderLoansList();
    } catch (err) {
      alert(err.message);
    }
  });
}

function bindPrintButtons() {
  document.getElementById('print-filtered-btn').addEventListener('click', () => {
    printLoans(sortLoansForDisplay(getFilteredLoans(loansCache)), 'Lista de Empréstimos (filtrada)');
  });
  document.getElementById('print-all-btn').addEventListener('click', () => {
    printLoans(sortLoansForDisplay(loansCache), 'Lista de Empréstimos (completa)');
  });
}

// ---------- Log de atividades ----------

function getFilteredLog(entries) {
  const user = document.getElementById('log-filter-user').value;
  const action = document.getElementById('log-filter-action').value;
  const date = document.getElementById('log-filter-date').value;
  const search = document.getElementById('log-filter-search').value.trim().toLowerCase();

  return entries.filter(entry => {
    if (user && entry.user !== user) return false;
    if (action && entry.action !== action) return false;
    if (date && !entry.timestamp.startsWith(date)) return false;
    if (search && !`${entry.user} ${entry.action} ${entry.details}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

async function renderLog() {
  const { log } = await api('GET', '/api/log');
  logCache = log;

  const users = [...new Set(logCache.map(l => l.user))].sort();
  comboLogUser.setOptions([{ label: 'Todos', value: '' }, ...users.map(u => ({ label: u, value: u }))]);

  const actions = [...new Set(logCache.map(l => l.action))].sort();
  comboLogAction.setOptions([{ label: 'Todas', value: '' }, ...actions.map(a => ({ label: a, value: a }))]);

  renderLogTable();
}

function renderLogTable() {
  const entries = getFilteredLog(logCache);
  const tbody = document.getElementById('log-tbody');
  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-msg">Nenhuma atividade encontrada.</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(entry => `
    <tr>
      <td>${new Date(entry.timestamp).toLocaleString('pt-BR')}</td>
      <td>${escapeHtml(entry.user)}</td>
      <td>${escapeHtml(entry.action)}</td>
      <td>${escapeHtml(entry.details)}</td>
    </tr>
  `).join('');
}

function bindLogFilters() {
  comboLogUser = createCombo('combo-log-filter-user');
  comboLogUser.setOptions([{ label: 'Todos', value: '' }]);

  comboLogAction = createCombo('combo-log-filter-action');
  comboLogAction.setOptions([{ label: 'Todas', value: '' }]);

  ['log-filter-user', 'log-filter-action', 'log-filter-date', 'log-filter-search'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderLogTable);
  });
  document.getElementById('log-filter-clear').addEventListener('click', () => {
    comboLogUser.selectValue('', { silent: true });
    comboLogAction.selectValue('', { silent: true });
    document.getElementById('log-filter-date').value = '';
    document.getElementById('log-filter-search').value = '';
    renderLogTable();
  });
}

// ---------- Administração ----------

async function renderAdmin() {
  const [usersResp, categoriesResp, itemsResp] = await Promise.all([
    api('GET', '/api/users'),
    api('GET', '/api/categories'),
    api('GET', '/api/items'),
  ]);
  usersCache = usersResp.users;
  categoriesCache = categoriesResp.categories;
  itemsCache = itemsResp.items;

  document.getElementById('users-tbody').innerHTML = usersCache.map(u => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${u.role === 'admin' ? 'Admin' : 'Colaborador'}</td>
      <td class="actions">
        <button class="btn small" data-action="reset-pwd" data-id="${u.id}">Redefinir senha</button>
        <button class="btn small danger" data-action="delete-user" data-id="${u.id}">Excluir</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('categories-tbody').innerHTML = categoriesCache.map(c => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td class="actions"><button class="btn small danger" data-action="delete-category" data-id="${c.id}">Excluir</button></td>
    </tr>
  `).join('');

  const catSelect = document.getElementById('item-category');
  catSelect.innerHTML = '<option value="">Selecione a categoria...</option>' +
    categoriesCache.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');

  document.getElementById('items-tbody').innerHTML = itemsCache.map(i => `
    <tr>
      <td>${escapeHtml(i.name)}</td>
      <td>${escapeHtml(i.category_name)}</td>
      <td class="actions"><button class="btn small danger" data-action="delete-item" data-id="${i.id}">Excluir</button></td>
    </tr>
  `).join('');
}

function bindAdminForms() {
  document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/users', {
        name: document.getElementById('user-name').value,
        username: document.getElementById('user-username').value,
        password: document.getElementById('user-password').value,
        role: document.getElementById('user-role').value,
      });
      e.target.reset();
      await renderAdmin();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('category-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/categories', { name: document.getElementById('category-name').value });
      e.target.reset();
      await renderAdmin();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/items', {
        name: document.getElementById('item-name').value,
        categoryName: document.getElementById('item-category').value,
      });
      e.target.reset();
      await renderAdmin();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('admin-panel').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    try {
      if (action === 'delete-user') {
        const target = usersCache.find(u => u.id === id);
        if (!confirm(`Excluir o usuário "${target.name}"?`)) return;
        await api('DELETE', `/api/users/${id}`);
      } else if (action === 'reset-pwd') {
        const target = usersCache.find(u => u.id === id);
        const newPassword = prompt(`Nova senha para ${target.name}:`);
        if (!newPassword) return;
        await api('POST', `/api/users/${id}/reset-password`, { newPassword });
      } else if (action === 'delete-category') {
        const target = categoriesCache.find(c => c.id === id);
        if (!confirm(`Excluir a categoria "${target.name}"? Itens já cadastrados nela não serão afetados.`)) return;
        await api('DELETE', `/api/categories/${id}`);
      } else if (action === 'delete-item') {
        const target = itemsCache.find(i => i.id === id);
        if (!confirm(`Excluir o item "${target.name}"?`)) return;
        await api('DELETE', `/api/items/${id}`);
      }
      await renderAdmin();
    } catch (err) {
      alert(err.message);
    }
  });
}
