"""Guided firmware 3.x upgrade for EFR32BG22 OpenDisplay units still on 2.x.

Firmware 3.x (Firmware_Unified) drives the panel from drive packets (0xAE-0xB1) in the
config. A 2.x config has none, so a BG22 flashed from 2.x to 3.x keeps its config but
draws nothing until drive data is written. The firmware update entity therefore never
offers 3.x; this module is the explicit, user-started path (options flow):

1. Pre-flight, before anything is flashed: the device must be awake; its 2.x config is
   read and saved to ``opendisplay/backups``; the 3.x migration is planned against that
   config as a BG22 on 3.x would see it, and the upgrade is refused when no usable drive
   data exists for the panel, or the migrated config would not fit the BG22.
2. Flash the release's ``ble-ota-from-2x`` image (manifest.json, sha256 checked) through
   the update entity's OTA path, with its BLE lock and deadline.
3. Wait for the unit to come back on 3.x, then write the planned drive data
   (``repairs.async_migrate``, which backs up again and verifies the read-back).
   When that fails, the "cannot draw its panel" repair is raised with the saved backup.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import logging
from pathlib import Path
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import slugify
import homeassistant.util.dt as dt_util

from opendisplay.models.config import GlobalConfig
from opendisplay.models.enums import ICType
from opendisplay.models.profile import build_profile
from opendisplay.panels import MigrationPlan, PanelDatabase, apply_migration
from opendisplay.panels.migration import plan_migration
from opendisplay.protocol.config_serializer import serialize_config

from . import OpenDisplayConfigEntry
from .const import CONF_HOST, DATA_FIRMWARE_UPGRADES
from .repairs import (
    BACKUP_DIR,
    MigrationFailedError,
    MigrationUnavailableError,
    _async_connected,
    _panel_name,
    _write_backup,
    async_migrate,
    async_update_needs_migration_issue,
)
from .update import (
    _GITHUB_HEADERS,
    GitHubRateLimitedError,
    OTAFlashError,
    _async_github_json,
    async_flash_silabs,
    device_probably_asleep,
)

_LOGGER = logging.getLogger(__name__)

UNIFIED_REPO = "OpenDisplay/Firmware_Unified"
BG22_BOARD = "bg22"
FROM_2X_FLOW = "ble-ota-from-2x"
RELEASE_MANIFEST_SCHEMA = "opendisplay-release/1"
# The largest config a BG22 on 3.x stores. The planner already checks the panel
# database's (more conservative) BG22 cap; this is the hard ceiling on top.
BG22_MAX_CONFIG = 4080
# After the AppLoader commits, the unit reboots into 3.x; how long to keep trying
# to reach it there before handing over to the repair.
RETURN_DEADLINE_S = 180.0
RETURN_RETRY_S = 5.0

_GITHUB_RELEASES = "https://api.github.com/repos/{repo}/releases?per_page=20"


class UpgradeRefusedError(Exception):
    """The upgrade stops here; ``reason`` is the options flow's abort reason."""

    def __init__(self, abort_reason: str, /, **placeholders: str) -> None:
        """Remember the abort reason and its placeholders."""
        super().__init__(abort_reason)
        self.reason = abort_reason
        self.placeholders = placeholders


@dataclass(frozen=True)
class V3Release:
    """The 3.x BLE OTA image a Firmware_Unified release offers the BG22 on 2.x."""

    tag: str
    file: str
    url: str
    sha256: str
    size: int | None


@dataclass(frozen=True)
class Preflight:
    """What the pre-flight found: the image, the plan and where the 2.x config was saved."""

    release: V3Release
    plan: MigrationPlan
    backup: Path
    config_bytes: int
    panel: str


def _tag_major(tag: str) -> int | None:
    tag = tag.strip()
    if tag[:1] in ("v", "V"):
        tag = tag[1:]
    head = tag.split(".", 1)[0]
    return int(head) if head.isdigit() else None


@callback
def upgrade_supported(entry: OpenDisplayConfigEntry) -> bool:
    """Return whether the guided 3.x upgrade applies: a loaded BLE BG22 on 2.x."""
    runtime = getattr(entry, "runtime_data", None)
    if runtime is None or CONF_HOST in entry.data:
        return False
    return (
        runtime.device_config.system.ic_type == ICType.EFR32BG22
        and runtime.firmware["major"] < 3
    )


