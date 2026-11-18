# Assistant runbook

The owner enabled `agent_enabled` in the AWS development database and `AGENT_ENABLED` on the local customer server for testing. Migrations `050`–`053`, checkpoint tables and runtime grants are present there. This does not approve a production rollout; the Expo Go walkthrough, native push and broader verification remain outstanding. See the latest section of the root `progress.md`.

To stop the assistant without an app release, turn off the `agent_enabled` feature flag. New runs then fail the permission check. A job that already passed that check can still finish its current transaction.

If a worker stops, expired jobs are marked failed and are not replayed. The original worker must own its exact unexpired job lease to begin a protected commit. Stop waits for an already-locked transaction, so an order committed first stays placed. Check `agent_jobs` and `agent_runs` for rows left `running` only after confirming the worker is down.

Notifications use generic text and do not include the customer's message. Push delivery is not verified in Expo Go. Do not start a native or EAS build without the owner's approval.

Provider errors are logged as a code and error name, not the provider body. A classified HTTP 429 becomes `RATE_LIMITED`.

`tool_ms` sums tool-handler durations and can overlap; `db_ms` is only the final message-commit transaction. `model_ms` is intentionally empty until provider calls are measured directly. These fields do not yet explain all response latency.
