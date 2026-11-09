# Medição de Campo (Teccel)

App de celular para o **supervisor** medir a obra em campo, **ponto a ponto**
(P1, P2, ...), com os mesmos códigos, serviços e valores do Termômetro, e gerar
no fim a medição no padrão do **Fechamento Simplificado** do Termômetro.

## Como funciona
1. **Nova obra**: número (8 ou 10 dígitos, mesma regra do Termômetro), local,
   município, departamento do catálogo (padrão C&M (LM)), equipe executora.
2. **Novo ponto**: cada poste/trecho é um ponto. O nome sugere o próximo
   (P1, P2...), a data repete a do ponto anterior e o GPS é marcado sozinho.
3. No ponto: **fotos** (câmera ou galeria; cada foto sai carimbada com obra,
   ponto, data/hora e GPS) e **serviços** (busca por código ou nome, digita a
   quantidade e escolhe Instalar / Retirar / Executar, igual ao app das equipes).
4. **Gerar medição**:
   - **Planilha Excel**: aba `FECHAMENTO OBRA` idêntica à do Termômetro e aba
     `MEDIÇÃO POR PONTO` (padrão do rateio, um bloco por ponto).
   - **PDF**: o fechamento no mesmo layout e depois cada ponto com os serviços
     e as fotos. Também tem a opção sem fotos.
5. **Backup da obra** (`.json` com fotos): para passar a obra a outro celular ou
   guardar cópia. Importa em Ajustes.

Tudo fica guardado **no celular** (IndexedDB) e funciona **sem internet**
depois de aberto uma vez com sinal.

## Valor
Igual ao Termômetro: `quantidade x US do serviço x valor da US do departamento
no ano`, arredondado por linha. O valor da US fica gravado no item na hora do
lançamento.

## Atualizar o catálogo
O catálogo (`catalogo.js`) é uma cópia de `termo_servicos` e `termo_us` do banco
do Termômetro. Se mudar código, US ou valor lá, gere de novo:

```
py -I ferramentas\gerar_catalogo.py "C:\Users\Compras\OneDrive\Documentos\Teccel Engenharia\sistema-programacao-teccel\backend\teccel.db" catalogo.js
```

Depois suba a `VERSAO` em `sw.js` para os celulares pegarem a nova cópia.

## Arquivos
- `index.html`, `app.css`, `app.js`: telas.
- `medicao.js`: contas e geração do Excel/PDF (cópia fiel de
  `exportacao_termometro.py`: seções, categorias, ordem, cores e colunas).
- `banco.js`: banco do aparelho.
- `sw.js`, `manifest.webmanifest`, `icones/`: app instalável e sem internet.
- Bibliotecas pelo cdnjs: ExcelJS 4.4.0, jsPDF 2.5.1, jsPDF-AutoTable 3.8.2.

## Testar no computador
```
python -m http.server 5620 --directory medicao-campo
```
e abrir http://localhost:5620.
