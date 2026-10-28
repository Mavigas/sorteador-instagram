/* Sorteio de números — rifas, bingos e sorteios por número.
   Dois modos:
     intervalo → todos os números de "De" até "Até", menos os marcados como fora do sorteio
     lista     → só os números vendidos, cada um com o nome (e contato) do comprador
   Usa o mesmo gerador criptográfico, histórico, comprovante e sincronização na nuvem do sorteio do Instagram. */
(() => {
  'use strict';

  const {
    APP_VERSION, TABLE_LIMIT, S, $, $$, esc, fmt, plural, fmtDate, fold, debounce, sleep, uid,
    toast, confirmDialog, sha256, secureIndex, confetti, kv, yesNo, csvCell,
  } = window.App;

  const MAX_RANGE = 1_000_000_000;  // cabe com folga no inteiro de 32 bits do sorteio
  const MAX_LIST = 1_000_000;

  const N = { drawing: false, current: null, list: { entries: [], duplicates: 0, ignored: 0, error: null } };

  /* =========================================================
     Leitura dos números
     ========================================================= */
  const toInt = v => (/^\s*\d+\s*$/.test(String(v)) ? parseInt(v, 10) : NaN);

  // Junta intervalos [a, b] que se sobrepõem ou encostam.
  function merge(intervals) {
    const sorted = intervals.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of sorted) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  // "7, 13, 40-50" → [[7,7],[13,13],[40,50]]
  function parseSet(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/(\d+)\s*(?:-|–|a|até)\s*(\d+)|(\d+)/gi)) {
      if (m[3] != null) { const n = +m[3]; out.push([n, n]); }
      else { const a = +m[1], b = +m[2]; out.push([Math.min(a, b), Math.max(a, b)]); }
    }
    return merge(out);
  }

  const intervalsText = list => list.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
  const PHONE = /\s*[-–·|]?\s*(\+?\d{0,3}\s?\(?\d{2}\)?\s?9?\d{4}[-\s.]?\d{4})\s*$/;

  /* Lista de vendidos. Aceita, por linha:
       "12 Maria Silva", "12 - Maria (67) 99999-0000", "10-15 Ana", "27, 28, 31",
       ou CSV/TSV com colunas número;nome;contato (o cabeçalho é ignorado). */
  function parseList(text) {
    const entries = [];
    const seen = new Set();
    let duplicates = 0, ignored = 0;
    const add = (number, name, extra) => {
      if (seen.has(number)) { duplicates++; return; }
      if (entries.length >= MAX_LIST) throw new Error(`A lista passou de ${fmt(MAX_LIST)} números.`);
      seen.add(number);
      entries.push({ number, name: name || '', extra: extra || '' });
    };
    const addRange = (a, b, name, extra) => {
      if (b - a > MAX_LIST) throw new Error(`A faixa ${a}-${b} é grande demais para uma lista. Use o modo Intervalo.`);
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) add(n, name, extra);
    };

    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      // Só números, faixas e separadores: "27, 28, 31" ou "40-45"
      if (/^[\d\s,;–-]+$/.test(line)) {
        parseSet(line).forEach(([a, b]) => addRange(a, b));
        continue;
      }
      // Colunas de planilha
      if (/[;\t]/.test(line)) {
        const cols = line.split(/[;\t]/).map(c => c.trim().replace(/^"|"$/g, ''));
        const m = cols[0].match(/^(\d+)(?:\s*(?:-|–|a|até)\s*(\d+))?$/i);
        if (!m) { ignored++; continue; }
        const name = cols[1] || '', extra = cols.slice(2).filter(Boolean).join(' · ');
        if (m[2]) addRange(+m[1], +m[2], name, extra); else add(+m[1], name, extra);
        continue;
      }
      // Texto livre: número (ou faixa) seguido do nome
      const m = line.match(/^#?(\d+)(?:\s*(?:-|–|a|até)\s*(\d+))?\s*[-–:.,)]?\s*(.*)$/i);
      if (!m) { ignored++; continue; }
      let rest = m[3].trim(), extra = '';
      const phone = rest.match(PHONE);
      if (phone) { extra = phone[1].trim(); rest = rest.slice(0, phone.index).trim(); }
      if (m[2]) addRange(+m[1], +m[2], rest, extra); else add(+m[1], rest, extra);
    }
    entries.sort((a, b) => a.number - b.number);
    return { entries, duplicates, ignored };
  }

  function readConfig() {
    const mode = $('input[name=numMode]:checked').value;
    return {
      title: $('#numTitle').value.trim(),
      mode,
      min: toInt($('#numMin').value),
      max: toInt($('#numMax').value),
      exclude: parseSet($('#numExclude').value),
      count: Math.max(1, parseInt($('#numCount').value, 10) || 1),
      prizes: $('#numPrizes').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
      noRepeat: $('#numNoRepeat').checked,
      uniquePerson: mode === 'list' && $('#numUniquePerson').checked,
      pad: $('#numPad').checked,
      notes: $('#numNotes').value.trim(),
    };
  }

  // Quantos números concorrem e como exibi-los.
  function computePool(cfg) {
    if (cfg.mode === 'list') {
      const L = N.list;
      if (L.error) return { error: L.error };
      if (!L.entries.length) return { error: 'Informe os números vendidos.' };
      const maxN = L.entries[L.entries.length - 1].number;
      return { size: L.entries.length, digits: String(maxN).length, listCount: L.entries.length, duplicates: L.duplicates, ignored: L.ignored, excludedCount: 0 };
    }
    if (isNaN(cfg.min) || isNaN(cfg.max)) return { error: 'Informe números inteiros em “De” e “Até”.' };
    if (cfg.min > cfg.max) return { error: '“De” precisa ser menor ou igual a “Até”.' };
    const total = cfg.max - cfg.min + 1;
    if (total > MAX_RANGE) return { error: `O intervalo pode ter no máximo ${fmt(MAX_RANGE)} números.` };
    const excl = merge(cfg.exclude.map(([a, b]) => [Math.max(a, cfg.min), Math.min(b, cfg.max)]));
    const excludedCount = excl.reduce((s, [a, b]) => s + (b - a + 1), 0);
    const size = total - excludedCount;
    if (size <= 0) return { error: 'Todos os números do intervalo estão fora do sorteio.' };
    return { size, digits: String(cfg.max).length, excl, excludedCount };
  }

  const show = (n, pad, digits) => (pad ? String(n).padStart(digits, '0') : String(n));

  function describe(cfg, pool) {
    if (cfg.mode === 'list') return `${plural(pool.listCount ?? pool.size, 'número vendido', 'números vendidos')}`;
    return `${show(cfg.min, cfg.pad, pool.digits)} a ${show(cfg.max, cfg.pad, pool.digits)}`;
  }

  /* =========================================================
     Painel
     ========================================================= */
  function syncMode() {
    const list = $('input[name=numMode]:checked').value === 'list';
    $('#numRangeBox').hidden = list;
    $('#numListBox').hidden = !list;
    $('#numUniqueWrap').hidden = !list;
  }

  function reparseList() {
    try {
      N.list = { ...parseList($('#numList').value), error: null };
    } catch (e) {
      N.list = { entries: [], duplicates: 0, ignored: 0, error: e.message };
    }
    const L = N.list;
    const named = L.entries.filter(e => e.name).length;
    $('#numListInfo').textContent = L.error ? L.error : L.entries.length
      ? [plural(L.entries.length, 'número', 'números'), named ? `${fmt(named)} com nome` : '', L.duplicates ? `${plural(L.duplicates, 'repetido ignorado', 'repetidos ignorados')}` : '', L.ignored ? `${plural(L.ignored, 'linha não reconhecida', 'linhas não reconhecidas')}` : ''].filter(Boolean).join(' · ')
      : '';
  }

  function updatePanel() {
    syncMode();
    const cfg = readConfig();
    const pool = computePool(cfg);
    $('#numStageTitle').textContent = cfg.title || 'Sorteio de números';
    if (pool.error) {
      $('#numStageMeta').textContent = pool.error;
      $('#btnNumDraw').disabled = true;
    } else {
      $('#numStageMeta').textContent = `${plural(pool.size, 'número participando', 'números participando')} · ${plural(cfg.count, 'sorteio', 'sorteios')}`;
      $('#btnNumDraw').disabled = N.drawing;
    }
    if (!N.current && !N.drawing) {
      $('#numSlotLabel').textContent = 'Tudo pronto';
      renderDigits(pool.error ? '?' : '–'.repeat(pool.digits || 1));
      $('#numSlotText').textContent = pool.error ? '' : describe(cfg, pool);
    }
  }

  function renderDigits(text, cls = '') {
    const box = $('#numDigits');
    box.style.setProperty('--n', Math.max(1, text.length));
    box.innerHTML = [...text].map(ch => `<span class="digit ${cls}">${esc(ch)}</span>`).join('');
  }

  // Cada dígito gira e para da esquerda para a direita, revelando o número.
  function roll(finalText, duration) {
    const box = $('#numDigits');
    renderDigits(finalText);
    const cells = $$('.digit', box);
    const start = performance.now();
    const stops = cells.map((_, i) => duration * (0.45 + 0.55 * ((i + 1) / cells.length)));
    return new Promise(resolve => {
      const tick = () => {
        const t = performance.now() - start;
        let pending = 0;
        cells.forEach((c, i) => {
          if (t >= stops[i]) {
            if (!c.classList.contains('is-set')) { c.textContent = finalText[i]; c.classList.add('is-set'); }
          } else {
            pending++;
            c.textContent = String(Math.floor(Math.random() * 10));
          }
        });
        if (pending) setTimeout(tick, 55); else resolve();
      };
      tick();
    });
  }

  const posLabel = (r, total) => (total > 1 ? `${r.rank}º sorteado` : 'Número sorteado');

  function ballCard(r, total) {
    return `
      <article class="ball-card ${r.position === 1 ? 'is-main' : ''}">
        <span class="ball">${esc(r.display)}</span>
        <div class="ball-info">
          <span class="pill accent">${esc(posLabel(r, total))}</span>
          ${r.prize ? `<strong class="prize">${esc(r.prize)}</strong>` : ''}
          ${r.name ? `<span class="buyer">${esc(r.name)}</span>` : ''}
          ${r.extra ? `<small class="muted">${esc(r.extra)}</small>` : ''}
          <small class="muted">entre ${plural(r.poolSize, 'número', 'números')} · posição ${fmt(r.poolIndex + 1)}</small>
        </div>
      </article>`;
  }

  /* =========================================================
     Sorteio
     ========================================================= */
  async function buildRecord(cfg, pool) {
    const picks = [];
    let listHash;

    if (cfg.mode === 'range') {
      listHash = await sha256(`intervalo:${cfg.min}-${cfg.max}|fora:${intervalsText(pool.excl)}`);
      let excl = pool.excl.map(x => [...x]);
      const total = cfg.max - cfg.min + 1;
      for (let k = 0; k < cfg.count; k++) {
        const size = total - excl.reduce((s, [a, b]) => s + (b - a + 1), 0);
        if (size <= 0) break;
        const rnd = secureIndex(size);
        // Posição sorteada → número real, pulando os intervalos excluídos.
        let x = cfg.min + rnd.index;
        for (const [a, b] of excl) { if (a <= x) x += b - a + 1; else break; }
        picks.push({ number: x, name: '', extra: '', poolSize: size, poolIndex: rnd.index, randomValue: rnd.value, rejected: rnd.rejected });
        if (cfg.noRepeat) excl = merge([...excl, [x, x]]);
      }
    } else {
      const entries = N.list.entries;
      listHash = await sha256(entries.map(e => `${e.number}|${e.name}`).join('\n'));
      let pool2 = entries.slice();
      for (let k = 0; k < cfg.count && pool2.length; k++) {
        const rnd = secureIndex(pool2.length);
        const e = pool2[rnd.index];
        picks.push({ number: e.number, name: e.name, extra: e.extra, poolSize: pool2.length, poolIndex: rnd.index, randomValue: rnd.value, rejected: rnd.rejected });
        if (cfg.uniquePerson && e.name) {
          const who = fold(e.name);
          pool2 = pool2.filter(p => fold(p.name) !== who);
        } else if (cfg.noRepeat) {
          pool2.splice(rnd.index, 1);
        }
      }
    }

    const now = new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const results = picks.map((p, k) => ({
      position: k + 1, rank: k + 1, role: 'sorteado', prize: cfg.prizes[k] || null,
      display: show(p.number, cfg.pad, pool.digits), ...p,
    }));

    return {
      id: uid(),
      kind: 'numbers',
      code: `SRT-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${uid().slice(0, 4).toUpperCase()}`,
      createdAt: now.toISOString(),
      appVersion: APP_VERSION,
      demo: false,
      title: cfg.title || `Sorteio de números de ${fmtDate(now.toISOString())}`,
      notes: cfg.notes,
      config: {
        mode: cfg.mode, min: cfg.mode === 'range' ? cfg.min : null, max: cfg.mode === 'range' ? cfg.max : null,
        exclude: cfg.mode === 'range' ? intervalsText(pool.excl) : '',
        count: cfg.count, prizes: cfg.prizes, noRepeat: cfg.noRepeat, uniquePerson: cfg.uniquePerson, pad: cfg.pad,
      },
      pool: { size: pool.size, digits: pool.digits, excludedCount: pool.excludedCount || 0, listCount: pool.listCount ?? null, duplicates: pool.duplicates || 0, ignored: pool.ignored || 0 },
      audit: {
        method: 'crypto.getRandomValues (gerador criptográfico do navegador), inteiro de 32 bits com amostragem por rejeição — distribuição uniforme, sem viés.',
        order: cfg.mode === 'range'
          ? 'Números do intervalo em ordem crescente, sem os que estão fora do sorteio; o valor aleatório escolhe a posição.' + (cfg.noRepeat ? ' Cada número sorteado sai antes do próximo sorteio.' : ' Números podem se repetir.')
          : 'Números vendidos em ordem crescente; o valor aleatório escolhe a posição.' + (cfg.uniquePerson ? ' Ao ser sorteado, o comprador sai com todos os seus números.' : cfg.noRepeat ? ' Cada número sorteado sai antes do próximo sorteio.' : ' Números podem se repetir.'),
        listHash,
        hashAlgo: cfg.mode === 'range' ? 'SHA-256 do texto "intervalo:DE-ATÉ|fora:EXCLUÍDOS"' : 'SHA-256 das linhas "número|nome" da lista, em ordem crescente',
        lockedAt: now.toISOString(),
        userAgent: navigator.userAgent,
      },
      results,
      participants: cfg.mode === 'list' ? N.list.entries.map(e => ({ ...e })) : null,
      owner: S.user?.uid || null,
      synced: false,
    };
  }

  async function run() {
    if (N.drawing) return;
    const cfg = readConfig();
    const pool = computePool(cfg);
    if (pool.error) return toast(pool.error, 'error');
    if (N.current) {
      const ok = await confirmDialog('Sortear novamente?', `O sorteio ${N.current.code} continua salvo no histórico. Um novo registro será criado.`, 'Sortear novamente');
      if (!ok) return;
    }

    N.drawing = true;
    const btn = $('#btnNumDraw');
    btn.disabled = true;
    $('#numAfter').hidden = true;
    $('#numResults').innerHTML = '';

    let rec;
    try {
      rec = await buildRecord(cfg, pool);
      await DB.put('draws', rec); // salvo antes da animação: o resultado já está travado
    } catch (e) {
      N.drawing = false; btn.disabled = false;
      return toast('Não foi possível salvar o sorteio: ' + (e.message || e), 'error', 8000);
    }
    N.current = rec;
    App.updateHistoryCount();
    if (rec.owner) App.uploadDraw(rec);

    const fast = $('#numFast').checked;
    const total = rec.results.length;
    const dur = k => (total > 20 ? 450 : total > 3 ? 1100 : k === 0 ? 3200 : 2200);
    for (const [k, r] of rec.results.entries()) {
      $('#numSlotLabel').textContent = `Sorteando${total > 1 ? ` · ${r.rank}º número` : ''}${r.prize ? ' · ' + r.prize : ''}`;
      $('#numSlotText').textContent = '';
      if (fast) renderDigits(r.display, 'is-set');
      else await roll(r.display, dur(k));
      $('#numSlotLabel').textContent = `${posLabel(r, total)}${r.prize ? ' · ' + r.prize : ''}`;
      $('#numSlotText').textContent = [r.name, r.extra].filter(Boolean).join(' · ');
      $('#numResults').insertAdjacentHTML('beforeend', ballCard(r, total));
      if (!fast && (k === 0 || total <= 5)) confetti();
      if (!fast && k < total - 1) await sleep(total > 20 ? 150 : 900);
    }
    if (fast) confetti();
    if (total < cfg.count) toast(`Só havia números para ${plural(total, 'sorteio', 'sorteios')}.`, 'warn', 7000);
    toast(`Sorteio ${rec.code} salvo no histórico.`, 'success', 6000);
    N.drawing = false;
    btn.disabled = false;
    btn.textContent = 'Sortear novamente';
    $('#numAfter').hidden = false;
  }

  function resetResults() {
    N.current = null;
    $('#numResults').innerHTML = '';
    $('#numAfter').hidden = true;
    $('#btnNumDraw').textContent = 'Sortear';
    updatePanel();
  }

  /* =========================================================
     Histórico e comprovante
     ========================================================= */
  const cfgOf = d => ({ ...d.config });

  function historyItem(d) {
    const shown = d.results.slice(0, 4).map(r => `<span class="pill accent">🎟 ${esc(r.display)}${r.name ? ' · ' + esc(r.name) : ''}</span>`).join('');
    const more = d.results.length > 4 ? `<span class="pill">+${fmt(d.results.length - 4)}</span>` : '';
    return `<button type="button" class="h-item" data-draw="${esc(d.id)}">
      <span class="h-thumb num-thumb" aria-hidden="true">#</span>
      <span class="h-main">
        <strong class="h-title">${esc(d.title)}</strong>
        <span class="h-meta">${esc(d.code)} · ${esc(fmtDate(d.createdAt))} · Números · ${esc(describe(cfgOf(d), d.pool))}</span>
        <span class="h-winners">${shown}${more}${d.owner && !d.synced ? '<span class="pill warn">Aguardando envio à nuvem</span>' : ''}</span>
      </span>
      <span class="h-side"><strong>${fmt(d.pool.size)}</strong>números</span>
    </button>`;
  }

  function searchText(d) {
    return [d.title, d.code, d.notes, ...d.results.map(r => `${r.display} ${r.number} ${r.name || ''} ${r.prize || ''}`)].join(' ');
  }

  function renderDetail(d, head) {
    const C = d.config, P = d.pool;
    const total = d.results.length;
    $('#detail').innerHTML = `
      ${head}
      <div class="section-title"><h3>Resultado</h3></div>
      <div class="num-results">${d.results.map(r => ballCard(r, total)).join('')}</div>

      <div class="detail-grid" style="margin-top:16px">
        <div class="card">
          <h3>Configuração</h3>
          ${kv([
            ['Tipo', C.mode === 'range' ? 'Intervalo de números' : 'Lista de números vendidos'],
            C.mode === 'range' && ['Intervalo', esc(describe(C, P))],
            C.mode === 'range' && ['Fora do sorteio', C.exclude ? esc(C.exclude) : '—'],
            ['Quantidade sorteada', `${fmt(total)}${total < C.count ? ` de ${fmt(C.count)} pedidos` : ''}`],
            ['Não repetir números', yesNo(C.noRepeat)],
            C.mode === 'list' && ['Comprador ganha uma vez', yesNo(C.uniquePerson)],
            ['Zeros à esquerda', yesNo(C.pad)],
            C.prizes?.length && ['Prêmios', C.prizes.map((p, i) => `${i + 1}º ${esc(p)}`).join('<br>')],
            d.notes && ['Observações', esc(d.notes)],
          ])}
        </div>
        <div class="card">
          <h3>Participação</h3>
          ${kv([
            ['Números participando', `<strong>${fmt(P.size)}</strong>`],
            C.mode === 'range' && ['Fora do sorteio', fmt(P.excludedCount)],
            C.mode === 'list' && P.duplicates && ['Repetidos ignorados', fmt(P.duplicates)],
            C.mode === 'list' && P.ignored && ['Linhas não reconhecidas', fmt(P.ignored)],
            C.mode === 'list' && d.participants && ['Compradores identificados', fmt(new Set(d.participants.filter(p => p.name).map(p => fold(p.name))).size)],
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
            ['Sorteios', d.results.map(r => `${esc(posLabel(r, total))}: <strong>${esc(r.display)}</strong> — posição ${fmt(r.poolIndex + 1)} de ${fmt(r.poolSize)} <span class="muted mono">(valor ${r.randomValue})</span>`).join('<br>')],
            ['Navegador', `<span class="muted small">${esc(d.audit.userAgent)}</span>`],
            ['ID do registro', `<span class="mono">${esc(d.id)}</span>`],
          ])}
        </div>
      </div>

      ${C.mode === 'list' ? `
        <div class="section-title">
          <h3>Números vendidos ${d.participants ? `(${fmt(d.participants.length)})` : ''}</h3>
          ${d.participants ? '<input type="search" class="input no-print" id="numPartSearch" placeholder="Buscar número ou nome">' : ''}
        </div>
        <div class="card">
          ${d.participants ? `
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Número</th><th>Comprador</th><th>Contato</th></tr></thead>
              <tbody id="numPartBody"></tbody>
            </table></div>
            <p class="muted small" id="numPartNote" style="margin-top:10px"></p>`
          : '<p class="muted">A lista de números está na nuvem. Entre com a conta Google para vê-la.</p>'}
        </div>` : ''}`;

    if (C.mode === 'list' && d.participants) {
      const won = new Set(d.results.map(r => r.number));
      const render = () => {
        const q = fold(($('#numPartSearch')?.value || '').trim());
        let rows = d.participants;
        if (q) rows = rows.filter(p => String(p.number).includes(q) || fold(p.name).includes(q));
        $('#numPartBody').innerHTML = rows.slice(0, TABLE_LIMIT).map(p => `
          <tr><td class="user">${esc(show(p.number, C.pad, P.digits))}${won.has(p.number) ? ' 🏆' : ''}</td><td>${esc(p.name || '—')}</td><td class="date">${esc(p.extra || '—')}</td></tr>`).join('')
          || '<tr><td colspan="3" class="empty">Nada encontrado.</td></tr>';
        $('#numPartNote').textContent = rows.length > TABLE_LIMIT ? `Mostrando ${fmt(TABLE_LIMIT)} de ${fmt(rows.length)}. A lista completa vai no CSV e no JSON.` : '';
      };
      render();
      $('#numPartSearch').addEventListener('input', debounce(render, 200));
    }
  }

  function csv(d) {
    const C = d.config, P = d.pool, total = d.results.length;
    const head = ['resultado', 'premio', 'numero', 'comprador', 'contato'];
    const byNumber = new Map();
    d.results.forEach(r => { if (!byNumber.has(r.number)) byNumber.set(r.number, r); });
    let rows;
    if (C.mode === 'list' && d.participants) {
      rows = d.participants.map(p => {
        const r = byNumber.get(p.number);
        return [r ? posLabel(r, total) : '', r?.prize || '', show(p.number, C.pad, P.digits), p.name, p.extra];
      });
    } else {
      rows = d.results.map(r => [posLabel(r, total), r.prize || '', r.display, r.name || '', r.extra || '']);
    }
    return [head.join(';'), ...rows.map(r => r.map(csvCell).join(';'))].join('\r\n');
  }

  /* =========================================================
     Eventos
     ========================================================= */
  function bind() {
    const refresh = debounce(updatePanel, 120);
    const reparseListSoon = debounce(() => { reparseList(); updatePanel(); }, 250);
    $('#numForm').addEventListener('input', e => {
      if (e.target.id === 'numList') reparseListSoon();
      else refresh();
    });
    $('#numForm').addEventListener('change', refresh);

    $('#numFile').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $('#numList').value = String(reader.result).replace(/^﻿/, '');
        reparseList();
        updatePanel();
        toast(`Arquivo ${file.name} carregado.`, 'success');
        e.target.value = '';
      };
      reader.readAsText(file, 'utf-8');
    });

    $('#btnNumDraw').addEventListener('click', run);
    $('#btnNumReset').addEventListener('click', resetResults);
    $('#btnNumReceipt').addEventListener('click', () => N.current && App.openDetail(N.current.id));
    window.addEventListener('beforeunload', e => { if (N.drawing) { e.preventDefault(); e.returnValue = ''; } });
  }

  bind();
  updatePanel();

  window.Numbers = { historyItem, renderDetail, csv, searchText, parseList, parseSet };
})();
