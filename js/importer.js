/* Leitura de comentários a partir de CSV, JSON ou texto colado,
   e gerador de comentários fictícios para o modo demonstração. */
const Importer = (() => {
  const KEYS = {
    username: ['username', 'usuario', 'usuário', 'user', 'perfil', 'profile', 'author', 'autor', 'owner', 'login', 'handle', 'nome de usuario', 'nome de usuário', 'ownerusername', 'from'],
    text: ['text', 'texto', 'comment', 'comentario', 'comentário', 'comments', 'message', 'mensagem', 'body', 'content', 'conteudo', 'conteúdo'],
    timestamp: ['timestamp', 'date', 'data', 'datetime', 'created_at', 'createdat', 'created_time', 'time', 'hora', 'data/hora', 'data e hora'],
    like_count: ['like_count', 'likes', 'curtidas', 'likescount', 'like count'],
    id: ['id', 'comment_id', 'commentid', 'id do comentario', 'id do comentário'],
  };
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_-]+/g, ' ').trim();
  const KEYMAP = Object.fromEntries(Object.entries(KEYS).map(([k, list]) => [k, list.map(norm)]));

  function pickKey(headers, field) {
    const wanted = KEYMAP[field];
    const normed = headers.map(norm);
    const i = normed.findIndex(h => wanted.includes(h));
    return i >= 0 ? headers[i] : null;
  }

  function parseDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
    const s = String(v).trim();
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (br) {
      const d = new Date(+br[3], +br[2] - 1, +br[1], +(br[4] || 0), +(br[5] || 0), +(br[6] || 0));
      return isNaN(d) ? null : d.toISOString();
    }
    if (/^\d{10,13}$/.test(s)) return parseDate(Number(s));
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString();
  }

  function deep(obj, key) {
    if (!key) return undefined;
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v.username || v.name || v.text || undefined;
    return v;
  }

  function fromObjects(rows) {
    if (!rows.length) return [];
    const headers = [...new Set(rows.flatMap(r => Object.keys(r)))];
    const k = Object.fromEntries(Object.keys(KEYS).map(f => [f, pickKey(headers, f)]));
    if (!k.username) throw new Error('Não encontrei a coluna de usuário/perfil no arquivo.');
    return rows.map((r, i) => ({
      id: String(deep(r, k.id) ?? `imp-${i + 1}`),
      username: String(deep(r, k.username) ?? '').replace(/^@/, '').trim(),
      text: String(deep(r, k.text) ?? ''),
      timestamp: parseDate(deep(r, k.timestamp)),
      like_count: k.like_count && r[k.like_count] !== '' ? Number(r[k.like_count]) || 0 : null,
      hidden: false, parent_id: null, is_reply: false, from_id: null,
      raw: r,
    })).filter(c => c.username);
  }

  function parseCSV(text) {
    const first = text.split(/\r?\n/, 1)[0];
    const delim = [';', '\t', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const clean = rows.filter(r => r.some(c => c.trim() !== ''));
    if (clean.length < 2) throw new Error('O CSV precisa ter um cabeçalho e ao menos uma linha.');
    const headers = clean[0].map(h => h.replace(/^﻿/, '').trim());
    return fromObjects(clean.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))));
  }

  function parseJSON(text) {
    let data = JSON.parse(text);
    if (!Array.isArray(data)) data = data.comments || data.data || data.items || data.results || [];
    if (!Array.isArray(data)) throw new Error('JSON sem uma lista de comentários.');
    return fromObjects(data.map(o => (typeof o === 'object' && o ? o : { text: String(o) })));
  }

  // Uma linha por comentário: "@usuario texto" ou "usuario: texto"
  function parseLines(text) {
    const out = [];
    text.split(/\r?\n/).forEach(line => {
      const m = line.trim().match(/^@?([A-Za-z0-9._]{1,30})\s*[:\-–—]?\s+(.*)$/) || line.trim().match(/^@?([A-Za-z0-9._]{1,30})$/);
      if (!m) return;
      out.push({ id: `imp-${out.length + 1}`, username: m[1], text: (m[2] || '').trim(), timestamp: null, like_count: null, hidden: false, parent_id: null, is_reply: false, from_id: null, raw: { linha: line } });
    });
    return out;
  }

  function parse(text, filename = '') {
    const t = text.replace(/^﻿/, '').trim();
    if (!t) throw new Error('Nenhum conteúdo para importar.');
    if (/\.json$/i.test(filename) || /^[[{]/.test(t)) return parseJSON(t);
    if (/\.(csv|tsv)$/i.test(filename)) return parseCSV(t);
    const firstLine = t.split(/\r?\n/, 1)[0];
    if (/[;,\t]/.test(firstLine) && pickKey(firstLine.split(/[;,\t]/).map(s => s.replace(/"/g, '')), 'username')) return parseCSV(t);
    return parseLines(t);
  }

  /* ---------- Demonstração ---------- */
  const A = ['ana', 'bia', 'caio', 'duda', 'enzo', 'fe', 'gabi', 'gui', 'heitor', 'isa', 'joao', 'ju', 'leo', 'lu', 'mari', 'mateus', 'nina', 'otavio', 'paula', 'pedro', 'rafa', 'sofia', 'theo', 'vini', 'yasmin'];
  const B = ['silva', 'souza', 'lima', 'costa', 'rocha', 'alves', 'gomes', 'dias', 'melo', 'ramos', 'pires', 'nunes', 'moura', 'cardoso', 'teixeira'];
  const PHRASES = ['Quero muito ganhar!', 'Participando 🙏', 'Que prêmio incrível!', 'Bora, sorte!', 'Eu e vocês nesse sorteio', 'Torcendo muito 🍀', 'Amei! Participando', 'Esse é meu!', 'Já sigo! Participando', 'Vem sorte 😍'];

  function demo(n, owner = 'sua.marca') {
    const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const user = () => `${pick(A)}${pick(['.', '_', ''])}${pick(B)}${rnd() < .5 ? Math.floor(rnd() * 99) : ''}`;
    const people = Array.from({ length: Math.max(20, Math.round(n * 0.65)) }, user);
    const start = Date.now() - 5 * 864e5;
    const list = [];
    for (let i = 0; i < n; i++) {
      const u = rnd() < 0.004 ? owner : pick(people);
      const mentions = Array.from({ length: Math.floor(rnd() * 4) }, () => '@' + pick(people)).join(' ');
      const tag = rnd() < 0.3 ? ' #eusorteio' : '';
      const text = `${rnd() < 0.7 ? pick(PHRASES) + ' ' : ''}${mentions}${tag}`.trim() || pick(PHRASES);
      const timestamp = new Date(start + rnd() * 5 * 864e5).toISOString();
      const id = String(17800000000000000 + i * 37 + Math.floor(rnd() * 30));
      const raw = { id, username: u, text, timestamp, like_count: Math.floor(rnd() ** 4 * 40), hidden: rnd() < 0.01, from: { id: String(Math.floor(rnd() * 1e15)), username: u } };
      list.push(IG.normalize(raw));
    }
    return list;
  }

  return { parse, demo };
})();
