# Synthetic RCA Case 02 – Steering Gear Loss of Control (Near Grounding)

This is a *harder* synthetic dataset designed to stress-test:
- evidence contradiction detection
- timestamp normalization (UTC vs Ship's LT)
- missing/partial data handling (incomplete VDR)
- multi-cause analysis (technical + human + organizational)

## Scenario summary
- Vessel experienced intermittent steering failure during coastal transit.
- Temporary loss of heading control led to near grounding; tug assistance not required.
- Evidence includes contradictory crew statements and misaligned timestamps.

## Key difficulty features
- Bridge log in LT, ECDIS track export in UTC.
- VDR transcript is partial (gap during critical minute).
- OCR-like errors in scanned checklist text.
- Conflicting narratives: "hydraulic pressure alarm" vs "no alarms".

## Folder guide
- /documents: evidence inputs for ingestion/RAG
- /manual_inputs: information the investigator would request manually
- /gold_standard_rca: reference RCA outcome for regression checks
- /metadata: mapping IDs and known contradictions (for evaluation harness)
