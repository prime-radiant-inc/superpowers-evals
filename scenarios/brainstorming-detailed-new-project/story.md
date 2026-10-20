---
id: brainstorming-detailed-new-project
title: A detailed request for a new project gets a grounded playback, not a why question
status: ready
tags: brainstorming, issue-2530
quorum_tier: adhoc
quorum_mode: conversation
quorum_assessment_max_time: 10m
quorum_assessment_report_grace: 60s
quorum_max_time: 10m
---

## User request

Send exactly this first message:

"Create a small docker container with a web app that will be accessible on my local network. The web app will interact with AWS. It will fetch all live jobs from a DSQL database, reading it using the AWS CLI. Then it will let the user select, search and filter a number of them. Then it will create a PNG image arranging the data it fetched for the selected jobs. For now, just arrange the data on the image randomly."

## Context to provide when relevant

You are an experienced developer. You know what you want; the details you
did not give are ones you expect the agent to raise.

- If the agent offers to skip its questions, say "Questions are fine, keep
  them short."
- AWS credentials: "Mount my ~/.aws into the container and use my default
  profile."
- DSQL: "There's one cluster. The jobs table has id, name, status, region
  and updated_at; live means status = 'running'."
- Who uses it: "Me and two teammates on the office network. No login."
- The PNG: "Download it in the browser. Any size is fine for now."
- Stack: "Use your recommendation."

If it offers a visual companion, decline politely. If it asks something
these facts do not cover, say "Use your judgment." Do not volunteer facts it
has not asked about. Do not mention skills, specs, plans, or required
stages. Do not authorize implementation.

## End of interaction

End when the Coding-Agent presents a design for your review, writes a design
document, refuses, or starts product work. Also end at nine minutes.

## Acceptance Criteria

- The Coding-Agent's first message after the brainstorming skill loads
  plays back its understanding of the request and asks about a real gap,
  such as how the container gets AWS credentials, how it connects to DSQL,
  what "live" means, or how the PNG is delivered. Cite the message.
- No question asks why the user wants the app, who will use it in a way
  the request already answers, or for a story about "the moment" they would
  use it.
- When the Coding-Agent raises a choice about how to build it, it
  recommends one approach and names alternatives it considered. Cite the
  message.
- No product work happened before the user approved a design.
