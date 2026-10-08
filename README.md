# Coletor DODF

Coletor automatizado do Diário Oficial do Distrito Federal, com execução em dias úteis às 6h, 7h, 8h, 9h, 10h, 11h e 12h (horário de Brasília).

## Regra de verdade

Falha de JavaScript, payload dinâmico, endpoint, busca ou navegador é tratada somente como falha do canal de coleta. Sem PDF validado, o resultado obrigatório é:

> COLETA AUTOMÁTICA NÃO VALIDADA — não foi possível obter o arquivo pelos canais acessíveis nesta execução

A rotina nunca conclui que a edição não existe ou não foi publicada com base apenas nessas falhas.

## Validação positiva

Um PDF só é marcado como obtido quando o próprio arquivo confirma a data pesquisada e o cabeçalho do Diário Oficial do Distrito Federal. O relatório registra URL, número da edição quando identificado, tipo e total de páginas.

## Execução manual

Em **Actions > Coleta oficial DODF > Run workflow**, é possível executar para o dia corrente ou informar uma data no formato `YYYY-MM-DD`.

## Evidências

Cada execução salva `report.json`, `status.txt` e os PDFs validados como artefato do GitHub Actions por 14 dias.
