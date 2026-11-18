# Prompts

`system.base.v1` is the running customer prompt (`PROMPT_VERSION`). New `agent_runs` rows store that version in `skill`, and the model label also includes it. Reasoning stays private.

The prompt allows eligible cash on delivery and an existing wallet balance. It says online payment and maps are coming soon, and that wallet top-ups, subscriptions and recipes are unavailable. "My usual" must use the history tool and `place_order` after the customer agrees. `place_order` obtains the checkout quote; there is no separate quote tool.

Prompt changes are not release approval. Live checks so far cover one synthetic usual order, one cancellation card and one wallet-top-up refusal.
