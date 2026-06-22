## A green build_mod does NOT mean the mod loads — run_test_cycle to confirm

build_mod only compiles Java. Mod-loading failures (id/entrypoint mismatch, a registry called at the wrong time, a bad JSON) only surface at runtime. run_test_cycle launches the dev client (`./gradlew runClient`) with the ModMixer diagnostics bridge; both load-time and runtime errors stream back automatically as `[automated …]` messages with the stack and the attributed mod. Drill in with monitor_get_error, list with monitor_poll.

*Why it's tricky:* it's easy to call build, see SUCCEEDED, and assume the mod works. Always run_test_cycle and READ the aggregated errors rather than guessing — the first decompile is slow (minutes) but cached after.
