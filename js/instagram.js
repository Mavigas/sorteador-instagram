/* Cliente da API oficial do Instagram.
   Aceita dois tipos de token:
     IG…  → API do Instagram com login do Instagram   (graph.instagram.com)
     EAA… → API do Instagram via Facebook/Página       (graph.facebook.com)
   Os comentários são lidos página por página seguindo `paging.next` até o fim — não há teto. */
const IG = (() => {
  const COMMENT_FIELDS = 'id,text,timestamp,username,like_count,hidden,parent_id,from{id,username}';
  const MEDIA_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count,username';
  const RATE_CODES = [4, 17, 32, 613, 80001, 80002];

  class ApiError extends Error {
    constructor(message, info = {}) { super(message); Object.assign(this, info); }
  }

  const kind = token => /^IG/i.test(token.trim()) ? 'instagram' : 'facebook';
  const base = (token, version) =>
    (kind(token) === 'instagram' ? 'https://graph.instagram.com/' : 'https://graph.facebook.com/') + version;

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Abortado', 'AbortError')); }, { once: true });
    });
  }

  function withToken(url, token) {
    const u = new URL(url);
    if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', token);
    return u.toString();
  }

  // Remove o token de URLs de paginação antes de guardar em cache.
  function stripToken(url) {
    if (!url) return url;
    const u = new URL(url);
    u.searchParams.delete('access_token');
    return u.toString();
  }

  function translate(e) {
    const code = e.code;
    if (code === 190) return 'Token inválido ou expirado. Gere um novo token e cole em Ajustes.';
    if (code === 10 || (code >= 200 && code < 300)) return 'O token não tem as permissões necessárias para ler comentários. Veja a ajuda em Ajustes.';
    if (code === 100 && /nonexist|does not exist|Unsupported get/i.test(e.message || '')) return 'Publicação ou conta não encontrada para este token (a API só acessa publicações da sua própria conta).';
    return `Instagram: ${e.error_user_msg || e.message || 'erro desconhecido'} (código ${code})`;
  }

  /* GET com novas tentativas automáticas.
     Limite de requisições → espera (até 15 min) e tenta de novo; o carregamento nunca é descartado. */
  async function get(url, token, { signal, onWait } = {}) {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw new DOMException('Abortado', 'AbortError');
      let res, data;
      try {
        res = await fetch(withToken(url, token), { signal });
        data = await res.json();
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (++attempt > 6) throw new ApiError('Falha de rede ao falar com o Instagram. Verifique a conexão e clique em Continuar.', { network: true });
        const ms = Math.min(60000, 1000 * 2 ** attempt);
        onWait?.(ms, 'rede');
        await wait(ms, signal);
        continue;
      }
      if (data && data.error) {
        const e = data.error;
        const rate = RATE_CODES.includes(e.code) || res.status === 429;
        const transient = rate || e.code === 1 || e.code === 2 || e.is_transient || res.status >= 500;
        if (transient && attempt < 10) {
          attempt++;
          const ms = rate ? Math.min(15 * 60000, 60000 * attempt) : Math.min(60000, 1500 * 2 ** attempt);
          onWait?.(ms, rate ? 'limite' : 'instabilidade');
          await wait(ms, signal);
          continue;
        }
        throw new ApiError(translate(e), { code: e.code, raw: e, rate });
      }
      if (!res.ok) throw new ApiError(`Erro HTTP ${res.status} ao acessar o Instagram.`);
      return data;
    }
  }

  async function accounts(token, version) {
    const b = base(token, version);
    if (kind(token) === 'instagram') {
      const me = await get(`${b}/me?fields=id,user_id,username,name,profile_picture_url,account_type,media_count`, token);
      return [{ id: me.id, igUserId: me.user_id || me.id, username: me.username, name: me.name || '', picture: me.profile_picture_url || '', mediaCount: me.media_count, kind: 'instagram' }];
    }
    const out = [];
    let url = `${b}/me/accounts?fields=name,instagram_business_account{id,username,name,profile_picture_url,media_count}&limit=100`;
    while (url) {
      const d = await get(url, token);
      for (const p of d.data || []) {
        const a = p.instagram_business_account;
        if (a) out.push({ id: a.id, igUserId: a.id, username: a.username, name: a.name || p.name, picture: a.profile_picture_url || '', mediaCount: a.media_count, page: p.name, kind: 'facebook' });
      }
      url = d.paging?.next || null;
    }
    if (!out.length) throw new ApiError('Nenhuma conta profissional do Instagram está vinculada às Páginas deste token.');
    return out;
  }

  async function media(token, version, account, nextUrl) {
    const owner = account.kind === 'instagram' ? 'me' : account.id;
    const url = nextUrl || `${base(token, version)}/${owner}/media?fields=${MEDIA_FIELDS}&limit=24`;
    const d = await get(url, token);
    return { items: d.data || [], next: d.paging?.next || null };
  }

  function shortcodeFrom(link) {
    const m = String(link).match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : null;
  }

  // Percorre todas as publicações da conta até achar a do link informado.
  async function findByLink(token, version, account, link, onProgress) {
    const code = shortcodeFrom(link);
    if (!code) throw new ApiError('Link inválido. Use o endereço completo da publicação (…/p/CODIGO/ ou …/reel/CODIGO/).');
    let next = null, scanned = 0;
    do {
      const page = await media(token, version, account, next);
      for (const m of page.items) {
        scanned++;
        if (m.permalink && m.permalink.includes(`/${code}`)) return m;
      }
      onProgress?.(scanned);
      next = page.next;
    } while (next);
    throw new ApiError('Essa publicação não foi encontrada na conta conectada.');
  }

  /* Gerador assíncrono: devolve um lote por página da API.
     `startUrl` permite retomar exatamente de onde parou. */
  async function* comments(token, version, mediaId, { includeReplies = false, startUrl = null, signal, onWait } = {}) {
    const fields = COMMENT_FIELDS + (includeReplies ? `,replies.limit(50){${COMMENT_FIELDS}}` : '');
    let url = startUrl || `${base(token, version)}/${mediaId}/comments?fields=${encodeURIComponent(fields)}&limit=50`;
    while (url) {
      const d = await get(url, token, { signal, onWait });
      const batch = [];
      for (const c of d.data || []) {
        const { replies, ...comment } = c;
        batch.push(comment);
        if (includeReplies && replies) {
          const tag = r => ({ ...r, parent_id: r.parent_id || c.id });
          batch.push(...(replies.data || []).map(tag));
          let rn = replies.paging?.next;
          while (rn) {
            const rd = await get(rn, token, { signal, onWait });
            batch.push(...(rd.data || []).map(tag));
            rn = rd.paging?.next;
          }
        }
      }
      url = d.paging?.next || null;
      yield { batch, nextUrl: url };
    }
  }

  // Formato único usado pelo app; o objeto original da API fica em `raw`.
  function normalize(raw) {
    const username = String(raw.username || raw.from?.username || '').replace(/^@/, '').trim();
    return {
      id: String(raw.id),
      username,
      text: raw.text || '',
      timestamp: raw.timestamp || null,
      like_count: raw.like_count ?? null,
      hidden: !!raw.hidden,
      parent_id: raw.parent_id || null,
      is_reply: !!raw.parent_id,
      from_id: raw.from?.id || null,
      raw,
    };
  }

  return { kind, accounts, media, findByLink, comments, normalize, stripToken, shortcodeFrom, ApiError };
})();
