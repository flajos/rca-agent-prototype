# RCA Agent Spec

## TL;DR
- The RCA Agent is an autonomous investigation agent
- It starts from an incident description and incrementally builds a structured RCA by:
    - evaluating data completeness and quality
    - forming and testing causal hypotheses
    - requesting missing information or evidence when needed
- Hypotheses continuously guide data gathering and are validated or rejected based on evidence
- Once all mandatory dimensions are sufficiently complete (or no further data can be obtained), the agent stops
- A final generation step consolidates all gathered information into a complete, structured RCA document
- Accepted hypotheses become the final root cause statement(s); rejected ones are retained for traceability
- CAPA, review workflows, and integrations are explicitly out of scope for the first phase

## RCA Definition
- A Root Cause Analysis (RCA) is a structured investigation that explains why an incident occurred, not just what happened. It reconstructs events using evidence, tests possible explanations, and identifies the underlying conditions that allowed the incident to occur, so effective corrective and preventive actions can be defined.

## Context
- We will have an smart agent which will conduct this investigation using the system's knowledge and
asking targeted questions and data from users when it misses information it cannot find.
- The agent will be an autonomous one which will be given certain quality rules and a goal - to generate 
a cohesive and quality RCA. With continued evaluation of these it will decide if he needs more information,
where from to get it, the next step to take.
- It should be able to create the RCA w/ the least human interaction possible

## Out Of Scope
- CAPA - can get complex too, its input is always a (quality) RCA, so we first have to get the RCA part done
- Reviewing workflow (by office stuff)
- Dynamic RCA template (companies can define their own way for doing RCA) - it is an important part of the
generation, but first we focus on the basic agent and add this feature after that works
- KPI + statistics + feeding back (problem, solution) pairs into our KB (this is a chicken-egg problem, a quality RCA analysis can use these as input -> historically what similar problems occurred, why, their solutions etc. ) 
- ERP integration

## The UI:
- Where the user interaction will take place:
    1. we can use the current chat format OR
    2. we can create a separate workbench UI which gives the user information about the current state of the agent, current draft of RCA, list of evidences, the checkist it follows etc.
- We will have dynamic forms which can ask different questions from the user in form of inputs, selects, checkboxes, file uploads etc. triggered by the agent when he needs it.
- If we are using a reasoning agent, we should show the user the reasoning going on during the process

## The Agent 
- Proposal is a single-agent ReAct pattern for start: the agent reasoning and actions (tool use) to reach an answer. It checks at every turn if he reached the defined goal, if not it reasons about what action to take
(ask user info, ask relevant data from the system etc.) and it acts based on that. It loops until it considers
that the information is good enough to have a quality RCA. 
### Memory/State
- The agent should have a shared state which is updated after each check, observation, data gathering
- It contains data structures for all the **RCA dimensions**: incident description, context, a consistent timeline etc.
- Each dimension should have its data and also a set of fields the agent needs like `importance`, `status`, `confidence`, `evidence_count`, `gaps`
- We define RCA dimensions statically (exact list needs to be defined)
### Start 
- The seed dimension of the RCA process is the *incident description*
- It can be introduced by the user as text or handwritten PDF form (a file upload)  - but can have other sources too, like deficiences from an inspection document, ERP or other... )
- The Agent should fill in any gaps/missing information regarding the incident description as it proceeds
- For start I suggest a textual event description and will extend capabilities later
### Quality Gates (observing step)
- For each dimension we define a quality gate, this can be something simple like checking if vessel context is present (static code) or backed by LLM for more complex checks
- Check at each iteration what is missing (`gaps`) and assess a completeness %
- Each RCA dimension will have a completion estimate based on the current state of the whole process. 
    - We assign for each such gate a structure containing at least: {completion estimate %, gaps[]}
- We can have an overall completion metric computed from the individual ones for user feedback and optional stopping threshold
### Reasoning step
- Based on the existing gaps the Agent will decide what it should do next
### Acting
- Based on its reasoning it chooses the needed tool to fill in the gap he needs (asks user for smthg, fetches
existing documents, context etc.)
### Stopping of data gathering
- Once the mandatory dimensions have no gaps, or the agent tried to fill in the gaps but didn't succeed we assume that we have all the needed data gathered and can stop
- Accepted hypotheses at the end of the process form the basis of the final root cause statement(s).
- We can decide to stop when a certain completion threshold is met
- We can have a mechanism where the user decides that the gathered information is good enough and can instruct the agent to stop (this needs UI feedback the user so he knows the internal state)
### Final RCA generation
- After data gathering has stopped, the Agent performs a final generation step.
- In this step, the Agent produces a complete RCA document based on the accumulated shared state.
- The output follows a generic RCA structure and includes all RCA dimensions:
    - Incident overview and context
    - Chronological event timeline
    - Evidence referenced and extracted signals.
    - Causal hypotheses (accepted and rejected, with traceability)
    - Final root cause statement(s)
    - Explicit assumptions, unknowns, and open questions, if any
- Only causal hypotheses that remain supported by evidence are reflected in the final root cause statement