@callback
def upgrade_in_progress(hass: HomeAssistant, entry_id: str) -> bool:
    """Return whether a guided upgrade is flashing or migrating this entry's display."""
    return entry_id in hass.data.get(DATA_FIRMWARE_UPGRADES, set())


def select_bg22_ota(
    manifest: dict[str, Any], asset_names: set[str]
) -> tuple[str, str, int | None] | None:
    """Pick the BG22 ``ble-ota-from-2x`` file, its sha256 and size from a release manifest.

    A release without that flow, or whose file is missing or has no sha256, offers nothing.
    """
    if manifest.get("schema") != RELEASE_MANIFEST_SCHEMA:
        return None
    board = next(
        (b for b in manifest.get("boards", []) if b.get("board") == BG22_BOARD), None
    )
    flow = ((board or {}).get("flows") or {}).get(FROM_2X_FLOW) or {}
    files = flow.get("files") or []
    if not files or files[0] not in asset_names:
        return None
    file = str(files[0])
    art = next((a for a in manifest.get("artefacts", []) if a.get("file") == file), {})
    if not art.get("sha256"):
        return None
    size = art.get("size")
    return file, str(art["sha256"]).lower(), int(size) if size is not None else None


async def async_find_release(
    hass: HomeAssistant, entry: OpenDisplayConfigEntry
) -> V3Release:
    """Return the newest published 3.x release that offers the BG22 a 2.x -> 3.x image."""
    try:
        releases: Any = await _async_github_json(
            hass, entry, _GITHUB_RELEASES.format(repo=UNIFIED_REPO)
        )
        for release in releases if isinstance(releases, list) else []:
            tag = str(release.get("tag_name") or "")
            if (
                release.get("draft")
                or release.get("prerelease")
                or _tag_major(tag) != 3
            ):
                continue
            assets = {
                a["name"]: a["browser_download_url"] for a in release.get("assets", [])
            }
            if "manifest.json" not in assets:
                continue
            try:
                manifest = await _async_manifest(hass, assets["manifest.json"])
            except (aiohttp.ClientError, TimeoutError, ValueError, TypeError) as err:
                _LOGGER.debug("%s: manifest.json unreadable: %s", tag, err)
                continue
            picked = select_bg22_ota(manifest, set(assets))
            if picked is None or _tag_major(str(manifest.get("version") or tag)) != 3:
                continue
            file, sha256, size = picked
            return V3Release(
                tag=tag, file=file, url=assets[file], sha256=sha256, size=size
            )
    except GitHubRateLimitedError as err:
        raise UpgradeRefusedError(
            "release_lookup_failed",
            error="GitHub API rate limit reached (resets at "
            f"{(err.translation_placeholders or {}).get('reset', '?')}); "
            "a GitHub token in these options raises it",
        ) from err
    except (aiohttp.ClientError, TimeoutError) as err:
        raise UpgradeRefusedError("release_lookup_failed", error=str(err)) from err
    raise UpgradeRefusedError("no_release")


async def _async_manifest(hass: HomeAssistant, url: str) -> dict[str, Any]:
    # browser_download_url is served from the CDN, not the API: no rate limit, no token.
    session = async_get_clientsession(hass)
    async with session.get(
        url, headers=_GITHUB_HEADERS, timeout=aiohttp.ClientTimeout(total=30)
    ) as resp:
        resp.raise_for_status()
        data = await resp.json(content_type=None)
    if not isinstance(data, dict):
        raise TypeError("manifest.json is not an object")
    return data


async def async_download_firmware(hass: HomeAssistant, release: V3Release) -> bytes:
    """Download the release's image and check it against the manifest's size and sha256."""
    session = async_get_clientsession(hass)
    try:
        async with session.get(
            release.url, timeout=aiohttp.ClientTimeout(total=120)
        ) as resp:
            resp.raise_for_status()
            data = await resp.read()
    except (aiohttp.ClientError, TimeoutError) as err:
        raise UpgradeRefusedError(
            "download_failed", error=str(err) or type(err).__name__
        ) from err
    if (release.size is not None and len(data) != release.size) or hashlib.sha256(
        data
    ).hexdigest() != release.sha256:
        raise UpgradeRefusedError("firmware_corrupt", file=release.file)
    return data


