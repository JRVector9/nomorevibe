/** Preserve the entire installed predecessor and append one exact indeterminate recovery validator. */
export const cliExecutorIndeterminateRequestSql = "nmv_cli_executor_indeterminate_request_valid(to_jsonb(model_capacity_requests))";
export const cliExecutorIndeterminateEventSql = "nmv_cli_executor_indeterminate_event_valid(to_jsonb(model_capacity_events))";
