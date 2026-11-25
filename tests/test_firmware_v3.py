"""Test the guided firmware 2.x -> 3.x upgrade of an EFR32BG22 display."""

import asyncio
import dataclasses
import hashlib
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.components.update import DOMAIN as UPDATE_DOMAIN, SERVICE_INSTALL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import issue_registry as ir
from opendisplay import BLEConnectionError, GlobalConfig
from opendisplay.ota import OTAError
import pytest
from pytest_homeassistant.common import MockConfigEntry
from pytest_homeassistant.components.bluetooth import inject_bluetooth_service_info
from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker

from custom_components.opendisplay.const import DATA_FIRMWARE_UPGRADES, DOMAIN
from custom_components.opendisplay.firmware_v3 import UNIFIED_REPO, select_bg22_ota
from custom_components.opendisplay.repairs import (
    MigrationFailedError,
    MigrationUnavailableError,
    async_update_needs_migration_issue,
    needs_migration_issue_id,
)
from custom_components.opendisplay.update import OTAFlashError

from . import GITHUB_LATEST, VALID_SERVICE_INFO, make_ota_device_config

_V3 = "custom_components.opendisplay.firmware_v3"
_UPDATE = "custom_components.opendisplay.update"

GBL = b"\x00gbl image" * 100
GBL_NAME = "opendisplay-bg22-ota.gbl"
RELEASES = f"https://api.github.com/repos/{UNIFIED_REPO}/releases?per_page=20"
MANIFEST_URL = "https://github.com/dl/3.1.0/manifest.json"
GBL_URL = "https://github.com/dl/3.1.0/opendisplay-bg22-ota.gbl"
V3_FIRMWARE = {"major": 3, "minor": 1, "patch": 0, "sha": "def456"}

# Panel ids from the bundled drive preset database.
PANEL_GLASS = 0x1E  # EP29YR_168x384: drive data seen drawing on glass
PANEL_EQUIVALENT = 0x05  # EP293_128x296: replays 2.x byte for byte, not seen on glass
PANEL_NONE = 0x41  # no 3.x drive data yet


def _manifest(sha256: str | None = None, size: int | None = None) -> dict[str, Any]:
    return {
        "schema": "opendisplay-release/1",
        "version": "3.1.0",
        "boards": [
            {
                "board": "bg22",
                "flows": {
                    "ble-ota": {"files": [GBL_NAME]},
                    "ble-ota-from-2x": {"files": [GBL_NAME]},
                },
            }
        ],
        "artefacts": [
            {
                "file": GBL_NAME,
                "sha256": sha256 or hashlib.sha256(GBL).hexdigest(),
                "size": len(GBL) if size is None else size,
            }
        ],
    }


def _bg22(panel_ic_type: int) -> GlobalConfig:
    config = make_ota_device_config()
    return dataclasses.replace(
        config,
        displays=[dataclasses.replace(config.displays[0], panel_ic_type=panel_ic_type)],
    )


@pytest.fixture(autouse=True)
def config_dir(hass: HomeAssistant, tmp_path: Path) -> Path:
    """Keep backups out of the repository's test config."""
    hass.config.config_dir = str(tmp_path)
    return tmp_path


@pytest.fixture
def device_config() -> GlobalConfig:
    """Return a 2.x BG22 whose panel has glass-verified 3.x drive data."""
    return _bg22(PANEL_GLASS)


@pytest.fixture(autouse=True)
def github(aioclient_mock: AiohttpClientMocker) -> AiohttpClientMocker:
    """Serve one Firmware_Unified release with a BG22 image, behind a newer empty one."""
    aioclient_mock.get(GITHUB_LATEST, json={"tag_name": "v2.30", "body": ""})
    aioclient_mock.get(
        RELEASES,
        json=[
            {"tag_name": "3.1.1", "draft": False, "prerelease": False, "assets": []},
            {"tag_name": "presets-v1.0.0", "prerelease": True, "assets": []},
            {
                "tag_name": "3.1.0",
                "draft": False,
                "prerelease": False,
                "assets": [
                    {"name": "manifest.json", "browser_download_url": MANIFEST_URL},
                    {"name": GBL_NAME, "browser_download_url": GBL_URL},
                ],
            },
        ],
    )
    aioclient_mock.get(MANIFEST_URL, text=json.dumps(_manifest()))
    aioclient_mock.get(GBL_URL, content=GBL)
    return aioclient_mock


