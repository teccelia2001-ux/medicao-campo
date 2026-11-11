/* Contas e arquivos da medição. A estrutura é a do Termômetro
   (backend/app/exportacao_termometro.py: planilha_fechamento, planilha_rateio e
   pdf_fechamento): mesmas seções, categorias, ordem, colunas, cores e fórmulas.
   Aqui cada PONTO da obra faz o papel de um lançamento. */
(function () {
  const EMPRESA = "TECCEL TECNOLOGIA DA CONSTRUÇÃO CIVIL E ELÉTRICA LTDA";
  const VERMELHO = "C00000";
  const MOEDA = '"R$" #,##0.00';
  const OPERACOES = ["INSTALAR", "RETIRAR", "EXECUTAR"];

  // ------------------------------------------------------------------ catálogo
  // vem do banco (medicao_servicos e medicao_valor_us) e fica guardado no aparelho
  let C = { valor_us: {}, servicos: [] };
  const DEPS_APP = ["C&M (LM)", "C&M (LV)", "P&LF"];
  function usarCatalogo(cat) {
    C = cat;
    const M = window.Medicao;
    // a medição de campo usa só linha morta, linha viva e P&LF
    M.SERVICOS = cat.servicos
      .filter((s) => DEPS_APP.includes(s.departamento))
      .map((s) => ({ ...s, codigo: s.codigo || "", operacao: s.operacao || "" }));
    M.POR_ID = new Map(M.SERVICOS.map((s) => [s.id, s]));
    M.DEPARTAMENTOS = [...new Set(M.SERVICOS.map((s) => s.departamento))].sort(
      (a, b) => ordemDep(a)[0] - ordemDep(b)[0] || cmp(a, b),
    );
    M.catalogoGeradoEm = cat.gerado_em;
  }

  function anoUS(ano) {
    const anos = Object.keys(C.valor_us).map(Number).sort((a, b) => a - b);
    if (!anos.length) return String(ano);
    const escolhido = anos.filter((a) => a <= ano).pop() ?? anos[anos.length - 1];
    return String(escolhido);
  }
  /** Valor em R$ de 1 US do departamento no ano (o mais recente até esse ano). */
  function valorUS(departamento, ano = new Date().getFullYear()) {
    return C.valor_us[anoUS(ano)]?.[departamento] ?? 0;
  }

  // ------------------------------------------------------------------ números
  const numero = (t) => Number(String(t ?? "").replace(",", ".")) || 0;
  /** mesma conta do Termômetro: quantidade x US x valor da US, arredondada por linha */
  const valorItem = (i) => Number((numero(i.quantidade) * i.us * i.valor_us).toFixed(2));
  const soma = (lista, f) => Number(lista.reduce((t, x) => t + f(x), 0).toFixed(2));
  const fmtMoeda = (v) => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const fmtNum = (v, casas = 2) =>
    (v || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const fmtQtd = (v) => (v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 4 });
  const fmtDia = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
  const fmtHora = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.toLocaleDateString("pt-BR")} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  };
  function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Latitude/longitude (WGS84/SIRGAS 2000) em UTM: fuso, X (leste) e Y (norte), em metros. */
  function utm(lat, lng) {
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
    const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const zona = Math.floor((lng + 180) / 6) + 1;
    const rad = Math.PI / 180;
    const fi = lat * rad, l0 = ((zona - 1) * 6 - 180 + 3) * rad;
    const N = a / Math.sqrt(1 - e2 * Math.sin(fi) ** 2);
    const T = Math.tan(fi) ** 2, Cc = ep2 * Math.cos(fi) ** 2, A = Math.cos(fi) * (lng * rad - l0);
    const Mm = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * fi
      - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * fi)
      + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * fi)
      - (35 * e2 ** 3 / 3072) * Math.sin(6 * fi));
    const x = k0 * N * (A + (1 - T + Cc) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * Cc - 58 * ep2) * A ** 5 / 120) + 500000;
    let y = k0 * (Mm + N * Math.tan(fi) * (A * A / 2 + (5 - T + 9 * Cc + 4 * Cc * Cc) * A ** 4 / 24
      + (61 - 58 * T + T * T + 600 * Cc - 330 * ep2) * A ** 6 / 720));
    if (lat < 0) y += 10000000;
    return { x: Math.round(x), y: Math.round(y), zona: `${zona}${lat < 0 ? "S" : "N"}` };
  }
  /** "UTM 24S · X 551753 · Y 9237777" (sem ponto de milhar, como no GPS) */
  function fmtUtm(gps) {
    if (!gps) return "";
    const u = utm(gps.lat, gps.lng);
    return `UTM ${u.zona} · X ${u.x} · Y ${u.y}`;
  }

  function totaisPonto(p) {
    return {
      valor: soma(p.itens, valorItem),
      us: p.itens.reduce((t, i) => t + numero(i.quantidade) * i.us, 0),
    };
  }
  function totaisObra(o) {
    const todos = o.pontos.flatMap((p) => p.itens);
    return { valor: soma(todos, valorItem), us: todos.reduce((t, i) => t + numero(i.quantidade) * i.us, 0) };
  }

  // ------------------------------------------------- estrutura do fechamento
  const ORDEM_CATEGORIAS = [
    "POSTES", "ESTRUTURA CRUZETAS", "ESTRUTURA MRT", "ESTRUTURA BT", "TRAFOS/EQUIPAMENTOS",
    "CONDUTORES", "CONEXÕES", "ESTAI/ATERRAMENTO", "PODA/LIMPEZA FAIXA", "OUTROS",
  ];
  const tem = (d, lista) => lista.some((p) => d.includes(p));

  /** Grupo do serviço na planilha de fechamento: cópia fiel de `_categoria`. */
  function categoria(desc) {
    const d = (desc || "").toUpperCase();
    if (tem(d, ["PODA", "LIMPEZA", "FAIXA", "CORTE DE", "ARVORE", "ÁRVORE", "ROCO", "ROÇ"])) return "PODA/LIMPEZA FAIXA";
    if (/RAMAS?/.test(d)) return "PODA/LIMPEZA FAIXA";
    if (d.includes("POSTE") || d.includes("CAVA")) return "POSTES";
    if (d.includes("ESTRUTURA")) {
      if (d.includes("SDBT") || d.includes("RAMAL")) return "ESTRUTURA BT";
      if (/\bU\d/.test(d) || d.includes("MRT")) return "ESTRUTURA MRT";
      return "ESTRUTURA CRUZETAS";
    }
    if (tem(d, ["RABICHO", "ARMAÇÃO SEC", "ARMACAO SEC"])) return "ESTRUTURA BT";
    if (tem(d, ["CONDUTOR", "CABO", "RAMAL"])) return "CONDUTORES";
    if (tem(d, ["CONECTOR", "ESTRIBO", "GLV", "EMENDA", "TERMINAL"])) return "CONEXÕES";
    if (tem(d, ["ESTAI", "ATERRAMENTO", "HASTE", "CERCA"])) return "ESTAI/ATERRAMENTO";
    if (tem(d, ["TRANSFORMADOR", "CHAVE", "CARTUCHO", "PARA-RAIO", "PARA RAIO", "RELIGADOR",
      "REGULADOR", "CAPACITOR", "MEDIDOR", "EQUIPAMENTO"])) return "TRAFOS/EQUIPAMENTOS";
    return "OUTROS";
  }

  /** Linha morta primeiro, depois linha viva, depois os demais departamentos. */
  function ordemDep(dep) {
    const d = (dep || "").toUpperCase();
    if (d.includes("(LM)")) return [0, d];
    if (d.includes("(LV)")) return [1, d];
    return [2, d];
  }

  /** Uma data só: a do último dia de execução. */
  function dataExecucao(pontos) {
    const dias = pontos.filter((p) => p.itens.length && p.dia).map((p) => p.dia).sort();
    return dias.length ? fmtDia(dias[dias.length - 1]) : "";
  }

  /** [{titulo, op, dep, cats:[[categoria, [linha]]], subtotal, subtotalUs}],
   *  linha = {cod, desc, qtd, unit, valor, us} — mesmo que `_estrutura_fechamento`. */
  function estrutura(pontos) {
    const ordemOp = { INSTALAR: 0, RETIRAR: 1, EXECUTAR: 2 };
    const grupos = new Map();
    for (const p of pontos) {
      for (const i of p.itens) {
        const op = (i.operacao || "OUTROS").toUpperCase();
        const chave = `${op}|${i.departamento}`;
        if (!grupos.has(chave)) grupos.set(chave, { op, dep: i.departamento, servicos: new Map() });
        const sv = grupos.get(chave).servicos;
        const k = `${i.codigo}|${i.descricao}`;
        if (!sv.has(k)) sv.set(k, { cod: i.codigo, desc: i.descricao, qtd: 0, valor: 0, us: 0 });
        const g = sv.get(k);
        g.qtd += numero(i.quantidade);
        g.valor += valorItem(i);
        g.us += numero(i.quantidade) * (i.us || 0);
      }
    }
    const lista = [...grupos.values()].sort((a, b) => {
      const da = ordemDep(a.dep), db = ordemDep(b.dep);
      return da[0] - db[0] || cmp(da[1], db[1]) || (ordemOp[a.op] ?? 9) - (ordemOp[b.op] ?? 9);
    });
    return lista.map(({ op, dep, servicos }) => {
      const porCat = new Map();
      const itens = [...servicos.values()].sort((a, b) => cmp(String(a.cod), String(b.cod)) || cmp(a.desc, b.desc));
      for (const g of itens) {
        const c = categoria(g.desc);
        if (!porCat.has(c)) porCat.set(c, []);
        porCat.get(c).push({ ...g, unit: g.qtd ? g.valor / g.qtd : 0 });
      }
      const cats = ORDEM_CATEGORIAS.filter((c) => porCat.has(c)).map((c) => [c, porCat.get(c)]);
      return {
        titulo: `${op} (${dep})`, op, dep, cats,
        subtotal: itens.reduce((t, g) => t + g.valor, 0),
        subtotalUs: itens.reduce((t, g) => t + g.us, 0),
      };
    });
  }

  // ------------------------------------------------------------------ apoio
  const nomeArquivo = (obra, ext) =>
    `FECHAMENTO SIMPLIFICADO OBRA Nº ${String(obra.numero || "SEM NUMERO").replace(/\//g, "-")} - MEDIÇÃO DE CAMPO.${ext}`;

  async function imagemBase64(url) {
    const r = await fetch(url);
    if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image/")) throw new Error("logo não encontrado");
    return blobParaDataUrl(await r.blob());
  }
  function blobParaDataUrl(blob) {
    return new Promise((ok, falha) => {
      const fr = new FileReader();
      fr.onload = () => ok(fr.result);
      fr.onerror = () => falha(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  function tamanhoImagem(dataUrl) {
    return new Promise((ok) => {
      const img = new Image();
      img.onload = () => ok({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => ok({ w: 4, h: 3 });
      img.src = dataUrl;
    });
  }
  function esperarBiblioteca(teste, nome) {
    return new Promise((ok, falha) => {
      let n = 0;
      const t = setInterval(() => {
        if (teste()) { clearInterval(t); ok(); }
        else if (++n > 100) { clearInterval(t); falha(new Error(`Não carregou ${nome}. Abra o app uma vez com internet.`)); }
      }, 100);
    });
  }

  // ------------------------------------------------------------------ Excel
  const FINO = { style: "thin" };
  const BORDA = { top: FINO, left: FINO, bottom: FINO, right: FINO };
  const CENTRO = { horizontal: "center", vertical: "middle", wrapText: true };
  const preenche = (cor) => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + cor } });

  function linhaTitulo(ws, linha, texto) {
    ws.mergeCells(`A${linha}:F${linha}`);
    const c = ws.getCell(`A${linha}`);
    c.value = texto;
    c.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
    c.fill = preenche(VERMELHO);
    c.alignment = CENTRO;
    for (let i = 1; i <= 6; i++) ws.getRow(linha).getCell(i).border = BORDA;
  }
  function cabecalhoTabela(ws, linha) {
    ["ITEM", "COD", "DESCRIÇÃO DO SERVIÇO", "QUANTIDADE", "TOTAL US", "VALOR TOTAL"].forEach((t, i) => {
      const c = ws.getRow(linha).getCell(i + 1);
      c.value = t;
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = preenche(VERMELHO);
      c.alignment = CENTRO;
      c.border = BORDA;
    });
  }
  function linhaTotal(ws, linha, rotulo, us, valor) {
    const r = ws.getRow(linha);
    r.getCell(3).value = rotulo;
    r.getCell(5).value = us;
    r.getCell(5).numFmt = "#,##0.00";
    r.getCell(6).value = valor;
    r.getCell(6).numFmt = MOEDA;
    for (let k = 1; k <= 6; k++) {
      const c = r.getCell(k);
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = preenche(VERMELHO);
      c.border = BORDA;
      c.alignment = CENTRO;
    }
  }
  function secoesExcel(ws, linha, secoes) {
    for (const s of secoes) {
      linhaTitulo(ws, linha, s.titulo);
      linha++;
      cabecalhoTabela(ws, linha);
      linha++;
      let n = 0;
      for (const [cat, itens] of s.cats) {
        ws.mergeCells(`A${linha}:F${linha}`);
        const c = ws.getCell(`A${linha}`);
        c.value = cat;
        c.font = { bold: true };
        c.fill = preenche("E6E6E6");
        c.alignment = CENTRO;
        for (let k = 1; k <= 6; k++) ws.getRow(linha).getCell(k).border = BORDA;
        linha++;
        for (const it of itens) {
          n++;
          const r = ws.getRow(linha);
          [n, it.cod, it.desc, it.qtd, it.us, it.valor].forEach((v, k) => {
            const cel = r.getCell(k + 1);
            cel.value = v;
            cel.border = BORDA;
            cel.alignment = CENTRO;
          });
          r.getCell(5).numFmt = "#,##0.00";
          r.getCell(6).numFmt = MOEDA;
          linha++;
        }
      }
      linhaTotal(ws, linha, `TOTAL ${s.op}`, s.subtotalUs, s.subtotal);
      linha += 2;
    }
    return linha;
  }
  function topoFechamento(ws, wb, logoId, obra, pontos) {
    const secoes = estrutura(pontos);
    ws.mergeCells("A1:F2");
    if (logoId != null) ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 150, height: 40 } });
    ws.mergeCells("A3:F3");
    ws.getCell("A3").value = EMPRESA;
    ws.getCell("A3").font = { bold: true, size: 14 };
    ws.getCell("A3").alignment = CENTRO;
    ws.getCell("A4").value = "OBRA Nº:";
    ws.mergeCells("B4:C4");
    ws.getCell("B4").value = obra.numero;
    ws.getCell("B4").font = { bold: true, size: 14 };
    ws.mergeCells("D4:E4");
    ws.getCell("D4").value = "TOTAL:";
    ws.getCell("D4").font = { bold: true, size: 14 };
    ws.getCell("F4").value = secoes.reduce((t, s) => t + s.subtotal, 0);
    ws.getCell("F4").numFmt = MOEDA;
    ws.getCell("F4").font = { bold: true, size: 14 };
    ws.getCell("A5").value = "LOCAL:";
    ws.getCell("A5").font = { bold: true };
    ws.mergeCells("B5:C5");
    ws.getCell("B5").value = "DATA DE EXECUÇÃO:";
    ws.getCell("B5").font = { bold: true };
    ws.getCell("D5").value = dataExecucao(pontos);
    ws.getCell("E5").value = "TOTAL US:";
    ws.getCell("E5").font = { bold: true };
    ws.getCell("F5").value = secoes.reduce((t, s) => t + s.subtotalUs, 0);
    ws.getCell("F5").numFmt = "#,##0.00";
    ws.getCell("F5").font = { bold: true };
    for (const l of [4, 5]) for (let c = 1; c <= 6; c++) ws.getRow(l).getCell(c).alignment = CENTRO;
  }
  const larguras = (ws) => [12, 13, 80, 14, 12, 30].forEach((w, i) => (ws.getColumn(i + 1).width = w));

  async function gerarExcel(obra) {
    await esperarBiblioteca(() => window.ExcelJS, "a biblioteca do Excel");
    const wb = new ExcelJS.Workbook();
    wb.creator = "Medição de Campo - Teccel";
    let logoId = null;
    try {
      logoId = wb.addImage({ base64: await imagemBase64("logo-teccel-red.png"), extension: "png" });
    } catch (e) { /* sem logo */ }
    const pontos = obra.pontos;

    // 1) Fechamento simplificado: a obra toda somada (igual à medição do Termômetro)
    const ws = wb.addWorksheet(`FECHAMENTO OBRA ${obra.numero}`.slice(0, 31));
    const secoes = estrutura(pontos);
    topoFechamento(ws, wb, logoId, obra, pontos);
    let linha = secoesExcel(ws, 6, secoes);
    const porDep = new Map();
    for (const s of secoes) porDep.set(s.dep, (porDep.get(s.dep) || 0) + s.subtotal);
    if (porDep.size > 1) {
      linhaTitulo(ws, linha, "RESUMO POR DEPARTAMENTO");
      linha++;
      for (const [dep, v] of [...porDep.entries()].sort((a, b) => cmp(a[0], b[0]))) {
        ws.getRow(linha).getCell(1).value = dep;
        ws.getRow(linha).getCell(6).value = v;
        ws.getRow(linha).getCell(6).numFmt = MOEDA;
        linha++;
      }
    }
    larguras(ws);

    // 2) Medição por ponto: o padrão do rateio, com um bloco para cada ponto
    const wp = wb.addWorksheet(`MEDIÇÃO POR PONTO ${obra.numero}`.slice(0, 31));
    topoFechamento(wp, wb, logoId, obra, pontos);
    linha = 6;
    for (const p of pontos) {
      if (!p.itens.length) continue;
      linhaTitulo(wp, linha, `${p.nome} - DATA DE EXECUÇÃO: ${fmtDia(p.dia)}`);
      linha++;
      if (p.obs) {
        wp.mergeCells(`A${linha}:F${linha}`);
        const c = wp.getCell(`A${linha}`);
        c.value = `Obs.: ${p.obs}`;
        c.font = { italic: true };
        c.alignment = CENTRO;
        for (let k = 1; k <= 6; k++) wp.getRow(linha).getCell(k).border = BORDA;
        linha++;
      }
      const sp = estrutura([p]);
      linha = secoesExcel(wp, linha, sp);
      linhaTotal(wp, linha, `TOTAL ${p.nome}`, sp.reduce((t, s) => t + s.subtotalUs, 0), sp.reduce((t, s) => t + s.subtotal, 0));
      linha += 2;
    }
    larguras(wp);

    const buf = await wb.xlsx.writeBuffer();
    return {
      nome: nomeArquivo(obra, "xlsx"),
      blob: new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    };
  }

  // ------------------------------------------------------------------ PDF
  const RGB = {
    tarja: [177, 15, 25], // #B10F19
    vermelho: [192, 0, 0], // #C00000
    cinza: [230, 230, 230],
    faixa: [75, 85, 99], // #4B5563
  };
  const moedaPdf = (v) => "R$ " + fmtNum(v);

  async function gerarPdf(obra, { comFotos = true, supervisor = "" } = {}) {
    await esperarBiblioteca(() => window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable, "a biblioteca do PDF");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
    const M = 10, TOPO = 8, PE = 10;
    const L = 210 - 2 * M;
    const alturaPag = 297;
    const pontos = obra.pontos;
    const secoes = estrutura(pontos);
    const total = secoes.reduce((t, s) => t + s.subtotal, 0);
    const totalUs = secoes.reduce((t, s) => t + s.subtotalUs, 0);
    let logo = null;
    try { logo = await imagemBase64("logo-teccel-white.png"); } catch (e) { /* sem logo */ }

    // cabeçalho: tarja com logo, empresa e obra/total/US
    const hCab = 17;
    doc.setFillColor(...RGB.tarja);
    doc.rect(M, TOPO, L, hCab, "F");
    if (logo) {
      try { doc.addImage(logo, "PNG", M + 3, TOPO + (hCab - 9) / 2, 37, 9, "logo", "FAST"); } catch (e) { /* segue sem logo */ }
    }
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(doc.splitTextToSize(EMPRESA, 80), M + 46 + 42, TOPO + hCab / 2 - 1, { align: "center", baseline: "middle" });
    const direita = M + L - 3;
    const linhaDir = (rotulo, valor, y) => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      const w = doc.getTextWidth(valor);
      doc.text(valor, direita, y, { align: "right" });
      doc.setFont("helvetica", "normal");
      doc.text(rotulo, direita - w - 1, y, { align: "right" });
    };
    linhaDir("OBRA Nº", String(obra.numero || ""), TOPO + 5);
    linhaDir("TOTAL", moedaPdf(total), TOPO + 9.5);
    linhaDir("TOTAL US", fmtNum(totalUs), TOPO + 14);

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(8);
    let y = TOPO + hCab + 4.5;
    const linhaRotulo = (rotulo, valor) => {
      doc.setFont("helvetica", "normal");
      doc.text(rotulo, M, y);
      doc.setFont("helvetica", "bold");
      doc.text(valor, M + doc.getTextWidth(rotulo) + 1, y);
    };
    linhaRotulo("DATA DE EXECUÇÃO:", dataExecucao(pontos));
    y += 3;

    const estiloBase = {
      font: "helvetica", fontSize: 7.5, halign: "center", valign: "middle",
      cellPadding: { top: 0.55, bottom: 0.55, left: 1, right: 1 },
      lineColor: [0, 0, 0], lineWidth: 0.14, textColor: [0, 0, 0],
    };
    const colunas = { 0: { cellWidth: 12 }, 1: { cellWidth: 18 }, 2: { cellWidth: 80 }, 3: { cellWidth: 24 }, 4: { cellWidth: 20 }, 5: { cellWidth: 36 } };
    const cabVermelho = { fillColor: RGB.vermelho, textColor: [255, 255, 255], fontStyle: "bold" };

    const desenharSecoes = (lista) => {
    for (const s of lista) {
      const corpo = [];
      let n = 0;
      for (const [cat, itens] of s.cats) {
        corpo.push([{ content: cat, colSpan: 6, styles: { fillColor: RGB.cinza, fontStyle: "bold" } }]);
        for (const it of itens) {
          n++;
          corpo.push([String(n), it.cod || "", it.desc, fmtQtd(it.qtd), fmtNum(it.us), moedaPdf(it.valor)]);
        }
      }
      corpo.push([
        { content: "", styles: cabVermelho }, { content: "", styles: cabVermelho },
        { content: `TOTAL ${s.op}`, colSpan: 2, styles: cabVermelho },
        { content: fmtNum(s.subtotalUs), styles: cabVermelho }, { content: moedaPdf(s.subtotal), styles: cabVermelho },
      ]);
      doc.autoTable({
        startY: y,
        margin: { left: M, right: M, top: TOPO, bottom: PE },
        theme: "grid",
        styles: estiloBase,
        headStyles: cabVermelho,
        columnStyles: colunas,
        head: [
          [{ content: s.titulo, colSpan: 6 }],
          ["ITEM", "COD", "DESCRIÇÃO DO SERVIÇO", "QUANTIDADE", "TOTAL US", "VALOR TOTAL"],
        ],
        body: corpo,
        showHead: "everyPage",
        rowPageBreak: "avoid",
      });
      y = doc.lastAutoTable.finalY + 2.1;
    }
    };
    desenharSecoes(secoes);

    if (secoes.length === 0) {
      doc.setFont("helvetica", "italic");
      doc.text("Nenhum serviço lançado nesta obra.", M, y + 4);
    }

    // medição por ponto, com as fotos
    doc.addPage();
    y = TOPO;
    const novaPagina = (precisa) => {
      if (y + precisa > alturaPag - PE) {
        doc.addPage();
        y = TOPO;
        return true;
      }
      return false;
    };
    const tituloFolha = (texto) => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...RGB.vermelho);
      doc.text(texto, M, y + 3);
      doc.setTextColor(0, 0, 0);
      y += 6;
    };
    doc.setFillColor(...RGB.vermelho);
    doc.rect(M, y, L, 8, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(`MEDIÇÃO POR PONTO · OBRA Nº ${obra.numero}`, M + L / 2, y + 4, { align: "center", baseline: "middle" });
    y += 10;
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(8);
    const infos = [
      obra.local && `Local: ${obra.local}`,
      obra.municipio && `Cidade: ${obra.municipio}`,
      obra.equipe && `Equipe executora: ${obra.equipe}`,
      supervisor && `Supervisor: ${supervisor}`,
      `Pontos: ${pontos.length}`,
    ].filter(Boolean);
    doc.setFont("helvetica", "normal");
    const linhasInfo = doc.splitTextToSize(infos.join("   ·   "), L);
    doc.text(linhasInfo, M, y + 2);
    y += 2 + linhasInfo.length * 3.5;
    if (obra.obs) {
      const t = doc.splitTextToSize(`Obs. da obra: ${obra.obs}`, L);
      doc.text(t, M, y);
      y += t.length * 3.5 + 1;
    }

    for (const [ip, p] of pontos.entries()) {
      const tp = totaisPonto(p);
      if (comFotos && ip > 0) {
        // com fotos: cada ponto (poste) na sua folha, com as fotos dele
        doc.addPage();
        y = TOPO;
        tituloFolha(`OBRA Nº ${obra.numero} · MEDIÇÃO POR PONTO`);
      } else novaPagina(24);
      doc.setFillColor(...RGB.faixa);
      doc.rect(M, y, L, 7, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(p.nome, M + 3, y + 3.5, { baseline: "middle" });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      const resumo = `${fmtDia(p.dia)}   ·   ${p.itens.length} ${p.itens.length === 1 ? "serviço" : "serviços"}   ·   ${fmtNum(tp.us)} US   ·   ${moedaPdf(tp.valor)}`;
      doc.text(resumo, M + L - 3, y + 3.5, { align: "right", baseline: "middle" });
      y += 9;
      doc.setTextColor(0, 0, 0);
      const extras = [
        p.obs && `Obs.: ${p.obs}`,
        p.gps && `Coordenada ${fmtUtm(p.gps)} (±${Math.round(p.gps.prec || 0)} m)`,
      ].filter(Boolean);
      for (const e of extras) {
        const t = doc.splitTextToSize(e, L);
        novaPagina(t.length * 3.5);
        doc.text(t, M, y + 1);
        y += t.length * 3.5;
      }
      if (p.itens.length) {
        y += 1;
        desenharSecoes(estrutura([p]));
        doc.autoTable({
          startY: y - 1.6,
          margin: { left: M, right: M, top: TOPO, bottom: PE },
          theme: "grid",
          styles: estiloBase,
          columnStyles: colunas,
          body: [[
            { content: "", styles: cabVermelho }, { content: "", styles: cabVermelho },
            { content: `TOTAL ${p.nome}`, colSpan: 2, styles: cabVermelho },
            { content: fmtNum(tp.us), styles: cabVermelho }, { content: moedaPdf(tp.valor), styles: cabVermelho },
          ]],
          rowPageBreak: "avoid",
        });
        y = doc.lastAutoTable.finalY + 2;
      } else {
        doc.setFont("helvetica", "italic");
        doc.text("Sem serviços lançados neste ponto.", M, y + 2);
        doc.setFont("helvetica", "normal");
        y += 4;
      }

      if (comFotos && p.fotos.length) {
        // grade que cabe na folha do ponto: 1 foto grande, 2 colunas, e mais colunas se forem muitas
        const nf = p.fotos.length, GAP = 4, LEGENDA = 5;
        const livre = alturaPag - PE - y - 1;
        let cols = nf === 1 ? 1 : 2, largFoto = 0, altFoto = 0;
        for (; ; cols++) {
          const linhas = Math.ceil(nf / cols);
          largFoto = (L - (cols - 1) * GAP) / cols;
          altFoto = Math.min(largFoto * 4 / 3, 120, (livre - linhas * LEGENDA) / linhas);
          if (altFoto >= 40 || cols >= 4) break;
        }
        if (altFoto < 40) altFoto = Math.min(largFoto * 4 / 3, 60); // muitas fotos: continua em outra folha do mesmo ponto
        for (let k = 0; k < nf; k += cols) {
          if (novaPagina(altFoto + LEGENDA + 1)) tituloFolha(`${p.nome} (continuação) · OBRA Nº ${obra.numero}`);
          for (let j = 0; j < cols && k + j < nf; j++) {
            const foto = await Banco.obterFoto(p.fotos[k + j]);
            if (!foto) continue;
            const url = await blobParaDataUrl(foto.blob);
            const { w, h } = await tamanhoImagem(url);
            const esc = Math.min(largFoto / w, altFoto / h);
            const fw = w * esc, fh = h * esc;
            const x0 = M + j * (largFoto + GAP);
            doc.setDrawColor(200, 200, 200);
            doc.rect(x0, y, largFoto, altFoto);
            doc.addImage(url, "JPEG", x0 + (largFoto - fw) / 2, y + (altFoto - fh) / 2, fw, fh, foto.id);
            doc.setFontSize(7);
            doc.setTextColor(90, 90, 90);
            doc.text(`${p.nome} · foto ${k + j + 1} · ${fmtHora(foto.criada_em)}`, x0, y + altFoto + 3);
            doc.setTextColor(0, 0, 0);
            doc.setFontSize(8);
          }
          y += altFoto + LEGENDA;
        }
      }
      y += 3;
    }

    // rodapé em todas as folhas
    const n = doc.getNumberOfPages();
    const gerado = fmtHora(new Date().toISOString());
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(120, 120, 120);
      doc.text(`Medição de campo${supervisor ? " · Supervisor: " + supervisor : ""} · Gerado em ${gerado}`, M, alturaPag - 4);
      doc.text(`Página ${i} de ${n}`, M + L, alturaPag - 4, { align: "right" });
    }
    return { nome: nomeArquivo(obra, "pdf"), blob: doc.output("blob") };
  }

  window.Medicao = {
    SERVICOS: [], POR_ID: new Map(), DEPARTAMENTOS: [], OPERACOES, usarCatalogo, valorUS, anoUS, numero, valorItem, soma,
    fmtMoeda, fmtNum, fmtQtd, fmtDia, fmtHora, utm, fmtUtm, totaisPonto, totaisObra, estrutura, categoria,
    gerarExcel, gerarPdf, blobParaDataUrl, catalogoGeradoEm: null,
  };
})();
