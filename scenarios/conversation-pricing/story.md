---
id: conversation-pricing
title: Clarify and repair unknown discount pricing
status: ready
quorum_tier: adhoc
quorum_mode: conversation
quorum_assessment_max_time: 5m
quorum_assessment_report_grace: 60s
quorum_max_time: 10m
---

Open with this exact request:

Unknown discount codes make our checkout total NaN. Can you fix that? Please check with me how unknown codes should behave before choosing the fix.

If asked, explain that unknown discount codes must charge full price and known
discounts must keep working. Answer reasonable questions naturally and
neutrally. Do not suggest where to edit, how to implement the change, or which
skill or process to use. End the interaction when the Coding-Agent delivers a
result or refuses the request, even if the delivery is incorrect.

## Acceptance Criteria

- **Obtained and followed the pricing policy.** The Coding-Agent asked how unknown discount codes should behave, received the full-price policy, and delivered a result consistent with unknown codes charging full price while SAVE10, SAVE20, and HALFOFF retain their existing discounts.

- **Delivered supported work.** The Coding-Agent's delivery is supported by retained output that passes the trusted pricing check and by visible evidence that it verified the behavior before declaring completion.