@pytest.fixture
def connected(mock_opendisplay_connect: MagicMock) -> MagicMock:
    """Return the device opendisplay.connect() yields."""
    return mock_opendisplay_connect.return_value


@pytest.fixture
def flash(connected: MagicMock) -> AsyncMock:
    """Patch the BLE flash; a successful flash leaves the display on 3.x."""

    async def _flash(*_args: Any, on_progress: Any) -> None:
        on_progress(50.0)
        connected.profile.firmware = V3_FIRMWARE

    with patch(f"{_V3}.async_flash_silabs", AsyncMock(side_effect=_flash)) as mock:
        yield mock


@pytest.fixture
def migrate(connected: MagicMock) -> AsyncMock:
    """Patch the post-flash drive data write (repairs.async_migrate)."""
    with patch(f"{_V3}.async_migrate", AsyncMock(return_value=Path("b.json"))) as mock:
        yield mock


async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def _start(hass: HomeAssistant, entry: MockConfigEntry) -> dict[str, Any]:
    """Open the options, pick the upgrade, continue past the explanation, run the check."""
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.MENU
    assert result["menu_options"] == ["settings", "firmware_v3"]
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "firmware_v3"}
    )
    assert result["step_id"] == "firmware_v3"
    result = await hass.config_entries.options.async_configure(result["flow_id"], {})
    return await _past_progress(hass, result)


async def _past_progress(hass: HomeAssistant, result: dict[str, Any]) -> dict[str, Any]:
    while result["type"] is FlowResultType.SHOW_PROGRESS:
        await hass.async_block_till_done(wait_background_tasks=True)
        result = await hass.config_entries.options.async_configure(result["flow_id"])
    return result


async def _confirm(hass: HomeAssistant, result: dict[str, Any]) -> dict[str, Any]:
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"confirm": True}
    )
    return await _past_progress(hass, result)


def _backups(config_dir: Path) -> list[Path]:
    return sorted((config_dir / "opendisplay" / "backups").iterdir())


# --- eligibility -------------------------------------------------------------


@pytest.mark.parametrize("device_config", [_bg22(PANEL_GLASS)])
async def test_only_a_2x_bg22_is_offered_the_upgrade(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, connected: MagicMock
) -> None:
    """The menu appears for a BG22 on 2.x; on 3.x the options open as before."""
    connected.profile.firmware = V3_FIRMWARE
    await _setup(hass, mock_config_entry)

    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"


async def test_the_settings_stay_reachable_from_the_menu(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    """Choosing settings shows the usual options form."""
    await _setup(hass, mock_config_entry)
    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "settings"}
    )

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "settings"


# --- release selection -------------------------------------------------------


def test_the_manifest_offers_only_the_from_2x_flow_with_a_checksum() -> None:
    """No from-2x flow, a missing asset or a missing sha256 offers nothing."""
    assets = {GBL_NAME, "manifest.json"}
    assert select_bg22_ota(_manifest(), assets) == (
        GBL_NAME,
        hashlib.sha256(GBL).hexdigest(),
        len(GBL),
    )
    no_flow = _manifest()
    del no_flow["boards"][0]["flows"]["ble-ota-from-2x"]
    assert select_bg22_ota(no_flow, assets) is None
    assert select_bg22_ota(_manifest(), {"manifest.json"}) is None
    no_sum = _manifest()
    no_sum["artefacts"][0]["sha256"] = None
    assert select_bg22_ota(no_sum, assets) is None
    assert select_bg22_ota({**_manifest(), "schema": "other/1"}, assets) is None


# --- happy path --------------------------------------------------------------


