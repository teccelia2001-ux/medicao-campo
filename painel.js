/* Painel do escritório: todas as obras medidas em campo, com filtros, totais,
   resumo por supervisor e o detalhe de cada obra (pontos, serviços, fotos e a
   medição em Excel/PDF no padrão do Termômetro). Usa o mesmo login do app. */
(function () {
  const M = window.Medicao;
  const $p = document.getElementById("painel");
  const $aviso = document.getElementById("aviso");
  const OPS = ["INSTALAR", "RETIRAR", "EXECUTAR"];

  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const normalizar = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const dia = (iso) => (iso ? iso.slice(0, 10) : "");

  let tempoAviso = null;
  function avisar(texto, tipo = "ok") {
    $aviso.textContent = texto;
    $aviso.className = `aviso aviso-${tipo}`;
    $aviso.hidden = false;
    clearTimeout(tempoAviso);
    tempoAviso = setTimeout(() => ($aviso.hidden = true), 3500);
  }

  const estado = {
    perfil: null,
    obras: null, // linhas de medicao_obras_lista
    filtro: { busca: "", supervisor: "", cidade: "", de: "", ate: "" },
    ordem: { campo: "atualizada_em", desc: true },
    aberta: null, // obra completa aberta na gaveta
    fotos: new Map(), // fotoId -> objectURL
    gerando: false,
  };

  // ------------------------------------------------------------------ dados
  async function carregar(avisando = false) {
    try {
      estado.obras = await Nuvem.listarObras();
      render();
      if (avisando) avisar("Lista atualizada.");
    } catch (e) {
      if (e.status === 401) return sair();
      avisar(e.message, "erro");
    }
  }

  function filtradas() {
    const f = estado.filtro;
    const termos = normalizar(f.busca).split(/\s+/).filter(Boolean);
    const lista = (estado.obras || []).filter((o) => {
      if (f.supervisor && o.supervisor_nome !== f.supervisor) return false;
      if (f.cidade && (o.municipio || "") !== f.cidade) return false;
      const d = dia(o.atualizada_em);
      if (f.de && d < f.de) return false;
      if (f.ate && d > f.ate) return false;
      if (termos.length && !termos.every((t) => normalizar(`${o.numero} ${o.municipio} ${o.supervisor_nome}`).includes(t))) return false;
      return true;
    });
    const { campo, desc } = estado.ordem;
    const valor = (o) => (["total", "total_us", "qtd_pontos"].includes(campo) ? Number(o[campo]) || 0 : String(o[campo] || ""));
    lista.sort((a, b) => {
      const x = valor(a), y = valor(b);
      const r = x < y ? -1 : x > y ? 1 : 0;
      return desc ? -r : r;
    });
    return lista;
  }

  /** linha do banco no formato que o app e a medição usam */
  function obraDaLinha(r, lista) {
    const resumo = lista?.find((x) => x.id === r.id);
    return {
      id: r.id, numero: r.numero, local: r.local || "", municipio: r.municipio || "", equipe: r.equipe || "", obs: r.obs || "",
      pontos: r.pontos || [], fotos_info: r.fotos || {}, criada_em: r.criada_em, atualizada_em: r.atualizada_em,
      supervisor_nome: resumo?.supervisor_nome || "",
    };
  }

  /** Foto: do cache do navegador ou do banco (fica guardada para o PDF). */
  async function foto(obra, id) {
    let f = await Banco.obterFoto(id);
    if (!f) {
      const blob = await Nuvem.baixarFoto(obra.id, id);
      const info = obra.fotos_info?.[id] || {};
      f = { id, obraId: obra.id, pontoId: info.pontoId, blob, enviada: true, criada_em: info.criada_em, gps: info.gps, largura: info.largura, altura: info.altura };
      await Banco.salvarFoto(f);
    }
    return f;
  }

  async function abrir(id) {
    try {
      avisar("Abrindo a obra…", "guardado");
      const r = await Nuvem.baixarObra(id);
      if (!r) return avisar("A obra não está mais no banco.", "erro");
      estado.aberta = obraDaLinha(r, estado.obras);
      $aviso.hidden = true;
      render();
      // miniaturas aos poucos
      for (const p of estado.aberta.pontos) {
        for (const fid of p.fotos) {
          if (estado.fotos.has(fid)) continue;
          try {
            const f = await foto(estado.aberta, fid);
            estado.fotos.set(fid, URL.createObjectURL(f.blob));
            const el = document.querySelector(`[data-foto="${fid}"]`);
            if (el) el.innerHTML = `<img src="${estado.fotos.get(fid)}" alt="Foto ${esc(p.nome)}">`;
          } catch (e) {
            const el = document.querySelector(`[data-foto="${fid}"]`);
            if (el) el.textContent = "sem foto";
          }
        }
      }
    } catch (e) {
      avisar(e.message, "erro");
    }
  }

  async function gerar(tipo, id) {
    if (estado.gerando) return;
    estado.gerando = true;
    avisar("Gerando o arquivo…", "guardado");
    try {
      let obra = estado.aberta?.id === id ? estado.aberta : null;
      if (!obra) obra = obraDaLinha(await Nuvem.baixarObra(id), estado.obras);
      if (tipo === "pdf") {
        let faltando = 0;
        for (const fid of obra.pontos.flatMap((p) => p.fotos)) {
          try { await foto(obra, fid); } catch (e) { faltando++; }
        }
        if (faltando) avisar(`${faltando} foto(s) não puderam ser baixadas: o PDF sai sem elas.`, "erro");
      }
      const arq = tipo === "xlsx"
        ? await M.gerarExcel(obra)
        : await M.gerarPdf(obra, { comFotos: tipo === "pdf", supervisor: obra.supervisor_nome });
      const url = URL.createObjectURL(arq.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = arq.nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      avisar("Arquivo pronto: " + arq.nome);
    } catch (e) {
      console.error(e);
      avisar(e.message || "Não foi possível gerar o arquivo.", "erro");
    }
    estado.gerando = false;
  }

  // ------------------------------------------------------------------ telas
  function telaEntrar() {
    return `<div class="entrar-pagina"><form class="entrar" id="form-entrar">
      <img src="logo-teccel-red.png" alt="Teccel">
      <h1>Painel de medições</h1>
      <p>Entre com o mesmo acesso do app.</p>
      <label>E-mail <input id="e-email" type="email" autocomplete="username" required></label>
      <label>Senha <input id="e-senha" type="password" autocomplete="current-password" required></label>
      <div class="erro" id="erro-entrar" hidden></div>
      <button class="botao" id="bt-entrar">Entrar</button>
    </form></div>`;
  }

  function opcoes(valores, escolhido, rotulo) {
    return `<option value="">${rotulo}</option>` + valores.map((v) => `<option ${v === escolhido ? "selected" : ""}>${esc(v)}</option>`).join("");
  }

  function th(campo, texto, num = false) {
    const o = estado.ordem;
    const seta = o.campo === campo ? `<span class="seta">${o.desc ? " ▼" : " ▲"}</span>` : "";
    return `<th data-ordem="${campo}" class="${num ? "num" : ""}">${texto}${seta}</th>`;
  }

  function telaPainel() {
    const todas = estado.obras || [];
    const lista = filtradas();
    const f = estado.filtro;
    const sups = [...new Set(todas.map((o) => o.supervisor_nome).filter(Boolean))].sort();
    const cidades = [...new Set(todas.map((o) => o.municipio).filter(Boolean))].sort();
    const total = lista.reduce((t, o) => t + Number(o.total || 0), 0);
    const us = lista.reduce((t, o) => t + Number(o.total_us || 0), 0);
    const pontos = lista.reduce((t, o) => t + Number(o.qtd_pontos || 0), 0);

    // resumo por supervisor (no recorte dos filtros)
    const porSup = new Map();
    lista.forEach((o) => {
      const k = o.supervisor_nome || "—";
      const s = porSup.get(k) || { obras: 0, valor: 0, pontos: 0 };
      s.obras++; s.valor += Number(o.total || 0); s.pontos += Number(o.qtd_pontos || 0);
      porSup.set(k, s);
    });
    const maior = Math.max(1, ...[...porSup.values()].map((s) => s.valor));
    const resumoSup = [...porSup.entries()].sort((a, b) => b[1].valor - a[1].valor).map(([nome, s]) => `<div class="sup-linha">
        <b>${esc(nome)}</b><span class="valor">${M.fmtMoeda(s.valor)}</span>
        <small>${s.obras} ${s.obras === 1 ? "obra" : "obras"} · ${s.pontos} pontos</small><span></span>
        <div class="barra-sup"><i style="width:${(s.valor / maior) * 100}%"></i></div>
      </div>`).join("");

    const linhas = lista.map((o) => `<tr data-abrir="${o.id}" class="${estado.aberta?.id === o.id ? "aberta" : ""}">
        <td><span class="chip-obra">${esc(o.numero)}</span></td>
        <td>${esc(o.municipio || "—")}</td>
        <td>${esc(o.supervisor_nome || "—")}</td>
        <td class="num">${o.qtd_pontos}</td>
        <td class="num">${M.fmtNum(Number(o.total_us || 0))}</td>
        <td class="num valor">${M.fmtMoeda(Number(o.total || 0))}</td>
        <td>${M.fmtHora(o.atualizada_em)}</td>
        <td><div class="acoes">
          <button type="button" class="mini" data-gerar="xlsx" data-id="${o.id}" title="Planilha Excel">Excel</button>
          <button type="button" class="mini" data-gerar="pdf" data-id="${o.id}" title="PDF com fotos">PDF</button>
        </div></td>
      </tr>`).join("");

    return `<header class="barra">
        <img src="logo-teccel-red.png" alt="Teccel">
        <h1>Painel de medições de campo</h1>
        <span class="espaco"></span>
        <span class="quem">${esc(estado.perfil?.nome || "")}</span>
        <a class="link" href="./">Abrir o app</a>
        <button type="button" class="link" data-acao="sair">Sair</button>
      </header>
      <main class="conteudo">
        <section class="filtros">
          <label class="busca">Buscar <input id="f-busca" type="search" value="${esc(f.busca)}" placeholder="Número da obra, cidade ou supervisor"></label>
          <label>Supervisor <select id="f-supervisor">${opcoes(sups, f.supervisor, "Todos")}</select></label>
          <label>Cidade <select id="f-cidade">${opcoes(cidades, f.cidade, "Todas")}</select></label>
          <label>Alterada de <input id="f-de" type="date" value="${esc(f.de)}"></label>
          <label>até <input id="f-ate" type="date" value="${esc(f.ate)}"></label>
          <button type="button" class="mini" data-acao="limpar">Limpar filtros</button>
          <button type="button" class="mini" data-acao="atualizar">⟳ Atualizar</button>
        </section>
        <section class="numeros">
          <div class="numero"><small>Obras</small><b>${lista.length}</b></div>
          <div class="numero"><small>Pontos medidos</small><b>${pontos}</b></div>
          <div class="numero"><small>Total de US</small><b>${M.fmtNum(us)}</b></div>
          <div class="numero numero-valor"><small>Valor medido</small><b>${M.fmtMoeda(total)}</b></div>
        </section>
        <div class="colunas">
          <section class="cartao">
            <h2>Obras medidas <small>${lista.length === todas.length ? `${todas.length}` : `${lista.length} de ${todas.length}`}</small></h2>
            <div class="rolagem"><table>
              <thead><tr>${th("numero", "Obra")}${th("municipio", "Cidade")}${th("supervisor_nome", "Supervisor")}${th("qtd_pontos", "Pontos", true)}${th("total_us", "US", true)}${th("total", "Valor", true)}${th("atualizada_em", "Alterada em")}<th>Medição</th></tr></thead>
              <tbody>${linhas}</tbody>
            </table></div>
            ${estado.obras === null ? `<p class="vazio">Carregando…</p>` : !lista.length ? `<p class="vazio">Nenhuma obra ${todas.length ? "com esses filtros" : "medida ainda"}.</p>` : ""}
          </section>
          <section class="cartao sup">
            <h2>Por supervisor</h2>
            ${resumoSup || `<p class="vazio">—</p>`}
          </section>
        </div>
      </main>
      ${gavetaHtml()}`;
  }

  function gavetaHtml() {
    const o = estado.aberta;
    if (!o) return "";
    const t = M.totaisObra(o);
    const secoes = M.estrutura(o.pontos).map((s) => `<div class="secao secao-${s.op.toLowerCase()}"><span>${esc(s.titulo)}</span><span>${M.fmtMoeda(s.subtotal)}</span></div>`).join("");
    const dias = o.pontos.filter((p) => p.itens.length && p.dia).map((p) => p.dia).sort();
    const pontos = o.pontos.map((p) => {
      const tp = M.totaisPonto(p);
      const itens = [...p.itens].sort((a, b) => OPS.indexOf(a.operacao) - OPS.indexOf(b.operacao));
      return `<article class="ponto">
        <div class="ponto-topo"><b>${esc(p.nome)}</b>
          ${p.gps ? `<span>${esc(M.fmtUtm(p.gps))}</span>` : ""}
          <span class="espaco"></span>
          <span>${p.itens.length} ${p.itens.length === 1 ? "serviço" : "serviços"} · ${M.fmtNum(tp.us)} US · <b>${M.fmtMoeda(tp.valor)}</b></span>
        </div>
        ${p.obs ? `<p class="ponto-obs">Obs.: ${esc(p.obs)}</p>` : ""}
        ${itens.length ? `<table><thead><tr><th>Cód.</th><th>Serviço</th><th>Tipo</th><th class="num">Qtd</th><th class="num">US</th><th class="num">Valor</th></tr></thead><tbody>
          ${itens.map((i) => `<tr><td>${esc(i.codigo)}</td><td>${esc(i.descricao)}</td>
            <td><span class="tipo tipo-${(i.operacao || "").toLowerCase()}">${esc((i.operacao || "").slice(0, 3))}</span></td>
            <td class="num">${M.fmtQtd(M.numero(i.quantidade))}</td><td class="num">${M.fmtNum(M.numero(i.quantidade) * i.us)}</td>
            <td class="num valor">${M.fmtMoeda(M.valorItem(i))}</td></tr>`).join("")}
        </tbody></table>` : `<p class="sem">Sem serviços lançados.</p>`}
        ${p.fotos.length ? `<div class="fotos">${p.fotos.map((fid) => `<button type="button" class="foto" data-foto="${fid}" data-ver="${fid}">${estado.fotos.has(fid) ? `<img src="${estado.fotos.get(fid)}" alt="Foto ${esc(p.nome)}">` : "carregando…"}</button>`).join("")}</div>`
          : `<p class="sem">Sem fotos.</p>`}
      </article>`;
    }).join("");
    return `<div class="fundo" data-acao="fechar">
      <aside class="gaveta" data-parar>
        <div class="gaveta-topo"><h2>Obra ${esc(o.numero)}</h2><span class="espaco"></span>
          <span>${M.fmtMoeda(t.valor)} · ${M.fmtNum(t.us)} US</span>
          <button type="button" class="fechar" data-acao="fechar" aria-label="Fechar">×</button></div>
        <div class="gaveta-corpo">
          <div class="info">
            <span>Cidade: <b>${esc(o.municipio || "—")}</b></span>
            <span>Supervisor: <b>${esc(o.supervisor_nome || "—")}</b></span>
            <span>Pontos: <b>${o.pontos.length}</b></span>
            <span>Data de execução: <b>${dias.length ? M.fmtDia(dias[dias.length - 1]) : "—"}</b></span>
            <span>Alterada em: <b>${M.fmtHora(o.atualizada_em)}</b></span>
          </div>
          ${o.obs ? `<p class="info">Obs.: ${esc(o.obs)}</p>` : ""}
          <div class="botoes">
            <button type="button" class="botao" data-gerar="pdf" data-id="${o.id}">📄 PDF com fotos</button>
            <button type="button" class="botao botao-claro" data-gerar="xlsx" data-id="${o.id}">📊 Planilha Excel</button>
            <button type="button" class="botao botao-claro" data-gerar="pdf-sem" data-id="${o.id}">📄 PDF sem fotos</button>
          </div>
          ${secoes ? `<div class="secoes">${secoes}</div>` : ""}
          ${pontos || `<p class="sem">Nenhum ponto.</p>`}
        </div>
      </aside>
    </div>`;
  }

  function render() {
    if (!Nuvem.lerSessao() || !estado.perfil) {
      $p.innerHTML = telaEntrar();
      return;
    }
    const busca = document.activeElement?.id === "f-busca" ? document.activeElement.selectionStart : null;
    const rolagem = document.querySelector(".gaveta")?.scrollTop;
    $p.innerHTML = telaPainel();
    if (busca != null) {
      const el = document.getElementById("f-busca");
      el.focus();
      el.setSelectionRange(busca, busca);
    }
    if (rolagem) document.querySelector(".gaveta").scrollTop = rolagem;
  }

  function sair() {
    Nuvem.sair();
    estado.perfil = null;
    estado.obras = null;
    estado.aberta = null;
    render();
  }

  // ------------------------------------------------------------------ eventos
  $p.addEventListener("click", (e) => {
    const g = e.target.closest("[data-gerar]");
    if (g) {
      e.stopPropagation();
      return gerar(g.dataset.gerar, g.dataset.id);
    }
    const ver = e.target.closest("[data-ver]");
    if (ver && estado.fotos.has(ver.dataset.ver)) {
      const v = document.createElement("div");
      v.className = "visor";
      v.innerHTML = `<img src="${estado.fotos.get(ver.dataset.ver)}" alt="Foto">`;
      v.addEventListener("click", () => v.remove());
      document.body.appendChild(v);
      return;
    }
    const ordem = e.target.closest("[data-ordem]");
    if (ordem) {
      const c = ordem.dataset.ordem;
      estado.ordem = { campo: c, desc: estado.ordem.campo === c ? !estado.ordem.desc : true };
      return render();
    }
    const linha = e.target.closest("[data-abrir]");
    if (linha) return abrir(linha.dataset.abrir);
    const acao = e.target.closest("[data-acao]");
    if (!acao) return;
    if (acao.dataset.acao === "fechar" && e.target.closest("[data-parar]") && !e.target.closest(".fechar")) return;
    switch (acao.dataset.acao) {
      case "fechar":
        estado.aberta = null;
        return render();
      case "sair": return sair();
      case "atualizar": return carregar(true);
      case "limpar":
        estado.filtro = { busca: "", supervisor: "", cidade: "", de: "", ate: "" };
        return render();
      default:
    }
  });

  $p.addEventListener("input", (e) => {
    const mapa = { "f-busca": "busca", "f-supervisor": "supervisor", "f-cidade": "cidade", "f-de": "de", "f-ate": "ate" };
    const campo = mapa[e.target.id];
    if (!campo) return;
    estado.filtro[campo] = e.target.value;
    render();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const v = document.querySelector(".visor");
    if (v) return v.remove();
    if (estado.aberta) { estado.aberta = null; render(); }
  });

  $p.addEventListener("submit", async (e) => {
    if (e.target.id !== "form-entrar") return;
    e.preventDefault();
    const bt = document.getElementById("bt-entrar");
    const erro = document.getElementById("erro-entrar");
    bt.disabled = true;
    bt.textContent = "Entrando…";
    erro.hidden = true;
    try {
      estado.perfil = await Nuvem.entrar(document.getElementById("e-email").value.trim(), document.getElementById("e-senha").value);
      render();
      carregar();
    } catch (err) {
      erro.textContent = err.status === 0 ? "Sem conexão com o banco." : err.message;
      erro.hidden = false;
      bt.disabled = false;
      bt.textContent = "Entrar";
    }
  });

  async function iniciar() {
    if (!Nuvem.lerSessao()) return render();
    try {
      estado.perfil = await Nuvem.meuPerfil();
      if (!estado.perfil || !estado.perfil.ativo) return sair();
    } catch (e) {
      if (e.status === 401) return sair();
      estado.perfil = await Banco.ler("perfil");
      if (!estado.perfil) return sair();
    }
    render();
    carregar();
  }
  iniciar();
})();
