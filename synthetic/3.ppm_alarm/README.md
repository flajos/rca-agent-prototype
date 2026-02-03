# Synthetic RCA Case 03 – Oily Water Discharge Alarm Bypass (MARPOL-related)

This is a *harder* synthetic dataset designed to stress-test:
- regulatory mapping (MARPOL Annex I / OWS/ODMCS expectations)
- intent vs error differentiation (bypass vs malfunction)
- incomplete/missing evidence handling
- role/responsibility and organizational control failures
- multilingual crew statement snippet + terminology ambiguity

## Scenario summary
- During port stay, an oily water separator (OWS) discharge exceeded limits.
- Overboard valve was found in an unexpected configuration.
- Evidence is incomplete: missing pages from Oil Record Book and missing CCTV clip.
- Conflicting accounts exist regarding training, supervision, and equipment condition.

## Folder guide
- /documents: evidence inputs for ingestion/RAG
- /manual_inputs: investigation requests / forms
- /gold_standard_rca: reference RCA outcome
- /metadata: regulation pointers and known gaps