async def test_upgrade_backs_up_flashes_and_migrates(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    config_dir: Path,
    flash: AsyncMock,
    migrate: AsyncMock,
    issue_registry: ir.IssueRegistry,
) -> None:
    """The check saves the 2.x config, the flash writes the verified image, then the drive data."""
    await _setup(hass, mock_config_entry)

    result = await _start(hass, mock_config_entry)

    assert result["step_id"] == "firmware_v3_confirm"
    placeholders = result["description_placeholders"]
    assert placeholders["version"] == "3.1.0"
    assert "EP29YR_168x384" in placeholders["panel"]
    backup = Path(placeholders["backup"])
    assert _backups(config_dir) == [backup]
    assert "-before-3x-" in backup.name
    flash.assert_not_awaited()

    result = await _confirm(hass, result)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "firmware_v3_done"
    assert flash.await_args.args[2] == GBL
    migrate.assert_awaited_once()
    assert (
        issue_registry.async_get_issue(
            DOMAIN, needs_migration_issue_id(mock_config_entry)
        )
        is None
    )
    assert not hass.data.get(DATA_FIRMWARE_UPGRADES)


async def test_the_flash_needs_the_box_ticked(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, flash: AsyncMock
) -> None:
    """Submitting the confirmation without ticking it flashes nothing."""
    await _setup(hass, mock_config_entry)
    result = await _start(hass, mock_config_entry)

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"confirm": False}
    )

    assert result["errors"] == {"base": "confirm_required"}
    flash.assert_not_awaited()


@pytest.mark.parametrize("device_config", [_bg22(PANEL_EQUIVALENT)])
async def test_untested_drive_data_gets_its_own_warning(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    """Drive data nobody has watched draw is confirmed with the untested warning."""
    await _setup(hass, mock_config_entry)

    result = await _start(hass, mock_config_entry)

    assert result["step_id"] == "firmware_v3_confirm_untested"


# --- refusals before any flash -----------------------------------------------


@pytest.mark.parametrize("device_config", [_bg22(PANEL_NONE)])
async def test_a_panel_without_3x_drive_data_is_refused(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    config_dir: Path,
    flash: AsyncMock,
) -> None:
    """No drive data for the panel: refuse, but keep the backup that was taken."""
    await _setup(hass, mock_config_entry)

    result = await _start(hass, mock_config_entry)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "unsupported"
    assert "No 3.x drive data" in result["description_placeholders"]["reason"]
    assert _backups(config_dir) == [Path(result["description_placeholders"]["backup"])]
    flash.assert_not_awaited()


async def test_a_config_too_large_for_the_bg22_is_refused(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, flash: AsyncMock
) -> None:
    """A migrated config over the BG22 ceiling is refused before the flash."""
    await _setup(hass, mock_config_entry)

    with patch(f"{_V3}.BG22_MAX_CONFIG", 1000):
        result = await _start(hass, mock_config_entry)

    assert result["reason"] == "too_large"
    assert result["description_placeholders"]["limit"] == "1000"
    assert int(result["description_placeholders"]["size"]) > 1000
    flash.assert_not_awaited()


async def test_a_sleeping_display_is_refused(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, flash: AsyncMock
) -> None:
    """A tag that is probably asleep is not connected to, let alone flashed."""
    await _setup(hass, mock_config_entry)

    with patch(f"{_V3}.device_probably_asleep", return_value=True):
        result = await _start(hass, mock_config_entry)

    assert result["reason"] == "device_sleeping"
    flash.assert_not_awaited()


async def test_an_unreachable_display_is_refused(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_opendisplay_device: MagicMock,
    config_dir: Path,
    flash: AsyncMock,
) -> None:
    """Without a connection there is no backup and no flash."""
    await _setup(hass, mock_config_entry)
    mock_opendisplay_device.__aenter__.side_effect = BLEConnectionError("gone")

    result = await _start(hass, mock_config_entry)

    assert result["reason"] == "cannot_connect"
    assert not (config_dir / "opendisplay" / "backups").exists()
    flash.assert_not_awaited()


async def test_no_release_with_a_bg22_image_is_refused(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    flash: AsyncMock,
) -> None:
    """Releases without the from-2x image offer nothing."""
    aioclient_mock.clear_requests()
    aioclient_mock.get(GITHUB_LATEST, json={"tag_name": "v2.30", "body": ""})
    aioclient_mock.get(
        RELEASES,
        json=[{"tag_name": "3.1.1", "draft": False, "prerelease": False, "assets": []}],
    )
    await _setup(hass, mock_config_entry)

    result = await _start(hass, mock_config_entry)

    assert result["reason"] == "no_release"
    flash.assert_not_awaited()


async def test_an_image_that_does_not_match_the_manifest_is_not_flashed(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    flash: AsyncMock,
) -> None:
    """A wrong sha256 stops the upgrade before the BLE flash."""
    await _setup(hass, mock_config_entry)
    result = await _start(hass, mock_config_entry)
    aioclient_mock.clear_requests()
    aioclient_mock.get(GBL_URL, content=b"truncated")

    result = await _confirm(hass, result)

    assert result["reason"] == "firmware_corrupt"
    flash.assert_not_awaited()
    assert not hass.data.get(DATA_FIRMWARE_UPGRADES)


# --- failures during and after the flash -------------------------------------


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (
            OTAFlashError("Firmware update failed: x", reached_apploader=False),
            "flash_failed",
        ),
        (
            OTAFlashError(
                "Firmware update failed: not in OTA mode", reached_apploader=True
            ),
            "flash_failed_apploader",
        ),
    ],
)
async def test_a_failed_flash_says_where_the_display_is(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    migrate: AsyncMock,
    error: Exception,
    reason: str,
    issue_registry: ir.IssueRegistry,
) -> None:
    """A flash that broke off after the DFU trigger warns about the AppLoader."""
    await _setup(hass, mock_config_entry)
    result = await _start(hass, mock_config_entry)

    with patch(f"{_V3}.async_flash_silabs", AsyncMock(side_effect=error)):
        result = await _confirm(hass, result)

    assert result["reason"] == reason
    assert "not in OTA mode" in result["description_placeholders"]["error"] or (
        reason == "flash_failed"
    )
    assert result["description_placeholders"]["backup"]
    migrate.assert_not_awaited()
    # Still a 2.x display as far as anyone knows: no repair, no reload.
    assert (
        issue_registry.async_get_issue(
            DOMAIN, needs_migration_issue_id(mock_config_entry)
        )
        is None
    )
    assert not hass.data.get(DATA_FIRMWARE_UPGRADES)


