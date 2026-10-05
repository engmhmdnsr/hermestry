"""On-device extras for Hermes Mobile (vc77, limits in vc86).

Routes the mobile app expects that the stock api_server does not serve:
  GET  /api/memory                      status {enabled, provider, active, summary, entries}
  POST /api/memory/toggle {enabled}     persisted switch (config.yaml memory.memory_enabled)
  GET  /api/memory                      also reports memory_char_limit, user_char_limit,
                                        memory_size, user_size (MEMORY.md / USER.md bytes)
  POST /api/memory/limits {memory_char_limit?, user_char_limit?}
                                        resize the builtin memory budgets (config.yaml memory.*)
  GET  /api/blueprints                  routine catalog mapped to the app Blueprint shape
  POST /api/blueprints/{id}/instantiate {slots}  fill slots + create a cron job
  GET  /api/doctor                     health rows for the Settings diagnostics card
  POST /api/backup                     write a chat/job/config snapshot under <home>/snapshots
  POST /api/debug/share                write a scrubbed gateway.log+service.log bundle

Auth is enforced by the server's global middleware, same as the sibling
/api/jobs routes: handlers here do not self-auth, mirroring api_server_runs.
All heavy imports stay inside handlers so a missing optional dependency
degrades to an honest 5xx instead of breaking server boot.
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any


def _home_dir() -> str:
    from hermes_constants import get_hermes_home

    return str(get_hermes_home())


def _write_yaml_atomic(cfg_path: str, yaml: Any, cfg: dict) -> None:
    # Crash-safe config write: a kill between open("w") and dump used to
    # leave config.yaml truncated, and the gateway would not boot. Write
    # to a sibling temp file, flush it to disk, then atomically replace.
    tmp_path = cfg_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        yaml.dump(cfg, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, cfg_path)


def _projects_dir() -> str:
    path = os.path.join(_home_dir(), ".projects")
    os.makedirs(path, exist_ok=True)
    return path


def _valid_project_id(raw: Any) -> str:
    pid = str(raw or "").strip()
    if not pid or len(pid) > 64:
        raise ValueError("bad project id")
    if not all(c.isascii() and (c.isalnum() or c in "-_") for c in pid):
        raise ValueError("bad project id")
    return pid


def _resolve_host_path(raw: Any) -> str:
    # Primary internal storage only: SAF tree URIs from other volumes have
    # no stable host path the gateway can follow.
    want = os.path.realpath(str(raw or ""))
    root = os.path.realpath("/storage/emulated/0")
    if not want or want != root and not want.startswith(root + os.sep):
        raise ValueError("only folders on internal storage are supported")
    if not os.path.isdir(want):
        raise ValueError("folder not found on this device")
    if not os.access(want, os.R_OK | os.X_OK):
        raise ValueError("cannot read that folder on this device")
    return want


# Desktop parity (config_env._CREDENTIAL_PROBES): env var -> (probe URL, auth style).
_CRED_PROBES: dict[str, tuple[str, str]] = {
    "OPENROUTER_API_KEY": ("https://openrouter.ai/api/v1/key", "bearer"),
    "OPENAI_API_KEY": ("https://api.openai.com/v1/models", "bearer"),
    "XAI_API_KEY": ("https://api.x.ai/v1/models", "bearer"),
    "GEMINI_API_KEY": ("https://generativelanguage.googleapis.com/v1beta/models", "query"),
    "HERMES_API_KEY": ("https://api.openai.com/v1/models", "bearer"),
    "ANTHROPIC_API_KEY": ("https://api.anthropic.com/v1/models", "bearer"),
}


def _model_ids(payload: Any) -> list[str]:
    ids: list[str] = []
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                ids.append(entry["id"])
    return ids


def _safe_ids(resp: Any) -> list[str]:
    try:
        return _model_ids(resp.json())
    except Exception:
        return []


async def _custom_base_policy(base_url: str) -> str | None:
    """Return an error message if a custom provider base URL is not allowed.

    Policy (HERMES-01): https only, public hosts only. Loopback,
    private, link-local, multicast, reserved, and unspecified addresses
    are rejected, whether written as a literal IP or resolved via DNS.
    The credential is only ever sent after this check passes, and the
    probe below never follows redirects, so the key cannot leak to a
    redirect target or an internal service.
    """
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(base_url)
    except Exception:
        return "That URL is not valid."
    if parts.scheme.lower() != "https":
        return "Custom endpoints must use https://."
    host = (parts.hostname or "").strip().rstrip(".")
    if not host:
        return "That URL has no host."
    try:
        import asyncio
        import ipaddress
        import socket

        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        addrs: list[str] = [str(literal)] if literal is not None else []
        if literal is None:
            try:
                infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            except Exception:
                return "Could not resolve %s." % host
            addrs = list({info[4][0] for info in infos})
            if not addrs:
                return "Could not resolve %s." % host
        for addr in addrs:
            try:
                ip = ipaddress.ip_address(addr)
            except ValueError:
                return "Could not validate %s." % host
            if not ip.is_global:
                return "Private and local addresses are not allowed."
    except Exception:
        return "Could not validate %s." % host
    return None


# Key names whose VALUE is a credential. Matched case-insensitively against a
# normalized form of the key so api_key, apiKey, API-KEY and apiKey all hit.
_SECRET_KEY_PARTS = (
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "cookie",
    "credential",
)

# Keys that contain a secret-ish word but never hold a credential. Without this
# the scrubber would eat harmless fields and quietly break the backup (a
# stripped 'monkey' or 'keybindings' value is data loss, not redaction).
_SECRET_KEY_ALLOWLIST = frozenset(
    {
        "keybindings",
        "keyboard",
        "keywords",
        "keys",
        "hotkey",
        "hotkeys",
        "turbo",
        "monkey",
        "donkey",
        "hockey",
        "keychain",
        "keystore_alias",
        "public_key",
        "publickey",
        "key_id",
        "keyid",
    }
)

_REDACTED = "[redacted]"


def _normalize_key(key: object) -> str:
    """Fold a config key to a comparable shape: lowercase, separators removed."""
    return "".join(ch for ch in str(key).lower() if ch.isalnum())


def _is_secret_key(key: object) -> bool:
    """True when this mapping key names a credential, not ordinary config."""
    norm = _normalize_key(key)
    if not norm:
        return False
    if norm in _SECRET_KEY_ALLOWLIST:
        return False
    return any(part in norm for part in _SECRET_KEY_PARTS)


def sanitize_secrets(value: Any, _depth: int = 0) -> Any:
    """Return a copy of ``value`` with credential values replaced.

    Recurses through dicts, lists, tuples and sets so a secret nested at any
    depth is removed, not just one sitting at the top level. A scalar is
    returned unchanged, so the walk is total and cannot raise on a config shape
    it has not seen. The input is never mutated: callers hand this the live
    config and keep using it afterwards.

    Redacted keys are kept rather than dropped, with their value replaced, so a
    reader can still see that the field existed and was withheld. A removed key
    would look the same as a field the app never had.

    Depth is bounded so a self-referential structure cannot spin forever. The
    bound is far deeper than any real config nests, and anything past it is
    replaced wholesale rather than walked.
    """
    if _depth > 64:
        return _REDACTED
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        for key, item in value.items():
            if _is_secret_key(key):
                out[key] = _REDACTED if item is not None else None
            else:
                out[key] = sanitize_secrets(item, _depth + 1)
        return out
    if isinstance(value, list):
        return [sanitize_secrets(item, _depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_secrets(item, _depth + 1) for item in value)
    if isinstance(value, set):
        return {sanitize_secrets(item, _depth + 1) for item in value}
    return value


# Credential shapes, compiled as a list of independent patterns rather than one
# big alternation. Two reasons, both learned the hard way:
#
#   1. Python numbers capture groups positionally across the WHOLE pattern, so
#      a single "a|b" chain makes group 1 belong to whichever branch came first,
#      not the branch that matched. Reading group(1) then returns None for a
#      secret and crashes the redaction mid-file.
#   2. Python also refuses to reuse a group NAME across alternation branches.
#
# Compiled one per pattern, each pattern's groups mean what they say: an
# optional group 1 is the prefix to keep, group 2 is the value to drop. A
# pattern with no groups is a secret that identifies itself and is replaced
# whole.
#
# Prefix/value pairs -- group 1 kept, group 2 replaced with [redacted]:
_SECRET_PAIR_PATTERNS = (
    # Authorization header, with or without a scheme
    r"((?:authorization|auth[_-]?token)\s*[=:]\s*(?:Bearer\s+|Basic\s+)?)([^\s\"\',}\]]+)",
    # A bare Bearer credential anywhere
    r"(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})",
    # key=value / key: value where the KEY names a credential. Either quote
    # style is accepted on both sides so single-quoted JSON/Python dicts are
    # caught too, not just {"api_key": "x"}. The opening quote is part of the
    # prefix, so the closing quote is left in place and the line still reads
    # as valid JSON with a redacted value.
    r"([\"']?(?:[A-Za-z0-9_.-]*"
    r"(?:api[_-]?key|apikey|server[_-]?key|access[_-]?token|refresh[_-]?token"
    r"|token|secret|password|passwd|authorization|cookie|credential)"
    r"[A-Za-z0-9_.-]*)[\"']?\s*[=:]\s*[\"']?)([\"']?[^\s\"',}\]]+)",
)

# Self-identifying secrets -- no group, replaced whole:
_SECRET_BARE_PATTERNS = (
    # OpenAI / Anthropic style keys
    r"sk-[A-Za-z0-9_-]{6,}",
    # GitHub tokens
    r"gh[pousr]_[A-Za-z0-9]{16,}",
    # Telegram bot tokens: numeric bot id, colon, then the secret
    r"\b\d{8,10}:[A-Za-z0-9_-]{30,}",
    # Slack
    r"xox[abprs]-[A-Za-z0-9-]{10,}",
    # JSON Web Tokens
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}",
    # PEM private key blocks, including the body
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
)

_SECRET_PAIR_RES = tuple(re.compile(p, re.IGNORECASE) for p in _SECRET_PAIR_PATTERNS)
_SECRET_BARE_RES = tuple(re.compile(p, re.IGNORECASE) for p in _SECRET_BARE_PATTERNS)


def redact_secrets(text: str) -> str:
    """Remove credential-shaped substrings from a block of plain text.

    Used for log lines and any text destined for a file the user may share. The
    patterns are deliberately conservative: they only rewrite something that
    either looks like a known secret on its own, or sits next to a key name
    that names a credential. Ordinary prose survives untouched, because a
    diagnostics bundle that eats real sentences is worse than no bundle.

    Self-identifying secrets go first so their distinctive prefixes are not
    half-eaten by a pair pattern first: "sk-abc..." would otherwise match the
    generic pair rule and keep a fragment of the key.

    Structure is preferred over pattern where it is available: a caller holding
    parsed JSON should run sanitize_secrets instead. This is the last line of
    defence for log lines, not the primary scrubber.
    """
    if not text:
        return text
    for rx in _SECRET_BARE_RES:
        text = rx.sub(_REDACTED, text)
    for rx in _SECRET_PAIR_RES:
        text = rx.sub(lambda m: m.group(1) + _REDACTED, text)
    return text


_SKILLS_COMPAT_APPLIED = False


def _apply_skills_compat() -> bool:
    """Repair GET /v1/skills when the agent is older than its own caller.

    api_server._handle_skills calls _find_all_skills(include_editorial=True),
    but that keyword only exists in a newer tools/skills_tool.py. Against the
    agent shipped in the mobile image the call raises TypeError, the handler
    converts it into a 500, and the app renders an empty Skills screen with no
    usable message. Nothing in this agent version references "editorial", so
    the kwarg has no behaviour behind it: the honest repair is to accept and
    drop it, not to invent a filter. No-op once the agent ships the kwarg.
    """
    global _SKILLS_COMPAT_APPLIED
    if _SKILLS_COMPAT_APPLIED:
        return True
    try:
        import inspect

        from tools import skills_tool
    except Exception:
        return False
    original = getattr(skills_tool, "_find_all_skills", None)
    if original is None:
        return False
    if getattr(original, "_hermes_mobile_compat", False):
        _SKILLS_COMPAT_APPLIED = True
        return True
    try:
        params = inspect.signature(original).parameters
        if "include_editorial" in params or any(
            p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
        ):
            _SKILLS_COMPAT_APPLIED = True
            return True
    except (TypeError, ValueError):
        pass

    def _find_all_skills(*args, include_editorial: bool = False, **kwargs):
        return original(*args, **kwargs)

    _find_all_skills._hermes_mobile_compat = True
    skills_tool._find_all_skills = _find_all_skills
    _SKILLS_COMPAT_APPLIED = True
    return True


_PHONE_BRIDGE_HOST = "127.0.0.1"
_PHONE_BRIDGE_PORT = 8091
_PHONE_BRIDGE_TIMEOUT_S = 5.0


def _phone_bridge_call(method, path, payload=None):
    # Blocking urllib inside asyncio.to_thread: never blocks the gateway loop.
    import json as _json
    import urllib.request as _urlreq

    url = "http://%s:%d%s" % (_PHONE_BRIDGE_HOST, _PHONE_BRIDGE_PORT, path)
    data = _json.dumps(payload or {}).encode("utf-8") if payload is not None else None
    req = _urlreq.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with _urlreq.urlopen(req, timeout=_PHONE_BRIDGE_TIMEOUT_S) as resp:
            return resp.status, _json.loads(resp.read().decode("utf-8") or "{}")
    except Exception as exc:
        code = getattr(exc, "code", None)
        if isinstance(code, int):
            try:
                return code, _json.loads(exc.read().decode("utf-8") or "{}")
            except Exception:
                return code, {"ok": False, "error": "bridge error %d" % code}
        return -1, {"ok": False, "error": "phone bridge unreachable"}


async def _phone_proxy(request, bridge_path, method="POST"):
    import asyncio as _asyncio

    from aiohttp import web

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)
    status, payload = await _asyncio.to_thread(_phone_bridge_call, method, bridge_path, body)
    if status < 0:
        return web.json_response(payload, status=502)
    return web.json_response(payload, status=status)


async def _get_phone_status(request):
    import asyncio as _asyncio

    from aiohttp import web

    status, payload = await _asyncio.to_thread(_phone_bridge_call, "GET", "/phone/status", None)
    if status < 0:
        return web.json_response(payload, status=502)
    return web.json_response(payload, status=status)


async def _post_phone_volume(request):
    return await _phone_proxy(request, "/phone/volume")


async def _post_phone_brightness(request):
    return await _phone_proxy(request, "/phone/brightness")


async def _post_phone_vibrate(request):
    return await _phone_proxy(request, "/phone/vibrate")


async def _post_phone_flashlight(request):
    return await _phone_proxy(request, "/phone/flashlight")


async def _post_phone_lock(request):
    return await _phone_proxy(request, "/phone/lock")


async def _post_phone_wifi_panel(request):
    return await _phone_proxy(request, "/phone/wifi_panel")


async def _post_phone_bluetooth_panel(request):
    return await _phone_proxy(request, "/phone/bluetooth_panel")


async def _post_phone_bluetooth_enable(request):
    return await _phone_proxy(request, "/phone/bluetooth_enable")


def _http_routes(api) -> list[tuple[str, str, Any]]:
    _apply_skills_compat()
    async def _get_memory(request):
        from aiohttp import web

        try:
            from hermes_yaml import safe_load

            home = _home_dir()
            cfg_path = os.path.join(home, "config.yaml")
            mem: dict = {}
            if os.path.exists(cfg_path):
                with open(cfg_path, "r", encoding="utf-8") as fh:
                    cfg = safe_load(fh) or {}
                if isinstance(cfg, dict) and isinstance(cfg.get("memory"), dict):
                    mem = cfg["memory"]
            enabled = bool(mem.get("memory_enabled", True))
            provider = str(mem.get("provider", "") or "")
            active = provider or ("builtin" if enabled else "")
            try:
                memory_char_limit = int(mem.get("memory_char_limit", 2200))
            except (TypeError, ValueError):
                memory_char_limit = 2200
            try:
                user_char_limit = int(mem.get("user_char_limit", 1375))
            except (TypeError, ValueError):
                user_char_limit = 1375
            mem_dir = os.path.join(home, "memories")
            files: dict[str, int] = {}
            entries = 0
            memory_size = 0
            user_size = 0
            for fname, key in (("MEMORY.md", "memory"), ("USER.md", "user")):
                path = os.path.join(mem_dir, fname)
                try:
                    size = os.path.getsize(path) if os.path.exists(path) else 0
                except OSError:
                    size = 0
                files[key] = size
                if key == "memory":
                    memory_size = size
                else:
                    user_size = size
                if key == "memory" and size:
                    try:
                        with open(path, "r", encoding="utf-8", errors="replace") as fh:
                            entries = sum(1 for line in fh if line.strip())
                    except OSError:
                        entries = 0
            return web.json_response(
                {
                    "enabled": enabled,
                    "provider": active,
                    "active": active,
                    "summary": "",
                    "entries": entries,
                    "builtin_files": files,
                    "memory_char_limit": memory_char_limit,
                    "user_char_limit": user_char_limit,
                    "memory_size": memory_size,
                    "user_size": user_size,
                }
            )
        except Exception as exc:  # honest 500, never an empty body
            from aiohttp import web as _web

            return _web.json_response({"error": str(exc)}, status=500)

    async def _post_memory_toggle(request):
        from aiohttp import web

        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            return web.json_response({"error": "enabled must be true or false"}, status=400)
        try:
            from hermes_yaml import roundtrip_yaml

            cfg_path = os.path.join(_home_dir(), "config.yaml")
            yaml = roundtrip_yaml()
            try:
                with open(cfg_path, "r", encoding="utf-8") as fh:
                    cfg = yaml.load(fh) or {}
            except FileNotFoundError:
                cfg = {}
            if not isinstance(cfg.get("memory"), dict):
                cfg["memory"] = {}
            cfg["memory"]["memory_enabled"] = enabled
            _write_yaml_atomic(cfg_path, yaml, cfg)
            return web.json_response({"ok": True, "enabled": enabled})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    async def _post_memory_limits(request):
        from aiohttp import web

        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        updates: dict[str, int] = {}
        for key in ("memory_char_limit", "user_char_limit"):
            if body.get(key) is None:
                continue
            raw = body.get(key)
            if isinstance(raw, bool) or not isinstance(raw, int):
                return web.json_response(
                    {"error": key + " must be a whole number"}, status=400
                )
            value = raw
            if value < 1000 or value > 50000:
                return web.json_response(
                    {"error": key + " must be between 1000 and 50000"}, status=400
                )
            updates[key] = value
        if not updates:
            return web.json_response(
                {"error": "nothing to change: send memory_char_limit and/or user_char_limit"},
                status=400,
            )
        try:
            from hermes_yaml import roundtrip_yaml

            cfg_path = os.path.join(_home_dir(), "config.yaml")
            yaml = roundtrip_yaml()
            try:
                with open(cfg_path, "r", encoding="utf-8") as fh:
                    cfg = yaml.load(fh) or {}
            except FileNotFoundError:
                cfg = {}
            if not isinstance(cfg.get("memory"), dict):
                cfg["memory"] = {}
            cfg["memory"].update(updates)
            _write_yaml_atomic(cfg_path, yaml, cfg)
            return web.json_response({"ok": True, **updates})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    async def _get_blueprints(request):
        from aiohttp import web

        try:
            from cron.blueprint_catalog import CATALOG

            items = []
            for bp in CATALOG:
                params = []
                for slot in bp.slots or []:
                    param: dict[str, Any] = {
                        "name": slot.name,
                        "label": slot.label or slot.name,
                    }
                    if slot.default is not None:
                        param["default"] = str(slot.default)
                    params.append(param)
                items.append(
                    {
                        "id": bp.key,
                        "name": bp.title,
                        "description": bp.description or "",
                        "parameters": params,
                    }
                )
            return web.json_response({"blueprints": items})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    async def _post_instantiate(request):
        from aiohttp import web

        blueprint_id = request.match_info.get("id", "")
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        values = body.get("slots")
        if not isinstance(values, dict):
            return web.json_response({"error": "slots must be an object"}, status=400)
        try:
            from cron.blueprint_catalog import (
                BlueprintFillError,
                fill_blueprint,
                get_blueprint,
            )

            blueprint = get_blueprint(blueprint_id)
            if blueprint is None:
                return web.json_response(
                    {"error": "Unknown blueprint: %s" % blueprint_id}, status=404
                )
            try:
                spec = fill_blueprint(blueprint, values)
            except BlueprintFillError as exc:
                return web.json_response({"error": str(exc)}, status=422)
            spec.pop("origin", None)
            from gateway.platforms.api_server import _cron_create

            if _cron_create is None:
                return web.json_response(
                    {"error": "Cron is not available on this server"}, status=503
                )
            job = _cron_create(origin=api._cron_origin_from_request(request), **spec)
            return web.json_response({"ok": True, "job": job})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    async def _post_providers_validate(request):
        # Live-probe a provider credential before it is saved. App shape:
        # {valid, models, error?}. Semantics mirror the desktop route: a
        # rejected key is valid:false (block), an unreachable provider is
        # valid:false with a connectivity message, an unknown provider is
        # valid:true with no models (cannot validate, do not block).
        from aiohttp import web

        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        value = str(body.get("key") or "").strip()
        env_var = str(body.get("env_var") or body.get("envVar") or "").strip()
        base_url = str(body.get("base_url") or body.get("baseUrl") or "").strip()
        if not value and not base_url:
            return web.json_response(
                {"valid": False, "models": [], "error": "Enter a value first."}
            )
        try:
            import httpx

            # Custom OpenAI-compatible endpoint: validate connectivity and
            # enumerate its /models (tries the base then the /v1 alternate).
            # HERMES-01: the URL policy runs before any credential leaves
            # the device, and the probe never follows redirects.
            if base_url:
                policy_error = await _custom_base_policy(base_url)
                if policy_error:
                    return web.json_response(
                        {"valid": False, "models": [], "error": policy_error}
                    )
                headers = {"Authorization": "Bearer " + value} if value else None
                base = base_url.rstrip("/")
                alt = base[:-3].rstrip("/") if base.lower().endswith("/v1") else base + "/v1"
                resolved, resp = base, None
                async with httpx.AsyncClient(timeout=httpx.Timeout(10.0), follow_redirects=False) as client:
                    for cand in (base, alt):
                        try:
                            cand_resp = await client.get(cand + "/models", headers=headers)
                        except Exception:
                            continue
                        if resp is None or cand_resp.is_success or resp.status_code == 404:
                            resolved, resp = cand, cand_resp
                        if cand_resp.is_success:
                            break
                if resp is None:
                    return web.json_response(
                        {"valid": False, "models": [],
                         "error": "Could not reach %s/models." % resolved}
                    )
                models = _safe_ids(resp) if resp.is_success else []
                if not models and not resp.is_success:
                    return web.json_response(
                        {"valid": False, "models": [],
                         "error": "%s answered HTTP %d." % (resolved + "/models", resp.status_code)}
                    )
                return web.json_response(
                    {"valid": True, "models": models, "resolved_base_url": resolved}
                )
            probe = _CRED_PROBES.get(env_var)
            if not probe:
                return web.json_response({"valid": False, "models": [], "reason": "unprobed", "error": "Provider cannot be verified: no probe configured."})
            url, auth = probe
            headers = {"Accept": "application/json"}
            params: dict[str, str] = {}
            if auth == "bearer":
                headers["Authorization"] = "Bearer " + value
            else:
                params["key"] = value
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                try:
                    resp = await client.get(url, headers=headers, params=params)
                except Exception:
                    return web.json_response(
                        {"valid": False, "models": [],
                         "error": "Could not reach the provider to verify the key."}
                    )
            if resp.status_code in (401, 403):
                return web.json_response(
                    {"valid": False, "models": [], "error": "That API key was rejected."}
                )
            if resp.status_code == 429 or resp.is_success:
                return web.json_response(
                    {"valid": True, "models": _safe_ids(resp) if resp.is_success else []}
                )
            return web.json_response(
                {"valid": False, "models": [],
                 "error": "Provider returned HTTP %d for this key." % resp.status_code}
            )
        except Exception as exc:
            return web.json_response({"valid": False, "models": [], "error": str(exc)})

    async def _get_projects(request):
        # Live binds: every entry under .projects/ that still resolves.
        from aiohttp import web

        items = []
        try:
            base = _projects_dir()
            for pid in sorted(os.listdir(base)):
                try:
                    _valid_project_id(pid)
                except ValueError:
                    continue
                link = os.path.join(base, pid)
                if os.path.islink(link):
                    try:
                        target = os.path.realpath(link)
                    except OSError:
                        continue
                    items.append({"id": pid, "guest_path": link, "host_path": target,
                                  "alive": os.path.isdir(target)})
                elif os.path.isdir(link):
                    # Local imported copy (Play vc87+): no host path.
                    items.append({"id": pid, "guest_path": link, "host_path": "",
                                  "alive": True})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"projects": items})

    async def _post_projects_bind(request):
        # Two modes. Legacy: symlink a host folder into the gateway (needs
        # raw /storage access on the device, kept for old desktop installs).
        # Local (Play vc87+): {"id": ..., "local": true} creates a real dir
        # under .projects/ holding the SAF-imported copy. No restart: both
        # are plain filesystem entries, unlike a proot -b mount.
        from aiohttp import web

        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        try:
            pid = _valid_project_id(body.get("id"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        link = os.path.join(_projects_dir(), pid)
        if body.get("local"):
            try:
                if os.path.islink(link):
                    return web.json_response(
                        {"error": "a legacy link owns that id; unbind it first"},
                        status=409,
                    )
                os.makedirs(link, exist_ok=True)
                return web.json_response({"ok": True, "guest_path": link})
            except Exception as exc:
                return web.json_response({"error": str(exc)}, status=500)
        try:
            target = _resolve_host_path(body.get("host_path"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        try:
            link = os.path.join(_projects_dir(), pid)
            if os.path.islink(link) or os.path.exists(link):
                if os.path.islink(link) and os.path.realpath(link) == target:
                    return web.json_response({"ok": True, "guest_path": link})
                try:
                    if os.path.islink(link):
                        os.unlink(link)
                    else:
                        return web.json_response(
                            {"error": "a non-link entry owns that id"}, status=409)
                except OSError as exc:
                    return web.json_response({"error": str(exc)}, status=500)
            os.symlink(target, link)
            return web.json_response({"ok": True, "guest_path": link})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    async def _delete_project(request):
        # Links: drop the link only, device files are never touched.
        # Local imported copies: delete the copy (it lives in app-private
        # storage, so keeping it would leak space with no way back).
        from aiohttp import web

        try:
            pid = _valid_project_id(request.match_info.get("id", ""))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        link = os.path.join(_projects_dir(), pid)
        try:
            if os.path.islink(link):
                os.unlink(link)
                return web.json_response({"ok": True})
            if os.path.isdir(link):
                import shutil

                shutil.rmtree(link)
                return web.json_response({"ok": True})
            return web.json_response({"error": "Unknown project"}, status=404)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)


    # ---- Diagnostics / backup / debug-share -------------------------------
    # The Settings screen has always offered these three buttons, but the
    # stock api_server serves none of them, so every tap ended in a 404 that
    # the UI reported as "did not finish". They are read-only views over state
    # the gateway already knows, so they are cheap and safe to serve here.

    async def _get_doctor(request):
        """Health of the pieces the app actually depends on, one row each."""
        from aiohttp import web

        checks: list[dict[str, Any]] = []

        def add(name: str, ok: bool, detail: str) -> None:
            checks.append({"name": name, "ok": ok, "detail": detail})

        # The server answering at all is the root check.
        add("api_server", True, "HTTP endpoint responding")

        home = _home_dir()
        cfg_path = os.path.join(home, "config.yaml")
        cfg: dict = {}
        try:
            from hermes_yaml import safe_load

            if os.path.exists(cfg_path):
                with open(cfg_path, "r", encoding="utf-8") as fh:
                    loaded = safe_load(fh) or {}
                if isinstance(loaded, dict):
                    cfg = loaded
        except Exception as exc:
            add("config.yaml", False, f"unreadable: {exc}")
        else:
            add("config.yaml", bool(cfg), "loaded" if cfg else "empty")

        # Model/provider wiring: a gateway with no provider answers nothing,
        # which is exactly the "boots but never replies" failure.
        model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
        provider = str(model_cfg.get("provider", "") or "")
        model = str(model_cfg.get("default", "") or model_cfg.get("model", "") or "")
        add("provider", bool(provider), provider or "not configured")
        add("model", bool(model), model or "not configured")

        # Credential presence only. The value never leaves this handler: the
        # app redacts too, but a 401/403 diagnosis does not need the secret.
        key_env = None
        for name in ("OPENCODE_GO_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"):
            if os.environ.get(name):
                key_env = name
                break
        add("credentials", key_env is not None, key_env or "no provider key in env")

        # Skills are checked live, against the same call the Skills screen
        # makes. An import check would pass while _find_all_skills still
        # raises at call time, and reading gateway.log was worse than both: a
        # traceback from hours earlier stayed in the file forever, so the
        # Settings screen kept saying "skills broken" while GET /v1/skills
        # was serving 53 skills. Report what works right now.
        try:
            from tools.skills_tool import _find_all_skills

            _apply_skills_compat()
            found = _find_all_skills(skip_disabled=False)
        except Exception as exc:
            add("skills", False, f"skill registry unavailable: {exc}")
        else:
            n = len(found or [])
            if n:
                add("skills", True, f"{n} skill(s) registered")
            else:
                add("skills", False, "no skills registered")

        ok = all(c["ok"] for c in checks)
        return web.json_response(
            {
                "ok": ok,
                "summary": "All checks passed" if ok else "Some checks failed",
                "version": _version(),
                "checks": checks,
            }
        )

    def _version() -> str:
        # Same helper api_server.py uses, so the app and the gateway never
        # disagree about which build is answering.
        try:
            from hermes_cli.version_info import get_version_info

            return str(get_version_info().base_version)
        except Exception:
            return ""

    async def _post_backup(request):
        """Write a snapshot of chats, jobs and settings to a file.

        Credential values are never copied: the config is walked recursively
        and every key naming a credential is kept with its value replaced by a
        redacted marker, so the reader can see the field existed and was
        withheld. A top-level key filter was not enough, because a provider's
        secrets sit under a nested block whose top-level key is just the
        provider name.

        The destination stays inside the Hermes home so the user can reach it
        over the app's file tools.
        """
        from aiohttp import web

        home = _home_dir()
        try:
            import json
            import time

            stamp = time.strftime("%Y%m%d-%H%M%S")
            out_dir = os.path.join(home, "snapshots")
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, f"hermes-{stamp}.json")

            payload: dict[str, Any] = {"created": stamp, "version": _version()}
            cfg_path = os.path.join(home, "config.yaml")
            if os.path.exists(cfg_path):
                from hermes_yaml import safe_load

                with open(cfg_path, "r", encoding="utf-8") as fh:
                    cfg = safe_load(fh) or {}
                if isinstance(cfg, dict):
                    # Strip credentials at every depth. A top-level key filter
                    # left nested provider blocks intact, because their
                    # top-level key is just the provider name.
                    payload["config"] = sanitize_secrets(cfg)
            sessions_dir = os.path.join(home, "sessions")
            sessions: list[str] = []
            if os.path.isdir(sessions_dir):
                sessions = sorted(
                    f for f in os.listdir(sessions_dir) if f.endswith(".json")
                )[:500]
            payload["sessions"] = sessions

            tmp = out_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, default=str)
            os.replace(tmp, out_path)
            return web.json_response(
                {
                    "ok": True,
                    "path": out_path,
                    "message": f"Saved {len(sessions)} session(s) to {out_path}",
                }
            )
        except Exception as exc:
            return web.json_response(
                {"ok": False, "path": "", "message": f"Backup failed: {exc}"}, status=500
            )

    async def _post_debug_share(request):
        """Produce the diagnostics bundle locally.

        The app offers a share link, but this gateway has nowhere to upload
        to. Returning the file:// path is the honest equivalent: the user can
        pull the file off the device instead of the button failing outright.
        Secrets are stripped on the way out.
        """
        from aiohttp import web

        home = _home_dir()
        try:
            import json
            import re
            import time

            # Log locations vary by host: Hermes keeps its own logs in a logs/
            # subdir, while the mobile service writes service.log and a small
            # gateway.log beside HERMES_HOME. Search both levels and any logs/
            # subdir so a host layout change degrades to "found what exists"
            # instead of a bundle with zero lines in it.
            def _find_log(name: str) -> str | None:
                roots = (home, os.path.dirname(home.rstrip("/")))
                for d in roots:
                    direct = os.path.join(d, name)
                    if os.path.exists(direct):
                        return direct
                    nested = os.path.join(d, "logs", name)
                    if os.path.exists(nested):
                        return nested
                return None

            logs: list[str] = []
            for name in ("gateway.log", "service.log", "errors.log", "agent.log"):
                path = _find_log(name)
                if not path:
                    continue
                try:
                    with open(path, "r", encoding="utf-8", errors="replace") as fh:
                        tail = fh.readlines()[-400:]
                    logs.extend(f"[{name}] {line.rstrip()}" for line in tail)
                except OSError:
                    continue

            # Belt and braces: the app redacts too, but the bundle is a file
            # on disk that could outlive the session that made it. The older
            # inline pattern missed quoted JSON such as {"api_key": "x"}, so
            # the shared redact_secrets scanner is used instead.
            logs = [redact_secrets(line) for line in logs]

            stamp = time.strftime("%Y%m%d-%H%M%S")
            out_dir = os.path.join(home, "snapshots")
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, f"hermes-debug-{stamp}.txt")

            payload = {
                "created": stamp,
                "version": _version(),
                "home": home,
                "platform": sys.platform,
                "python": sys.version.split()[0],
                "log_lines": len(logs),
            }
            with open(out_path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(payload, indent=2))
                fh.write("\n\n")
                fh.write("\n".join(logs))
            return web.json_response(
                {
                    "ok": True,
                    "urls": [f"file://{out_path}"],
                    "summary": f"Wrote {len(logs)} log line(s) to {out_path}",
                }
            )
        except Exception as exc:
            return web.json_response(
                {"ok": False, "urls": [], "summary": f"Debug share failed: {exc}"},
                status=500,
            )

    return [
        ("GET", "/api/doctor", _get_doctor),
        ("POST", "/api/backup", _post_backup),
        ("POST", "/api/debug/share", _post_debug_share),
        ("GET", "/api/memory", _get_memory),
        ("POST", "/api/memory/toggle", _post_memory_toggle),
        ("POST", "/api/memory/limits", _post_memory_limits),
        ("GET", "/api/blueprints", _get_blueprints),
        ("POST", "/api/blueprints/{id}/instantiate", _post_instantiate),
        ("POST", "/api/providers/validate", _post_providers_validate),
        ("GET", "/api/projects", _get_projects),
        ("POST", "/api/projects/bind", _post_projects_bind),
        ("DELETE", "/api/projects/{id}", _delete_project),
        ("GET", "/api/phone/status", _get_phone_status),
        ("POST", "/api/phone/volume", _post_phone_volume),
        ("POST", "/api/phone/brightness", _post_phone_brightness),
        ("POST", "/api/phone/vibrate", _post_phone_vibrate),
        ("POST", "/api/phone/flashlight", _post_phone_flashlight),
        ("POST", "/api/phone/lock", _post_phone_lock),
        ("POST", "/api/phone/wifi_panel", _post_phone_wifi_panel),
        ("POST", "/api/phone/bluetooth_panel", _post_phone_bluetooth_panel),
        ("POST", "/api/phone/bluetooth_enable", _post_phone_bluetooth_enable),
    ]