def plan_for_v3(config: GlobalConfig, database: PanelDatabase) -> MigrationPlan:
    """Plan the migration a 2.x BG22 config needs once the unit runs 3.x."""
    profile = build_profile(
        {"major": 3, "minor": 0, "patch": 0, "sha": ""}, config, None
    )
    return plan_migration(config, profile, database)


async def async_preflight(
    hass: HomeAssistant, entry: OpenDisplayConfigEntry, release: V3Release
) -> Preflight:
    """Back up the 2.x config and check that 3.x can drive this panel, before any flash.

    Raises:
        UpgradeRefusedError: The upgrade must not go ahead (``reason`` says why).

    """
    if device_probably_asleep(entry):
        raise UpgradeRefusedError("device_sleeping")
    try:
        async with _async_connected(hass, entry) as device:
            firmware = device.profile.firmware
            config = device.config.cached
    except MigrationUnavailableError as err:
        raise UpgradeRefusedError("cannot_connect") from err
    if firmware["major"] >= 3:
        raise UpgradeRefusedError("already_v3")
    if config is None or not config.displays:
        raise UpgradeRefusedError("no_config")

    stem = f"{slugify(entry.title)}-before-3x-{dt_util.now().strftime('%Y%m%d-%H%M%S')}"
    try:
        backup = await hass.async_add_executor_job(
            _write_backup, Path(hass.config.path(*BACKUP_DIR)), stem, config
        )
    except OSError as err:
        raise UpgradeRefusedError("backup_failed", error=str(err)) from err
    _LOGGER.info(
        "%s: 2.x config saved to %s before the 3.x upgrade", entry.title, backup
    )

    database = await hass.async_add_executor_job(PanelDatabase.load)
    plan = plan_for_v3(config, database)
    if plan.blocked:
        raise UpgradeRefusedError("unsupported", reason=plan.reason, backup=str(backup))
    size = len(serialize_config(apply_migration(config, plan)))
    if size > BG22_MAX_CONFIG:
        raise UpgradeRefusedError(
            "too_large", size=str(size), limit=str(BG22_MAX_CONFIG), backup=str(backup)
        )
    return Preflight(
        release=release,
        plan=plan,
        backup=backup,
        config_bytes=size,
        panel=_panel_name(plan) if plan.needed else "-",
    )


async def async_flash(
    hass: HomeAssistant,
    entry: OpenDisplayConfigEntry,
    preflight: Preflight,
    on_progress: Any,
) -> None:
    """Download and flash the 3.x image.

    Raises:
        UpgradeRefusedError: The download failed or did not match (nothing was flashed).
        OTAFlashError: The flash failed; ``reached_apploader`` says whether the unit
            may now sit in the AppLoader.
        HomeAssistantError: Out of range, or the key was rejected (reauth started).

    """
    if device_probably_asleep(entry):
        raise UpgradeRefusedError("device_sleeping")
    firmware = await async_download_firmware(hass, preflight.release)
    await async_flash_silabs(hass, entry, firmware, on_progress=on_progress)
    _LOGGER.info("%s: flashed %s", entry.title, preflight.release.tag)


async def async_wait_for_v3(
    hass: HomeAssistant,
    entry: OpenDisplayConfigEntry,
    deadline_s: float | None = None,
) -> None:
    """Wait until the display answers on 3.x after the flash.

    The AppLoader shares the app's address but not its GATT table, so the first
    attempts may reach the AppLoader (or a stale cache) and fail; keep trying.

    Raises:
        UpgradeRefusedError: ``not_back`` after the deadline, ``still_v2`` when the
            display came back on 2.x.

    """
    if deadline_s is None:
        deadline_s = RETURN_DEADLINE_S
    loop = asyncio.get_running_loop()
    end = loop.time() + deadline_s
    major: int | None = None
    while True:
        try:
            async with _async_connected(hass, entry) as device:
                major = device.profile.firmware["major"]
        except MigrationUnavailableError:
            major = None
        if major is not None and major >= 3:
            return
        if loop.time() + RETURN_RETRY_S > end:
            break
        await asyncio.sleep(RETURN_RETRY_S)
    if major is not None:
        raise UpgradeRefusedError("still_v2")
    raise UpgradeRefusedError("not_back", minutes=str(round(deadline_s / 60)))