async def test_a_failed_migration_falls_back_to_the_repair(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    connected: MagicMock,
    flash: AsyncMock,
    migrate: AsyncMock,
    issue_registry: ir.IssueRegistry,
) -> None:
    """Flashed but the drive data write failed: the repair opens, pointing at the backup.

    The entry reloads on 3.x and its setup re-raises the issue; the backup survives that.
    """
    migrate.side_effect = MigrationFailedError("it did not read back")
    await _setup(hass, mock_config_entry)
    result = await _start(hass, mock_config_entry)
    backup = result["description_placeholders"]["backup"]
    connected.profile.needs_migration = True

    result = await _confirm(hass, result)
    await hass.async_block_till_done(wait_background_tasks=True)

    assert result["reason"] == "migrate_failed"
    assert result["description_placeholders"]["error"] == "it did not read back"
    assert result["description_placeholders"]["backup"] == backup
    issue = issue_registry.async_get_issue(
        DOMAIN, needs_migration_issue_id(mock_config_entry)
    )
    assert issue is not None
    assert issue.translation_key == "needs_migration_after_upgrade"
    assert issue.translation_placeholders["backup"] == backup
    # The reload re-read the display on 3.x.
    assert mock_config_entry.runtime_data.firmware["major"] == 3


async def test_a_display_that_does_not_come_back_falls_back_to_the_repair(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    connected: MagicMock,
    migrate: AsyncMock,
    issue_registry: ir.IssueRegistry,
) -> None:
    """Never answering on 3.x after the flash hands over to the repair, unmigrated."""
    await _setup(hass, mock_config_entry)
    result = await _start(hass, mock_config_entry)
    # When it does answer later (the reload), it is on 3.x without drive data.
    connected.profile.firmware = V3_FIRMWARE
    connected.profile.needs_migration = True

    with (
        patch(f"{_V3}.async_flash_silabs", AsyncMock()),
        patch(f"{_V3}.RETURN_DEADLINE_S", 0.0),
        patch(f"{_V3}._async_connected", side_effect=_unavailable),
    ):
        result = await _confirm(hass, result)

    assert result["reason"] == "not_back"
    migrate.assert_not_awaited()
    issue = issue_registry.async_get_issue(
        DOMAIN, needs_migration_issue_id(mock_config_entry)
    )
    assert issue is not None
    assert issue.data["backup"] == result["description_placeholders"]["backup"]


