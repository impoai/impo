"""Drive the gadget SDK's own LinkSession against a local `wrangler dev` gateway.

Only the transport URL scheme differs from production (ws:// instead of wss://),
through the `connect` hook LinkSession already exposes.
"""

import asyncio
import json
import sys
import urllib.request

from websockets.asyncio.client import connect as ws_connect

from impogadget import impo_api
from impogadget.executor import COMMAND_SPECS, Account, Executor
from impogadget.link_client import DeviceDescription, LinkSession, Outcome

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8799"
ADMIN = sys.argv[2] if len(sys.argv) > 2 else "local-admin"
VM = "e2e-check"


def admin(method, path, body=None):
    req = urllib.request.Request(
        f"{BASE}/admin/vms/{VM}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {ADMIN}", "Content-Type": "application/json",
                 "User-Agent": "impo-gateway-e2e"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def check(label, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + label, detail, flush=True)
    if not condition:
        raise SystemExit(1)


async def main():
    status, minted = await asyncio.to_thread(admin, "POST", "/pairings", {"label": "local e2e"})
    check("admin mints a pairing", status == 201, minted["pairing_id"])
    pairing = minted["pairing"]

    vms, status = impo_api.fetch_vms_with_status(pairing["access_token"], BASE)
    check("SDK fetch_vms", status == 200 and len(vms) == 1, vms[0]["vm_id"])
    bad, status = impo_api.fetch_vms_with_status("garbage", BASE)
    check("fetch_vms rejects a bad token", status == 401 and not bad)

    tokens, status = impo_api.refresh_device_token(pairing["refresh_token"], "homelink-e2e000", BASE)
    check("SDK token refresh", status == 200 and tokens and tokens["access_token"])

    async def connect(url, headers):
        return await ws_connect(url if BASE.startswith("https") else url.replace("wss://", "ws://"), additional_headers=headers, max_size=None)

    def session(node_id, bearer):
        return LinkSession(
            noise_host=BASE.split("://")[1], vm_id=vms[0]["vm_id"], vm_auth_token=bearer,
            device=DeviceDescription(node_id=node_id, display_name="e2e", version="0.1.0", commands=COMMAND_SPECS),
            run_command=Executor(Account.current()).run, connect=connect,
        )

    rejected = False
    try:
        await session("homelink-e2e000", "garbage").run(asyncio.Event())
    except Exception as exc:
        rejected = "401" in str(exc)
    check("gateway refuses a bad VM bearer", rejected)

    link = session("homelink-e2e000", vms[0]["vm_auth_token"])
    stop = asyncio.Event()
    running = asyncio.ensure_future(link.run(stop))
    for _ in range(100):
        if link.registered_at or running.done():
            break
        await asyncio.sleep(0.05)
    check("SDK LinkSession registers", link.registered_at is not None)

    status, result = await asyncio.to_thread(
        admin, "POST", "/invoke", {"command": "system.run", "params": {"command": "echo hello-from-gadget"}})
    check("invoke system.run", status == 200 and result.get("payload", {}).get("stdout") == "hello-from-gadget\n",
          json.dumps(result)[:160])

    big = "x" * 90000  # result spans more than one Noise chunk
    status, result = await asyncio.to_thread(
        admin, "POST", "/invoke", {"command": "system.run", "params": {"command": f"printf %s {big}"}})
    check("invoke with a multi-chunk result", result.get("payload", {}).get("stdout") == big)

    results = await asyncio.gather(*[
        asyncio.to_thread(admin, "POST", "/invoke", {"command": "system.run", "params": {"command": f"echo {i}"}})
        for i in range(8)
    ])
    check("concurrent invokes keep their results apart",
          [r[1].get("payload", {}).get("stdout") for r in results] == [f"{i}\n" for i in range(8)])

    status, result = await asyncio.to_thread(admin, "POST", "/invoke", {"command": "nope"})
    check("unsupported command reports an error", result.get("ok") is False, json.dumps(result)[:120])

    chat = await link.send_chat("the backup finished", "backups")
    check("device chat is acknowledged", chat["ok"] and chat["response"].get("message_id"))

    status, state = await asyncio.to_thread(admin, "GET", "")
    device = state["devices"][0]
    check("state lists the online gadget", device["online"] and "system.run" in device["commands"])
    check("state holds the chat message",
          state["chat"][-1]["message"] == "the backup finished" and state["chat"][-1]["session_id"] == "backups")

    status, _ = await asyncio.to_thread(admin, "DELETE", f"/pairings/{minted['pairing_id']}")
    outcome = await asyncio.wait_for(running, 10)
    check("unpairing ends the session", status == 200 and outcome is Outcome.UNPAIRED, outcome.value)

    _, status = impo_api.fetch_vms_with_status(pairing["access_token"], BASE)
    check("unpaired token is rejected", status == 401)
    status, result = await asyncio.to_thread(admin, "POST", "/invoke", {"command": "device.health"})
    check("invoke after unpair reports offline", status == 409 and result["error"] == "device_offline")
    print("ALL CHECKS PASSED")


asyncio.run(main())
