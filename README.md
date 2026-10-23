# Sorteador de Comentários do Instagram

Aplicativo web (HTML + CSS + JavaScript puro, sem instalação) para sortear entre **todos** os comentários de uma publicação do Instagram, com histórico completo e comprovante de cada sorteio.

## Como usar

- **Publicar no GitHub Pages** (recomendado): suba a pasta inteira para um repositório e ative o Pages. Funciona em qualquer navegador, inclusive no celular.
- **Rodar localmente**: na pasta do projeto, execute `python -m http.server 5510` e abra `http://localhost:5510`.

> Abrir o `index.html` com dois cliques também funciona no Chrome/Edge, mas um endereço `http(s)` é mais confiável para salvar o histórico.

## Fluxo

1. **Origem** — escolha entre:
   - *Minha conta profissional*: API oficial do Instagram (token `IG…` ou `EAA…`). Lista as publicações da conta ou localiza pelo link.
   - *Importar lista*: CSV, JSON ou texto colado (`@usuario comentário`, um por linha).
   - *Demonstração*: gera até 100 mil comentários fictícios para testes.
2. **Comentários** — leitura página por página até o fim, **sem limite**. Se o Instagram limitar as requisições, o app espera e continua sozinho. Dá para pausar e retomar depois, mesmo fechando o navegador (o progresso fica em cache).
3. **Regras** — ganhadores, suplentes, 1 chance por perfil ou por comentário, menções mínimas, palavra/hashtag obrigatória, prazo, perfis excluídos, respostas, comentários ocultos.
4. **Sorteio** — sorteio com `crypto.getRandomValues` (gerador criptográfico, sem viés). O resultado é **salvo antes da animação**, então não há como “sortear até sair quem eu quero” sem que isso fique registrado.

## O que fica salvo em cada sorteio

- Código único (`SRT-AAAAMMDD-XXXX`), data e hora, nome e observações
- Publicação: perfil, legenda, link, ID, data, contagem informada pelo Instagram
- Origem: conta conectada e versão da API, ou arquivo importado
- Carregamento: total de comentários, respostas, perfis únicos, páginas lidas, se a lista estava completa
- Regras aplicadas e quantos comentários cada regra excluiu
- Ganhadores e suplentes com **todos os dados do comentário** (texto, data, curtidas, ID do comentário, ID do perfil e o objeto original da API)
- Auditoria: hash SHA-256 da lista de participantes, valores aleatórios sorteados e posição de cada sorteado
- Lista completa de participantes (opcional)

Cada sorteio pode ser impresso/salvo em PDF como comprovante e exportado em JSON ou CSV.

## Onde os dados ficam

- **Sem login:** tudo fica no navegador (IndexedDB). Use **Ajustes → Exportar backup** para guardar uma cópia.
- **Com a conta Google (botão "Entrar com Google"):** cada sorteio é enviado para o Firebase (Firestore) e aparece em qualquer aparelho em que a pessoa entrar. Cada usuário só acessa os próprios dados (regras em `firestore.rules`). O token do Instagram nunca sai do aparelho.
- Ao entrar, o site oferece enviar para a conta os sorteios feitos antes sem login. Ao sair, as cópias locais da conta são removidas do navegador.

### Firebase (projeto `sorteador-75b4b`)

- Authentication → Método de login: **Google** ativado.
- Authentication → Configurações → Domínios autorizados: `mavigas.github.io` (e o domínio próprio, quando houver).
- Firestore → Regras: conteúdo de `firestore.rules` publicado.

## Limitações da API do Instagram

- A API oficial só lê comentários de publicações da **própria conta profissional** (Comercial ou Criador de conteúdo) ligada ao token. Para publicações de outras contas, use “Importar lista”.
- O total de comentários exibido pelo Instagram inclui respostas; por isso o número carregado sem respostas costuma ser menor.
- Tokens de usuário expiram (o do Instagram dura 60 dias). Gere outro em Ajustes quando aparecer “token inválido ou expirado”.

## Estrutura

```
index.html         interface
css/styles.css     visual (tema claro/escuro automático, responsivo, estilo de impressão)
js/db.js           armazenamento local (IndexedDB)
js/cloud.js        login com Google e histórico na nuvem (Firebase)
firestore.rules    regras de segurança do Firestore
js/instagram.js    cliente da API com paginação ilimitada e novas tentativas
js/importer.js     leitura de CSV/JSON/texto e gerador da demonstração
js/app.js          telas, regras, sorteio, histórico e comprovante
```