def _unavailable(*_args: Any) -> Any:
    raise MigrationUnavailableError


# --- guards while the upgrade runs -------------------------------------------


async def test_the_update_entity_refuses_while_the_upgrade_runs(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    """A 2.x install mid-upgrade would undo it, so it is refused."""
    await _setup(hass, mock_config_entry)
    inject_bluetooth_service_info(hass, VALID_SERVICE_INFO)
    await hass.async_block_till_done()
    hass.data.setdefault(DATA_FIRMWARE_UPGRADES, set()).add(mock_config_entry.entry_id)

    with (
        patch(
            f"{_UPDATE}.perform_silabs_ota", AsyncMock(side_effect=OTAError("x"))
        ) as ota,
        pytest.raises(HomeAssistantError) as err,
    ):
        await hass.services.async_call(
            UPDATE_DOMAIN,
            SERVICE_INSTALL,
            {"entity_id": "update.opendisplay_1234_firmware"},
            blocking=True,
        )

    assert err.value.translation_key == "firmware_upgrade_running"
    ota.assert_not_awaited()


async def test_closing_the_dialog_does_not_stop_the_flash_or_the_migration(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    connected: MagicMock,
    migrate: AsyncMock,
) -> None:
    """The flash runs in the background: closing the flow mid-flash still migrates."""
    await _setup(hass, mock_config_entry)
    result = await _start(hass, mock_config_entry)
    release = asyncio.Event()

    async def _slow_flash(*_args: Any, on_progress: Any) -> None:
        await release.wait()
        connected.profile.firmware = V3_FIRMWARE

    with patch(f"{_V3}.async_flash_silabs", AsyncMock(side_effect=_slow_flash)):
        result = await hass.config_entries.options.async_configure(
            result["flow_id"], {"confirm": True}
        )
        assert result["type"] is FlowResultType.SHOW_PROGRESS
        hass.config_entries.options.async_abort(result["flow_id"])
        await hass.async_block_till_done()
        assert hass.data[DATA_FIRMWARE_UPGRADES] == {mock_config_entry.entry_id}

        release.set()
        await hass.async_block_till_done(wait_background_tasks=True)

    migrate.assert_awaited_once()
    assert not hass.data[DATA_FIRMWARE_UPGRADES]


async def test_the_repair_keeps_pointing_at_the_backup_after_a_setup(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    issue_registry: ir.IssueRegistry,
) -> None:
    """A later setup re-raising the issue keeps the pre-upgrade backup in it."""
    mock_config_entry.add_to_hass(hass)
    issue_id = needs_migration_issue_id(mock_config_entry)

    async_update_needs_migration_issue(hass, mock_config_entry, True, backup="/b.json")
    async_update_needs_migration_issue(hass, mock_config_entry, True)

    issue = issue_registry.async_get_issue(DOMAIN, issue_id)
    assert issue.translation_key == "needs_migration_after_upgrade"
    assert issue.translation_placeholders == {
        "name": mock_config_entry.title,
        "backup": "/b.json",
    }

    async_update_needs_migration_issue(hass, mock_config_entry, False)
    assert issue_registry.async_get_issue(DOMAIN, issue_id) is None
