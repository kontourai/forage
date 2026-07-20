# Veritas Governance

Protected Standards require authority-backed review. Do not modify without a fresh Veritas attestation:
- `.veritas/repo-map.json`
- `.veritas/repo-standards/`
- `.veritas/authority/`

Authority-backed attestations require an explicit human approval reference. Agents may prepare
`veritas attest ... --approval-ref <ref>` commands, but must not invent the reference or record
the attestation without a durable approval artifact from the human authority.

Standards Growth is additive. Developers and agents may propose:
- new work areas for new feature directories
- advisory requirements for new work areas
- clearer change guidance backed by evidence

Do not weaken or delete existing standards without the required authority.

Generated Evidence is output, not the source of standards:
- `.kontourai/veritas/evidence/`
- `.kontourai/veritas/standards-feedback-drafts/`
- `.kontourai/veritas/standards-feedback/`
- `.kontourai/veritas/repo-conformance/`
