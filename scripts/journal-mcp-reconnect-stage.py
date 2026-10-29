"""Unbound post-install MCP reconnect preparation; no executable entry point."""
import copy

EXPECTED_GENERATION = "e93878d682900a6292aeeeca23d3fc4c3d280cdf1cd7bee2cc8c89802f539f7f"
EXPECTED_SERVER_SHA256 = "d669a11c904598a6c23221a3c16f9a2f797a006530c43ba26f251aa44b41323e"


def run():
    # Replace only after the signed delivery, source receipt, verifier closure,
    # disposable session and exact installed B route have independent admission.
    raise RuntimeError("Fresh signed delivery and source-bound reconnect admission are not available")


def _exercise(fixture, mcp, observe):
    """Internal sequence for testing only; observations are not acceptance evidence.

    A future caller must first independently bind the exact fixture type, route,
    signed inventory, verifier, observer, source and disposable session. This
    helper deliberately does not provide or imply that admission.
    """
    if fixture.connection is not None or fixture.started or fixture.closed:
        raise RuntimeError("Fresh unused fixture required")
    if fixture.route.server.parent.name != "server" or EXPECTED_GENERATION not in fixture.route.server.parts:
        raise RuntimeError("Exact B server generation required")
    if fixture.route.binding["resourceFiles"]["mcp/server/creator-works-mcp.mjs"] != EXPECTED_SERVER_SHA256:
        raise RuntimeError("Exact B server bytes required")
    before = copy.deepcopy(fixture._preserved())
    fixture.started = True  # A failed or uncertain launch is never retried.
    observations, records = [], []
    for name in ("existing", "reconnect"):
        fixture.route.recheck()
        if fixture._preserved() != before:
            raise RuntimeError("Protected files changed")
        connection = fixture._new(name)
        if connection.handshake != {"ready": True, "server": mcp.SERVER}:
            raise RuntimeError("Actual SDK handshake required")
        original_router, original_sdk = copy.deepcopy(connection.runtime_identity), copy.deepcopy(connection.child_identity)
        if records and (original_router["pid"] == records[0]["router"]["pid"] or
                        original_sdk["pid"] == records[0]["sdk"]["pid"]):
            raise RuntimeError("Reconnect requires distinct processes")
        protocol = connection.check()
        mcp._protocol(protocol, 2)
        connection.alive()
        mcp.same_process(original_router, connection.native.native_process(connection.runtime.pid, fixture.helper))
        mcp.same_process(original_sdk, connection.native.native_process(connection.child.pid, fixture.helper))
        observations.append(observe(connection, name))
        connection.alive()
        mcp.same_process(original_router, connection.native.native_process(connection.runtime.pid, fixture.helper))
        mcp.same_process(original_sdk, connection.native.native_process(connection.child.pid, fixture.helper))
        fixture.route.recheck()
        if fixture._preserved() != before:
            raise RuntimeError("Protected files changed")
        connection.close()  # Existing SDK implementation requires normal EOF and zero exits.
        fixture.route.recheck()
        if fixture._preserved() != before:
            raise RuntimeError("Protected files changed")
        records.append({"name": name, "handshake": copy.deepcopy(connection.handshake),
                        "protocol": copy.deepcopy(protocol), "router": original_router, "sdk": original_sdk})
    fixture.closed = True
    return {"scope": "post-install-reconnect-unverified", "records": records, "observations": observations,
            "signaturesVerifiedHere": False, "sourceAdmissionVerified": False,
            "nativeReconnectAccepted": False, "transitionAccepted": False, "releaseReady": False}
