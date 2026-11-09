/* Medição de Campo: o supervisor abre a obra, lança ponto a ponto (P1, P2...) os
   serviços feitos com os códigos e valores do Termômetro, tira as fotos de cada
   ponto e no fim gera a medição (Excel e PDF) no padrão do fechamento do Termômetro.
   Funciona sem internet: tudo fica guardado no celular. */
(function () {
  const M = window.Medicao;
  const ROTULO = { INSTALAR: "Instalar", RETIRAR: "Retirar", EXECUTAR: "Executar" };
  const SECAO = { INSTALAR: "Instalados", RETIRAR: "Retirados", EXECUTAR: "Executados" };
  const MAX_RESULTADOS = 40;
  const FOTO_MAX = 1600;

  const $app = document.getElementById("app");
  const $aviso = document.getElementById("aviso");

  // ------------------------------------------------------------------ util
  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const novoId = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const dataLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const hoje = () => dataLocal(new Date());
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const normalizar = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const obraValida = (n) => /^(\d{8}|\d{10})$/.test(n || "");

  let tempoAviso = null;
  function avisar(texto, tipo = "ok") {
    $aviso.textContent = texto;
    $aviso.className = `aviso aviso-${tipo}`;
    $aviso.hidden = false;
    clearTimeout(tempoAviso);
    tempoAviso = setTimeout(() => ($aviso.hidden = true), 3500);
  }

  // ------------------------------------------------------------------ estado
  const estado = {
    tela: "inicio", // inicio | obra-form | obra | ponto | medicao | config
    obras: [],
    obra: null,
    pontoId: null,
    busca: "",
    escolhido: null, // {codigo, descricao, opcoes}
    qtd: "",
    foto: null, // {id, url}
    arquivo: null, // {nome, blob}
    gerando: false,
    miniaturas: new Map(), // fotoId -> objectURL
    perfil: null, // linha de medicao_supervisores
    remotas: null, // obras do banco (medicao_obras_lista)
    filtro: "minhas", // minhas | todas
    enviando: false,
    online: navigator.onLine,
    supervisores: null, // ajustes do administrador
  };
  const ponto = () => estado.obra?.pontos.find((p) => p.id === estado.pontoId);
  /** obra de outro supervisor: abre só para consulta e para gerar a medição */
  const soLeitura = (o) => o && o.dono === false;

  let tempoSalvar = null;
  function salvarDepois() {
    clearTimeout(tempoSalvar);
    tempoSalvar = setTimeout(salvarAgora, 400);
  }
  async function salvarAgora() {
    clearTimeout(tempoSalvar);
    // obra nova só existe depois do botão "Criar obra"
    if (!estado.obra || soLeitura(estado.obra) || !estado.obra.criada_em) return;
    try {
      estado.obra.dono = true;
      await Banco.salvarObra(estado.obra);
      enviarDepois();
    } catch (e) {
      avisar("Não foi possível guardar no celular. Libere espaço.", "erro");
    }
  }

  async function irPara(tela, extra = {}) {
    await salvarAgora();
    Object.assign(estado, { tela, busca: "", escolhido: null, qtd: "", arquivo: null }, extra);
    if (tela === "inicio") {
      await recarregarLocais();
      estado.obra = null;
      liberarMiniaturas();
    }
    render();
    window.scrollTo(0, 0);
  }
  async function recarregarLocais() {
    estado.obras = (await Banco.listarObras()).sort((a, b) => (b.atualizada_em || "").localeCompare(a.atualizada_em || ""));
  }

  function liberarMiniaturas() {
    estado.miniaturas.forEach((u) => URL.revokeObjectURL(u));
    estado.miniaturas.clear();
  }
  /** Foto do aparelho; se ela só existe no banco (obra aberta de lá), baixa e guarda. */
  async function fotoLocal(obra, id) {
    const f = await Banco.obterFoto(id);
    if (f) return f;
    if (!navigator.onLine || !Nuvem.lerSessao()) return null;
    try {
      const blob = await Nuvem.baixarFoto(obra.id, id);
      const info = obra.fotos_info?.[id] || {};
      const p = obra.pontos.find((x) => x.fotos.includes(id));
      const nova = { id, obraId: obra.id, pontoId: p?.id || info.pontoId, blob, enviada: true, criada_em: info.criada_em, gps: info.gps, largura: info.largura, altura: info.altura };
      await Banco.salvarFoto(nova);
      return nova;
    } catch (e) {
      return null;
    }
  }
  const carregando = new Set();
  async function carregarMiniaturas(ids) {
    const faltam = ids.filter((id) => !estado.miniaturas.has(id) && !carregando.has(id));
    if (!faltam.length) return;
    const obra = estado.obra;
    faltam.forEach((id) => carregando.add(id));
    for (const id of faltam) {
      const f = await fotoLocal(obra, id);
      if (f) estado.miniaturas.set(id, URL.createObjectURL(f.blob));
    }
    faltam.forEach((id) => carregando.delete(id));
    if (estado.obra === obra && estado.tela === "ponto") render();
  }

  // ------------------------------------------------------------------ envio ao banco
  let tempoEnvio = null;
  function enviarDepois(ms = 4000) {
    clearTimeout(tempoEnvio);
    tempoEnvio = setTimeout(enviarPendentes, ms);
  }
  /** Manda ao banco as obras alteradas e as exclusões guardadas. Sem sinal, espera. */
  async function enviarPendentes() {
    clearTimeout(tempoEnvio);
    if (estado.enviando || !navigator.onLine || !Nuvem.lerSessao()) return;
    estado.enviando = true;
    atualizarSelo();
    try {
      const exclusoes = await Banco.ler("exclusoes", []);
      for (const id of [...exclusoes]) {
        try {
          await Nuvem.apagarFotos(id, await Nuvem.listarFotos(id));
          await Nuvem.apagarObra(id);
          exclusoes.splice(exclusoes.indexOf(id), 1);
          await Banco.gravar("exclusoes", exclusoes);
        } catch (e) {
          if (e.status === 0) throw e;
        }
      }
      const obras = (await Banco.listarObras()).filter((o) => o.pendente && o.dono !== false && o.criada_em);
      for (const o of obras) {
        try {
          await Nuvem.enviarObra(o, M.totaisObra(o));
        } catch (e) {
          if (e.status === 0) throw e; // caiu o sinal: tenta tudo depois
          if (e.status === 401) { avisar("Sua sessão expirou. Entre de novo.", "erro"); return sairDaConta(true); }
          const atual = await Banco.obterObra(o.id);
          if (atual) { atual.erro_envio = e.message; await Banco.salvarObra(atual, { envio: true }); }
        }
      }
    } catch (e) {
      /* sem sinal */
    } finally {
      estado.enviando = false;
    }
    // atualiza o que está na tela sem perder o que o supervisor digita
    if (estado.obra) {
      const atual = await Banco.obterObra(estado.obra.id);
      if (atual && atual.atualizada_em === estado.obra.atualizada_em) {
        Object.assign(estado.obra, { pendente: atual.pendente, enviada_em: atual.enviada_em, erro_envio: atual.erro_envio, fotos_info: atual.fotos_info });
      }
    }
    if (estado.tela === "inicio") { await recarregarLocais(); render(); }
    atualizarSelo();
  }

  function seloHtml(o) {
    if (!o) return "";
    if (soLeitura(o)) return `<span class="selo selo-consulta">Consulta</span>`;
    if (o.erro_envio) return `<span class="selo selo-erro" title="${esc(o.erro_envio)}">⚠ Não enviada</span>`;
    if (o.pendente) return `<span class="selo selo-pendente">${estado.enviando ? "⟳ Enviando…" : "⏳ Aguardando envio"}</span>`;
    return `<span class="selo selo-ok">✓ No banco</span>`;
  }
  function atualizarSelo() {
    const el = document.getElementById("selo-obra");
    if (el && estado.obra) el.innerHTML = seloHtml(estado.obra);
  }

  // ------------------------------------------------------------------ obras do banco
  async function buscarRemotas(avisando = false) {
    if (!navigator.onLine || !Nuvem.lerSessao()) return;
    try {
      const lista = await Nuvem.listarObras();
      estado.remotas = lista;
      // obra parada no aparelho e mais nova no banco: traz a versão do banco
      for (const r of lista) {
        const local = await Banco.obterObra(r.id);
        if (local && !local.pendente && r.atualizada_em && new Date(r.atualizada_em) > new Date(local.atualizada_em)) {
          await trazerObra(r.id);
        }
      }
      if (estado.tela === "inicio") { await recarregarLocais(); render(); }
      if (avisando) avisar("Lista atualizada.");
    } catch (e) {
      if (avisando) avisar(e.message, "erro");
    }
  }

  async function trazerObra(id) {
    const r = await Nuvem.baixarObra(id);
    if (!r) throw new Error("A obra não está mais no banco.");
    const dono = r.supervisor_id === estado.perfil?.user_id;
    const remota = estado.remotas?.find((x) => x.id === id);
    const obra = {
      id: r.id, numero: r.numero, local: r.local || "", municipio: r.municipio || "", departamento: r.departamento,
      equipe: r.equipe || "", obs: r.obs || "", pontos: r.pontos || [], fotos_info: r.fotos || {},
      criada_em: r.criada_em, atualizada_em: r.atualizada_em, pendente: false, enviada_em: r.recebida_em,
      dono, supervisor_nome: remota?.supervisor_nome || null,
    };
    await Banco.salvarObra(obra, { envio: true });
    return obra;
  }

  // ------------------------------------------------------------------ render
  function render() {
    const telas = { entrar: telaEntrar, carregando: telaCarregando, inicio: telaInicio, "obra-form": telaObraForm, obra: telaObra, ponto: telaPonto, medicao: telaMedicao, config: telaConfig };
    $app.innerHTML = telas[estado.tela]();
    if (estado.tela === "ponto") {
      const p = ponto();
      if (p) carregarMiniaturas(p.fotos);
      // na mesma hora do toque: assim o celular abre o teclado
      if (estado.escolhido) document.getElementById("qtd-folha")?.focus();
    }
  }

  function topo(titulo, voltar, direita = "") {
    return `<header class="topo">
      ${voltar ? `<button type="button" class="voltar" data-acao="${voltar}">‹ Voltar</button>` : `<img src="logo-teccel-red.png" alt="Teccel" class="topo-logo">`}
      <b>${esc(titulo)}</b>
      <span class="topo-dir">${direita}</span>
    </header>`;
  }

  // ---------- entrada
  function telaEntrar() {
    return `<div class="pagina pagina-entrar">
      <form class="cartao entrar" id="form-entrar">
        <img src="logo-teccel-red.png" alt="Teccel" class="logo-entrar">
        <h1>Medição de campo</h1>
        <p class="sub centro">Entre com o seu acesso de supervisor.</p>
        ${!Nuvem.configurada() ? `<div class="erro">O endereço do banco ainda não foi configurado (config.js).</div>` : ""}
        <label class="campo">E-mail
          <input id="e-email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" required>
        </label>
        <label class="campo">Senha
          <input id="e-senha" type="password" autocomplete="current-password" required>
        </label>
        <div class="erro" id="erro-entrar" hidden></div>
        <button class="botao" id="bt-entrar">Entrar</button>
      </form>
    </div>`;
  }
  function telaCarregando() {
    return `<div class="pagina pagina-entrar"><p class="vazio centro">${esc(estado.carregandoTexto || "Carregando…")}</p></div>`;
  }

  // ---------- início
  function telaInicio() {
    const sup = estado.perfil?.nome;
    const pendentes = estado.obras.filter((o) => o.pendente && !soLeitura(o)).length;
    const minhas = estado.obras.filter((o) => !soLeitura(o));
    const consultas = estado.obras.filter(soLeitura);
    const cartao = (o) => {
      const t = M.totaisObra(o);
      return `<button type="button" class="cartao obra-item" data-acao="abrir-obra" data-id="${o.id}">
        <div class="linha-topo"><span class="chip-obra"><small>OBRA</small><b>${esc(o.numero)}</b></span><b class="valor">${M.fmtMoeda(t.valor)}</b></div>
        ${o.local || o.municipio ? `<p class="sub">${esc([o.local, o.municipio].filter(Boolean).join(" · "))}</p>` : ""}
        <small class="sub">${plural(o.pontos.length, "ponto", "pontos")} · ${plural(o.pontos.reduce((n, p) => n + p.fotos.length, 0), "foto", "fotos")}${o.supervisor_nome && soLeitura(o) ? " · " + esc(o.supervisor_nome) : ""}</small>
        <div class="linha-topo">${seloHtml(o)}<small class="sub">alterada ${M.fmtHora(o.atualizada_em)}</small></div>
      </button>`;
    };
    // obras que estão no banco e não neste aparelho
    const locais = new Set(estado.obras.map((o) => o.id));
    const meu = estado.perfil?.user_id;
    const doBanco = (estado.remotas || [])
      .filter((r) => !locais.has(r.id) && r.supervisor_id === meu)
      .map((r) => `<div class="cartao obra-item">
        <div class="linha-topo"><span class="chip-obra chip-obra-banco"><small>OBRA</small><b>${esc(r.numero)}</b></span><b class="valor">${M.fmtMoeda(Number(r.total))}</b></div>
        <small class="sub">${esc([r.local, r.municipio].filter(Boolean).join(" · "))}</small>
        <small class="sub">${plural(r.qtd_pontos, "ponto", "pontos")} · ${esc(r.supervisor_nome || "")} · alterada ${M.fmtHora(r.atualizada_em)}</small>
        <button type="button" class="botao botao-claro botao-pequeno" data-acao="trazer-obra" data-id="${r.id}">${r.supervisor_id === meu ? "Baixar para este celular" : "Abrir para consulta"}</button>
      </div>`).join("");
    return `<div class="pagina">
      ${topo("", null, `<button type="button" class="link" data-acao="config">⚙ Ajustes</button>`)}
      <section class="saudacao">
        <small>Medição de campo</small>
        <h1>${sup ? esc(sup) : "Supervisor"}</h1>
        <p>Lance os serviços de cada ponto da obra e gere a medição no padrão do Termômetro.</p>
      </section>
      ${!estado.online ? `<div class="faixa faixa-guardado">Sem internet: tudo fica guardado no celular e sobe para o banco quando o sinal voltar.</div>`
        : pendentes ? `<div class="faixa faixa-guardado">${plural(pendentes, "obra aguardando", "obras aguardando")} envio ao banco${estado.enviando ? "… enviando" : ""}.</div>` : ""}
      <button type="button" class="botao botao-grande" data-acao="nova-obra">+ Nova obra</button>
      ${instalarHtml()}
      <section class="bloco">
        <h2>Minhas obras neste celular</h2>
        ${minhas.map(cartao).join("") || `<p class="vazio">Nenhuma obra ainda. Toque em <b>Nova obra</b> para começar.</p>`}
      </section>
      ${consultas.length ? `<section class="bloco"><h2>Abertas para consulta</h2>${consultas.map(cartao).join("")}</section>` : ""}
      <section class="bloco">
        <button type="button" class="botao botao-claro" data-acao="mostrar-banco">
          ${estado.bancoAberto ? "▲ Esconder minhas obras no banco" : `▼ Mostrar minhas obras no banco${estado.remotas ? ` (${(estado.remotas || []).filter((r) => !locais.has(r.id) && r.supervisor_id === meu).length})` : ""}`}
        </button>
        ${!estado.bancoAberto ? "" : `<div class="linha-topo"><small class="sub">Obras suas que estão no banco e não neste celular.</small><button type="button" class="link" data-acao="atualizar-lista">⟳ Atualizar</button></div>
        ${estado.remotas === null ? `<p class="vazio">${estado.online ? "Carregando…" : "Sem internet."}</p>`
          : doBanco || `<p class="vazio">Nenhuma outra obra sua no banco.</p>`}`}
      </section>
    </div>`;
  }

  function instalarHtml() {
    const instalado = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (instalado || !/Android|iPhone|iPad/i.test(navigator.userAgent)) return "";
    const ios = /iPhone|iPad/i.test(navigator.userAgent);
    return `<div class="instalar"><button type="button" data-acao="instalar">📲 Instalar no celular</button>
      <p id="ajuda-instalar" hidden>${ios ? "No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início." : "No menu ⋮ do Chrome, toque em Instalar aplicativo ou Adicionar à tela inicial."}</p></div>`;
  }

  // ---------- ajustes
  function telaConfig() {
    const p = estado.perfil || {};
    const sups = estado.supervisores;
    return `<div class="pagina">
      ${topo("Ajustes", "inicio")}
      <section class="cartao dados">
        <b>Sua conta</b>
        <p class="sub">${esc(p.nome)} · ${esc(p.email)}${p.admin ? " · administrador" : ""}</p>
        <p class="sub">O nome que sai na medição é o do cadastro${p.admin ? "" : "; para corrigir, fale com o administrador"}.</p>
        <button type="button" class="botao botao-perigo" data-acao="sair">Sair da conta</button>
      </section>
      ${p.admin ? `<section class="cartao dados">
        <b>Supervisores</b>
        <p class="sub">Para dar acesso a um supervisor, crie a conta dele no Supabase (Authentication › Users › Add user, com e-mail e senha). Ele aparece aqui sozinho; ajuste o nome que sai na medição.</p>
        ${sups === null ? `<p class="vazio">Carregando…</p>` : sups.map((s) => `<div class="sup-linha">
          <input value="${esc(s.nome)}" data-sup-nome="${s.user_id}" aria-label="Nome de ${esc(s.email)}">
          <small class="sub">${esc(s.email)}</small>
          <label><input type="checkbox" data-sup-ativo="${s.user_id}" ${s.ativo ? "checked" : ""}> ativo</label>
          <label><input type="checkbox" data-sup-admin="${s.user_id}" ${s.admin ? "checked" : ""} ${s.user_id === p.user_id ? "disabled" : ""}> administrador</label>
        </div>`).join("")}
      </section>` : ""}
      <section class="cartao dados">
        <b>Backup</b>
        <p class="sub">Para passar uma obra para outro celular ou guardar uma cópia, abra a obra e toque em <b>Backup da obra</b>. Para trazer de volta:</p>
        <label class="botao botao-claro">Importar backup (.json)
          <input type="file" accept=".json,application/json" data-acao="importar" hidden>
        </label>
      </section>
      <section class="cartao dados">
        <b>Catálogo de serviços</b>
        <p class="sub">${M.SERVICOS.length} serviços do Termômetro, baixados do banco em ${M.fmtHora(M.catalogoGeradoEm)}.</p>
        <button type="button" class="botao botao-claro botao-pequeno" data-acao="atualizar-catalogo">⟳ Baixar catálogo de novo</button>
        <table class="tabela-us"><tr><th>Departamento</th><th>Valor da US (${M.anoUS(new Date().getFullYear())})</th></tr>
          ${M.DEPARTAMENTOS.map((d) => `<tr><td>${esc(d)}</td><td>${M.fmtMoeda(M.valorUS(d))}</td></tr>`).join("")}
        </table>
        <p class="sub" id="espaco"></p>
      </section>
    </div>`;
  }

  // ---------- obra (dados)
  function telaObraForm() {
    const o = estado.obra;
    const nova = !o.criada_em;
    return `<div class="pagina pagina-form">
      ${topo(nova ? "Nova obra" : "Dados da obra", nova ? "inicio" : "obra")}
      <section class="cartao dados">
        <label class="campo">Número da obra
          <input id="f-numero" value="${esc(o.numero)}" inputMode="numeric" maxlength="10" placeholder="8 ou 10 dígitos" class="${!o.numero ? "" : obraValida(o.numero) ? "valido" : "invalido"}">
          <small class="dica-erro" id="dica-numero">${o.numero && !obraValida(o.numero) ? `Tem ${o.numero.length} dígitos. Precisa de 8 ou 10.` : ""}</small>
        </label>
        <label class="campo"><span>Cidade <small>(se tiver)</small></span>
          <input id="f-municipio" value="${esc(o.municipio)}">
        </label>
        <label class="campo"><span>Observação <small>(se tiver)</small></span>
          <textarea id="f-obs" rows="2">${esc(o.obs)}</textarea>
        </label>
      </section>
      <div class="erro" id="erro-form" hidden></div>
      <div class="rodape"><button type="button" class="botao" data-acao="salvar-obra">${nova ? "Criar obra" : "Salvar"}</button></div>
    </div>`;
  }

  // ---------- obra (pontos)
  function telaObra() {
    const o = estado.obra;
    const t = M.totaisObra(o);
    const pontos = o.pontos.map((p) => {
      const tp = M.totaisPonto(p);
      return `<button type="button" class="cartao ponto-item" data-acao="abrir-ponto" data-id="${p.id}">
        <div class="linha-topo"><b class="ponto-nome">${esc(p.nome)}</b><b class="valor">${M.fmtMoeda(tp.valor)}</b></div>
        <small class="sub">${plural(p.itens.length, "serviço", "serviços")} · ${p.fotos.length ? "📷 " + p.fotos.length : "sem foto"}${p.gps ? " · 📍" : ""}</small>
        ${p.obs ? `<small class="sub">${esc(p.obs)}</small>` : ""}
      </button>`;
    }).join("");
    return `<div class="pagina pagina-form">
      ${topo("Obra", "inicio", soLeitura(o) ? "" : `<button type="button" class="link" data-acao="editar-obra">Editar</button>`)}
      <div class="linha-topo"><span id="selo-obra">${seloHtml(o)}</span>${o.enviada_em ? `<small class="sub">no banco desde ${M.fmtHora(o.enviada_em)}</small>` : ""}</div>
      ${soLeitura(o) ? `<div class="faixa faixa-consulta">Obra de ${esc(o.supervisor_nome || "outro supervisor")}: aberta só para consulta e para gerar a medição.</div>` : ""}
      ${o.erro_envio ? `<div class="erro">O banco recusou o envio: ${esc(o.erro_envio)}</div>` : ""}
      <div class="chips">
        <span class="chip-obra"><small>OBRA</small><b>${esc(o.numero)}</b></span>
        <span class="chip chip-total">Total <b>${M.fmtMoeda(t.valor)}</b></span>
        <span class="chip chip-us"><b>${M.fmtNum(t.us)}</b> US</span>
        <span class="chip"><b>${o.pontos.length}</b> ${o.pontos.length === 1 ? "ponto" : "pontos"}</span>
      </div>
      ${o.local || o.municipio || o.equipe ? `<p class="sub">${esc([o.local, o.municipio, o.equipe].filter(Boolean).join(" · "))}</p>` : ""}
      ${soLeitura(o) ? "" : `<button type="button" class="botao botao-grande" data-acao="novo-ponto">+ Novo ponto <small>${esc(proximoNome(o))}</small></button>`}
      <section class="bloco">
        <h2>Pontos da obra</h2>
        ${pontos || `<p class="vazio">Nenhum ponto ainda. Cada poste ou trecho é um ponto (P1, P2...).</p>`}
      </section>
      <section class="bloco acoes-obra">
        <button type="button" class="botao botao-claro" data-acao="backup">💾 Backup da obra</button>
        <button type="button" class="botao botao-perigo" data-acao="excluir-obra">${soLeitura(o) ? "Tirar deste celular" : "Excluir obra"}</button>
      </section>
      <div class="rodape">
        <div class="rodape-total"><span>Total da obra</span><b>${M.fmtMoeda(t.valor)}</b></div>
        <button type="button" class="botao" data-acao="medicao" ${o.pontos.some((p) => p.itens.length) ? "" : "disabled"}>Gerar medição</button>
      </div>
    </div>`;
  }

  function proximoNome(o) {
    const nums = o.pontos.map((p) => /^P(\d+)$/i.exec(p.nome.trim())).filter(Boolean).map((m) => Number(m[1]));
    return `P${(nums.length ? Math.max(...nums) : 0) + 1}`;
  }

  // ---------- ponto
  // rótulo curto do departamento; também vale na busca ("lv cruzeta")
  const SIGLA = { "C&M (LM)": "LM", "C&M (LV)": "LV", "P&LF": "P&LF" };
  const sigla = (dep) => SIGLA[dep] || dep;

  /** Um resultado por departamento + código, com os tipos que existem (instalar, retirar...). */
  function montarGrupos() {
    const mapa = new Map();
    M.SERVICOS.forEach((s) => {
      const k = `${s.departamento}|${s.codigo}`;
      if (!mapa.has(k)) {
        mapa.set(k, {
          chave: k, codigo: s.codigo, descricao: s.descricao, departamento: s.departamento,
          busca: normalizar(`${s.codigo} ${s.descricao} ${sigla(s.departamento)} ${sigla(s.departamento).replace("&", "")}`), opcoes: [],
        });
      }
      mapa.get(k).opcoes.push(s);
    });
    mapa.forEach((g) => g.opcoes.sort((a, b) => M.OPERACOES.indexOf(a.operacao) - M.OPERACOES.indexOf(b.operacao)));
    const ordem = (d) => M.DEPARTAMENTOS.indexOf(d);
    return [...mapa.values()].sort((a, b) => ordem(a.departamento) - ordem(b.departamento));
  }
  const cacheGrupos = new Map(); // limpo quando o catálogo é baixado de novo
  const grupos = () => {
    if (!cacheGrupos.has("todos")) cacheGrupos.set("todos", montarGrupos());
    return cacheGrupos.get("todos");
  };

  function resultadosHtml() {
    const termos = normalizar(estado.busca).split(/\s+/).filter(Boolean);
    if (!termos.length) return "";
    const res = grupos().filter((g) => termos.every((t) => g.busca.includes(t))).slice(0, MAX_RESULTADOS);
    if (!res.length) return `<p class="vazio">Nenhum serviço encontrado.</p>`;
    return `<ul class="resultados">${res.map((g) => `<li><button type="button" data-acao="escolher" data-chave="${esc(g.chave)}"><b>${esc(g.codigo)}</b><span>${esc(g.descricao)}</span><i class="sigla sigla-${esc(sigla(g.departamento).replace("&", "").toLowerCase())}">${esc(sigla(g.departamento))}</i></button></li>`).join("")}</ul>`;
  }

  function campoQtd(valor, attrs, grande = false) {
    return `<div class="setas${grande ? " setas-grande" : ""}">
      <input inputmode="decimal" value="${esc(valor)}" placeholder="0" ${attrs}>
      <div><button type="button" aria-label="Aumentar" data-passo="1">▲</button><button type="button" aria-label="Diminuir" data-passo="-1">▼</button></div>
    </div>`;
  }

  // lista pré-definida para o supervisor só tocar (nome curto só na tela; a medição sai com a descrição do catálogo)
  const RAPIDOS = [
    ["Poste e base", [["61600", "CAVA PERFURATRIZ"], ["62261", "CAVA LAVANCA"], ["62177", "CALÇADA"], ["62045", "DEFENSA"], ["62297", "POSTE"]]],
    ["Estruturas MT", [["62184", "CE1"], ["62186", "CE2"], ["62190", "CE3"], ["62195", "CE4"], ["62007", "LOSANGULAR"],
      ["60007", "B1/N1"], ["60067", "B2/N2"], ["60080", "B3/N3"], ["60096", "B4/N4"]]],
    ["Cruzetas", [["64197", "1N"], ["64201", "2N"]]],
    ["Estruturas BT", [["60072", "SI1"], ["62205", "SI3"], ["62211", "SI4"], ["62192", "RA2"], ["64073", "RABICHO"], ["64223", "V1"]]],
    ["Transformador", [["62193", "<=40KVA"], ["62183", ">40<=112,5KVA"], ["68125", ">112,5KVA"], ["68000", "COMPONENTE"]]],
    ["Chaves e para-raios", [["62069", "FACA"], ["60139", "FUSIVEL"], ["62033", "CARTUCHO"], ["60129", "PRBT"], ["62272", "PRMT"]]],
    ["Emendas e telecom", [["62124", "EMENDA BT"], ["62125", "EMENDA MT"], ["62080", "INTERNET"]]],
    ["Isoladores", [["62091", "PILAR"], ["62093", "POLIMERICO"], ["60038", "BASTÃO"]]],
    ["Conectores", [["64097", "AMPACTINHO"], ["62152", "CUNHA"], ["60044", "COMPRESSÃO"], ["60054", "PERFURANTE"], ["60040", "ESTRIBO"], ["64079", "GLV"]]],
    ["Aterramento", [["60006", "ATERR POSTE"], ["60005", "ATERR CPREDE"]]],
    ["Iluminação pública", [["60108", "IP<1,5"], ["60111", "IP>1,5"], ["60113", "RELÉ IP"]]],
    ["Ramal", [["60085", "R CONCÊNTRICO"], ["60087", "R MULTIPLEX"], ["60153", "R SUBTERRÂNEO"], ["64135", "CP REDE"]]],
    ["Poda", [["60131", "PODA P"], ["60133", "PODA M"]]],
  ];
  const DEP_RAPIDOS = "C&M (LM)";
  const NOME_CURTO = new Map(RAPIDOS.flatMap(([, itens]) => itens.map(([cod, rot]) => [`${DEP_RAPIDOS}|${cod}`, rot])));
  const nomeNaTela = (i) => NOME_CURTO.get(`${i.departamento}|${i.codigo}`) || i.descricao;

  function rapidosHtml(p) {
    return RAPIDOS.map(([grupo, itens]) => `<div class="rapidos-grupo">
      <small class="cat">${esc(grupo)}</small>
      <div class="rapidos">${itens.map(([cod, rot]) => {
        const lancados = p.itens.filter((i) => i.codigo === cod && i.departamento === DEP_RAPIDOS);
        const qtd = lancados.reduce((t, i) => t + M.numero(i.quantidade), 0);
        return `<button type="button" class="rapido${lancados.length ? " rapido-usado" : ""}" data-acao="rapido" data-chave="${esc(`${DEP_RAPIDOS}|${cod}`)}" data-rotulo="${esc(rot)}">
          ${esc(rot)}${lancados.length ? `<b class="rapido-qtd">${M.fmtQtd(qtd)}</b>` : ""}</button>`;
      }).join("")}</div>
    </div>`).join("");
  }

  function telaPonto() {
    const o = estado.obra;
    const p = ponto();
    if (!p) return telaObra();
    const tp = M.totaisPonto(p);
    const secoes = M.OPERACOES.map((op) => {
      const itens = p.itens.filter((i) => i.operacao === op);
      if (!itens.length) return "";
      return `<section class="bloco">
        <h2 class="secao secao-${op.toLowerCase()}"><span>${SECAO[op]} · ${itens.length}</span><span>${M.fmtMoeda(M.soma(itens, M.valorItem))}</span></h2>
        ${itens.map((i) => `<div class="cartao item">
          <div class="item-topo"><div class="item-texto"><b>${esc(nomeNaTela(i))}</b> <small class="dep">${esc(i.codigo)}</small></div>
            <button type="button" class="remover" data-acao="remover-item" data-sid="${i.sid}" aria-label="Remover">×</button></div>
          <div class="item-base">${campoQtd(i.quantidade, `data-qtd-item="${i.sid}" aria-label="Quantidade"`)}
            <b class="item-valor" id="valor-${i.sid}">${M.fmtMoeda(M.valorItem(i))}</b></div>
        </div>`).join("")}
      </section>`;
    }).join("");

    const fotos = p.fotos.map((id, k) => {
      const url = estado.miniaturas.get(id);
      return `<button type="button" class="miniatura" data-acao="ver-foto" data-id="${id}">${url ? `<img src="${url}" alt="Foto ${k + 1}">` : "…"}</button>`;
    }).join("");

    const outros = o.pontos.length > 1;
    const idx = o.pontos.indexOf(p);
    const u = p.gps ? M.utm(p.gps.lat, p.gps.lng) : null;

    return `<div class="pagina pagina-form">
      ${topo(p.nome, "obra", `<span class="topo-equipe">Obra ${esc(o.numero)}</span>`)}
      ${outros ? `<div class="navega">
        <button type="button" class="link" data-acao="ponto-ant" ${idx === 0 ? "disabled" : ""}>‹ ${idx > 0 ? esc(o.pontos[idx - 1].nome) : ""}</button>
        <small>${idx + 1} de ${o.pontos.length}</small>
        <button type="button" class="link" data-acao="ponto-prox" ${idx === o.pontos.length - 1 ? "disabled" : ""}>${idx < o.pontos.length - 1 ? esc(o.pontos[idx + 1].nome) : ""} ›</button>
      </div>` : ""}
      <fieldset class="conjunto" ${soLeitura(o) ? "disabled" : ""}>
      <section class="cartao dados">
        <label class="campo">Ponto
          <input id="p-nome" value="${esc(p.nome)}" placeholder="P1" autocapitalize="characters">
        </label>
        <label class="campo"><span>Observação <small>(se tiver)</small></span>
          <textarea id="p-obs" rows="2" placeholder="Ex.: poste novo 11/300, troca de cruzeta">${esc(p.obs)}</textarea>
        </label>
        <div class="gps">
          ${u ? `<span class="utm"><small>UTM ${esc(u.zona)}</small> <b>X</b> ${u.x.toLocaleString("pt-BR")} <b>Y</b> ${u.y.toLocaleString("pt-BR")} <small>±${Math.round(p.gps.prec || 0)} m</small></span>` : `<span class="sub">Sem coordenada</span>`}
          <button type="button" class="link" data-acao="gps">${p.gps ? "Atualizar" : "📍 Marcar coordenada"}</button>
        </div>
      </section>
      </fieldset>

      <section class="cartao adicionar" ${soLeitura(o) ? "hidden" : ""}>
        <b>Serviços</b>
        ${rapidosHtml(p)}
        <button type="button" class="link link-busca" data-acao="abrir-busca">${estado.buscaAberta ? "Fechar busca" : "🔎 Outro serviço (buscar no catálogo)"}</button>
        ${estado.buscaAberta ? `<label class="campo">
          <input id="p-busca" type="search" value="${esc(estado.busca)}" placeholder="Código ou nome do serviço" autocomplete="off">
        </label>
        <div id="resultados">${resultadosHtml()}</div>` : ""}
      </section>

      <fieldset class="conjunto" ${soLeitura(o) ? "disabled" : ""}>
      ${secoes || `<p class="vazio">Nenhum serviço lançado neste ponto.</p>`}
      </fieldset>

      <section class="cartao dados">
        <div class="linha-topo"><b>Fotos do ponto</b><small class="sub">${plural(p.fotos.length, "foto", "fotos")}</small></div>
        ${fotos ? `<div class="fotos">${fotos}</div>` : ""}
        <div class="dupla" ${soLeitura(o) ? "hidden" : ""}>
          <label class="botao">📷 Tirar foto<input type="file" accept="image/*" capture="environment" data-acao="foto" hidden></label>
          <label class="botao botao-claro">🖼 Galeria<input type="file" accept="image/*" multiple data-acao="foto" hidden></label>
        </div>
      </section>

      ${soLeitura(o) ? "" : `<button type="button" class="botao botao-perigo botao-pequeno" data-acao="excluir-ponto">Excluir ponto ${esc(p.nome)}</button>`}

      <div class="rodape">
        <div class="rodape-total"><span>Total do ponto</span><b id="total-ponto">${M.fmtMoeda(tp.valor)}</b></div>
        <div class="dupla" ${soLeitura(o) ? "hidden" : ""}>
          <button type="button" class="botao botao-claro" data-acao="obra">Concluir ponto</button>
          <button type="button" class="botao" data-acao="novo-ponto">Próximo ponto ›</button>
        </div>
      </div>
      ${folhaHtml()}
      ${fotoHtml()}
    </div>`;
  }

  function folhaHtml() {
    const g = estado.escolhido;
    if (!g) return "";
    const p = ponto();
    const qtdOk = M.numero(estado.qtd) > 0;
    const ano = Number((p.dia || hoje()).slice(0, 4));
    return `<div class="fundo" data-acao="fechar-folha">
      <div class="folha" data-parar>
        <div class="folha-topo"><b>${esc(g.rotulo || g.codigo)}</b><button type="button" class="remover" data-acao="fechar-folha" aria-label="Fechar">×</button></div>
        <p>${g.rotulo ? `<small class="sub">Código ${esc(g.codigo)}</small>` : `${esc(g.descricao)} <i class="sigla sigla-${esc(sigla(g.departamento).replace("&", "").toLowerCase())}">${esc(sigla(g.departamento))}</i>`}</p>
        <div class="campo">Quantidade ${campoQtd(estado.qtd, `id="qtd-folha" aria-label="Quantidade"`, true)}</div>
        <div class="opcoes">
          ${g.opcoes.map((s) => {
            const ja = p.itens.some((i) => i.sid === s.id);
            const valor = M.valorItem({ quantidade: estado.qtd, us: s.us, valor_us: M.valorUS(s.departamento, ano) });
            return `<button type="button" class="opcao opcao-${(s.operacao || "").toLowerCase()}" data-acao="adicionar" data-sid="${s.id}" ${ja || !qtdOk ? "disabled" : ""}>
              ${ja ? "✓ " : ""}${esc(ROTULO[s.operacao] ?? s.operacao)}<small data-valor-op="${s.id}">${qtdOk ? M.fmtMoeda(valor) : ""}</small></button>`;
          }).join("")}
        </div>
        ${!qtdOk ? `<small class="folha-dica">Digite a quantidade e escolha o tipo.</small>` : ""}
      </div>
    </div>`;
  }

  function fotoHtml() {
    const f = estado.foto;
    if (!f) return "";
    const url = estado.miniaturas.get(f.id);
    return `<div class="visor">
      <img src="${url || ""}" alt="Foto do ponto">
      <div class="visor-acoes">
        ${soLeitura(estado.obra) ? "<span></span>" : `<button type="button" class="botao botao-perigo" data-acao="excluir-foto">Excluir foto</button>`}
        <button type="button" class="botao botao-claro" data-acao="fechar-foto">Fechar</button>
      </div>
    </div>`;
  }

  // ---------- medição
  function telaMedicao() {
    const o = estado.obra;
    const t = M.totaisObra(o);
    const secoes = M.estrutura(o.pontos);
    const semServico = o.pontos.filter((p) => !p.itens.length);
    const semFoto = o.pontos.filter((p) => !p.fotos.length);
    const resumo = secoes.map((s) => `<section class="bloco">
      <h2 class="secao secao-${s.op.toLowerCase()}"><span>${esc(s.titulo)}</span><span>${M.fmtMoeda(s.subtotal)}</span></h2>
      ${s.cats.map(([cat, itens]) => `<div class="cartao resumo-cat">
        <small class="cat">${esc(cat)}</small>
        ${itens.map((i) => `<div class="resumo-linha"><b>${esc(i.cod)}</b><span>${esc(i.desc)}</span><span class="q">${M.fmtQtd(i.qtd)}</span><span class="v">${M.fmtMoeda(i.valor)}</span></div>`).join("")}
      </div>`).join("")}
    </section>`).join("");
    const arq = estado.arquivo;
    return `<div class="pagina pagina-form">
      ${topo("Medição", "obra")}
      <div class="chips">
        <span class="chip-obra"><small>OBRA</small><b>${esc(o.numero)}</b></span>
        <span class="chip chip-total">Total <b>${M.fmtMoeda(t.valor)}</b></span>
        <span class="chip chip-us"><b>${M.fmtNum(t.us)}</b> US</span>
        <span class="chip">Execução <b>${esc(dataExec(o))}</b></span>
      </div>
      ${semServico.length ? `<div class="faixa faixa-guardado">Sem serviço: ${esc(semServico.map((p) => p.nome).join(", "))}. Eles saem só no PDF, com as fotos.</div>` : ""}
      ${semFoto.length ? `<div class="faixa faixa-guardado">Sem foto: ${esc(semFoto.map((p) => p.nome).join(", "))}.</div>` : ""}
      <section class="cartao dados">
        <b>Gerar arquivo</b>
        <p class="sub">Mesma estrutura do fechamento simplificado do Termômetro. A planilha traz também uma aba com a medição de cada ponto; o PDF traz cada ponto com as fotos.</p>
        <div class="gerar">
          <button type="button" class="botao" data-acao="gerar-pdf" ${estado.gerando ? "disabled" : ""}>📄 PDF com fotos</button>
          <button type="button" class="botao botao-claro" data-acao="gerar-xlsx" ${estado.gerando ? "disabled" : ""}>📊 Planilha Excel</button>
          <button type="button" class="botao botao-claro" data-acao="gerar-pdf-sem" ${estado.gerando ? "disabled" : ""}>📄 PDF sem fotos</button>
        </div>
        ${estado.gerando ? `<p class="sub">Gerando… com muitas fotos pode levar alguns segundos.</p>` : ""}
        ${arq ? `<div class="pronto">
          <small>Pronto:</small><b>${esc(arq.nome)}</b><small>${(arq.blob.size / 1024 / 1024).toFixed(2)} MB</small>
          <div class="dupla">
            ${podeCompartilhar(arq) ? `<button type="button" class="botao" data-acao="compartilhar">Compartilhar</button>` : ""}
            <button type="button" class="botao botao-claro" data-acao="baixar">Baixar</button>
          </div>
        </div>` : ""}
      </section>
      <h2 class="titulo-resumo">Conferência</h2>
      ${resumo}
    </div>`;
  }
  const dataExec = (o) => {
    const dias = o.pontos.filter((p) => p.itens.length && p.dia).map((p) => p.dia).sort();
    return dias.length ? M.fmtDia(dias[dias.length - 1]) : "—";
  };
  const arquivoDe = (a) => new File([a.blob], a.nome, { type: a.blob.type });
  const podeCompartilhar = (a) => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [arquivoDe(a)] })); } catch (e) { return false; }
  };

  // ------------------------------------------------------------------ fotos
  async function abrirImagem(arquivo) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(arquivo, { imageOrientation: "from-image" }); } catch (e) { /* tenta pelo <img> */ }
    }
    return new Promise((ok, falha) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => falha(new Error("Imagem inválida"));
      img.src = URL.createObjectURL(arquivo);
    });
  }

  /** Reduz a foto e grava na parte de baixo a obra, o ponto, a data/hora e o GPS. */
  async function prepararFoto(arquivo, o, p) {
    const img = await abrirImagem(arquivo);
    const w0 = img.width, h0 = img.height;
    const esc1 = Math.min(1, FOTO_MAX / Math.max(w0, h0));
    const w = Math.round(w0 * esc1), h = Math.round(h0 * esc1);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    if (img.close) img.close();
    const agora = new Date();
    const linhas = [
      `OBRA ${o.numero} · ${p.nome}`,
      `${agora.toLocaleDateString("pt-BR")} ${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}${p.gps ? ` · ${M.fmtUtm(p.gps)}` : ""}`,
    ];
    const fs = Math.max(14, Math.round(Math.min(w, h) * 0.032));
    const alt = fs * 1.35 * linhas.length + fs * 0.6;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, h - alt, w, alt);
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textBaseline = "top";
    linhas.forEach((t, k) => ctx.fillText(t, fs * 0.6, h - alt + fs * 0.3 + k * fs * 1.35));
    const blob = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.78));
    return { blob, largura: w, altura: h, criada_em: agora.toISOString() };
  }

  async function receberFotos(arquivos) {
    const o = estado.obra, p = ponto();
    if (!arquivos.length || !p) return;
    avisar(arquivos.length > 1 ? `Guardando ${arquivos.length} fotos…` : "Guardando foto…", "guardado");
    let ok = 0;
    for (const a of arquivos) {
      try {
        const pronta = await prepararFoto(a, o, p);
        const foto = { id: novoId(), obraId: o.id, pontoId: p.id, gps: p.gps || null, ...pronta };
        await Banco.salvarFoto(foto);
        p.fotos.push(foto.id);
        estado.miniaturas.set(foto.id, URL.createObjectURL(foto.blob));
        ok++;
      } catch (e) {
        console.error(e);
      }
    }
    await salvarAgora();
    render();
    avisar(ok === arquivos.length ? (ok > 1 ? `${ok} fotos guardadas.` : "Foto guardada.") : `Guardadas ${ok} de ${arquivos.length} fotos.`, ok ? "ok" : "erro");
  }

  function marcarGps() {
    const p = ponto();
    if (!navigator.geolocation) return avisar("Este aparelho não informa a localização.", "erro");
    avisar("Buscando a localização…", "guardado");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        p.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, prec: pos.coords.accuracy, em: new Date().toISOString() };
        salvarAgora();
        render();
        avisar("Localização marcada.");
      },
      () => avisar("Não foi possível pegar a localização. Confira se o GPS está ligado e permitido.", "erro"),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 },
    );
  }

  // ------------------------------------------------------------------ ações
  function novaObra() {
    estado.obra = {
      id: novoId(), numero: "", local: "", municipio: "", equipe: "", obs: "",
      departamento: null,
      pontos: [], criada_em: null,
    };
    irPara("obra-form");
  }

  async function salvarObraForm() {
    const o = estado.obra;
    const v = (id) => document.getElementById(id).value.trim();
    const numero = v("f-numero").replace(/\D/g, "");
    const erro = document.getElementById("erro-form");
    if (!obraValida(numero)) {
      erro.textContent = "O número da obra deve ter 8 ou 10 dígitos.";
      erro.hidden = false;
      return;
    }
    const repetida = (await Banco.listarObras()).find((x) => x.numero === numero && x.id !== o.id);
    if (repetida && !confirm(`Já existe a obra ${numero} neste celular. Criar outra com o mesmo número?`)) return;
    const nova = !o.criada_em;
    Object.assign(o, { numero, municipio: v("f-municipio"), obs: v("f-obs") });
    if (nova) o.criada_em = new Date().toISOString();
    await salvarAgora();
    Banco.pedirPersistencia();
    irPara("obra");
  }

  function novoPonto() {
    const o = estado.obra;
    const anterior = ponto();
    const p = { id: novoId(), nome: proximoNome(o), dia: hoje(), obs: "", gps: null, itens: [], fotos: [] };
    o.pontos.push(p);
    salvarAgora();
    irPara("ponto", { pontoId: p.id });
    marcarGpsSilencioso(p);
  }

  function marcarGpsSilencioso(p) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (p.gps) return;
        p.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, prec: pos.coords.accuracy, em: new Date().toISOString() };
        salvarAgora();
        if (estado.tela === "ponto" && estado.pontoId === p.id) render();
      },
      () => {},
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    );
  }

  function adicionarItem(sid) {
    const p = ponto();
    const s = M.POR_ID.get(sid);
    if (!s || p.itens.some((i) => i.sid === sid) || M.numero(estado.qtd) <= 0) return;
    const ano = Number((p.dia || hoje()).slice(0, 4));
    p.itens.push({
      sid: s.id, codigo: s.codigo, descricao: s.descricao, operacao: s.operacao, departamento: s.departamento,
      us: s.us, valor_us: M.valorUS(s.departamento, ano), quantidade: estado.qtd,
    });
    salvarAgora();
    estado.qtd = "";
    // código com instalar e retirar continua aberto para lançar o outro tipo
    const faltam = estado.escolhido.opcoes.filter((o) => !p.itens.some((i) => i.sid === o.id));
    if (!faltam.length) estado.escolhido = null;
    render();
  }

  async function gerar(tipo) {
    estado.gerando = true;
    estado.arquivo = null;
    render();
    try {
      const o = estado.obra;
      if (tipo === "pdf") {
        // fotos que estão só no banco: baixa antes de montar o PDF
        let faltando = 0;
        for (const id of o.pontos.flatMap((p) => p.fotos)) if (!(await fotoLocal(o, id))) faltando++;
        if (faltando) avisar(`${plural(faltando, "foto não pôde ser baixada", "fotos não puderam ser baixadas")}: o PDF sai sem elas.`, "erro");
      }
      const supervisor = soLeitura(o) ? o.supervisor_nome || "" : estado.perfil?.nome || "";
      estado.arquivo = tipo === "xlsx"
        ? await M.gerarExcel(o)
        : await M.gerarPdf(o, { comFotos: tipo === "pdf", supervisor });
    } catch (e) {
      console.error(e);
      avisar(e.message || "Não foi possível gerar o arquivo.", "erro");
    }
    estado.gerando = false;
    render();
  }

  function baixar(blob, nome) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function compartilhar() {
    const a = estado.arquivo;
    try {
      await navigator.share({ files: [arquivoDe(a)], title: a.nome });
    } catch (e) {
      if (e.name !== "AbortError") baixar(a.blob, a.nome);
    }
  }

  async function backupObra() {
    const o = estado.obra;
    await salvarAgora();
    avisar("Montando o backup…", "guardado");
    const fotos = await Banco.fotosDaObra(o.id);
    const dados = {
      app: "medicao-campo", versao: 1, exportado_em: new Date().toISOString(), obra: o,
      fotos: await Promise.all(fotos.map(async (f) => ({
        id: f.id, pontoId: f.pontoId, criada_em: f.criada_em, gps: f.gps, largura: f.largura, altura: f.altura,
        dataUrl: await M.blobParaDataUrl(f.blob),
      }))),
    };
    const blob = new Blob([JSON.stringify(dados)], { type: "application/json" });
    const nome = `obra-${o.numero}-medicao.json`;
    const arq = { blob, nome };
    if (podeCompartilhar(arq)) {
      try { await navigator.share({ files: [arquivoDe(arq)], title: nome }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    baixar(blob, nome);
  }

  async function importarBackup(arquivo) {
    try {
      const dados = JSON.parse(await arquivo.text());
      if (dados.app !== "medicao-campo" || !dados.obra?.id) throw new Error("Arquivo não é um backup da Medição de Campo.");
      const existe = await Banco.obterObra(dados.obra.id);
      if (existe && !confirm(`A obra ${dados.obra.numero} já está neste celular. Substituir pela do backup?`)) return;
      if (existe) await Banco.excluirObra(existe.id);
      for (const f of dados.fotos || []) {
        const blob = await (await fetch(f.dataUrl)).blob();
        await Banco.salvarFoto({ id: f.id, obraId: dados.obra.id, pontoId: f.pontoId, criada_em: f.criada_em, gps: f.gps, largura: f.largura, altura: f.altura, blob });
      }
      await Banco.salvarObra(dados.obra);
      avisar(`Obra ${dados.obra.numero} importada.`);
      irPara("inicio");
    } catch (e) {
      avisar(e.message || "Não foi possível ler o backup.", "erro");
    }
  }

  function atualizarValoresPonto() {
    const p = ponto();
    p.itens.forEach((i) => {
      const el = document.getElementById(`valor-${i.sid}`);
      if (el) el.textContent = M.fmtMoeda(M.valorItem(i));
    });
    document.getElementById("total-ponto").textContent = M.fmtMoeda(M.totaisPonto(p).valor);
    // subtotais das seções
    document.querySelectorAll(".secao").forEach((h, k) => {
      const ops = M.OPERACOES.filter((op) => p.itens.some((i) => i.operacao === op));
      const itens = p.itens.filter((i) => i.operacao === ops[k]);
      h.lastElementChild.textContent = M.fmtMoeda(M.soma(itens, M.valorItem));
    });
  }

  function atualizarFolha() {
    const qtdOk = M.numero(estado.qtd) > 0;
    const p = ponto();
    const ano = Number((p.dia || hoje()).slice(0, 4));
    document.querySelectorAll("[data-valor-op]").forEach((el) => {
      const s = M.POR_ID.get(Number(el.dataset.valorOp));
      el.textContent = qtdOk ? M.fmtMoeda(M.valorItem({ quantidade: estado.qtd, us: s.us, valor_us: M.valorUS(s.departamento, ano) })) : "";
      const ja = p.itens.some((i) => i.sid === s.id);
      el.parentElement.disabled = ja || !qtdOk;
    });
    const dica = document.querySelector(".folha-dica");
    if (dica) dica.hidden = qtdOk;
  }

  // cliques
  $app.addEventListener("click", async (e) => {
    const passo = e.target.closest("[data-passo]");
    if (passo) {
      const input = passo.closest(".setas").querySelector("input");
      const novo = Math.round((M.numero(input.value || 0) + Number(passo.dataset.passo)) * 10000) / 10000;
      if (novo > 0) {
        input.value = String(novo).replace(".", ",");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    const alvo = e.target.closest("[data-acao]");
    if (!alvo) return;
    if (alvo.tagName === "INPUT") return; // inputs de arquivo usam o change
    if (alvo.dataset.acao === "fechar-folha" && e.target.closest("[data-parar]") && !e.target.closest("button")) return;
    const o = estado.obra;
    switch (alvo.dataset.acao) {
      case "inicio": return irPara("inicio");
      case "config": {
        estado.supervisores = estado.perfil?.admin ? null : [];
        await irPara("config");
        carregarAjustes();
        const esp = await Banco.espaco();
        if (esp && document.getElementById("espaco")) {
          document.getElementById("espaco").textContent = `Espaço usado no celular: ${(esp.usage / 1024 / 1024).toFixed(1)} MB.`;
        }
        return;
      }
      case "sair": return sairDaConta();
      case "filtro":
        estado.filtro = alvo.dataset.f;
        return render();
      case "atualizar-lista":
        avisar("Atualizando…", "guardado");
        await enviarPendentes();
        return buscarRemotas(true);
      case "trazer-obra": {
        try {
          avisar("Baixando a obra…", "guardado");
          const obra = await trazerObra(alvo.dataset.id);
          estado.obra = obra;
          $aviso.hidden = true;
          return irPara("obra");
        } catch (err) {
          return avisar(err.message, "erro");
        }
      }
      case "atualizar-catalogo":
        try {
          await baixarCatalogo();
          avisar("Catálogo atualizado.");
          return render();
        } catch (err) {
          return avisar(err.message, "erro");
        }
      case "instalar": {
        if (window.pedidoInstalar) {
          window.pedidoInstalar.prompt();
          window.pedidoInstalar = null;
        } else {
          const aj = document.getElementById("ajuda-instalar");
          if (aj) aj.hidden = !aj.hidden;
        }
        return;
      }
      case "nova-obra": return novaObra();
      case "abrir-obra": {
        estado.obra = await Banco.obterObra(alvo.dataset.id);
        return irPara("obra");
      }
      case "editar-obra": return irPara("obra-form");
      case "salvar-obra": return salvarObraForm();
      case "obra": return irPara("obra");
      case "novo-ponto": return novoPonto();
      case "abrir-ponto": return irPara("ponto", { pontoId: alvo.dataset.id });
      case "ponto-ant":
      case "ponto-prox": {
        const idx = o.pontos.findIndex((p) => p.id === estado.pontoId) + (alvo.dataset.acao === "ponto-ant" ? -1 : 1);
        if (o.pontos[idx]) return irPara("ponto", { pontoId: o.pontos[idx].id });
        return;
      }
      case "excluir-ponto": {
        const p = ponto();
        if (!confirm(`Excluir o ponto ${p.nome}? Os serviços e as ${p.fotos.length} fotos dele serão apagados.`)) return;
        for (const id of p.fotos) await Banco.excluirFoto(id);
        o.pontos = o.pontos.filter((x) => x.id !== p.id);
        return irPara("obra");
      }
      case "excluir-obra": {
        if (soLeitura(o)) {
          // consulta: tira só deste aparelho, a obra continua no banco
          await Banco.excluirObra(o.id);
          estado.obra = null;
          return irPara("inicio");
        }
        if (!confirm(`Excluir a obra ${o.numero}? Pontos, serviços e fotos serão apagados deste celular E DO BANCO, e não dá para desfazer.`)) return;
        if (o.pontos.length && !confirm("Tem certeza? Se ainda não gerou a medição, tudo será perdido.")) return;
        await Banco.excluirObra(o.id);
        if (o.enviada_em || !o.pendente) {
          const exclusoes = await Banco.ler("exclusoes", []);
          if (!exclusoes.includes(o.id)) exclusoes.push(o.id);
          await Banco.gravar("exclusoes", exclusoes);
        }
        estado.obra = null;
        avisar("Obra excluída.");
        enviarDepois(500);
        return irPara("inicio");
      }
      case "gps": return marcarGps();
      case "escolher": {
        const g = grupos().find((x) => x.chave === alvo.dataset.chave);
        estado.escolhido = g;
        estado.qtd = "";
        estado.busca = "";
        return render();
      }
      case "rapido": {
        const g = grupos().find((x) => x.chave === alvo.dataset.chave);
        if (!g) return avisar("Esse código não está no catálogo baixado.", "erro");
        estado.escolhido = { ...g, rotulo: alvo.dataset.rotulo };
        estado.qtd = "";
        return render();
      }
      case "abrir-busca":
        estado.buscaAberta = !estado.buscaAberta;
        estado.busca = "";
        render();
        if (estado.buscaAberta) document.getElementById("p-busca")?.focus();
        return;
      case "mostrar-banco":
        estado.bancoAberto = !estado.bancoAberto;
        if (estado.bancoAberto && estado.remotas === null) buscarRemotas();
        return render();
      case "fechar-folha":
        estado.escolhido = null;
        return render();
      case "adicionar": return adicionarItem(Number(alvo.dataset.sid));
      case "remover-item": {
        const p = ponto();
        p.itens = p.itens.filter((i) => i.sid !== Number(alvo.dataset.sid));
        salvarAgora();
        return render();
      }
      case "ver-foto":
        estado.foto = { id: alvo.dataset.id };
        return render();
      case "fechar-foto":
        estado.foto = null;
        return render();
      case "excluir-foto": {
        if (soLeitura(o) || !confirm("Excluir esta foto?")) return;
        const p = ponto();
        await Banco.excluirFoto(estado.foto.id);
        p.fotos = p.fotos.filter((id) => id !== estado.foto.id);
        estado.foto = null;
        await salvarAgora();
        return render();
      }
      case "medicao": return irPara("medicao");
      case "gerar-pdf": return gerar("pdf");
      case "gerar-pdf-sem": return gerar("pdf-sem");
      case "gerar-xlsx": return gerar("xlsx");
      case "compartilhar": return compartilhar();
      case "baixar": return baixar(estado.arquivo.blob, estado.arquivo.nome);
      case "backup": return backupObra();
      default:
    }
  });

  // digitação
  $app.addEventListener("input", (e) => {
    const t = e.target;
    const p = ponto();
    if (t.id === "f-numero") {
      t.value = t.value.replace(/\D/g, "").slice(0, 10);
      t.className = !t.value ? "" : obraValida(t.value) ? "valido" : "invalido";
      document.getElementById("dica-numero").textContent =
        t.value && !obraValida(t.value) ? `Tem ${t.value.length} dígitos. Precisa de 8 ou 10.` : "";
      return;
    }
    if (t.id === "p-busca") {
      estado.busca = t.value;
      document.getElementById("resultados").innerHTML = resultadosHtml();
      return;
    }
    if (t.id === "qtd-folha") {
      t.value = t.value.replace(/[^\d.,]/g, "");
      estado.qtd = t.value;
      return atualizarFolha();
    }
    if (t.dataset.qtdItem && p) {
      t.value = t.value.replace(/[^\d.,]/g, "");
      const item = p.itens.find((i) => i.sid === Number(t.dataset.qtdItem));
      item.quantidade = t.value;
      salvarDepois();
      return atualizarValoresPonto();
    }
    if (p && t.id === "p-nome") { p.nome = t.value.toUpperCase().slice(0, 30); salvarDepois(); return; }
    if (p && t.id === "p-obs") { p.obs = t.value; salvarDepois(); return; }
  });

  $app.addEventListener("change", (e) => {
    const t = e.target;
    const p = ponto();
    if (t.dataset.acao === "foto") {
      const arquivos = [...t.files];
      t.value = "";
      return receberFotos(arquivos);
    }
    if (t.dataset.acao === "importar") {
      const a = t.files[0];
      t.value = "";
      if (a) importarBackup(a);
      return;
    }
    if (p && t.id === "p-dia") {
      if (!t.value || t.value > hoje()) { t.value = p.dia; return avisar("A data não pode ser futura.", "erro"); }
      p.dia = t.value;
      salvarAgora();
      return;
    }
    if (p && t.id === "p-nome") {
      if (!p.nome.trim()) p.nome = proximoNome(estado.obra);
      salvarAgora();
      render();
    }
  });

  $app.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "qtd-folha") {
      e.preventDefault();
      const unico = estado.escolhido?.opcoes.filter((s) => !ponto().itens.some((i) => i.sid === s.id));
      if (unico && unico.length === 1) adicionarItem(unico[0].id);
    }
  });

  // o campo de busca sobe para o topo: abaixo dele o teclado cobriria a lista
  $app.addEventListener("focusin", (e) => {
    if (e.target.id === "p-busca") setTimeout(() => e.target.scrollIntoView({ block: "start", behavior: "smooth" }), 300);
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    window.pedidoInstalar = e;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") salvarAgora();
    else enviarDepois(500);
  });
  window.addEventListener("online", () => {
    estado.online = true;
    enviarDepois(500);
    buscarRemotas();
    if (estado.tela === "inicio") render();
  });
  window.addEventListener("offline", () => {
    estado.online = false;
    if (estado.tela === "inicio") render();
  });
  setInterval(() => enviarDepois(0), 60000);

  // ajustes do administrador: nome, ativo e administrador de cada supervisor
  $app.addEventListener("change", async (e) => {
    const t = e.target;
    const id = t.dataset.supNome || t.dataset.supAtivo || t.dataset.supAdmin;
    if (!id) return;
    const campos = t.dataset.supNome ? { nome: t.value.trim().toUpperCase() } : t.dataset.supAtivo ? { ativo: t.checked } : { admin: t.checked };
    if (campos.nome === "") return avisar("O nome não pode ficar vazio.", "erro");
    try {
      await Nuvem.alterarSupervisor(id, campos);
      if (t.dataset.supNome) t.value = campos.nome;
      avisar("Supervisor atualizado.");
    } catch (err) {
      avisar(err.message, "erro");
    }
  });

  // ------------------------------------------------------------------ entrada
  $app.addEventListener("submit", async (e) => {
    if (e.target.id !== "form-entrar") return;
    e.preventDefault();
    const bt = document.getElementById("bt-entrar");
    const erro = document.getElementById("erro-entrar");
    bt.disabled = true;
    bt.textContent = "Entrando…";
    erro.hidden = true;
    try {
      const perfil = await Nuvem.entrar(document.getElementById("e-email").value.trim(), document.getElementById("e-senha").value);
      estado.perfil = perfil;
      await Banco.gravar("perfil", perfil);
      await baixarCatalogo();
      Banco.pedirPersistencia();
      await iniciar();
    } catch (err) {
      erro.textContent = err.status === 0 ? "Sem conexão. Para entrar é preciso de internet." : err.message;
      erro.hidden = false;
      bt.disabled = false;
      bt.textContent = "Entrar";
    }
  });

  async function baixarCatalogo() {
    const cat = await Nuvem.catalogo();
    if (!cat.servicos.length) throw new Error("O catálogo do banco está vazio.");
    await Banco.gravar("catalogo", cat);
    M.usarCatalogo(cat);
    cacheGrupos.clear();
  }

  async function sairDaConta(forcado = false) {
    const pend = (await Banco.listarObras()).filter((o) => o.pendente && !soLeitura(o)).length;
    if (!forcado && pend && !confirm(`${plural(pend, "obra ainda não subiu", "obras ainda não subiram")} para o banco. Elas continuam no celular e sobem quando você entrar de novo. Sair mesmo assim?`)) return;
    Nuvem.sair();
    estado.perfil = null;
    estado.remotas = null;
    estado.obra = null;
    await Banco.gravar("perfil", null);
    estado.tela = "entrar";
    render();
  }

  async function carregarAjustes() {
    if (!estado.perfil?.admin || !navigator.onLine) return;
    try {
      estado.supervisores = await Nuvem.supervisores();
    } catch (e) {
      estado.supervisores = [];
    }
    if (estado.tela === "config") render();
  }

  /** Abre o app: com sessão e catálogo guardados entra direto, mesmo sem sinal. */
  async function iniciar() {
    if (!Nuvem.lerSessao()) {
      estado.tela = "entrar";
      return render();
    }
    estado.perfil = await Banco.ler("perfil");
    const cat = await Banco.ler("catalogo");
    if (cat) M.usarCatalogo(cat);
    if (!cat || !estado.perfil) {
      estado.tela = "carregando";
      estado.carregandoTexto = "Baixando o catálogo de serviços…";
      render();
      try {
        if (!estado.perfil) {
          estado.perfil = await Nuvem.meuPerfil();
          await Banco.gravar("perfil", estado.perfil);
        }
        if (!cat) await baixarCatalogo();
      } catch (e) {
        estado.carregandoTexto = e.status === 0 ? "Sem internet. Na primeira vez é preciso de sinal para baixar o catálogo." : e.message;
        render();
        if (e.status === 401 || e.status === 403) return sairDaConta(true);
        return;
      }
    }
    await irPara("inicio");
    if (navigator.onLine) {
      // confere se o acesso continua ativo e se o nome mudou
      Nuvem.meuPerfil().then(async (p) => {
        if (!p || !p.ativo) { avisar("Seu acesso foi desativado.", "erro"); return sairDaConta(true); }
        estado.perfil = p;
        await Banco.gravar("perfil", p);
        if (estado.tela === "inicio") render();
      }).catch(() => {});
      await enviarPendentes();
      buscarRemotas();
    }
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    // pergunta por versão nova a cada abertura e recarrega uma vez quando ela assume
    let jaRecarregou = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (jaRecarregou) return;
      jaRecarregou = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
  }

  iniciar();
})();

