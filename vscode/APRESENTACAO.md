# CGMES & NC Profile Hints

## Mais contexto para trabalhar com modelos CIM/XML no VS Code

**CGMES & NC Profile Hints** é uma extensão para apoiar a edição e a revisão de arquivos CIM/XML (RDF/XML). Ela oferece sugestões e validações contextualizadas pelos perfis, ajudando a encontrar inconsistências mais cedo e a navegar por conjuntos de modelos relacionados.

Compatível com **CGMES 2.4.15**, **CGMES 3.0** e **ENTSO-E Network Code Profiles (NCP) 2.2**.

## O que a extensão oferece

### Sugestões que acompanham o modelo

Ao pressionar `Ctrl+Space`, a extensão sugere classes concretas disponíveis no perfil ativo, propriedades aplicáveis à classe e valores compatíveis com o contexto. Propriedades obrigatórias aparecem primeiro; ao criar um objeto, a extensão pode incluir as propriedades exigidas pelo perfil.

Nas associações, também pode sugerir objetos compatíveis já encontrados no arquivo. Em um documento vazio, oferece modelos iniciais com namespaces e cabeçalho.

**Exemplo de uso:** dentro de `rdf:RDF`, comece uma nova tag e abra as sugestões. Depois de escolher uma classe, faça o mesmo dentro do objeto para ver suas propriedades:

```xml
<rdf:RDF>
  <
</rdf:RDF>
```

As opções disponíveis dependem da versão e do perfil reconhecidos para o arquivo.

### Informações sem sair do código

Passe o cursor sobre uma classe ou propriedade para consultar descrição, herança, tipo de dado, unidade, multiplicidade, enumerações, perfis em que ela é usada e regras SHACL relacionadas.

Isso facilita conferir, por exemplo, se uma propriedade pertence à classe em edição e se aceita um valor literal ou uma referência.

### Validação enquanto você edita

A extensão aponta problemas de sintaxe e estrutura XML, identificadores duplicados ou inválidos, prefixos não declarados e inconsistências com as definições RDFS e as restrições SHACL cobertas.

Entre os exemplos de verificações estão:

- classe ou propriedade desconhecida, no namespace errado ou fora do perfil;
- propriedade usada em uma classe à qual não pertence;
- valor de enumeração, tipo de dado ou referência incompatível;
- propriedade obrigatória ausente ou ocorrência acima da multiplicidade;
- referência para um objeto inexistente ou de classe incompatível.

Quando há uma correção possível, o editor pode oferecer *quick fixes* — por exemplo, substituir uma propriedade escrita incorretamente, declarar um prefixo ou inserir propriedades obrigatórias.

**Exemplo:** uma propriedade digitada incorretamente pode ser sinalizada e acompanhada de uma sugestão de substituição:

```xml
<cim:Breaker rdf:ID="_550e8400-e29b-41d4-a716-446655440000">
  <cim:IdentifiedObject.nam>Disjuntor</cim:IdentifiedObject.nam>
</cim:Breaker>
```

Nesse caso, a extensão pode sugerir `cim:IdentifiedObject.name`, se essa propriedade for válida para a classe e o perfil em uso.

### Verificações entre arquivos do conjunto

Ao trabalhar com um conjunto de modelos, a extensão pode relacionar arquivos como EQ, SSH, TP e SV de um CGM, ou arquivos de perfis NC que referenciam outros modelos. Ela verifica se os objetos referenciados são encontrados e se suas classes são compatíveis.

**Exemplo ilustrativo:** um equipamento pode referenciar uma tensão-base definida em outro arquivo do conjunto. Os cabeçalhos e namespaces foram omitidos:

```xml
<!-- EQ.xml -->
<cim:BaseVoltage rdf:ID="_550e8400-e29b-41d4-a716-446655440000">
  <cim:IdentifiedObject.mRID>base-voltage-001</cim:IdentifiedObject.mRID>
</cim:BaseVoltage>

<!-- Outro arquivo do conjunto -->
<cim:Breaker rdf:ID="_550e8400-e29b-41d4-a716-446655440001">
  <cim:ConductingEquipment.BaseVoltage
      rdf:resource="#_550e8400-e29b-41d4-a716-446655440000"/>
</cim:Breaker>
```

Se o objeto referenciado não for encontrado no conjunto selecionado, ou não for da classe esperada, a extensão pode indicar o problema.

Por padrão, a seleção considera as dependências declaradas no cabeçalho e os demais arquivos da pasta. Também é possível selecionar arquivos ou uma pasta no Explorer e usar **Validate together**, ou ajustar o conjunto pelo item **Dataset** na barra de status.

### Problemas organizados para revisão

A visualização **CIM Issues**, no Explorer, reúne os achados por categoria — schema, SHACL, referências entre arquivos, dados de referência e arquivo/identificadores. É possível agrupá-los por severidade ou tipo de verificação, ver o objeto relacionado e clicar em um item para ir diretamente à linha correspondente.

## Um fluxo rápido

1. Abra um arquivo `.rdf`, `.cimxml` ou XML que contenha CIM/XML.
2. Confira a versão e o perfil exibidos na barra de status; se necessário, selecione-os ali ou pela Paleta de Comandos.
3. Use `Ctrl+Space` para completar classes, propriedades e valores.
4. Revise os diagnósticos no editor ou abra **CIM Issues** para navegar pelos problemas do arquivo.
5. Para validar referências entre vários arquivos, selecione o conjunto com **Validate together** ou configure o **Dataset**.

Também é possível criar um novo arquivo pelo comando **CGMES: New CIM/XML instance file**, que prepara um cabeçalho e os namespaces para o perfil escolhido.

## Adaptação a outros esquemas

Além dos perfis incluídos, é possível apontar a configuração `cgmes.schemaFolders` para pastas com definições RDFS e, opcionalmente, arquivos SHACL `.ttl`. A configuração `cgmes.crossFile.extraFolders` permite incluir outras pastas nas verificações entre arquivos.

## Escopo das verificações

A extensão cobre verificações úteis durante a edição, mas não substitui todas as ferramentas de validação de modelos. Regras SHACL baseadas em SPARQL não são executadas; nas verificações entre arquivos, o foco é a resolução de identificadores e a compatibilidade das classes, não a validação semântica completa de todas as relações.

## Saiba mais

- [README técnico](./README.md): instalação, configurações, comandos e detalhes de funcionamento.
- [Catálogo de funcionalidades](./FEATURES.md): regras e verificações cobertas em mais detalhe.
