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

Auth is enforced by the server's global middleware, same as the sibling
/api/jobs routes: handlers here do not self-auth, mirroring api_server_runs.
All heavy imports stay inside handlers so a missing optional dependency
degrades to an honest 5xx instead of breaking server boot.
"""

from __future__ import annotations

import os
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


def _http_routes(api) -> list[tuple[str, str, Any]]:
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

    return [
        ("GET", "/api/memory", _get_memory),
        ("POST", "/api/memory/toggle", _post_memory_toggle),
        ("POST", "/api/memory/limits", _post_memory_limits),
        ("GET", "/api/blueprints", _get_blueprints),
        ("POST", "/api/blueprints/{id}/instantiate", _post_instantiate),
        ("POST", "/api/providers/validate", _post_providers_validate),
        ("GET", "/api/projects", _get_projects),
        ("POST", "/api/projects/bind", _post_projects_bind),
        ("DELETE", "/api/projects/{id}", _delete_project),
    ]
