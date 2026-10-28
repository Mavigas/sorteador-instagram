/* Sorteador de Comentários — lógica da interface */
(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const SETTINGS_KEY = 'sorteador.settings';
  const TABLE_LIMIT = 250;

  /* =========================================================
     Utilidades
     ========================================================= */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const nf = new Intl.NumberFormat('pt-BR');
  const fmt = n => nf.format(n || 0);
  const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  const fmtDate = iso => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : dtf.format(d); };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
  const highlight = t => esc(t).replace(/@([A-Za-z0-9._]+)/g, '<span class="mention">@$1</span>');
  const initials = u => (String(u || '').replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?');
  const avatar = (u, pic = '', cls = '') =>
    `<span class="avatar ${cls}">${esc(initials(u))}${pic ? `<img src="${esc(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;
  const ICON_COMMENT = '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';

  function toast(msg, type = 'info', ms = 4500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
  }

  function confirmDialog(title, text, okLabel = 'Confirmar') {
    const dlg = $('#modal');
    if (dlg.open) return Promise.resolve(false);
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalOk').textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
  }

  function busy(btn, on, label) {
    btn.classList.toggle('is-busy', on);
    btn.disabled = on;
    if (on && label) { btn.dataset.label = btn.textContent; btn.textContent = label; }
    if (!on && btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
  }

  function download(name, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function sha256(text) {
    if (!crypto.subtle) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  // Inteiro uniforme em [0, n) usando o gerador criptográfico do navegador (sem viés de módulo).
  function secureIndex(n) {
    const limit = Math.floor(2 ** 32 / n) * n;
    const buf = new Uint32Array(1);
    let rejected = 0;
    for (;;) {
      crypto.getRandomValues(buf);
      if (buf[0] < limit) return { index: buf[0] % n, value: buf[0], rejected };
      rejected++;
    }
  }

  const ts = c => { const t = c.timestamp ? Date.parse(c.timestamp) : NaN; return isNaN(t) ? Infinity : t; };
  const thumbOf = p => p ? (p.media_type === 'VIDEO' ? (p.thumbnail_url || p.media_url) : (p.media_url || p.thumbnail_url)) || '' : '';
  const SOURCE_LABEL = { api: 'API oficial', import: 'Lista importada', demo: 'Demonstração' };

  /* =========================================================
     Estado
     ========================================================= */
  const saved = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })();

  const S = {
    token: saved.token || '',
    apiVersion: saved.apiVersion || 'v23.0',
    remember: saved.remember !== false,
    step: 1,
    source: null,          // origem selecionada no passo 1
    sourceType: null,      // origem efetiva dos comentários carregados
    accounts: [], account: null,
    posts: [], postsNext: null,
    post: null,
    importFile: null, importMeta: null,
    comments: [], seen: new Set(), users: new Set(), replies: 0,
    loader: freshLoader(false),
    currentDraw: null,
    drawing: false,
    elig: null,
    user: null,            // conta Google conectada (Firebase)
    authReady: false,
    sync: 'idle',          // idle | syncing | ok | error
    askedImport: false,
  };

  function freshLoader(includeReplies) {
    return { running: false, done: false, nextUrl: null, pages: 0, ctrl: null, includeReplies, error: null, wait: null, startedAt: null, finishedAt: null, restoredAt: null };
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiVersion: S.apiVersion, remember: S.remember, token: S.remember ? S.token : '' }));
    } catch { /* navegador sem armazenamento: segue só nesta sessão */ }
  }

  const ownerUsername = () => (S.post?.username || S.account?.username || '').replace(/^@/, '').toLowerCase();

  /* =========================================================
     Navegação
     ========================================================= */
  function showView(name) {
    $$('.view').forEach(v => v.classList.toggle('is-active', v.id === `view-${name}`));
    $$('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === (name === 'detail' ? 'history' : name)));
    window.scrollTo({ top: 0 });
    if (name === 'history') renderHistory();
    if (name === 'settings') fillSettings();
  }

  function canReach(n) {
    if (n <= 1) return true;
    if (!S.post) return false;
    if (n === 2) return true;
    if (!S.comments.length) return false;
    if (n === 3) return true;
    return computeEligibility(readRules()).entries.length > 0;
  }

  function goStep(n) {
    if (!canReach(n)) {
      toast(n === 2 ? 'Escolha primeiro a origem e a publicação.' : n === 3 ? 'Ainda não há comentários carregados.' : 'Nenhuma participação válida com as regras atuais.', 'warn');
      return;
    }
    S.step = n;
    $$('.step-panel').forEach(p => { p.hidden = Number(p.dataset.panel) !== n; });
    updateStepper();
    if (n === 2) { renderPostSummary(); updateLoadUI(); renderTable(); }
    if (n === 3) { $('#ruleRepliesWrap').hidden = S.replies === 0; updateElig(); }
    if (n === 4) prepareStage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateStepper() {
    $$('#stepper li').forEach(li => {
      const n = Number(li.dataset.step);
      li.classList.toggle('is-current', n === S.step);
      li.classList.toggle('is-done', n < S.step);
      li.querySelector('button').disabled = n !== S.step && !canReach(n);
    });
  }

  function updateConn() {
    const box = $('#connStatus');
    const on = !!S.account;
    box.classList.toggle('is-on', on);
    $('.conn-text', box).textContent = on ? `Instagram: @${S.account.username}` : S.token ? 'Instagram: token salvo' : 'Instagram: não conectado';
  }

  async function updateHistoryCount() {
    try { $('#historyCount').textContent = fmt((await allDraws()).length); } catch { /* sem IndexedDB */ }
  }

  /* =========================================================
     Passo 1 — origem
     ========================================================= */
  function selectSource(src) {
    S.source = src;
    $$('.source-card').forEach(c => c.classList.toggle('is-selected', c.dataset.source === src));
    $$('.source-body').forEach(b => { b.hidden = b.id !== `src-${src}`; });
    if (src === 'api') {
      $('#tokenInput').value = S.token;
      renderAccounts();
      $('#postPicker').hidden = !S.account;
    }
  }

  async function connect() {
    const btn = $('#btnConnect');
    const token = $('#tokenInput').value.trim();
    if (!token) return toast('Cole o token de acesso.', 'warn');
    busy(btn, true, 'Conectando');
    try {
      const accs = await IG.accounts(token, S.apiVersion);
      S.token = token;
      S.accounts = accs;
      saveSettings();
      await selectAccount(accs[0]);
      toast(`Conectado como @${accs[0].username}`, 'success');
    } catch (e) {
      toast(e.message, 'error', 7000);
    } finally {
      busy(btn, false);
    }
  }

  function renderAccounts() {
    $('#accountBox').innerHTML = S.accounts.map((a, i) => `
      <button type="button" class="account-chip ${S.account && S.account.id === a.id ? 'is-selected' : ''}" data-acc="${i}">
        ${avatar(a.username, a.picture)}
        <span>@${esc(a.username)} <small>${a.mediaCount != null ? plural(a.mediaCount, 'publicação', 'publicações') : ''}</small></span>
      </button>`).join('');
  }

  async function selectAccount(acc) {
    S.account = acc;
    S.posts = []; S.postsNext = null;
    renderAccounts();
    updateConn();
    $('#postPicker').hidden = false;
    $('#postGrid').innerHTML = '<p class="muted">Carregando publicações…</p>';
    await loadPosts();
  }

  async function loadPosts() {
    const btn = $('#btnMorePosts');
    busy(btn, true);
    try {
      const page = await IG.media(S.token, S.apiVersion, S.account, S.postsNext);
      S.posts.push(...page.items);
      S.postsNext = page.next;
      renderPosts();
    } catch (e) {
      toast(e.message, 'error', 7000);
      if (!S.posts.length) $('#postGrid').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    } finally {
      busy(btn, false);
      btn.hidden = !S.postsNext;
    }
  }

  function renderPosts() {
    if (!S.posts.length) { $('#postGrid').innerHTML = '<p class="muted">Nenhuma publicação encontrada nesta conta.</p>'; return; }
    $('#postGrid').innerHTML = S.posts.map((p, i) => {
      const img = thumbOf(p);
      return `<button type="button" class="post-tile" data-post="${i}" title="${esc((p.caption || '').slice(0, 140))}">
        <span class="noimg"></span>
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span class="ov"><strong>${ICON_COMMENT}${fmt(p.comments_count)}</strong><small>${esc(fmtDate(p.timestamp).slice(0, 10))} · ${esc((p.caption || 'Sem legenda').slice(0, 80))}</small></span>
      </button>`;
    }).join('');
  }

  async function findByLink() {
    const link = $('#postLink').value.trim();
    if (!link) return toast('Cole o link da publicação.', 'warn');
    if (!S.account) return toast('Conecte a conta primeiro.', 'warn');
    const btn = $('#btnFindLink');
    busy(btn, true, 'Procurando');
    try {
      const post = await IG.findByLink(S.token, S.apiVersion, S.account, link, n => { btn.textContent = `${fmt(n)} verificadas`; });
      await choosePost(post, 'api');
    } catch (e) {
      toast(e.message, 'error', 7000);
    } finally {
      busy(btn, false);
      btn.textContent = 'Buscar';
    }
  }

  function resetComments() {
    S.comments = []; S.seen = new Set(); S.users = new Set(); S.replies = 0;
    S.currentDraw = null;
    $('#results').innerHTML = '';
    $('#afterDraw').hidden = true;
  }

  function addComments(list) {
    for (const c of list) {
      if (S.seen.has(c.id)) continue;
      S.seen.add(c.id);
      c.seq = S.comments.length;
      S.comments.push(c);
      if (c.is_reply) S.replies++;
      if (c.username) S.users.add(c.username.toLowerCase());
    }
  }

  const cacheKey = () => `${S.post.id}|${S.loader.includeReplies ? 1 : 0}`;

  async function restoreCache() {
    try {
      const cached = await DB.get('cache', cacheKey());
      if (!cached) return false;
      addComments(cached.comments);
      Object.assign(S.loader, { nextUrl: cached.nextUrl, done: cached.done, pages: cached.pages, restoredAt: cached.updatedAt, startedAt: cached.startedAt || null, finishedAt: cached.finishedAt || null });
      return true;
    } catch { return false; }
  }

  async function saveCache() {
    if (S.sourceType !== 'api' || !S.post) return;
    try {
      await DB.put('cache', {
        key: cacheKey(), postId: S.post.id, post: S.post, includeReplies: S.loader.includeReplies,
        comments: S.comments, nextUrl: IG.stripToken(S.loader.nextUrl), done: S.loader.done, pages: S.loader.pages,
        startedAt: S.loader.startedAt, finishedAt: S.loader.finishedAt, updatedAt: new Date().toISOString(),
      });
    } catch (e) { console.warn('Cache não salvo', e); }
  }

  async function choosePost(post, type) {
    stopLoading();
    resetComments();
    S.post = post;
    S.sourceType = type;
    S.loader = freshLoader($('#optReplies').checked);
    if (type === 'api') {
      const restored = await restoreCache();
      goStep(2);
      if (!restored || !S.loader.done) startLoading();
      else toast(`${fmt(S.comments.length)} comentários recuperados do carregamento salvo. Use “Recarregar do zero” para buscar comentários novos.`, 'info', 7000);
    } else {
      S.loader.done = true;
      goStep(2);
    }
  }

  // Importação
  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      S.importFile = { name: file.name, text: String(reader.result) };
      $('#fileName').textContent = `${file.name} · ${fmt(Math.round(file.size / 1024))} KB`;
    };
    reader.onerror = () => toast('Não foi possível ler o arquivo.', 'error');
    reader.readAsText(file, 'utf-8');
  }

  async function doImport() {
    const pasted = $('#pasteInput').value;
    const text = S.importFile?.text || pasted;
    let list;
    try {
      list = Importer.parse(text, S.importFile?.name || '');
    } catch (e) {
      return toast(e.message || 'Não foi possível interpretar os dados.', 'error', 7000);
    }
    if (!list.length) return toast('Nenhum comentário reconhecido. Confira o formato.', 'error');
    const link = $('#importLink').value.trim();
    S.importMeta = { fileName: S.importFile?.name || null, pasted: !S.importFile };
    await choosePost({
      id: `import-${uid()}`,
      caption: $('#importCaption').value.trim() || (S.importFile ? `Importado de ${S.importFile.name}` : 'Lista colada'),
      permalink: link || null,
      username: $('#importOwner').value.trim().replace(/^@/, '') || null,
      timestamp: null, media_type: 'IMPORT', comments_count: list.length,
    }, 'import');
    addComments(list);
    updateLoadUI(); renderTable();
    toast(`${fmt(S.comments.length)} comentários importados.`, 'success');
  }

  async function doDemo() {
    const n = Number($('#demoCount').value);
    const btn = $('#btnDemo');
    busy(btn, true, 'Gerando');
    await sleep(30);
    const list = Importer.demo(n, 'sua.marca');
    await choosePost({
      id: `demo-${Date.now()}`,
      caption: '🎁 SORTEIO! Para participar: siga @sua.marca, curta esta publicação e marque 2 amigos nos comentários. Pode comentar quantas vezes quiser! #eusorteio',
      permalink: null, username: 'sua.marca', media_type: 'DEMO',
      timestamp: new Date(Date.now() - 5 * 864e5).toISOString(), comments_count: n, like_count: Math.round(n * 1.4),
    }, 'demo');
    addComments(list);
    updateLoadUI(); renderTable();
    busy(btn, false);
  }

  /* =========================================================
     Passo 2 — carregamento e lista
     ========================================================= */
  function renderPostSummary() {
    const p = S.post;
    if (!p) return;
    const img = thumbOf(p);
    $('#postSummary').innerHTML = `
      <div class="thumb">${img ? `<img src="${esc(img)}" alt="" onerror="this.remove()">` : ''}</div>
      <div class="info">
        <h3>${p.username ? '@' + esc(p.username) : 'Publicação'}</h3>
        <p class="caption">${esc(p.caption || 'Sem legenda')}</p>
        <div class="meta">
          <span class="pill ${S.sourceType === 'demo' ? 'warn' : 'accent'}">${SOURCE_LABEL[S.sourceType]}</span>
          ${p.timestamp ? `<span class="pill">Publicada em ${esc(fmtDate(p.timestamp))}</span>` : ''}
          ${S.sourceType === 'api' && p.comments_count != null ? `<span class="pill">${plural(p.comments_count, 'comentário', 'comentários')} segundo o Instagram</span>` : ''}
          ${p.permalink ? `<a class="pill" href="${esc(p.permalink)}" target="_blank" rel="noopener">Abrir no Instagram ↗</a>` : ''}
        </div>
      </div>`;
  }

  function updateLoadUI() {
    if (!S.post) return;
    const L = S.loader;
    const api = S.sourceType === 'api';
    $('#stLoaded').textContent = fmt(S.comments.length);
    $('#stReplies').textContent = fmt(S.replies);
    $('#stUsers').textContent = fmt(S.users.size);
    $('#stPages').textContent = api ? fmt(L.pages) : '—';

    $('#loadControls').hidden = !api;
    $('#optReplies').checked = L.includeReplies;
    $('#btnLoadStart').hidden = L.running || L.done;
    $('#btnLoadStart').textContent = L.pages > 0 ? 'Continuar' : 'Carregar';
    $('#btnLoadPause').hidden = !L.running;
    $('#btnLoadReset').hidden = L.running || (!L.done && L.pages === 0);

    const bar = $('#progressBar');
    const expected = api ? S.post.comments_count : null;
    bar.classList.toggle('is-indeterminate', L.running && !expected);
    bar.style.width = (L.done ? 100 : expected ? Math.min(99, (S.comments.length / expected) * 100) : 0) + '%';

    let title, sub;
    if (!api) {
      title = S.sourceType === 'demo' ? 'Comentários de demonstração' : 'Comentários importados';
      sub = S.sourceType === 'import' && S.importMeta?.fileName ? `Arquivo: ${S.importMeta.fileName}` : 'Lista pronta para o sorteio.';
    } else if (L.running) {
      title = 'Carregando todos os comentários…';
      sub = L.wait || `Lendo a página ${fmt(L.pages + 1)} da API. Você pode pausar e continuar depois, mesmo fechando o navegador.`;
    } else if (L.done) {
      title = 'Todos os comentários foram carregados';
      sub = L.restoredAt ? `Carregamento salvo em ${fmtDate(L.restoredAt)}. Comentários feitos depois disso exigem “Recarregar do zero”.` : `Leitura concluída em ${fmtDate(L.finishedAt)}.`;
      if (expected && !L.includeReplies && S.post.comments_count > S.comments.length) sub += ' O total informado pelo Instagram inclui respostas.';
    } else if (L.error) {
      title = 'Carregamento interrompido';
      sub = `${L.error} Clique em Continuar para seguir de onde parou.`;
    } else if (L.pages > 0) {
      title = 'Carregamento pausado';
      sub = 'Clique em Continuar para seguir exatamente de onde parou.';
    } else {
      title = 'Comentários';
      sub = 'Clique em Carregar para ler todos os comentários da publicação.';
    }
    $('#loadTitle').textContent = title;
    $('#loadSub').textContent = sub;
    updateStepper();
  }

  async function startLoading() {
    const L = S.loader;
    if (S.sourceType !== 'api' || L.running || L.done) return;
    L.running = true; L.error = null; L.wait = null;
    L.ctrl = new AbortController();
    L.startedAt = L.startedAt || new Date().toISOString();
    const post = S.post;
    updateLoadUI();
    const repaint = debounce(renderTable, 400);
    try {
      const pages = IG.comments(S.token, S.apiVersion, post.id, {
        includeReplies: L.includeReplies, startUrl: L.nextUrl, signal: L.ctrl.signal,
        onWait: (ms, why) => {
          const reason = why === 'limite' ? 'o Instagram pediu uma pausa (limite de requisições)' : why === 'rede' ? 'falha de conexão' : 'instabilidade na API';
          L.wait = `Aguardando ${Math.round(ms / 1000)} s: ${reason}. O carregamento continua sozinho.`;
          updateLoadUI();
        },
      });
      for await (const { batch, nextUrl } of pages) {
        if (S.post !== post) return;
        addComments(batch.map(IG.normalize));
        L.nextUrl = nextUrl; L.pages++; L.wait = null;
        if (L.pages % 10 === 0) saveCache();
        updateLoadUI(); repaint();
      }
      L.done = true;
      L.finishedAt = new Date().toISOString();
      toast(`Pronto! ${fmt(S.comments.length)} comentários carregados.`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') { L.error = e.message; toast(e.message, 'error', 8000); }
    } finally {
      if (S.post === post) {
        L.running = false; L.wait = null;
        await saveCache();
        updateLoadUI(); renderTable();
      }
    }
  }

  function stopLoading() {
    if (S.loader.running) S.loader.ctrl?.abort();
  }

  async function resetLoading() {
    const ok = await confirmDialog('Recarregar do zero?', 'Os comentários carregados desta publicação serão descartados e lidos novamente pela API. Sorteios já feitos não são afetados.', 'Recarregar');
    if (!ok) return;
    stopLoading();
    await DB.del('cache', cacheKey()).catch(() => {});
    resetComments();
    S.loader = freshLoader(S.loader.includeReplies);
    await sleep(50);
    startLoading();
  }

  async function toggleReplies() {
    const want = $('#optReplies').checked;
    if (want === S.loader.includeReplies) return;
    if (S.comments.length) {
      const ok = await confirmDialog(want ? 'Incluir respostas?' : 'Remover respostas?', 'Para mudar essa opção, os comentários serão lidos novamente (ou recuperados do carregamento salvo, se existir).', 'Mudar');
      if (!ok) { $('#optReplies').checked = !want; return; }
    }
    stopLoading();
    resetComments();
    S.loader = freshLoader(want);
    if (S.sourceType === 'api' && S.post) {
      await sleep(50);
      const restored = await restoreCache();
      updateLoadUI(); renderTable();
      if (!restored || !S.loader.done) startLoading();
    }
  }

  function renderTable() {
    const body = $('#commentsBody');
    if (!body) return;
    const q = fold($('#commentSearch').value.trim().replace(/^@/, ''));
    let rows = S.comments;
    if (q) rows = rows.filter(c => fold(c.username).includes(q) || fold(c.text).includes(q));
    const shown = rows.slice(0, TABLE_LIMIT);
    body.innerHTML = shown.length ? shown.map(c => `
      <tr>
        <td class="idx">${c.seq + 1}</td>
        <td class="user">@${esc(c.username || '—')}${c.is_reply ? '<span class="reply">resposta</span>' : ''}</td>
        <td class="text">${highlight(c.text)}</td>
        <td class="date">${esc(fmtDate(c.timestamp))}</td>
        <td class="num">${c.like_count ?? '—'}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="empty">${S.comments.length ? 'Nenhum comentário encontrado na busca.' : 'Nenhum comentário carregado ainda.'}</td></tr>`;
    $('#tableNote').textContent = rows.length > TABLE_LIMIT
      ? `Mostrando ${fmt(TABLE_LIMIT)} de ${fmt(rows.length)} — todos entram no sorteio. Use a busca para encontrar um comentário específico.`
      : rows.length ? `${plural(rows.length, 'comentário', 'comentários')}.` : '';
  }

  /* =========================================================
     Passo 3 — regras e elegibilidade
     ========================================================= */
  const int = (v, min) => Math.max(min, parseInt(v, 10) || 0);
  const handles = s => String(s || '').split(/[\s,;]+/).map(x => x.replace(/^@/, '').trim().toLowerCase()).filter(Boolean);

  function readRules() {
    return {
      title: $('#ruleTitle').value.trim(),
      winners: int($('#ruleWinners').value, 1),
      subs: int($('#ruleSubs').value, 0),
      mode: $('input[name=ruleMode]:checked').value,
      minMentions: int($('#ruleMentions').value, 0),
      until: $('#ruleUntil').value || null,
      keywords: $('#ruleKeyword').value.split(',').map(s => s.trim()).filter(Boolean),
      keywordMode: $('#ruleKeywordMode').value,
      exclude: handles($('#ruleExclude').value),
      excludeOwner: $('#ruleExcludeOwner').checked,
      ignoreHidden: $('#ruleIgnoreHidden').checked,
      includeReplies: S.replies > 0 && $('#ruleIncludeReplies').checked,
      saveParticipants: $('#ruleSaveAll').checked,
      notes: $('#ruleNotes').value.trim(),
    };
  }

  function mentionsOf(text, self, owner) {
    const set = new Set();
    for (const m of String(text || '').matchAll(/@([A-Za-z0-9._]{1,30})/g)) {
      const h = m[1].replace(/\.+$/, '').toLowerCase();
      if (h && h !== self && h !== owner) set.add(h);
    }
    return set;
  }

  function computeEligibility(r) {
    const owner = ownerUsername();
    const excluded = new Set(r.exclude);
    if (r.excludeOwner && owner) excluded.add(owner);
    const kws = r.keywords.map(fold);
    const until = r.until ? new Date(r.until).getTime() : null;
    const reasons = { reply: 0, nouser: 0, hidden: 0, date: 0, user: 0, keyword: 0, mentions: 0, duplicate: 0 };
    const valid = [];

    for (const c of S.comments) {
      if (c.is_reply && !r.includeReplies) { reasons.reply++; continue; }
      if (!c.username) { reasons.nouser++; continue; }
      const u = c.username.toLowerCase();
      if (r.ignoreHidden && c.hidden) { reasons.hidden++; continue; }
      if (until && ts(c) !== Infinity && ts(c) > until) { reasons.date++; continue; }
      if (excluded.has(u)) { reasons.user++; continue; }
      if (kws.length) {
        const t = fold(c.text);
        const ok = r.keywordMode === 'all' ? kws.every(k => t.includes(k)) : kws.some(k => t.includes(k));
        if (!ok) { reasons.keyword++; continue; }
      }
      if (r.minMentions > 0 && mentionsOf(c.text, u, owner).size < r.minMentions) { reasons.mentions++; continue; }
      valid.push(c);
    }

    // Ordem determinística: data do comentário e, em empate, ordem de carregamento.
    valid.sort((a, b) => (ts(a) - ts(b)) || (a.seq - b.seq));

    let entries = valid;
    if (r.mode === 'perUser') {
      const seen = new Set();
      entries = [];
      for (const c of valid) {
        const u = c.username.toLowerCase();
        if (seen.has(u)) { reasons.duplicate++; continue; }
        seen.add(u);
        entries.push(c);
      }
    }
    const unique = r.mode === 'perUser' ? entries.length : new Set(entries.map(c => c.username.toLowerCase())).size;
    return { entries, unique, reasons, total: S.comments.length };
  }

  const REASON_LABEL = {
    reply: 'Respostas (não contam)', nouser: 'Sem perfil identificado', hidden: 'Comentários ocultos', date: 'Fora do prazo',
    user: 'Perfis excluídos', keyword: 'Sem a palavra obrigatória', mentions: 'Menções insuficientes', duplicate: 'Repetidos do mesmo perfil',
  };

  function updateElig() {
    const r = readRules();
    const el = computeEligibility(r);
    S.elig = el;
    $('#eligCount').textContent = fmt(el.entries.length);
    $('#eligLabel').textContent = r.mode === 'perUser' ? 'perfis participando' : `comentários válidos · ${plural(el.unique, 'perfil', 'perfis')}`;
    const items = [`<li><span>Comentários carregados</span><span>${fmt(el.total)}</span></li>`];
    for (const [k, v] of Object.entries(el.reasons)) if (v) items.push(`<li class="minus"><span>${REASON_LABEL[k]}</span><span>−${fmt(v)}</span></li>`);
    const need = r.winners + r.subs;
    if (el.unique < need) items.push(`<li class="minus"><span>⚠ Faltam perfis para ${plural(need, 'vaga', 'vagas')}</span><span>${fmt(el.unique)}</span></li>`);
    $('#eligList').innerHTML = items.join('');
    $('#btnToDraw').disabled = el.entries.length === 0;
    updateStepper();
  }

  /* =========================================================
     Passo 4 — sorteio
     ========================================================= */
  function prepareStage() {
    const r = readRules();
    const el = computeEligibility(r);
    S.elig = el;
    $('#stageTitle').textContent = r.title || 'Sorteio';
    $('#stageMeta').textContent = `${plural(el.entries.length, 'participação', 'participações')} · ${plural(r.winners, 'ganhador', 'ganhadores')}${r.subs ? ` + ${plural(r.subs, 'suplente', 'suplentes')}` : ''}`;
    if (!S.currentDraw) {
      $('#slotLabel').textContent = 'Tudo pronto';
      $('#slotName').className = 'slot-name';
      $('#slotName').textContent = 'Boa sorte!';
      $('#slotText').textContent = `${plural(el.unique, 'perfil', 'perfis')} concorrendo.`;
      $('#btnDraw').textContent = 'Sortear';
    } else {
      $('#btnDraw').textContent = 'Sortear novamente';
    }
  }

  async function buildRecord(r, el) {
    const total = r.winners + r.subs;
    const listHash = await sha256(el.entries.map(c => `${c.id}|${c.username}|${c.timestamp || ''}`).join('\n'));
    let pool = el.entries.map((c, i) => ({ c, i }));
    const results = [];
    for (let k = 0; k < total && pool.length; k++) {
      const rnd = secureIndex(pool.length);
      const { c, i } = pool[rnd.index];
      const { seq, ...comment } = c;
      results.push({
        position: k + 1,
        role: k < r.winners ? 'ganhador' : 'suplente',
        rank: k < r.winners ? k + 1 : k - r.winners + 1,
        entryIndex: i, poolSize: pool.length, poolIndex: rnd.index, randomValue: rnd.value, rejected: rnd.rejected,
        comment: JSON.parse(JSON.stringify(comment)),
      });
      const u = c.username.toLowerCase();
      pool = pool.filter(p => p.c.username.toLowerCase() !== u); // um perfil não ganha duas vezes
    }

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const code = `SRT-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${uid().slice(0, 4).toUpperCase()}`;
    const L = S.loader;
    const p = S.post;

    return {
      id: uid(), code, createdAt: now.toISOString(), appVersion: APP_VERSION,
      demo: S.sourceType === 'demo',
      title: r.title || `Sorteio de ${fmtDate(now.toISOString())}`,
      notes: r.notes,
      source: {
        type: S.sourceType,
        account: S.sourceType === 'api' && S.account ? { id: S.account.id, username: S.account.username, name: S.account.name, kind: S.account.kind } : null,
        apiVersion: S.sourceType === 'api' ? S.apiVersion : null,
        fileName: S.importMeta?.fileName || null,
      },
      post: {
        id: p.id, permalink: p.permalink || null, caption: p.caption || '', username: p.username || S.account?.username || null,
        timestamp: p.timestamp || null, media_type: p.media_type || null, thumbnail: thumbOf(p) || null,
        comments_count: p.comments_count ?? null, like_count: p.like_count ?? null,
      },
      load: {
        totalLoaded: S.comments.length, topLevel: S.comments.length - S.replies, replies: S.replies, uniqueProfiles: S.users.size,
        pages: S.sourceType === 'api' ? L.pages : null, complete: !!L.done, includeReplies: L.includeReplies,
        startedAt: L.startedAt, finishedAt: L.finishedAt,
      },
      rules: r,
      eligibility: { entries: el.entries.length, uniqueProfiles: el.unique, excluded: el.reasons },
      audit: {
        method: 'crypto.getRandomValues (gerador criptográfico do navegador), inteiro de 32 bits com amostragem por rejeição — distribuição uniforme, sem viés.',
        order: 'Participações ordenadas pela data do comentário e, em empate, pela ordem de carregamento. Cada sorteado é retirado (com todas as participações do mesmo perfil) antes do próximo sorteio.',
        listHash, hashAlgo: 'SHA-256 das linhas "id|usuario|data" das participações, na ordem acima',
        lockedAt: now.toISOString(),
        userAgent: navigator.userAgent,
      },
      results,
      participants: r.saveParticipants
        ? el.entries.map(c => ({ id: c.id, username: c.username, text: c.text, timestamp: c.timestamp, like_count: c.like_count, parent_id: c.parent_id, from_id: c.from_id }))
        : null,
    };
  }

  async function runDraw() {
    if (S.drawing) return;
    const r = readRules();
    const el = computeEligibility(r);
    if (!el.entries.length) return toast('Nenhuma participação válida com as regras atuais.', 'error');
    if (S.sourceType === 'api' && !S.loader.done) {
      const ok = await confirmDialog('Carregamento incompleto',
        `Só ${fmt(S.comments.length)} comentários foram carregados até agora. Sortear assim mesmo? O comprovante vai registrar que a lista estava incompleta.`, 'Sortear assim mesmo');
      if (!ok) return;
    }
    if (S.currentDraw) {
      const ok = await confirmDialog('Sortear novamente?', `O sorteio ${S.currentDraw.code} continua salvo no histórico. Um novo registro será criado.`, 'Sortear novamente');
      if (!ok) return;
    }

    S.drawing = true;
    const btn = $('#btnDraw');
    btn.disabled = true;
    $('#afterDraw').hidden = true;
    $('#results').innerHTML = '';

    let record;
    try {
      record = await buildRecord(r, el);
      record.owner = S.user?.uid || null;
      record.synced = false;
      await DB.put('draws', record); // salvo antes da animação: o resultado já está travado
    } catch (e) {
      S.drawing = false; btn.disabled = false;
      return toast('Não foi possível salvar o sorteio: ' + (e.message || e), 'error', 8000);
    }
    S.currentDraw = record;
    updateHistoryCount();
    if (record.owner) uploadDraw(record); // envia para a nuvem em segundo plano, durante a animação

    const fast = $('#optFast').checked;
    for (const res of record.results) {
      const label = res.role === 'ganhador' ? (r.winners > 1 ? `${res.rank}º ganhador` : 'Ganhador') : `${res.rank}º suplente`;
      if (!fast) await roll(el.entries, res.position === 1 ? 3600 : 2200, label);
      const slotName = $('#slotName');
      $('#slotLabel').textContent = label;
      slotName.className = 'slot-name';
      void slotName.offsetWidth;
      slotName.classList.add('is-win');
      slotName.textContent = '@' + res.comment.username;
      $('#slotText').innerHTML = highlight(res.comment.text);
      if (res.role === 'ganhador') confetti();
      $('#results').insertAdjacentHTML('beforeend', winnerCard(res, r));
      if (!fast && res !== record.results[record.results.length - 1]) await sleep(1300);
    }
    if (record.results.length < r.winners + r.subs) toast('Não havia perfis suficientes para preencher todas as vagas.', 'warn', 7000);
    toast(`Sorteio ${record.code} salvo no histórico.`, 'success', 6000);
    S.drawing = false;
    btn.disabled = false;
    btn.textContent = 'Sortear novamente';
    $('#afterDraw').hidden = false;
  }

  // Animação visual (os nomes que passam na tela são só efeito; o resultado já foi sorteado e salvo).
  function roll(entries, duration, label) {
    const name = $('#slotName');
    $('#slotLabel').textContent = `Sorteando · ${label}`;
    $('#slotText').textContent = '';
    name.className = 'slot-name is-rolling';
    const start = performance.now();
    return new Promise(resolve => {
      const tick = () => {
        const t = (performance.now() - start) / duration;
        if (t >= 1) return resolve();
        name.textContent = '@' + entries[Math.floor(Math.random() * entries.length)].username;
        setTimeout(tick, 35 + 420 * t ** 3);
      };
      tick();
    });
  }

  function roleLabel(res, rules) {
    if (res.role === 'ganhador') return rules.winners > 1 ? `${res.rank}º ganhador` : 'Ganhador';
    return `${res.rank}º suplente`;
  }

  function winnerCard(res, rules) {
    const c = res.comment;
    return `
      <article class="winner ${res.position === 1 ? 'is-main' : ''}">
        <div class="winner-head">
          ${avatar(c.username, '', 'lg')}
          <div class="who">
            <span class="pill ${res.role === 'ganhador' ? 'accent' : ''}">${esc(roleLabel(res, rules))}</span>
            <div><a href="https://www.instagram.com/${encodeURIComponent(c.username)}/" target="_blank" rel="noopener">@${esc(c.username)}</a></div>
            <small>comentou em ${esc(fmtDate(c.timestamp))}</small>
          </div>
        </div>
        <div class="quote">${c.text ? highlight(c.text) : '<em>(comentário sem texto)</em>'}</div>
        <dl>
          <dt>ID do comentário</dt><dd class="mono">${esc(c.id)}</dd>
          <dt>ID do perfil</dt><dd class="mono">${esc(c.from_id || '—')}</dd>
          <dt>Curtidas</dt><dd>${c.like_count ?? '—'}</dd>
          <dt>Tipo</dt><dd>${c.is_reply ? `Resposta ao comentário ${esc(c.parent_id)}` : 'Comentário na publicação'}</dd>
          <dt>Sorteado entre</dt><dd>${plural(res.poolSize, 'participação', 'participações')} (nº ${fmt(res.poolIndex + 1)})</dd>
        </dl>
        <details class="raw">
          <summary>Todos os dados do comentário</summary>
          <pre>${esc(JSON.stringify(c, null, 2))}</pre>
        </details>
      </article>`;
  }

  // Confete leve em canvas
  function confetti() {
    const cv = $('#confetti');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#FF8A3D', '#E2336B', '#7B3FF2', '#FFD166', '#3FCB8E', '#FFFFFF'];
    const parts = Array.from({ length: 160 }, () => ({
      x: innerWidth / 2 + (Math.random() - .5) * 200, y: innerHeight * .45,
      vx: (Math.random() - .5) * 16, vy: -Math.random() * 15 - 5,
      w: 6 + Math.random() * 6, h: 8 + Math.random() * 10,
      r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    const start = performance.now();
    (function frame(now) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const life = (now - start) / 2600;
      for (const p of parts) {
        p.vy += .38; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.globalAlpha = Math.max(0, 1 - life);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.cos(p.r * 2));
        ctx.restore();
      }
      if (life < 1) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(start);
  }

  function newDraw() {
    stopLoading();
    resetComments();
    S.post = null; S.sourceType = null; S.importFile = null; S.importMeta = null;
    S.loader = freshLoader(false);
    $('#ruleTitle').value = ''; $('#ruleNotes').value = '';
    $('#pasteInput').value = ''; $('#fileInput').value = ''; $('#fileName').textContent = 'CSV, JSON ou TXT';
    goStep(1);
  }

  /* =========================================================
     Histórico
     ========================================================= */
  // Sorteios visíveis agora: os da conta Google conectada, ou os sem dono quando ninguém entrou.
  async function allDraws() {
    const owner = S.user?.uid || null;
    const list = (await DB.all('draws')).filter(d => (d.owner || null) === owner);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function renderHistory() {
    const box = $('#historyList');
    let list;
    try { list = await allDraws(); } catch (e) { box.innerHTML = `<div class="empty-state"><h3>Armazenamento indisponível</h3><p>${esc(e.message || e)}</p></div>`; return; }
    const q = fold($('#historySearch').value.trim().replace(/^@/, ''));
    const kind = S.historyKind || 'all';
    if (kind !== 'all') list = list.filter(d => (d.kind || 'instagram') === kind);
    if (q) list = list.filter(d => fold(d.kind === 'numbers' ? Numbers.searchText(d) : [d.title, d.code, d.post?.caption, d.post?.username, ...d.results.map(r => r.comment.username)].join(' ')).includes(q));
    if (!list.length) {
      const filtered = q || kind !== 'all';
      box.innerHTML = `<div class="empty-state"><h3>${filtered ? 'Nada encontrado' : 'Nenhum sorteio ainda'}</h3><p>${filtered ? 'Tente outro termo de busca ou outro filtro.' : 'Os sorteios realizados aparecem aqui com todos os detalhes.'}</p>${filtered ? '' : '<div class="row wrap" style="justify-content:center"><button class="btn primary" data-goto-view="new">Sortear comentários</button><button class="btn" data-goto-view="numbers">Sortear números</button></div>'}</div>`;
      return;
    }
    box.innerHTML = list.map(d => {
      if (d.kind === 'numbers') return Numbers.historyItem(d);
      const winners = d.results.filter(r => r.role === 'ganhador');
      const subs = d.results.length - winners.length;
      return `<button type="button" class="h-item" data-draw="${esc(d.id)}">
        <span class="h-thumb">${d.post?.thumbnail ? `<img src="${esc(d.post.thumbnail)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
        <span class="h-main">
          <strong class="h-title">${esc(d.title)}</strong>
          <span class="h-meta">${esc(d.code)} · ${esc(fmtDate(d.createdAt))} · Instagram · ${esc(SOURCE_LABEL[d.source.type] || '')}${d.post?.username ? ' · @' + esc(d.post.username) : ''}</span>
          <span class="h-winners">${winners.map(w => `<span class="pill accent">🏆 @${esc(w.comment.username)}</span>`).join('')}${subs ? `<span class="pill">+${plural(subs, 'suplente', 'suplentes')}</span>` : ''}${d.demo ? '<span class="pill warn">Demo</span>' : ''}${d.load.complete ? '' : '<span class="pill warn">Lista incompleta</span>'}${d.owner && !d.synced ? '<span class="pill warn">Aguardando envio à nuvem</span>' : ''}</span>
        </span>
        <span class="h-side"><strong>${fmt(d.eligibility.entries)}</strong>participações</span>
      </button>`;
    }).join('');
  }

  /* =========================================================
     Detalhe / comprovante
     ========================================================= */
  const kv = rows => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const yesNo = b => (b ? 'Sim' : 'Não');

  // Cabeçalho do comprovante, comum aos sorteios de Instagram e de números.
  function detailHead(d) {
    const kindLabel = d.kind === 'numbers' ? 'sorteio de números' : 'sorteio do Instagram';
    return `
      <button type="button" class="btn ghost back no-print" data-goto-view="history">← Histórico</button>
      <header class="detail-head">
        <div>
          <p class="eyebrow">Comprovante · ${kindLabel}${d.demo ? ' · demonstração' : ''}</p>
          <h1>${esc(d.title)}</h1>
          <p class="code">${esc(d.code)} · realizado em ${esc(fmtDate(d.createdAt))}</p>
          <p class="no-print" style="margin-top:8px">${d.owner ? (d.synced ? '<span class="pill ok">Salvo na sua conta Google</span>' : '<span class="pill warn">Aguardando envio à nuvem</span>') : '<span class="pill">Salvo só neste navegador</span>'}</p>
        </div>
        <div class="row wrap no-print">
          <button type="button" class="btn" data-act="print">Imprimir / PDF</button>
          <button type="button" class="btn" data-act="json">Exportar JSON</button>
          <button type="button" class="btn" data-act="csv">Planilha CSV</button>
          <button type="button" class="btn ghost danger" data-act="delete">Excluir</button>
        </div>
      </header>`;
  }

  async function openDetail(id) {
    let d = await DB.get('draws', id);
    if (!d) return toast('Sorteio não encontrado.', 'error');
    if (!d.participants && d.participantsInCloud && S.user && window.Cloud) {
      toast('Buscando a lista de participantes na nuvem…', 'info', 2500);
      try {
        d = { ...d, participants: await Cloud.getParticipants(id) };
        await DB.put('draws', d);
      } catch (e) {
        toast('Não foi possível buscar os participantes: ' + (e.message || e), 'error', 7000);
      }
    }
    showView('detail');
    $('#detail').dataset.id = d.id;
    if (d.kind === 'numbers') return Numbers.renderDetail(d, detailHead(d));
    const R = d.rules;
    const P = d.post;
    const L = d.load;
    const reasons = Object.entries(d.eligibility.excluded || {}).filter(([, v]) => v);

    $('#detail').innerHTML = `
      ${detailHead(d)}

      ${L.complete ? '' : '<div class="card" style="border-color:var(--warn);background:var(--warn-soft)"><strong>Atenção:</strong> este sorteio foi feito antes de terminar o carregamento de todos os comentários.</div>'}

      <div class="section-title"><h3>Resultado</h3></div>
      <div class="results">${d.results.map(r => winnerCard(r, R)).join('')}</div>

      <div class="detail-grid" style="margin-top:16px">
        <div class="card">
          <h3>Publicação</h3>
          ${kv([
            ['Perfil', P.username ? '@' + esc(P.username) : '—'],
            ['Legenda', esc(P.caption || '—')],
            ['Publicada em', esc(fmtDate(P.timestamp))],
            ['Link', P.permalink ? `<a href="${esc(P.permalink)}" target="_blank" rel="noopener">${esc(P.permalink)}</a>` : '—'],
            ['ID da publicação', `<span class="mono">${esc(P.id)}</span>`],
            P.comments_count != null && ['Comentários (Instagram)', fmt(P.comments_count)],
            ['Origem dos dados', esc(SOURCE_LABEL[d.source.type]) + (d.source.fileName ? ` — ${esc(d.source.fileName)}` : '')],
            d.source.account && ['Conta conectada', `@${esc(d.source.account.username)} (API ${esc(d.source.apiVersion)})`],
          ])}
        </div>
        <div class="card">
          <h3>Carregamento</h3>
          ${kv([
            ['Comentários carregados', fmt(L.totalLoaded)],
            ['Comentários principais', fmt(L.topLevel)],
            ['Respostas', fmt(L.replies)],
            ['Perfis diferentes', fmt(L.uniqueProfiles)],
            L.pages != null && ['Páginas lidas da API', fmt(L.pages)],
            ['Lista completa', L.complete ? '<span class="pill ok">Sim</span>' : '<span class="pill warn">Não</span>'],
            L.startedAt && ['Início da leitura', esc(fmtDate(L.startedAt))],
            L.finishedAt && ['Fim da leitura', esc(fmtDate(L.finishedAt))],
          ])}
        </div>
        <div class="card">
          <h3>Regras aplicadas</h3>
          ${kv([
            ['Ganhadores', fmt(R.winners)],
            ['Suplentes', fmt(R.subs)],
            ['Contagem', R.mode === 'perUser' ? '1 chance por perfil' : '1 chance por comentário'],
            ['Menções mínimas', fmt(R.minMentions)],
            ['Palavras obrigatórias', R.keywords.length ? esc(R.keywords.join(', ')) + (R.keywords.length > 1 ? ` (${R.keywordMode === 'all' ? 'todas' : 'qualquer uma'})` : '') : '—'],
            ['Comentários até', R.until ? esc(fmtDate(new Date(R.until).toISOString())) : 'Sem limite'],
            ['Perfis excluídos', R.exclude.length ? esc(R.exclude.map(u => '@' + u).join(', ')) : '—'],
            ['Excluir próprio perfil', yesNo(R.excludeOwner)],
            ['Ignorar ocultos', yesNo(R.ignoreHidden)],
            ['Respostas contam', yesNo(R.includeReplies)],
            R.notes && ['Observações', esc(R.notes)],
          ])}
        </div>
        <div class="card">
          <h3>Participação</h3>
          ${kv([
            ['Participações válidas', `<strong>${fmt(d.eligibility.entries)}</strong>`],
            ['Perfis concorrendo', fmt(d.eligibility.uniqueProfiles)],
            ...reasons.map(([k, v]) => [REASON_LABEL[k] || k, '−' + fmt(v)]),
          ])}
        </div>
        <div class="card span2">
          <h3>Auditoria</h3>
          ${kv([
            ['Método', esc(d.audit.method)],
            ['Ordem e regra', esc(d.audit.order)],
            ['Hash da lista', d.audit.listHash ? `<span class="mono">${esc(d.audit.listHash)}</span>` : 'Indisponível'],
            ['Cálculo do hash', esc(d.audit.hashAlgo)],
            ['Resultado travado em', esc(fmtDate(d.audit.lockedAt))],
            ['Sorteios', d.results.map(r => `${esc(roleLabel(r, R))}: nº ${fmt(r.poolIndex + 1)} de ${fmt(r.poolSize)} <span class="muted mono">(valor ${r.randomValue})</span>`).join('<br>')],
            ['Navegador', `<span class="muted small">${esc(d.audit.userAgent)}</span>`],
            ['ID do registro', `<span class="mono">${esc(d.id)}</span>`],
          ])}
        </div>
      </div>

      <div class="section-title">
        <h3>Participantes ${d.participants ? `(${fmt(d.participants.length)})` : ''}</h3>
        ${d.participants ? '<input type="search" class="input no-print" id="partSearch" placeholder="Buscar participante">' : ''}
      </div>
      <div class="card">
        ${d.participants ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>#</th><th>Perfil</th><th>Comentário</th><th>Data</th></tr></thead>
            <tbody id="partBody"></tbody>
          </table></div>
          <p class="muted small" id="partNote" style="margin-top:10px"></p>`
        : `<p class="muted">${d.participantsInCloud ? 'A lista de participantes está na nuvem. Entre com a conta Google para vê-la.' : 'A lista completa de participantes não foi salva neste sorteio (opção desativada nas regras).'}</p>`}
      </div>`;

    $('#detail').dataset.id = d.id;
    if (d.participants) {
      const render = () => {
        const q = fold(($('#partSearch')?.value || '').trim().replace(/^@/, ''));
        const winnersIdx = new Set(d.results.map(r => r.entryIndex));
        let rows = d.participants.map((p, i) => ({ p, i }));
        if (q) rows = rows.filter(({ p }) => fold(p.username).includes(q) || fold(p.text).includes(q));
        $('#partBody').innerHTML = rows.slice(0, TABLE_LIMIT).map(({ p, i }) => `
          <tr><td class="idx">${i + 1}</td><td class="user">@${esc(p.username)}${winnersIdx.has(i) ? ' 🏆' : ''}</td><td class="text">${highlight(p.text)}</td><td class="date">${esc(fmtDate(p.timestamp))}</td></tr>`).join('')
          || '<tr><td colspan="4" class="empty">Nenhum participante encontrado.</td></tr>';
        $('#partNote').textContent = rows.length > TABLE_LIMIT ? `Mostrando ${fmt(TABLE_LIMIT)} de ${fmt(rows.length)}. A lista completa vai no CSV e no JSON.` : '';
      };
      render();
      $('#partSearch').addEventListener('input', debounce(render, 200));
    }
  }

  const csvCell = v => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const safeName = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'sorteio';

  async function detailAction(act) {
    const id = $('#detail').dataset.id;
    const d = await DB.get('draws', id);
    if (!d) return;
    if (act === 'print') window.print();
    if (act === 'json') download(`${d.code}-${safeName(d.title)}.json`, JSON.stringify(d, null, 2), 'application/json');
    if (act === 'csv' && d.kind === 'numbers') {
      download(`${d.code}-numeros.csv`, '﻿' + Numbers.csv(d), 'text/csv;charset=utf-8');
    } else if (act === 'csv') {
      const byIndex = new Map(d.results.map(r => [r.entryIndex, roleLabel(r, d.rules)]));
      const head = ['resultado', 'n', 'id_comentario', 'perfil', 'comentario', 'data', 'curtidas', 'id_perfil', 'resposta_de'];
      const source = d.participants || d.results.map(r => ({ ...r.comment, _i: r.entryIndex }));
      const lines = source.map((p, i) => {
        const idx = p._i ?? i;
        return [byIndex.get(idx) || '', idx + 1, p.id, '@' + p.username, p.text, p.timestamp ? fmtDate(p.timestamp) : '', p.like_count ?? '', p.from_id || '', p.parent_id || ''].map(csvCell).join(';');
      });
      download(`${d.code}-participantes.csv`, '﻿' + [head.join(';'), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
    }
    if (act === 'delete') {
      const where = d.owner ? 'da sua conta Google e de todos os aparelhos' : 'deste navegador';
      const ok = await confirmDialog('Excluir este sorteio?', `O registro ${d.code} será apagado ${where}. Exporte o JSON antes se quiser guardar uma cópia.`, 'Excluir');
      if (!ok) return;
      if (d.owner && d.synced) {
        try { await Cloud.deleteDraw(id); } catch (e) { return toast('Não foi possível excluir da nuvem: ' + (e.message || e), 'error', 7000); }
      }
      await DB.del('draws', id);
      if (S.currentDraw?.id === id) S.currentDraw = null;
      updateHistoryCount();
      toast('Sorteio excluído.');
      showView('history');
    }
  }

  /* =========================================================
     Ajustes
     ========================================================= */
  function fillSettings() {
    $('#setToken').value = S.token;
    $('#setVersion').value = S.apiVersion;
    $('#setRemember').checked = S.remember;
  }

  function saveSettingsForm() {
    const token = $('#setToken').value.trim();
    if (token !== S.token) { S.accounts = []; S.account = null; S.posts = []; }
    S.token = token;
    S.apiVersion = $('#setVersion').value.trim() || 'v23.0';
    S.remember = $('#setRemember').checked;
    saveSettings();
    updateConn();
    toast('Ajustes salvos.', 'success');
  }

  function forgetToken() {
    S.token = ''; S.accounts = []; S.account = null; S.posts = [];
    saveSettings(); fillSettings(); updateConn();
    $('#accountBox').innerHTML = ''; $('#postPicker').hidden = true;
    toast('Token removido deste navegador.');
  }

  async function exportBackup() {
    const draws = await allDraws();
    if (!draws.length) return toast('Ainda não há sorteios para exportar.', 'warn');
    for (const d of draws) {
      if (!d.participants && d.participantsInCloud && S.user) {
        try { d.participants = await Cloud.getParticipants(d.id); } catch { /* exporta sem a lista */ }
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    download(`backup-sorteios-${stamp}.json`, JSON.stringify({ app: 'sorteador-instagram', version: APP_VERSION, exportedAt: new Date().toISOString(), draws }, null, 2), 'application/json');
  }

  function restoreBackup(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(String(reader.result));
        const draws = (Array.isArray(data) ? data : data.draws || [data]).filter(d => d && d.id && d.code && Array.isArray(d.results));
        if (!draws.length) throw new Error('Nenhum sorteio válido no arquivo.');
        for (const d of draws) await DB.put('draws', { ...d, owner: S.user?.uid || null, synced: false });
        updateHistoryCount();
        toast(`${plural(draws.length, 'sorteio restaurado', 'sorteios restaurados')}.`, 'success');
        if (S.user) syncWithCloud();
      } catch (e) {
        toast('Backup inválido: ' + e.message, 'error', 7000);
      }
      $('#restoreInput').value = '';
    };
    reader.readAsText(file);
  }

  /* =========================================================
     Conta Google e nuvem
     ========================================================= */
  const ICON_GOOGLE = '<svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  const ICON_LOGOUT = '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>';
  const SYNC_LABEL = { idle: 'Conectando à nuvem…', syncing: 'Sincronizando…', ok: 'Histórico salvo na nuvem', error: 'Falha ao sincronizar · tentar de novo' };

  function cloudError(e) {
    const code = e?.code || '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
    if (code === 'auth/unauthorized-domain') return `Este endereço (${location.hostname}) ainda não está autorizado no Firebase. Adicione-o em Authentication → Configurações → Domínios autorizados.`;
    if (code === 'auth/network-request-failed' || code === 'unavailable') return 'Sem conexão com a nuvem. Os sorteios ficam neste aparelho e são enviados quando a conexão voltar.';
    if (code === 'permission-denied') return 'A nuvem recusou o acesso. Confira se as regras de segurança do Firestore foram publicadas.';
    if (code === 'auth/operation-not-allowed') return 'O login com Google não está ativado no Firebase (Authentication → Método de login).';
    return `Nuvem: ${e?.message || e}`;
  }

  function renderUserBox() {
    const box = $('#userBox');
    if (!S.authReady) {
      box.innerHTML = '<p class="user-hint">Verificando conta…</p>';
    } else if (!S.user) {
      box.innerHTML = `
        <button type="button" class="btn google block" data-cloud="signin">${ICON_GOOGLE}<span>Entrar com Google</span></button>
        <p class="user-hint">Entre para guardar seus sorteios na nuvem e acessar de qualquer aparelho. Ao entrar, você aceita os <a href="termos.html">Termos</a> e a <a href="privacidade.html">Privacidade</a>.</p>`;
    } else {
      const u = S.user;
      box.innerHTML = `
        <div class="user-card" data-goto-view="settings" title="Conta e sincronização">
          ${avatar(u.name || u.email, u.photo)}
          <div class="who"><strong>${esc(u.name || 'Minha conta')}</strong><small>${esc(u.email)}</small></div>
          <button type="button" class="icon-btn" data-cloud="signout" title="Sair da conta" aria-label="Sair da conta">${ICON_LOGOUT}</button>
        </div>
        <button type="button" class="sync-line is-${S.sync}" data-cloud="sync" title="Sincronizar agora"><span class="dot"></span><span>${SYNC_LABEL[S.sync]}</span></button>`;
    }
    renderAccountCard();
  }

  async function renderAccountCard() {
    const card = $('#accountCard');
    if (!S.user) {
      card.innerHTML = `
        <h3>Conta Google</h3>
        <p class="muted">Sem login, os sorteios ficam salvos apenas neste navegador. Entre com sua conta Google para guardar o histórico na nuvem, com segurança, e acessá-lo de qualquer computador ou celular.</p>
        <button type="button" class="btn google" data-cloud="signin">${ICON_GOOGLE}<span>Entrar com Google</span></button>
        <p class="muted small" style="margin-top:12px">Ao entrar, você concorda com os <a href="termos.html">Termos de Uso</a> e a <a href="privacidade.html">Política de Privacidade</a>.</p>`;
      return;
    }
    const all = await DB.all('draws').catch(() => []);
    const mine = all.filter(d => d.owner === S.user.uid);
    const pending = mine.filter(d => !d.synced).length;
    const anon = all.filter(d => !d.owner).length;
    const u = S.user;
    card.innerHTML = `
      <h3>Conta Google</h3>
      <div class="user-card">${avatar(u.name || u.email, u.photo, 'lg')}<div class="who"><strong>${esc(u.name || 'Minha conta')}</strong><small>${esc(u.email)}</small></div></div>
      ${kv([
        ['Sorteios na nuvem', fmt(mine.length - pending)],
        pending && ['Aguardando envio', fmt(pending)],
        ['Situação', esc(SYNC_LABEL[S.sync])],
      ])}
      ${anon ? `<p class="muted small" style="margin-top:14px">${plural(anon, 'sorteio feito', 'sorteios feitos')} sem login neste navegador ainda não ${anon === 1 ? 'está' : 'estão'} na sua conta.</p>` : ''}
      <div class="row wrap" style="margin-top:16px">
        <button type="button" class="btn" data-cloud="sync">Sincronizar agora</button>
        ${anon ? '<button type="button" class="btn" data-cloud="import">Enviar para minha conta</button>' : ''}
        <button type="button" class="btn ghost" data-cloud="signout">Sair da conta</button>
      </div>
      <hr>
      <p class="muted small">Quer apagar tudo? Isso remove seus sorteios da nuvem, seu perfil e o cadastro de login. <a href="privacidade.html#direitos">Seus direitos</a></p>
      <button type="button" class="btn ghost danger" data-cloud="deleteAccount" style="margin-top:10px">Excluir minha conta e dados</button>`;
  }

  async function deleteAccountFlow() {
    if (!S.user) return;
    const uid = S.user.uid;
    const ok = await confirmDialog('Excluir conta e todos os dados?',
      'Todos os sorteios salvos na nuvem, seu perfil e o cadastro de login serão apagados de forma definitiva. Se quiser guardar uma cópia, use antes “Exportar backup”. O Google pode pedir para você confirmar a conta.', 'Excluir tudo');
    if (!ok) return;
    try {
      await Cloud.deleteAccount();
    } catch (e) {
      const m = cloudError(e);
      if (m) toast('Não foi possível concluir a exclusão. ' + m, 'error', 9000);
      return;
    }
    for (const d of await DB.all('draws')) if (d.owner === uid) await DB.del('draws', d.id);
    if (S.currentDraw?.owner === uid) S.currentDraw = null;
    refreshHistory();
    toast('Sua conta e seus dados foram excluídos.', 'success', 6000);
  }

  function initCloud() {
    if (S.cloudInit || !window.Cloud) return;
    S.cloudInit = true;
    Cloud.onChange(onUserChange);
  }

  async function onUserChange(user) {
    S.user = user;
    S.authReady = true;
    S.sync = user ? 'syncing' : 'idle';
    renderUserBox();
    // O detalhe aberto pode ser de outra conta: volta para a lista.
    if ($('#view-detail').classList.contains('is-active')) showView('history');
    if (user) {
      Cloud.touchProfile().catch(() => {});
      await syncWithCloud();
    } else {
      refreshHistory();
    }
  }

  function refreshHistory() {
    updateHistoryCount();
    if ($('#view-history').classList.contains('is-active')) renderHistory();
  }

  async function uploadDraw(rec, quiet = false) {
    try {
      await Cloud.saveDraw(rec);
      const cur = await DB.get('draws', rec.id);
      if (cur) await DB.put('draws', { ...cur, synced: true, participantsInCloud: !!(cur.participants && cur.participants.length) });
      if (S.currentDraw?.id === rec.id) S.currentDraw.synced = true;
      if (!quiet) { S.sync = 'ok'; renderUserBox(); }
      return true;
    } catch (e) {
      console.warn('Envio à nuvem falhou', e);
      S.sync = 'error';
      renderUserBox();
      if (!quiet) toast('Sorteio salvo neste aparelho, mas o envio para a nuvem falhou. Ele será reenviado na próxima sincronização.', 'warn', 8000);
      return false;
    }
  }

  // Envia o que está pendente e traz da nuvem o que foi feito em outros aparelhos.
  async function syncWithCloud() {
    if (!S.user || S.syncing) return;
    S.syncing = true;
    S.sync = 'syncing';
    renderUserBox();
    const uid = S.user.uid;
    try {
      const local = await DB.all('draws');
      let failed = 0;
      for (const d of local.filter(x => x.owner === uid && !x.synced)) if (!(await uploadDraw(d, true))) failed++;
      const remote = await Cloud.listDraws();
      if (S.user?.uid !== uid) return;
      const byId = new Map(local.map(d => [d.id, d]));
      const remoteIds = new Set(remote.map(r => r.id));
      for (const r of remote) {
        await DB.put('draws', { ...r, owner: uid, synced: true, participants: byId.get(r.id)?.participants || null });
      }
      // Excluídos em outro aparelho
      for (const l of local) if (l.owner === uid && l.synced && !remoteIds.has(l.id)) await DB.del('draws', l.id);
      S.sync = failed ? 'error' : 'ok';
      const anon = local.filter(d => !d.owner).length;
      if (anon && !S.askedImport) { S.askedImport = true; setTimeout(() => offerImport(anon), 500); }
    } catch (e) {
      S.sync = 'error';
      const m = cloudError(e);
      if (m) toast(m, 'error', 9000);
    } finally {
      S.syncing = false;
      renderUserBox();
      refreshHistory();
    }
  }

  async function offerImport(n) {
    const ok = await confirmDialog('Guardar sorteios na sua conta?',
      `Este navegador tem ${plural(n, 'sorteio feito', 'sorteios feitos')} sem login. Deseja enviá-${n === 1 ? 'lo' : 'los'} para a sua conta Google? Você também pode fazer isso depois em Ajustes.`, 'Enviar para a conta');
    if (ok) importAnon();
  }

  async function importAnon() {
    if (!S.user) return;
    const anon = (await DB.all('draws')).filter(d => !d.owner);
    if (!anon.length) return;
    for (const d of anon) await DB.put('draws', { ...d, owner: S.user.uid, synced: false });
    await syncWithCloud();
    if (S.sync === 'ok') toast(`${plural(anon.length, 'sorteio enviado', 'sorteios enviados')} para a sua conta.`, 'success');
  }

  async function signIn() {
    if (!window.Cloud) return toast('O login não está disponível agora. Verifique a internet e recarregue a página.', 'error', 7000);
    try {
      await Cloud.signIn();
    } catch (e) {
      const m = cloudError(e);
      if (m) toast(m, 'error', 9000);
    }
  }

  async function signOutFlow() {
    if (!S.user) return;
    const uid = S.user.uid;
    const ownPending = async () => (await DB.all('draws')).filter(d => d.owner === uid && !d.synced).length;
    if (await ownPending()) await syncWithCloud();
    const still = await ownPending();
    const ok = await confirmDialog('Sair da conta?', still
      ? `${plural(still, 'sorteio ainda não foi enviado', 'sorteios ainda não foram enviados')} para a nuvem e ${still === 1 ? 'fica' : 'ficam'} guardado${still === 1 ? '' : 's'} neste navegador até você entrar de novo.`
      : 'Seus sorteios continuam salvos na sua conta Google. As cópias deste navegador serão removidas.', 'Sair');
    if (!ok) return;
    for (const d of await DB.all('draws')) if (d.owner === uid && d.synced) await DB.del('draws', d.id);
    if (S.currentDraw?.owner === uid) S.currentDraw = null;
    await Cloud.signOut();
    toast('Você saiu da conta.');
  }

  function cloudAction(act) {
    if (act === 'signin') signIn();
    if (act === 'signout') signOutFlow();
    if (act === 'sync') syncWithCloud();
    if (act === 'import') importAnon();
    if (act === 'deleteAccount') deleteAccountFlow();
  }

  /* =========================================================
     Eventos
     ========================================================= */
  function bind() {
    $$('.nav-item').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    $$('#stepper button').forEach(b => b.addEventListener('click', () => goStep(Number(b.closest('li').dataset.step))));

    document.addEventListener('click', e => {
      const t = e.target.closest('[data-goto-view],[data-goto],[data-acc],[data-post],[data-draw],[data-act],[data-cloud]');
      if (!t) return;
      if (t.dataset.cloud) cloudAction(t.dataset.cloud);
      else if (t.dataset.gotoView) showView(t.dataset.gotoView);
      else if (t.dataset.goto) goStep(Number(t.dataset.goto));
      else if (t.dataset.acc) selectAccount(S.accounts[Number(t.dataset.acc)]);
      else if (t.dataset.post) choosePost(S.posts[Number(t.dataset.post)], 'api');
      else if (t.dataset.draw) openDetail(t.dataset.draw);
      else if (t.dataset.act) detailAction(t.dataset.act);
    });

    $$('.source-card').forEach(c => c.addEventListener('click', () => selectSource(c.dataset.source)));
    $('#btnConnect').addEventListener('click', connect);
    $('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
    $('#btnMorePosts').addEventListener('click', loadPosts);
    $('#btnFindLink').addEventListener('click', findByLink);
    $('#postLink').addEventListener('keydown', e => { if (e.key === 'Enter') findByLink(); });

    const dz = $('#dropzone');
    $('#fileInput').addEventListener('change', e => readFile(e.target.files[0]));
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('is-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('is-over'); readFile(e.dataTransfer.files[0]); });
    $('#btnImport').addEventListener('click', doImport);

    $('#demoCount').addEventListener('input', e => { $('#demoCountOut').textContent = fmt(Number(e.target.value)); });
    $('#btnDemo').addEventListener('click', doDemo);

    $('#btnLoadStart').addEventListener('click', startLoading);
    $('#btnLoadPause').addEventListener('click', stopLoading);
    $('#btnLoadReset').addEventListener('click', resetLoading);
    $('#optReplies').addEventListener('change', toggleReplies);
    $('#commentSearch').addEventListener('input', debounce(renderTable, 200));

    const onRules = debounce(updateElig, 150);
    $('#rulesForm').addEventListener('input', onRules);
    $('#rulesForm').addEventListener('change', onRules);

    $('#btnDraw').addEventListener('click', runDraw);
    $('#btnViewReceipt').addEventListener('click', () => S.currentDraw && openDetail(S.currentDraw.id));
    $('#btnNewDraw').addEventListener('click', newDraw);

    $('#historySearch').addEventListener('input', debounce(renderHistory, 200));
    $$('#historyKind button').forEach(b => b.addEventListener('click', () => {
      S.historyKind = b.dataset.kind;
      $$('#historyKind button').forEach(x => x.classList.toggle('is-active', x === b));
      renderHistory();
    }));

    $('#btnSaveSettings').addEventListener('click', saveSettingsForm);
    $('#btnForget').addEventListener('click', forgetToken);
    $('#btnBackup').addEventListener('click', exportBackup);
    $('#restoreInput').addEventListener('change', e => restoreBackup(e.target.files[0]));
    $('#btnClearCache').addEventListener('click', async () => {
      const ok = await confirmDialog('Limpar cache?', 'Os comentários salvos para retomar carregamentos serão apagados. O histórico de sorteios não é afetado.', 'Limpar');
      if (!ok) return;
      await DB.clear('cache');
      toast('Cache de comentários limpo.');
    });

    window.addEventListener('online', () => { if (S.user) syncWithCloud(); });
    window.addEventListener('cloud:ready', initCloud);

    window.addEventListener('beforeunload', e => {
      if (S.loader.running || S.drawing) { saveCache(); e.preventDefault(); e.returnValue = ''; }
    });
  }

  function init() {
    bind();
    updateConn();
    updateHistoryCount();
    renderUserBox();
    initCloud();
    // Sem resposta do Firebase (offline ou bloqueado): libera o modo local.
    setTimeout(() => { if (!S.authReady) { S.authReady = true; renderUserBox(); } }, 8000);
    goStep(1);
    if (!window.indexedDB) toast('Este navegador não permite salvar o histórico (IndexedDB indisponível).', 'error', 10000);
  }

  // Recursos compartilhados com o sorteio de números (js/numbers.js).
  window.App = {
    APP_VERSION, TABLE_LIMIT, S, $, $$, esc, fmt, plural, fmtDate, fold, debounce, sleep, uid,
    toast, confirmDialog, busy, sha256, secureIndex, confetti, kv, yesNo, csvCell,
    uploadDraw, updateHistoryCount, openDetail, showView,
  };

  init();
})();
