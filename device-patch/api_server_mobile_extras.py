"""On-device extras for Hermes Mobile (vc77).

Routes the mobile app expects that the stock api_server does not serve:
  GET  /api/memory                      status {enabled, provider, active, summary, entries}
  POST /api/memory/toggle {enabled}     persisted switch (config.yaml memory.memory_enabled)
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
            mem_dir = os.path.join(home, "memories")
            files: dict[str, int] = {}
            entries = 0
            for fname, key in (("MEMORY.md", "memory"), ("USER.md", "user")):
                path = os.path.join(mem_dir, fname)
                try:
                    size = os.path.getsize(path) if os.path.exists(path) else 0
                except OSError:
                    size = 0
                files[key] = size
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
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            return web.json_response({"error": "enabled must be true or false"}, status=400)
        try:
            from hermes_yaml import roundtrip_yaml

            cfg_path = os.path.join(_home_dir(), "config.yaml")
            yaml = roundtrip_yaml()
            with open(cfg_path, "r", encoding="utf-8") as fh:
                cfg = yaml.load(fh) or {}
            if not isinstance(cfg.get("memory"), dict):
                cfg["memory"] = {}
            cfg["memory"]["memory_enabled"] = enabled
            with open(cfg_path, "w", encoding="utf-8") as fh:
                yaml.dump(cfg, fh)
            return web.json_response({"ok": True, "enabled": enabled})
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

    return [
        ("GET", "/api/memory", _get_memory),
        ("POST", "/api/memory/toggle", _post_memory_toggle),
        ("GET", "/api/blueprints", _get_blueprints),
        ("POST", "/api/blueprints/{id}/instantiate", _post_instantiate),
    ]
