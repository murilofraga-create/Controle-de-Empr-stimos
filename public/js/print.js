function printLoans(loans, title) {
  const rows = loans.map(l => `
    <tr>
      <td>${l.date}</td>
      <td>${l.time}</td>
      <td>${escapeHtml(l.room)}</td>
      <td>${escapeHtml(l.person)}</td>
      <td>${escapeHtml(l.occurrence_type)}</td>
      <td>${escapeHtml(l.item_name)}</td>
      <td>${escapeHtml(l.category_name)}</td>
      <td>${l.shift}</td>
      <td>${l.status}</td>
    </tr>
  `).join('');

  const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(title)}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
        h1 { font-size: 18px; margin-bottom: 4px; }
        p.meta { color: #555; font-size: 12px; margin-top: 0; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
        th { background: #eee; }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">Gerado em ${new Date().toLocaleString('pt-BR')} — ${loans.length} registro(s)</p>
      <table>
        <thead>
          <tr>
            <th>Data</th><th>Hora</th><th>Sala</th><th>Professor/Funcionário</th>
            <th>Ocorrência</th><th>Item</th><th>Categoria</th><th>Turno</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="9">Nenhum registro.</td></tr>'}</tbody>
      </table>
      <script>window.onload = () => window.print();</script>
    </body>
    </html>
  `;

  const win = window.open('', '_blank');
  win.document.open();
  win.document.write(html);
  win.document.close();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
