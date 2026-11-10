/* Banco do aparelho (IndexedDB). O celular trabalha sempre aqui, com ou sem sinal;
   o envio para o Supabase (nuvem.js) lê daqui. Lojas: "obras" (pontos e serviços),
   "fotos" (arquivos) e "chaves" (catálogo guardado, sessão do supervisor...). */
(function () {
  const NOME = "medicao-campo";
  let conexao = null;

  function abrir() {
    if (conexao) return conexao;
    conexao = new Promise((ok, falha) => {
      const req = indexedDB.open(NOME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("obras")) db.createObjectStore("obras", { keyPath: "id" });
        if (!db.objectStoreNames.contains("fotos")) {
          const f = db.createObjectStore("fotos", { keyPath: "id" });
          f.createIndex("obra", "obraId");
        }
        if (!db.objectStoreNames.contains("chaves")) db.createObjectStore("chaves", { keyPath: "k" });
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => falha(req.error);
    });
    return conexao;
  }

  async function operar(loja, modo, fn) {
    const db = await abrir();
    return new Promise((ok, falha) => {
      const tx = db.transaction(loja, modo);
      const st = tx.objectStore(loja);
      let resultado;
      const r = fn(st);
      if (r) r.onsuccess = () => (resultado = r.result);
      tx.oncomplete = () => ok(resultado);
      tx.onerror = () => falha(tx.error);
      tx.onabort = () => falha(tx.error || new Error("Operação cancelada"));
    });
  }

  window.Banco = {
    listarObras: () => operar("obras", "readonly", (s) => s.getAll()),
    obterObra: (id) => operar("obras", "readonly", (s) => s.get(id)),
    /** Grava a obra. Mudança feita pelo supervisor marca a obra para envio;
     *  `{ envio: true }` é a gravação do próprio envio, que não muda nada disso. */
    salvarObra: (obra, { envio = false } = {}) => {
      if (!envio) {
        obra.atualizada_em = new Date().toISOString();
        obra.pendente = true;
      }
      return operar("obras", "readwrite", (s) => s.put(obra));
    },
    async excluirObra(id) {
      const fotos = await this.fotosDaObra(id);
      await operar("fotos", "readwrite", (s) => fotos.forEach((f) => s.delete(f.id)));
      return operar("obras", "readwrite", (s) => s.delete(id));
    },
    salvarFoto: (foto) => operar("fotos", "readwrite", (s) => s.put(foto)),
    obterFoto: (id) => operar("fotos", "readonly", (s) => s.get(id)),
    excluirFoto: (id) => operar("fotos", "readwrite", (s) => s.delete(id)),
    fotosDaObra: (obraId) => operar("fotos", "readonly", (s) => s.index("obra").getAll(obraId)),
    todasFotos: () => operar("fotos", "readonly", (s) => s.getAll()),
    /** o navegador não apaga nada sozinho quando o celular fica sem espaço */
    async persistente() {
      try { return !!(navigator.storage && (await navigator.storage.persisted())); } catch (e) { return false; }
    },
    async ler(k, padrao = null) {
      const r = await operar("chaves", "readonly", (s) => s.get(k));
      return r ? r.v : padrao;
    },
    gravar: (k, v) => operar("chaves", "readwrite", (s) => s.put({ k, v })),
    async pedirPersistencia() {
      try {
        if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
      } catch (e) { /* sem suporte */ }
      return false;
    },
    async espaco() {
      try {
        if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
      } catch (e) { /* sem suporte */ }
      return null;
    },
  };
})();
