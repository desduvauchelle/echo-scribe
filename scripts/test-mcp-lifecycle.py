#!/usr/bin/env python3
"""Exercise a real MCP executable with isolated data; never touch user captures."""
import json
import os
import subprocess
import sys
import tempfile

binary = sys.argv[1]
requests = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "ping"},
]
for payload in ("", "\n".join(map(json.dumps, requests)) + "\n"):
    with tempfile.TemporaryDirectory(prefix="tucky-mcp-test-") as directory:
        result = subprocess.run(
            [binary, "--mcp"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ, "ECHO_SCRIBE_MCP_DB": directory + "/test.sqlite"},
        )
        assert result.returncode == 0, result.stderr
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        if payload:
            assert [response["id"] for response in responses] == [1, 2], responses
            assert "result" in responses[0] and "result" in responses[1], responses
        else:
            assert not responses, responses
print("MCP initialize, notification, ping, and exit on closed input passed.")
