# CGMES & NC Profile Hints

## More context for working with CIM/XML models in VS Code

**CGMES & NC Profile Hints** is an extension that supports editing and reviewing CIM/XML (RDF/XML) files. It provides profile-aware suggestions and validation, helping you find inconsistencies earlier and navigate sets of related models.

Compatible with **CGMES 2.4.15**, **CGMES 3.0**, and **ENTSO-E Network Code Profiles (NCP) 2.2**.

## What the extension offers

### Model-aware suggestions

Press `Ctrl+Space` to see concrete classes available in the active profile, properties applicable to the class, and values appropriate to the context. Required properties appear first; when creating an object, the extension can include the properties required by the profile.

For associations, it can also suggest compatible objects already found in the file. In an empty document, it offers starter templates with namespaces and a header.

**Example:** inside `rdf:RDF`, start a new tag and open the suggestions. After choosing a class, do the same inside the object to see its properties:

```xml
<rdf:RDF>
  <
</rdf:RDF>
```

The available options depend on the version and profile recognized for the file.

### Information without leaving the code

Hover over a class or property to see its description, inheritance, data type, unit, multiplicity, enumerations, profiles in which it is used, and related SHACL rules.

This makes it easier to check, for example, whether a property belongs to the class being edited and whether it accepts a literal value or a reference.

### Validation as you edit

The extension identifies XML syntax and structure problems, duplicate or invalid identifiers, undeclared prefixes, and inconsistencies with RDFS definitions and the covered SHACL constraints.

Examples of checks include:

- an unknown class or property, one in the wrong namespace, or one outside the profile;
- a property used on a class to which it does not belong;
- an incompatible enumeration value, data type, or reference;
- a missing required property or a property exceeding its multiplicity;
- a reference to a nonexistent object or an object of an incompatible class.

When a correction is available, the editor can offer *quick fixes* — for example, replacing a misspelled property, declaring a prefix, or inserting required properties.

**Example:** a misspelled property can be flagged with a suggested replacement:

```xml
<cim:Breaker rdf:ID="_550e8400-e29b-41d4-a716-446655440000">
  <cim:IdentifiedObject.nam>Breaker</cim:IdentifiedObject.nam>
</cim:Breaker>
```

In this case, the extension can suggest `cim:IdentifiedObject.name` if that property is valid for the class and profile in use.

### Cross-file checks within a dataset

When working with a set of models, the extension can relate files such as EQ, SSH, TP, and SV from a CGM, or NC profile files that reference other models. It checks whether referenced objects can be found and whether their classes are compatible.

**Illustrative example:** equipment can reference a base voltage defined in another file in the dataset. Headers and namespaces have been omitted:

```xml
<!-- EQ.xml -->
<cim:BaseVoltage rdf:ID="_550e8400-e29b-41d4-a716-446655440000">
  <cim:IdentifiedObject.mRID>base-voltage-001</cim:IdentifiedObject.mRID>
</cim:BaseVoltage>

<!-- Another file in the dataset -->
<cim:Breaker rdf:ID="_550e8400-e29b-41d4-a716-446655440001">
  <cim:ConductingEquipment.BaseVoltage
      rdf:resource="#_550e8400-e29b-41d4-a716-446655440000"/>
</cim:Breaker>
```

If the referenced object is not found in the selected dataset, or is not of the expected class, the extension can flag the problem.

By default, selection considers the dependencies declared in the header and the other files in the folder. You can also select files or a folder in Explorer and use **Validate together**, or adjust the selection through **Dataset** in the status bar.

### Issues organized for review

The **CIM Issues** view in Explorer collects findings by category — schema, SHACL, cross-file references, reference data, and file/identifier issues. You can group them by severity or check type, see the related object, and click an item to go directly to the corresponding line.

## A quick workflow

1. Open a `.rdf`, `.cimxml`, or XML file containing CIM/XML.
2. Check the version and profile shown in the status bar; if necessary, select them there or through the Command Palette.
3. Use `Ctrl+Space` to complete classes, properties, and values.
4. Review diagnostics in the editor or open **CIM Issues** to navigate the file's issues.
5. To validate references across multiple files, select the set with **Validate together** or configure the **Dataset**.

You can also create a new file using the **CGMES: New CIM/XML instance file** command, which prepares a header and namespaces for the chosen profile.

## Adapting to other schemas

In addition to the included profiles, you can point the `cgmes.schemaFolders` setting to folders containing RDFS definitions and, optionally, SHACL `.ttl` files. The `cgmes.crossFile.extraFolders` setting lets you include other folders in cross-file checks.

## Scope of checks

The extension covers checks that are useful during editing, but it does not replace all model validation tools. SPARQL-based SHACL rules are not executed; cross-file checks focus on identifier resolution and class compatibility, not full semantic validation of all relationships.

## Learn more

- [Technical README](./README.md): installation, settings, commands, and implementation details.
- [Feature catalog](./FEATURES.md): more detail on the rules and checks covered.
