/* Guarda o app e as bibliotecas no celular para abrir sem internet.
   Ao mudar qualquer arquivo, suba a VERSAO para os celulares pegarem a nova. */
const VERSAO = "medicao-v5";
const ARQUIVOS = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "banco.js",
  "medicao.js",
  "config.js",
  "nuvem.js",
  "manifest.webmanifest",
  "logo-teccel-red.png",
  "logo-teccel-white.png",
  "icones/icon-192.png",
  "icones/icon-512.png",
  "icones/apple-touch-icon.png",
  "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// arquivos do app: rede primeiro (pega atualização), cai no guardado sem sinal.
// bibliotecas do CDN: guardado primeiro (não mudam).
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // o banco (Supabase) passa direto, nunca vai para o cache
  if (url.origin !== location.origin) {
    if (url.hostname === "cdnjs.cloudflare.com") e.respondWith(caches.match(req).then((r) => r || fetch(req)));
    return;
  }
  // no-cache: o GitHub Pages manda max-age=600 e o navegador devolveria o arquivo velho
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((r) => {
        if (r.ok) {
          const copia = r.clone();
          caches.open(VERSAO).then((c) => c.put(req, copia));
        }
        return r;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))),
  );
});
