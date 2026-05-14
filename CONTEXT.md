# Canonical domain vocabulary

Add your project's domain types, aggregates, value objects, and their definitions here.

The Sandcastle reviewer reads this file as the source of truth for nomenclature binding (see [docs/principles/domain-modeling.md](docs/principles/domain-modeling.md)) — every type / table / file path / UI label in new code must use these exact names. Synonyms are flagged as findings.

Until this file is populated, the nomenclature-binding check is a no-op.

## Format

Each domain concept gets its own heading and a one-paragraph definition. Cross-link to related concepts. When relationships have their own attributes, model them as reified associations (see domain-modeling.md).

```markdown
## ConceptName

One-paragraph definition. What is it, what invariants does it carry, what does it relate to.

## OtherConcept

...
```
