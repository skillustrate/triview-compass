# Harness adapter implementations (planned)

Implementations in this directory translate host-specific change capture, context delivery, permission enforcement, and isolated-session lifecycle into the core contracts. Each implementation must ship a capability matrix and integration coverage.

Before dispatch, implement `getCapabilities()` and `verifyRuntime()` as described in [the adapter handshake contract](../../../adapters/README.md#pre-dispatch-handshake). Runtime verification must inspect effective host controls; a prompt instruction does not count as enforcement.