async def async_finish(
    hass: HomeAssistant, entry: OpenDisplayConfigEntry, preflight: Preflight
) -> None:
    """After the flash: wait for 3.x, write the drive data, verify the display can draw.

    On any failure the "cannot draw its panel" repair is raised, pointing at the 2.x
    backup, and the error is re-raised as ``UpgradeRefusedError``.
    """
    try:
        await async_wait_for_v3(hass, entry)
        if preflight.plan.needed:
            try:
                await async_migrate(hass, entry)
            except MigrationUnavailableError as err:
                raise UpgradeRefusedError(
                    "migrate_failed", error="the display did not answer"
                ) from err
            except MigrationFailedError as err:
                raise UpgradeRefusedError(
                    "migrate_failed", error=str(err) or "unknown error"
                ) from err
    except UpgradeRefusedError as err:
        async_update_needs_migration_issue(
            hass, entry, True, backup=str(preflight.backup)
        )
        err.placeholders.setdefault("backup", str(preflight.backup))
        raise
    async_update_needs_migration_issue(hass, entry, False)


def flash_error_placeholders(
    err: HomeAssistantError, preflight: Preflight
) -> tuple[str, dict[str, str]]:
    """Return the abort reason and placeholders for a failed flash."""
    reason = (
        "flash_failed_apploader"
        if isinstance(err, OTAFlashError) and err.reached_apploader
        else "flash_failed"
    )
    return reason, {
        "error": str(err) or type(err).__name__,
        "backup": str(preflight.backup),
    }


@dataclass
class UpgradeJob:
    """The flash -> wait -> migrate run, independent of the flow that started it.

    Closing the options dialog must not cancel a flash half way (that strands the
    unit in the AppLoader) nor skip the migration after it, so the work runs as a
    background task and the flow only watches it.
    """

    task: asyncio.Task[None]
    flashed: asyncio.Event


@callback
def async_start_upgrade(
    hass: HomeAssistant,
    entry: OpenDisplayConfigEntry,
    preflight: Preflight,
    on_progress: Any,
) -> UpgradeJob:
    """Start flashing and migrating the display in the background."""
    upgrades = hass.data.setdefault(DATA_FIRMWARE_UPGRADES, set())
    upgrades.add(entry.entry_id)
    flashed = asyncio.Event()

    async def _run() -> None:
        try:
            try:
                await async_flash(hass, entry, preflight, on_progress)
            except (UpgradeRefusedError, HomeAssistantError) as err:
                _LOGGER.error(
                    "%s: firmware 3.x upgrade failed before or during the flash: %s "
                    "(2.x config backup: %s)",
                    entry.title,
                    getattr(err, "reason", None) or err,
                    preflight.backup,
                )
                raise
            flashed.set()
            try:
                await async_finish(hass, entry, preflight)
            except UpgradeRefusedError as err:
                _LOGGER.error(
                    "%s: flashed %s, but the drive data was not written (%s); "
                    "see the repair. 2.x config backup: %s",
                    entry.title,
                    preflight.release.tag,
                    err.placeholders.get("error", err.reason),
                    preflight.backup,
                )
                raise
        finally:
            upgrades.discard(entry.entry_id)
            if flashed.is_set():
                # The display runs other firmware than the entry was set up with.
                hass.config_entries.async_schedule_reload(entry.entry_id)

    task = hass.async_create_background_task(
        _run(), f"opendisplay firmware 3.x upgrade {entry.entry_id}"
    )
    return UpgradeJob(task=task, flashed=flashed)


async def async_wait_flashed(job: UpgradeJob) -> None:
    """Return once the flash finished (or the job ended); never cancels the job."""
    waiter = asyncio.ensure_future(job.flashed.wait())
    try:
        await asyncio.wait({waiter, job.task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        waiter.cancel()


async def async_wait_done(job: UpgradeJob) -> None:
    """Return once the job ended; never cancels the job."""
    await asyncio.wait({job.task})
