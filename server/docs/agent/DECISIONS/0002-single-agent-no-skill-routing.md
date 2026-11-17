# Single agent without skill routing

- `AGENT_ROUTING` stays declared but unused: one agent holds all tools (13 reads/writes + 3 confirmation tools) instead of per-skill routers.
- Reasons: three "skills" (shopping, order support, subscriptions — the last disabled) would each need their own prompt/route with a cheap routing model call per turn; with ~16 tools the routing benefit was unproven and the failure mode (misroutes) is worse than a slightly larger tool list.
- `agent_runs.skill` stays null while there is no routing. Revisit if live evaluations show tool confusion on either model; the `SkillDefinition` shape from the spec makes the split mechanical if needed.
- Token-bounded history uses the LangChain `trimMessages` window (`agent_history_max_tokens`) in a `wrapModelCall` middleware instead of a router; operator system notes ride the system message so trimming cannot drop them.
