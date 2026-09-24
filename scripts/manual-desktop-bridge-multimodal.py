#!/usr/bin/env python3
"""Manually exercise the desktop bridge's managed image/audio agent/run path.

Compile the sidecar first: bun run --cwd packages/desktop-bridge compile
Run: python3 scripts/manual-desktop-bridge-multimodal.py --sidecar packages/desktop-bridge/dist/agent-runtime
Use --handshake-only to check the executable without making a model request.
"""

import argparse
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import threading
import uuid
from pathlib import Path


GOAL = "Extract text from image and transcribe the audio - provide word count for both"


def stage(source, kind, root):
    source = source.expanduser().resolve(strict=True)
    if not source.is_file():
        raise ValueError(f"Not a regular file: {source}")
    attachment_id = str(uuid.uuid4())
    destination = root / attachment_id / source.name
    destination.parent.mkdir()
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as src, destination.open("xb") as dst:
        while chunk := src.read(1024 * 1024):
            dst.write(chunk)
            digest.update(chunk)
            size += len(chunk)
    if size > 10 * 1024 * 1024:
        raise ValueError(f"Desktop attachment exceeds 10 MiB: {source}")
    result = {
        "attachmentId": attachment_id,
        "kind": kind,
        "stagedRelativePath": f"{attachment_id}/{source.name}",
        "name": source.name,
        "sizeBytes": size,
        "sha256": digest.hexdigest(),
    }
    mime_type, _ = mimetypes.guess_type(source.name)
    if mime_type:
        result["mimeType"] = mime_type
    if kind == "audio":
        result["audioFormat"] = "mp3"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecar", required=True, type=Path, help="Compiled desktop-bridge agent-runtime binary")
    parser.add_argument("--cwd", type=Path, default=Path("~/coding"))
    parser.add_argument("--image", type=Path, default=Path("/Users/ugmurthy/Desktop/quit-message.png"))
    parser.add_argument("--audio", type=Path, default=Path("/Users/ugmurthy/Downloads/sample.mp3"))
    parser.add_argument("--settings", type=Path, help="Override the settings file discovered from --cwd")
    parser.add_argument("--handshake-only", action="store_true", help="Check JSON-RPC protocol without a model call")
    args = parser.parse_args()
    sidecar = args.sidecar.expanduser().resolve(strict=True)
    cwd = args.cwd.expanduser().resolve(strict=True)

    with tempfile.TemporaryDirectory(prefix="desktop-bridge-attachments-") as directory:
        root = Path(directory).resolve()
        child = subprocess.Popen(
            [str(sidecar)], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )

        def diagnostics():
            for line in child.stderr:
                print(line, end="", file=sys.stderr)

        threading.Thread(target=diagnostics, daemon=True).start()

        def request(request_id, method, params=None):
            message = {"jsonrpc": "2.0", "id": request_id, "method": method}
            if params is not None:
                message["params"] = params
            child.stdin.write(json.dumps(message) + "\n")
            child.stdin.flush()
            for line in child.stdout:
                response = json.loads(line)
                if response.get("method") == "agent/event":
                    print(json.dumps(response["params"], ensure_ascii=False), file=sys.stderr)
                elif response.get("method") == "runtime/ready":
                    print(f"Bridge ready: protocol {response['params']['protocolVersion']}", file=sys.stderr)
                elif response.get("id") == request_id:
                    if "error" in response:
                        raise RuntimeError(f"{method}: {response['error']}")
                    return response["result"]
            raise RuntimeError(f"Bridge exited before responding to {method} (status {child.poll()})")

        try:
            hello = request("hello", "initialize", {
                "protocolVersion": "1.19", "clientInfo": {"name": "manual-multimodal-check"},
            })
            print(f"Negotiated protocol {hello['protocolVersion']}", file=sys.stderr)
            if args.handshake_only:
                return 0

            attachments = [stage(args.image, "image", root), stage(args.audio, "audio", root)]
            # agent/run has no per-run --enhance flag. Use an isolated copy of the
            # same settings with preparation disabled; never edit the user's file.
            settings_source = args.settings or os.environ.get("ADAPTIVE_AGENT_SETTINGS")
            if settings_source:
                settings_source = Path(settings_source).expanduser()
                if not settings_source.is_absolute():
                    settings_source = cwd / settings_source
                settings_source = settings_source.resolve(strict=True)
            else:
                candidates = (cwd / "agent.settings.json", Path(os.environ.get("ADAPTIVE_AGENT_HOME", "~/.adaptiveAgent")).expanduser() / "agent.settings.json")
                settings_source = next((path for path in candidates if path.is_file()), None)
            init_params = {"cwd": str(cwd), "managedAttachmentRoot": str(root)}
            if settings_source:
                settings = json.loads(settings_source.read_text())
                settings.setdefault("taskPreparation", {})["mode"] = "never"
                isolated_settings = root / "agent.settings.json"
                isolated_settings.write_text(json.dumps(settings))
                init_params["settingsConfigPath"] = str(isolated_settings)
            initialized = request("runtime", "runtime/initialize", {
                **init_params,
            })
            mode = initialized.get("resolvedConfiguration", {}).get("taskPreparation", {}).get("mode")
            if mode != "never":
                raise RuntimeError(f"Resolved task preparation is {mode!r}, not --enhance never; refusing to run")
            print(f"Runtime initialized: agent={initialized['agent']['id']}, workspace={initialized['workspaceRoot']}", file=sys.stderr)
            result = request("run", "agent/run", {
                "executionId": str(uuid.uuid4()), "goal": GOAL, "attachments": attachments,
            })
            print(json.dumps(result, indent=2))
            return 0 if result.get("status") == "success" else 1
        finally:
            if child.poll() is None:
                child.stdin.close()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    child.wait(timeout=5)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"desktop-bridge check failed: {error}", file=sys.stderr)
        sys.exit(1)
