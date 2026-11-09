/* Conversa com o Supabase (projeto setor_de_qualidade) por fetch puro, sem biblioteca:
   login do supervisor, catálogo, envio das obras e das fotos.
   A chave daqui é a "anon/publishable": ela é pública por natureza. Quem protege os
   dados são as regras (RLS) de supabase/01_estrutura.sql. */
(function () {
  const CFG = window.NUVEM_CONFIG || {};
  const PRAZO = 30000;
  const CHAVE_SESSAO = "medicao_sessao";

  const configurada = () => !!(CFG.url && CFG.chave);

  function lerSessao() {
    try { return JSON.parse(localStorage.getItem(CHAVE_SESSAO) || "null"); } catch (e) { return null; }
  }
  function gravarSessao(s) {
    try {
      if (s) localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s));
      else localStorage.removeItem(CHAVE_SESSAO);
    } catch (e) { /* sem espaço */ }
  }

  class ErroNuvem extends Error {
    constructor(msg, status) { super(msg); this.status = status; }
  }

  async function chamar(caminho, { metodo = "GET", corpo, cabecalhos = {}, autenticado = true, bruto = false } = {}) {
    const h = { apikey: CFG.chave, ...cabecalhos };
    if (autenticado) h.Authorization = `Bearer ${await token()}`;
    if (corpo !== undefined && !(corpo instanceof Blob) && !h["Content-Type"]) h["Content-Type"] = "application/json";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PRAZO);
    let r;
    try {
      r = await fetch(CFG.url + caminho, {
        method: metodo,
        headers: h,
        body: corpo === undefined ? undefined : corpo instanceof Blob ? corpo : JSON.stringify(corpo),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new ErroNuvem("Sem conexão com o banco.", 0);
    } finally {
      clearTimeout(t);
    }
    if (!r.ok) {
      let msg = `Erro ${r.status}`;
      try {
        const j = await r.json();
        msg = j.msg || j.message || j.error_description || j.error || msg;
      } catch (e) { /* sem corpo */ }
      throw new ErroNuvem(msg, r.status);
    }
    if (bruto) return r;
    const texto = await r.text();
    return texto ? JSON.parse(texto) : null;
  }

  // ---------------------------------------------------------------- sessão
  let renovando = null;
  async function token() {
    const s = lerSessao();
    if (!s) throw new ErroNuvem("Entre de novo.", 401);
    if (s.expira_em - 60 > Date.now() / 1000) return s.access_token;
    if (!renovando) {
      renovando = chamar("/auth/v1/token?grant_type=refresh_token", {
        metodo: "POST", corpo: { refresh_token: s.refresh_token }, autenticado: false,
      })
        .then((r) => {
          gravarSessao({ ...s, access_token: r.access_token, refresh_token: r.refresh_token, expira_em: r.expires_at || Date.now() / 1000 + r.expires_in });
          return r.access_token;
        })
        .catch((e) => {
          if (e.status === 400 || e.status === 401) gravarSessao(null);
          throw e;
        })
        .finally(() => (renovando = null));
    }
    return renovando;
  }

  async function entrar(email, senha) {
    const r = await chamar("/auth/v1/token?grant_type=password", {
      metodo: "POST", corpo: { email, password: senha }, autenticado: false,
    }).catch((e) => {
      if (e.status === 400) throw new ErroNuvem("E-mail ou senha incorretos.", 400);
      throw e;
    });
    gravarSessao({
      access_token: r.access_token, refresh_token: r.refresh_token,
      expira_em: r.expires_at || Date.now() / 1000 + r.expires_in,
      user: { id: r.user.id, email: r.user.email },
    });
    const perfil = await meuPerfil().catch((e) => {
      gravarSessao(null);
      throw e;
    });
    if (!perfil) {
      gravarSessao(null);
      throw new ErroNuvem("Sua conta ainda não está liberada para a Medição de Campo.", 403);
    }
    if (!perfil.ativo) {
      gravarSessao(null);
      throw new ErroNuvem("Seu acesso à Medição de Campo está desativado.", 403);
    }
    return perfil;
  }

  function sair() {
    const s = lerSessao();
    gravarSessao(null);
    if (s) chamar("/auth/v1/logout", { metodo: "POST", cabecalhos: { Authorization: `Bearer ${s.access_token}` }, autenticado: false }).catch(() => {});
  }

  async function meuPerfil() {
    const s = lerSessao();
    const r = await chamar(`/rest/v1/medicao_supervisores?user_id=eq.${s.user.id}&select=*`);
    return r[0] || null;
  }

  // ---------------------------------------------------------------- catálogo
  async function catalogo() {
    const servicos = [];
    for (let de = 0; ; de += 1000) {
      const parte = await chamar(`/rest/v1/medicao_servicos?select=id,departamento,codigo,descricao,operacao,us&order=id&limit=1000&offset=${de}`);
      servicos.push(...parte);
      if (parte.length < 1000) break;
    }
    const us = await chamar("/rest/v1/medicao_valor_us?select=ano,departamento,valor");
    const valor_us = {};
    us.forEach((u) => ((valor_us[u.ano] ||= {})[u.departamento] = u.valor));
    return { gerado_em: new Date().toISOString(), valor_us, servicos };
  }

  // ---------------------------------------------------------------- supervisores
  const supervisores = () => chamar("/rest/v1/medicao_supervisores?select=*&order=nome");
  const alterarSupervisor = (id, campos) =>
    chamar(`/rest/v1/medicao_supervisores?user_id=eq.${id}`, { metodo: "PATCH", corpo: campos, cabecalhos: { Prefer: "return=minimal" } });
  // funções do banco (supabase/03_usuarios.sql): só o administrador consegue
  const criarUsuario = (email, senha, nome, admin) =>
    chamar("/rest/v1/rpc/medicao_criar_usuario", { metodo: "POST", corpo: { p_email: email, p_senha: senha, p_nome: nome, p_admin: admin } });
  const trocarSenha = (userId, senha) =>
    chamar("/rest/v1/rpc/medicao_trocar_senha", { metodo: "POST", corpo: { p_user_id: userId, p_senha: senha } });

  // ---------------------------------------------------------------- obras
  const listarObras = () => chamar("/rest/v1/medicao_obras_lista?select=*&order=atualizada_em.desc&limit=500");
  const baixarObra = async (id) => (await chamar(`/rest/v1/medicao_obras?id=eq.${id}&select=*`))[0] || null;
  const apagarObra = (id) => chamar(`/rest/v1/medicao_obras?id=eq.${id}`, { metodo: "DELETE", cabecalhos: { Prefer: "return=minimal" } });

  const caminhoFoto = (obraId, fotoId) => `${obraId}/${fotoId}.jpg`;
  const enviarFoto = (obraId, foto) =>
    chamar(`/storage/v1/object/medicao-fotos/${caminhoFoto(obraId, foto.id)}`, {
      metodo: "POST", corpo: foto.blob, cabecalhos: { "Content-Type": "image/jpeg", "x-upsert": "true" },
    });
  const baixarFoto = async (obraId, fotoId) =>
    (await chamar(`/storage/v1/object/authenticated/medicao-fotos/${caminhoFoto(obraId, fotoId)}`, { bruto: true })).blob();
  const listarFotos = async (obraId) =>
    (await chamar("/storage/v1/object/list/medicao-fotos", { metodo: "POST", corpo: { prefix: `${obraId}/`, limit: 1000 } }))
      .map((o) => o.name.replace(/\.jpg$/, ""));
  const apagarFotos = (obraId, ids) =>
    ids.length
      ? chamar("/storage/v1/object/medicao-fotos", { metodo: "DELETE", corpo: { prefixes: ids.map((id) => caminhoFoto(obraId, id)) } })
      : Promise.resolve();

  /** Manda uma obra: primeiro as fotos que faltam, depois o documento, e por fim
   *  apaga do banco as fotos que o supervisor excluiu. */
  async function enviarObra(obra, totais) {
    const fotosLocais = await Banco.fotosDaObra(obra.id);
    const usadas = new Set(obra.pontos.flatMap((p) => p.fotos));
    const infos = {};
    for (const f of fotosLocais) {
      if (!usadas.has(f.id)) continue;
      if (!f.enviada) {
        await enviarFoto(obra.id, f);
        f.enviada = true;
        await Banco.salvarFoto(f);
      }
      infos[f.id] = { pontoId: f.pontoId, criada_em: f.criada_em, gps: f.gps || null, largura: f.largura, altura: f.altura };
    }
    // foto que veio do banco e ainda não foi baixada neste aparelho
    for (const id of usadas) if (!infos[id] && obra.fotos_info?.[id]) infos[id] = obra.fotos_info[id];
    const enviadoEm = obra.atualizada_em;
    await chamar("/rest/v1/medicao_obras?on_conflict=id", {
      metodo: "POST",
      cabecalhos: { Prefer: "resolution=merge-duplicates,return=minimal" },
      corpo: {
        id: obra.id, numero: obra.numero, local: obra.local || null, municipio: obra.municipio || null,
        departamento: obra.departamento, equipe: obra.equipe || null, obs: obra.obs || null,
        pontos: obra.pontos, fotos: infos, total: totais.valor, total_us: totais.us,
        qtd_pontos: obra.pontos.length, criada_em: obra.criada_em, atualizada_em: obra.atualizada_em,
      },
    });
    try {
      const noBanco = await listarFotos(obra.id);
      await apagarFotos(obra.id, noBanco.filter((id) => !usadas.has(id)));
    } catch (e) { /* limpeza fica para o próximo envio */ }
    // só marca como enviada se ninguém mexeu na obra enquanto ela subia
    const atual = await Banco.obterObra(obra.id);
    if (atual && atual.atualizada_em === enviadoEm) {
      atual.pendente = false;
      atual.enviada_em = new Date().toISOString();
      atual.fotos_info = infos;
      atual.erro_envio = null;
      await Banco.salvarObra(atual, { envio: true });
    }
  }

  window.Nuvem = {
    configurada, ErroNuvem, lerSessao, entrar, sair, meuPerfil, catalogo, supervisores, alterarSupervisor, criarUsuario, trocarSenha,
    listarObras, baixarObra, apagarObra, enviarObra, baixarFoto, listarFotos, apagarFotos,
  };
})();
